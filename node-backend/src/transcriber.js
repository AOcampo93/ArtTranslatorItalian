/**
 * transcriber.js
 * Transcripción de italiano con whisper.cpp, manteniendo el modelo en memoria.
 *
 * Sustituye al `nativePipeline.js` del proyecto base, que hacía `spawn` de
 * `whisper-cli` por cada trozo de 2 segundos y por tanto **recargaba 465 MB de
 * disco cada 2 segundos**. Era el mayor cuello de botella del proyecto de
 * origen. Aquí `whisper-server` arranca una vez y se le mandan los trozos por
 * HTTP.
 *
 * Tres invariantes de PLAN.md §0 que este módulo tiene que cumplir:
 *
 *  - **§0.2 — escuchar en `127.0.0.1` explícito.** Si algo hace `bind` a
 *    `0.0.0.0`, Windows muestra el diálogo del Firewall en el primer arranque;
 *    el usuario no técnico pulsa "Cancelar", Windows crea una regla de bloqueo
 *    permanente y la app queda rota para siempre sin ningún mensaje.
 *  - **§0.8 — el hijo no puede quedar huérfano.** Node no mata el árbol de
 *    procesos en Windows: si Electron muere, `whisper-server` sobrevive comiendo
 *    700 MB y ocupando el puerto, y el siguiente arranque habla con el proceso
 *    de la versión anterior.
 *  - **§0.10 — VAD y `audio_ctx` siempre.** El encoder de Whisper procesa
 *    SIEMPRE una ventana de 30 s aunque el trozo sea de 2 s. Sin VAD ni contexto
 *    recortado, una ventana deslizante ingenua multiplica el coste por el número
 *    de pasos y hunde cualquiera de los dos equipos del cliente.
 */

'use strict'

const { spawn } = require('child_process')
const net = require('net')
const path = require('path')
const fs = require('fs')

const ES_WINDOWS = process.platform === 'win32'

/**
 * Códigos de salida de Windows que significan algo concreto.
 *
 * Solo el primero está observado: en una VM de Windows real, sin el runtime de
 * MSVC, `whisper-server.exe` murió con 0xC0000135 antes de imprimir nada
 * `[verificado]`. Sin esta traducción el usuario solo ve "terminó con código
 * 3221225781", que no le dice qué hacer.
 *
 * Los otros tres NO se han observado nunca aquí: son la conversión de la
 * constante NTSTATUS documentada `[por medir]`. La cabecera de esta tabla
 * llevaba antes un `[medido]` que los cubría a todos, y con él se colaron dos
 * errores: `3221225595` estaba etiquetado como 0xC0000139 cuando en realidad es
 * **0xC000007B**, y el 0xC0000139 de verdad —3221225785— no estaba en la tabla,
 * así que ese fallo nunca se habría traducido. La prueba que recorría la tabla
 * solo comprobaba que los textos no estuvieran vacíos, nunca la aritmética.
 */
const CODIGOS_WINDOWS = {
  3221225781: {                                   // 0xC0000135 STATUS_DLL_NOT_FOUND  [verificado]
    causa: 'falta una DLL junto al ejecutable',
    arreglo: 'comprueba la carpeta con: node herramientas/dependencias-windows.js <carpeta bin>, y envía este informe',
  },
  3221225785: {                                   // 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND  [por medir]
    causa: 'una DLL está presente pero es de otra versión',
    arreglo: 'hay una DLL del sistema tapando a la que trae el programa; envía este informe',
  },
  3221225595: {                                   // 0xC000007B STATUS_INVALID_IMAGE_FORMAT  [por medir]
    causa: 'un binario es de otra arquitectura o está corrupto',
    arreglo: 'la descarga puede haberse dañado; vuelve a descargar el programa',
  },
  3221225477: {                                   // 0xC0000005 STATUS_ACCESS_VIOLATION  [por medir]
    causa: 'el proceso falló por violación de acceso',
    arreglo: 'suele indicar incompatibilidad de CPU; envía este informe',
  },
}

/**
 * Extrae del `system_info` de whisper las instrucciones que sí están activas.
 * Con eso se deduce qué DLL `ggml-cpu-*` ganó el despacho: AVX2 y F16C activos
 * significan `haswell` o mejor; solo SSE significa que cayó a `sse42`, que es
 * la variante para CPUs de 2010 y rendiría fatal sin avisar.
 */
function resumirSystemInfo (linea) {
  const activas = []
  for (const par of linea.split('|')) {
    const m = par.trim().match(/^([A-Z0-9_]+)\s*=\s*1$/)
    if (m) activas.push(m[1])
  }
  const tiene = (x) => activas.includes(x)
  const nivel = tiene('AVX512F') ? 'AVX-512 (skylakex o superior)'
    : tiene('AVX2') ? 'AVX2 (haswell o superior)'
    : tiene('AVX') ? 'AVX (sandybridge)'
    : 'solo SSE — variante sse42, rendimiento muy pobre'
  return { instrucciones: activas, nivel, sospechoso: !tiene('AVX2') }
}

/** Traduce un código de salida a algo que el usuario pueda accionar. */
function explicarCodigo (code) {
  const m = CODIGOS_WINDOWS[code]
  if (!m) return `terminó con código ${code}`
  return `${m.causa} (0x${(code >>> 0).toString(16).toUpperCase()}). ${m.arreglo}`
}

// Contexto de audio recortado: el gran ahorro frente a decodificar los 30 s
// completos. La ganancia real está [por medir] en el equipo del cliente.
/**
 * Topes de hilos. Ninguno es un óptimo demostrado: son los límites hasta donde
 * llega la medición, y están puestos para errar por lo bajo a propósito.
 * Ver `hilosRecomendados()` para las cifras y el porqué.
 */
const HILOS_MIN = 2
const HILOS_MAX = 6              // no hay medición por encima de 6  [por medir]
const RESERVA_VIDEOLLAMADA = 4   // núcleos que se le dejan a Teams   [por medir]

const AUDIO_CTX = 512

/** Pide al sistema un puerto libre. Nunca fijamos uno: chocaría con otra app. */
function puertoLibre () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    // Escuchamos en loopback también aquí: pedir el puerto en 0.0.0.0 ya
    // dispararía el diálogo del Firewall en Windows.
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

class Transcriber {
  /**
   * @param {object} opts
   * @param {string} opts.binario  ruta a whisper-server
   * @param {string} opts.modelo   ruta al modelo ggml multilingüe
   * @param {number} [opts.hilos]  hilos de cómputo
   */
  constructor ({ binario, modelo, hilos }) {
    this.binario = binario
    this.modelo = modelo
    this.hilos = hilos || Transcriber.hilosRecomendados()
    this.proc = null
    this.puerto = null
    this._limpiadores = []
    this._ultimoError = null
    // Qué variante de DLL eligió el despacho por microarquitectura.
    // Si cae a `sse42` en una CPU moderna, algo va mal con el empaquetado y
    // el rendimiento será pésimo SIN dar ningún error.  (PLAN.md §7)
    this.infoSistema = null
  }

  /**
   * Hilos de cómputo para whisper.
   *
   * ## Lo que se midió, y por qué contradice lo que este comentario decía antes
   *
   * Aquí decía que pasarse de los núcleos físicos "degrada hasta 2x", con marca
   * `[medido]`. **Nadie lo había medido**, y las tres afirmaciones que sostenían
   * la fórmula anterior eran falsas. Estas son las mediciones reales:
   *
   * Apple M5, 10 núcleos (4P + 6E), sin hyperthreading, GPU apagada para que
   * mida la CPU como el build de Windows, audio de 6,5 s:  `[medido]`
   *
   * |  hilos | en reposo | con 4 de 10 núcleos ocupados |
   * |-------:|----------:|-----------------------------:|
   * |      2 |         — |                     2.775 ms |
   * |      3 |  1.435 ms |                     1.892 ms |
   * |      4 |  1.203 ms |                     1.632 ms |
   * |      6 |  1.006 ms |                 **1.500 ms** |
   * |      8 |  **909 ms** |                   2.158 ms |
   * |     10 |  1.360 ms |                     4.465 ms |
   * |     12 | **73.652 ms** |                        — |
   *
   * HP Pavilion i5-10210U, 4 físicos / 8 lógicos, 15 W, en reposo:  `[medido]`
   * 6 hilos → whisper p50 1.983 ms · 3 hilos → 4.246 ms
   *
   * ## Las tres cosas que esas cifras establecen
   *
   * 1. **El óptimo se mueve según la carga.** En reposo gana 8; con cuatro
   *    núcleos ocupados gana 6, y 8 pasa a ser 1,4x peor. La app **nunca** corre
   *    en reposo: corre con la videollamada que la hizo necesaria. Un óptimo
   *    medido con la máquina quieta mide el escenario equivocado, y por eso
   *    aquí no hay barrido en el arranque.
   * 2. **El óptimo es aproximadamente el número de núcleos LIBRES**, no de
   *    núcleos físicos: con 4 de 10 ocupados, el mejor fue exactamente 6.
   * 3. **El error es asimétrico, y por eso la regla yerra por lo bajo.**
   *    Quedarse corto cuesta entre un 10% y un 30%. Pasarse cuesta 1,4x y luego
   *    se cae por un precipicio: 12 hilos sobre 10 núcleos dieron **81 veces**
   *    más tiempo. La causa está en el código de ggml y no es una anomalía: la
   *    barrera entre hilos es **espera activa** (`ggml_thread_cpu_relax`, que es
   *    `_mm_pause` en x86 y `yield` en ARM). Un hilo que espera no se duerme:
   *    quema el núcleo que otro hilo necesita para avanzar.
   *
   * whisper.cpp usa por defecto `min(4, hardware_concurrency)` — el `--help` del
   * binario que empaquetamos imprime `[4]` en una máquina de 10 núcleos
   * `[verificado]`. Upstream no consulta núcleos físicos en ningún sitio: esa
   * distinción viene del dominio del álgebra densa, donde sí importa, y aquí se
   * dio por buena sin comprobarla.
   *
   * ## Lo que sigue sin medirse
   *
   * Las dos constantes salen de una sola máquina. Cuántos núcleos reserva de
   * verdad una videollamada de Teams, y dónde está el óptimo en el i9-13900HX
   * y en el Ryzen 7 del cliente, está **`[por medir]`**. Para eso existe
   * `WHISPER_HILOS`, y el informe dice siempre con qué valor se midió.
   */
  static hilosRecomendados ({ logicos } = {}) {
    const forzado = parseInt(process.env.WHISPER_HILOS || '', 10)
    if (Number.isFinite(forzado) && forzado > 0) return forzado

    // availableParallelism() respeta límites de cgroup y de afinidad; cpus()
    // no. En un contenedor o una VM con la CPU limitada, cpus() cuenta los del
    // anfitrión y nos llevaría directos al precipicio.
    const n = Number.isFinite(logicos) ? logicos : Transcriber.logicosDisponibles()
    if (!Number.isFinite(n) || n < 1) return HILOS_MIN   // os.cpus() vacío: pasa en contenedores

    // El suelo no puede pasarse de los núcleos que hay: en una máquina de 1
    // vCPU, pedir 2 hilos ya es sobresuscripción, y el precipicio está medido.
    return Math.max(
      Math.min(HILOS_MIN, n),
      Math.min(HILOS_MAX, n - RESERVA_VIDEOLLAMADA)
    )
  }

  /** Núcleos que el proceso puede usar de verdad. */
  static logicosDisponibles () {
    const os = require('os')
    return typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length
  }

  /** Arranca el servidor y espera a que responda. Idempotente. */
  async start () {
    if (this.proc) return

    if (!fs.existsSync(this.binario)) {
      throw new Error(`whisper-server no encontrado en ${this.binario}`)
    }
    if (!fs.existsSync(this.modelo)) {
      throw new Error(`modelo no encontrado en ${this.modelo}`)
    }
    // Los modelos .en son solo-inglés: con italiano devolverían basura fonética.
    if (/\.en\.bin$/i.test(path.basename(this.modelo))) {
      throw new Error(`el modelo ${path.basename(this.modelo)} es solo-inglés; hace falta uno multilingüe`)
    }

    this.puerto = await puertoLibre()

    this.proc = spawn(this.binario, [
      '-m', this.modelo,
      '--host', '127.0.0.1',        // explícito: ver §0.2
      '--port', String(this.puerto),
      '-l', 'it',                   // italiano, no autodetección
      '-t', String(this.hilos),
      '-ac', String(AUDIO_CTX),
      '-nt',                        // sin marcas de tiempo: solo queremos el texto
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    this.proc.stderr.on('data', d => {
      const texto = d.toString()
      // whisper.cpp anuncia en su arranque qué juego de instrucciones usa.
      // Es el único sitio donde se puede leer qué variante ganó el despacho.
      const m = texto.match(/system_info:\s*(.+)/)
      if (m && !this.infoSistema) this.infoSistema = resumirSystemInfo(m[1])
      const linea = texto.trim().split('\n')[0]
      if (linea) console.log('[whisper]', linea)
    })
    this.proc.on('exit', (code) => {
      if (code) {
        this._ultimoError = explicarCodigo(code)
        console.warn(`[whisper] ${this._ultimoError}`)
      }
      this.proc = null
    })

    this._instalarLimpiadores()
    await this._esperarListo()
    console.log(`[whisper] listo en 127.0.0.1:${this.puerto} · ${this.hilos} hilos · modelo ${path.basename(this.modelo)}`)
  }

  /**
   * Mata el hijo en cualquier salida del padre.
   * En Windows, `kill()` de Node no mata el árbol: hace falta `taskkill /T`.
   */
  _instalarLimpiadores () {
    const matar = () => this.stop()
    for (const ev of ['exit', 'SIGINT', 'SIGTERM']) {
      process.on(ev, matar)
      this._limpiadores.push(() => process.off(ev, matar))
    }
  }

  async _esperarListo (maxMs = 60000) {
    const t0 = Date.now()
    while (Date.now() - t0 < maxMs) {
      if (!this.proc) {
        throw new Error(this._ultimoError
          ? `whisper-server no arrancó: ${this._ultimoError}`
          : 'whisper-server murió durante el arranque')
      }
      try {
        const r = await fetch(`http://127.0.0.1:${this.puerto}/`, {
          signal: AbortSignal.timeout(1000),
        })
        if (r.status < 500) return
      } catch { /* todavía arrancando */ }
      await new Promise(r => setTimeout(r, 250))
    }
    this.stop()
    throw new Error(`whisper-server no respondió en ${maxMs} ms`)
  }

  /**
   * Transcribe un WAV de 16 kHz mono.
   * @param {Buffer} wav
   * @param {object} [opts]
   * @param {string} [opts.prompt] glosario del contexto de proyecto: mejora
   *        notablemente la transcripción de siglas y nombres propios.
   * @returns {Promise<{ texto: string, ms: number }>}
   */
  async transcribir (wav, { prompt } = {}) {
    if (!this.proc) throw new Error('el transcriptor no está arrancado')

    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
    form.append('response_format', 'json')
    form.append('language', 'it')
    form.append('audio_ctx', String(AUDIO_CTX))
    if (prompt) form.append('prompt', prompt)

    const t0 = Date.now()
    const res = await fetch(`http://127.0.0.1:${this.puerto}/inference`, {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      throw new Error(`whisper respondió ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const json = await res.json()
    return { texto: limpiar(json.text || ''), ms: Date.now() - t0 }
  }

  /** Para el servidor. Seguro de llamar varias veces. */
  stop () {
    const p = this.proc
    this.proc = null
    this._limpiadores.forEach(f => f())
    this._limpiadores = []
    if (!p || p.killed) return

    if (ES_WINDOWS) {
      // /T mata el árbol, /F fuerza. Sin esto quedan huérfanos ocupando el puerto.
      try { spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) }
      catch { p.kill('SIGKILL') }
      return
    }
    p.kill('SIGTERM')
    setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, 3000).unref?.()
  }

  get estaVivo () { return this.proc !== null }
}

/**
 * Quita los artefactos que Whisper mete y que no son habla.
 * `[BLANK_AUDIO]` y los paréntesis de sonido ambiente ensucian la traducción.
 */
function limpiar (texto) {
  return texto
    .replace(/\[BLANK_AUDIO\]/gi, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

module.exports = { Transcriber, AUDIO_CTX }
module.exports._internos = { limpiar, puertoLibre, explicarCodigo, CODIGOS_WINDOWS, resumirSystemInfo }
