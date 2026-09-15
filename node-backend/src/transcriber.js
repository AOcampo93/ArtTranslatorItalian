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
 * Verificado en una VM de Windows real: sin el runtime de MSVC,
 * `whisper-server.exe` muere con 0xC0000135 antes de imprimir nada. Sin esta
 * traducción, el usuario solo ve "terminó con código 3221225781", que no le
 * dice qué hacer.  [medido]
 */
const CODIGOS_WINDOWS = {
  3221225781: {                                   // 0xC0000135 STATUS_DLL_NOT_FOUND
    causa: 'falta una DLL del sistema',
    arreglo: 'ejecuta vc_redist.x64.exe, que viene en la carpeta del programa, y reinténtalo',
  },
  3221225595: {                                   // 0xC0000139 ENTRYPOINT_NOT_FOUND
    causa: 'una DLL está presente pero es de otra versión',
    arreglo: 'reinstala el runtime de Microsoft con vc_redist.x64.exe',
  },
  3221225477: {                                   // 0xC0000005 ACCESS_VIOLATION
    causa: 'el proceso falló por violación de acceso',
    arreglo: 'suele indicar incompatibilidad de CPU; envía este informe',
  },
}

/** Traduce un código de salida a algo que el usuario pueda accionar. */
function explicarCodigo (code) {
  const m = CODIGOS_WINDOWS[code]
  if (!m) return `terminó con código ${code}`
  return `${m.causa} (0x${(code >>> 0).toString(16).toUpperCase()}). ${m.arreglo}`
}

// Contexto de audio recortado: el gran ahorro frente a decodificar los 30 s
// completos. La ganancia real está [por medir] en el equipo del cliente.
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
  }

  /**
   * Hilos a usar, consciente de núcleos híbridos.
   *
   * No es "núcleos − 2": en un i9-13900HX (8 P + 16 E) eso daría 22 hilos y
   * rendiría PEOR que usar solo los 8 P-cores, porque whisper.cpp reparte el
   * trabajo por igual y los núcleos rápidos acabarían esperando a los lentos.
   * Distinguir P de E no se puede leer desde Node sin un addon nativo, así que
   * la heurística es conservadora y el test de admisión la validará.  [por medir]
   */
  static hilosRecomendados () {
    // Anulación manual. Existe por dos motivos reales:
    //  · En una máquina virtual la heurística se queda corta: está calibrada
    //    sobre los núcleos lógicos de una CPU híbrida real (32 en el i9 del
    //    cliente), y con 8 vCPU daría 2 hilos y una medición falsamente mala.
    //  · El test de admisión debe poder probar varios valores y quedarse con
    //    el mejor, en vez de confiar en una deducción que no se puede verificar.
    const forzado = parseInt(process.env.WHISPER_HILOS || '', 10)
    if (Number.isFinite(forzado) && forzado > 0) return forzado

    const cpus = require('os').cpus()
    const logicos = cpus.length
    const nombre = (cpus[0]?.model || '').toLowerCase()
    // Intel de 12ª en adelante es híbrido; Apple Silicon también tiene E-cores.
    const esHibrido = /12th|13th|14th|15th|core ultra|apple m/.test(nombre)
    if (esHibrido) return Math.max(2, Math.min(8, Math.floor(logicos / 3)))
    return Math.max(2, logicos - 2)
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
      const s = d.toString().trim()
      if (s) console.log('[whisper]', s.split('\n')[0])
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
module.exports._internos = { limpiar, puertoLibre, explicarCodigo, CODIGOS_WINDOWS }
