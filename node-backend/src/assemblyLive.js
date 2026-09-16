/**
 * assemblyLive.js
 * Transcripción de italiano en vivo con AssemblyAI Universal-3.5 Pro Realtime.
 *
 * Es el motor de la versión 1. Sustituye a whisper local, y se eligió frente a
 * Gemini Live con medidas propias sobre el mismo audio y el mismo instrumento:
 *
 * |                        | Gemini Live | AssemblyAI U-3.5 Pro |
 * |------------------------|------------:|---------------------:|
 * | WER con audio limpio   |  0,0% (n=1) |      0,0% p50 (n=25) |
 * | Primer parcial         |    1.478 ms |         881–980 ms   |
 * | **Tras dejar de hablar** |    298 ms |       **201–257 ms** |
 * | **Tope de sesión**     | **9,84 min** |          **3 horas** |
 *
 * El tope es lo que decidió la elección, no la latencia: una reunión de 90
 * minutos es **una sola conexión** en lugar de seis a nueve relevos, y cada
 * relevo era una costura por la que se podía perder una frase.
 *
 * ## La disciplina de sesión NO es opcional
 *
 * AssemblyAI **factura por tiempo de socket abierto, no por audio enviado**, y
 * una sesión que no se cierra con `Terminate` se cierra sola **a las 3 horas y
 * se facturan las 3 horas completas**. Peor aún: ocupa una de las cinco plazas
 * de concurrencia, así que una sesión huérfana **impide la siguiente reunión**.
 *
 * Esto está medido, y me costó dinero descubrirlo: una prueba mía abrió veinte
 * conexiones en diez segundos sin mandar `Terminate`, y el servidor empezó a
 * responder `Unauthorized Connection: Too many concurrent sessions`.
 *
 * De ahí salen tres invariantes de este módulo:
 *
 *  1. **Como mucho una sesión viva.** Nada de solapar como hacía el módulo de
 *     Gemini: con sesiones de 3 horas no hace falta, y solapar quemaría el
 *     límite de concurrencia.
 *  2. **`Terminate` siempre**, y en todas las salidas: al parar, al cerrar la
 *     ventana, al morir el proceso. Ver `registrarSalidas()`.
 *  3. **Nunca más de cuatro conexiones nuevas por minuto.** El límite del plan
 *     gratuito son cinco; se deja una de margen. Sin este freno, una racha de
 *     reconexiones deja al usuario sin servicio justo cuando más lo necesita.
 */

'use strict'

const { EventEmitter } = require('events')

const HOST = 'wss://streaming.assemblyai.com/v3/ws'
const MODELO = 'universal-3-5-pro'

/** Lo que exige el protocolo: PCM16 LE, mono, 16 kHz, en frames binarios. */
const SAMPLE_RATE = 16000
const MS_TROZO = 100
const MUESTRAS_TROZO = SAMPLE_RATE * MS_TROZO / 1000

/**
 * Trozos fuera de 50–1000 ms hacen que el servidor cierre con 3007. Los 100 ms
 * están dentro con margen por los dos lados.
 */
const MS_TROZO_MIN = 50
const MS_TROZO_MAX = 1000

/** Tope real de sesión del servidor. */
const TOPE_SESION_MS = 3 * 60 * 60 * 1000
/** Se releva antes, para que el corte no caiga en mitad de una reunión larga. */
const RELEVAR_A_LOS_MS = 2.75 * 60 * 60 * 1000

/**
 * Esperas de reconexión, espaciadas para respetar el límite de conexiones
 * nuevas por minuto. La primera es rápida porque un corte de red suele durar
 * poco; a partir de ahí se separan.
 */
const ESPERAS_MS = [1500, 6000, 20000, 40000]

/** Conexiones nuevas permitidas en una ventana móvil de 60 s. El plan da 5. */
const MAX_CONEXIONES_MIN = 4

/** Tras `Terminate`, el acuse tardó 1.067–1.224 ms medidos. Se espera de sobra. */
const ESPERA_TERMINATION_MS = 4000

/** Cuánto audio se guarda sin conexión antes de empezar a tirarlo. */
const MAX_BUFFER_S = 60

/** Códigos de cierre que significan algo concreto. */
const CIERRES = {
  1008: 'credenciales rechazadas o demasiadas sesiones abiertas a la vez',
  3005: 'el servidor canceló la sesión',
  3006: 'mensaje mal formado',
  3007: 'trozo de audio fuera del tamaño permitido',
  3008: 'la sesión llegó al tope de 3 horas',
  3009: 'demasiadas sesiones simultáneas',
}

/** Float32 [-1,1] a PCM16 little-endian. */
function aPcm16 (muestras) {
  const b = Buffer.alloc(muestras.length * 2)
  for (let i = 0; i < muestras.length; i++) {
    const v = Math.max(-1, Math.min(1, muestras[i]))
    b.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return b
}

/**
 * Construye la URL con sus parámetros.
 *
 * `keyterms_prompt` y `prompt` son la vía por la que el glosario y el contexto
 * de proyecto llegan al modelo, y es lo que hace que «il gestionale» o «Rossi
 * Logistica» se transcriban bien. Los topes son suyos: 100 términos y ~1500
 * caracteres.
 */
function construirUrl ({ idioma, glosario, contexto, modo }) {
  const p = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    encoding: 'pcm_s16le',
    speech_model: MODELO,
    mode: modo || 'balanced',
  })
  // Sin `language_code` el modelo alterna idiomas por su cuenta. Se fija el
  // italiano porque la reunión es en italiano; si el cliente mezcla inglés
  // técnico, quitarlo permite el cambio de idioma dentro de la frase.
  if (idioma) p.set('language_code', idioma)

  const terminos = (glosario || []).map(t => String(t).trim()).filter(Boolean).slice(0, 100)
  if (terminos.length) p.set('keyterms_prompt', JSON.stringify(terminos))

  if (contexto) p.set('prompt', String(contexto).slice(0, 1500))
  return `${HOST}?${p}`
}

class AssemblyLiveTranscriber extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.idioma]     por defecto 'it'
   * @param {string[]} [opts.glosario] términos del contexto de proyecto
   * @param {string} [opts.contexto]   descripción de la reunión, en italiano
   * @param {Function} [opts.crearSocket] inyectable, para probar sin red
   */
  constructor ({ apiKey, idioma = 'it', glosario = [], contexto = '', modo = 'balanced', crearSocket } = {}) {
    super()
    if (!apiKey && !crearSocket) throw new Error('hace falta una API key de AssemblyAI')
    this.apiKey = apiKey
    this.opciones = { idioma, glosario, contexto, modo }
    this._crearSocket = crearSocket

    this._ws = null
    this._corriendo = false
    this._cerrandoAdrede = false
    this._reconectando = false
    this._abiertaEn = null
    this._resto = []
    this._pendiente = []
    this._descartadosS = 0
    this._avisadoDelHueco = false
    this._conexiones = []        // marcas de tiempo, para el freno de ritmo
    this._quitarSalidas = null

    this.stats = {
      frases: 0, reconexiones: 0, segundosAudio: 0,
      segundosSesion: 0, sesiones: 0, relevos: 0,
    }
  }

  // ── Freno de ritmo de conexiones ────────────────────────────────────
  /** Milisegundos que hay que esperar para no pasarse del límite. */
  _esperaPorRitmo () {
    const ahora = Date.now()
    this._conexiones = this._conexiones.filter(t => ahora - t < 60000)
    if (this._conexiones.length < MAX_CONEXIONES_MIN) return 0
    return 60000 - (ahora - this._conexiones[0]) + 200
  }

  // ── Ciclo de vida ───────────────────────────────────────────────────
  async start () {
    if (this._corriendo) return
    this._corriendo = true
    this._registrarSalidas()
    this.emit('estado', 'conectando')
    await this._abrir()
    this.emit('estado', 'escuchando')
  }

  async _abrir () {
    const espera = this._esperaPorRitmo()
    if (espera > 0) {
      this.emit('estado', 'esperando-cupo')
      await new Promise(r => setTimeout(r, espera))
    }

    const url = construirUrl(this.opciones)
    const ws = this._crearSocket
      ? this._crearSocket(url, this.apiKey)
      : new (require('ws'))(url, { headers: { authorization: this.apiKey } })

    this._conexiones.push(Date.now())
    this.stats.sesiones++

    ws.on('message', d => this._mensaje(d))
    ws.on('close', (codigo, motivo) => this._cerrado(ws, codigo, String(motivo || '')))
    ws.on('error', e => this.emit('error', new Error(`socket: ${e.message}`)))

    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('15 s sin conectar')), 15000)
      ws.once('open', () => { clearTimeout(t); res() })
      ws.once('close', (c, m) => {
        clearTimeout(t)
        rej(new Error(`cerró al abrir: ${c} ${CIERRES[c] || String(m || '')}`))
      })
    })

    this._ws = ws
    this._abiertaEn = Date.now()
    this._vaciarPendiente()
  }

  _mensaje (datos) {
    let m
    try { m = JSON.parse(datos.toString()) } catch { return }

    switch (m.type) {
      case 'Begin':
        this.emit('sesion', { id: m.id, expiraEn: m.expires_at })
        return

      case 'Turn': {
        const texto = (m.transcript || '').trim()
        if (!texto) return
        if (m.end_of_turn) {
          this.stats.frases++
          this.emit('frase', { texto, orden: m.turn_order, palabras: m.words })
        } else {
          this.emit('parcial', { texto })
        }
        return
      }

      case 'Termination':
        this.stats.segundosSesion += m.session_duration_seconds || 0
        this.emit('terminada', {
          segundosAudio: m.audio_duration_seconds,
          segundosSesion: m.session_duration_seconds,
        })
        return

      case 'Error':
        // El caso que de verdad muerde: sin plaza libre no hay transcripción,
        // y suele significar que una sesión anterior quedó sin cerrar.
        this.emit('error', new Error(`AssemblyAI: ${m.error || 'error sin detalle'}`))
        return
    }
  }

  async _cerrado (ws, codigo, motivo) {
    if (ws !== this._ws) return                    // sesión ya reemplazada
    this._ws = null
    if (this._cerrandoAdrede || !this._corriendo) return

    const explicado = CIERRES[codigo] || motivo || 'sin motivo'
    this.emit('error', new Error(`la conexión se cortó (${codigo}: ${explicado})`))
    await this._reconectar()
  }

  async _reconectar () {
    if (this._reconectando || !this._corriendo) return
    this._reconectando = true
    this.emit('estado', 'reconectando')
    this.stats.reconexiones++

    for (const espera of ESPERAS_MS) {
      if (!this._corriendo) break
      await new Promise(r => setTimeout(r, espera))
      try {
        await this._abrir()
        this._reconectando = false
        this.emit('estado', 'escuchando')
        return
      } catch (err) {
        this.emit('error', new Error(`reintento fallido: ${err.message}`))
      }
    }
    this._reconectando = false
    this.emit('estado', 'sin-conexion')
    this.emit('error', new Error(
      'no se pudo reconectar. La transcripción está parada; el audio de este rato se ha perdido.'))
  }

  // ── Audio ───────────────────────────────────────────────────────────
  /**
   * @param {Float32Array|number[]} muestras  16 kHz mono, rango [-1,1]
   */
  alimentar (muestras) {
    if (!this._corriendo || !muestras?.length) return
    this.stats.segundosAudio += muestras.length / SAMPLE_RATE

    for (let i = 0; i < muestras.length; i++) this._resto.push(muestras[i])
    while (this._resto.length >= MUESTRAS_TROZO) {
      this._enviar(aPcm16(this._resto.splice(0, MUESTRAS_TROZO)))
    }
    this._quizaRelevar()
  }

  _enviar (pcm) {
    if (this._ws?.readyState === 1) { this._ws.send(pcm); return }
    this._pendiente.push(pcm)
    const tope = MAX_BUFFER_S * 1000 / MS_TROZO
    while (this._pendiente.length > tope) {
      this._pendiente.shift()
      this._descartadosS += MS_TROZO / 1000
      if (!this._avisadoDelHueco) {
        this._avisadoDelHueco = true
        this.emit('error', new Error(
          `llevamos ${MAX_BUFFER_S} s sin conexión: se está perdiendo audio`))
      }
    }
  }

  /**
   * Vuelca lo guardado, pero **no de golpe**: el servidor cierra con 3007 si
   * el audio llega más rápido que el tiempo real. Se manda al ritmo del audio.
   */
  _vaciarPendiente () {
    if (!this._pendiente.length) return
    const cola = this._pendiente
    this._pendiente = []
    let i = 0
    const siguiente = () => {
      if (!this._corriendo || this._ws?.readyState !== 1) {
        this._pendiente.unshift(...cola.slice(i))
        return
      }
      if (i >= cola.length) {
        if (this._descartadosS > 0) {
          this.emit('error', new Error(
            `se perdieron ${this._descartadosS.toFixed(1)} s de audio sin conexión`))
          this._descartadosS = 0
          this._avisadoDelHueco = false
        }
        return
      }
      this._ws.send(cola[i++])
      setTimeout(siguiente, MS_TROZO)
    }
    siguiente()
  }

  /** Releva antes del tope de 3 horas, para no cortar en mitad de la reunión. */
  _quizaRelevar () {
    if (!this._abiertaEn || this._reconectando) return
    if (Date.now() - this._abiertaEn < RELEVAR_A_LOS_MS) return
    this._abiertaEn = Date.now()
    this.stats.relevos++
    this.emit('rotacion', { motivo: 'cerca del tope de 3 horas' })
    this._reiniciar()
  }

  async _reiniciar () {
    await this._cerrarSesion()
    if (this._corriendo) {
      try { await this._abrir() } catch { await this._reconectar() }
    }
  }

  // ── Cierre, que es lo que cuesta dinero si se olvida ────────────────
  /**
   * Cierra la sesión **como manda el protocolo**: `Terminate`, esperar el
   * acuse, y sólo entonces cerrar el socket. Cerrar sin esto deja la sesión
   * viva hasta 3 horas, facturando y ocupando una plaza de concurrencia.
   */
  async _cerrarSesion () {
    const ws = this._ws
    if (!ws) return
    this._cerrandoAdrede = true
    this._ws = null
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'Terminate' }))
        await new Promise(res => {
          const t = setTimeout(res, ESPERA_TERMINATION_MS)
          const alMensaje = d => {
            try {
              if (JSON.parse(d.toString()).type === 'Termination') { clearTimeout(t); res() }
            } catch { /* no era JSON */ }
          }
          ws.on('message', alMensaje)
          ws.once('close', () => { clearTimeout(t); res() })
        })
      }
    } catch (err) {
      this.emit('error', new Error(`al cerrar la sesión: ${err.message}`))
    } finally {
      try { ws.close() } catch { /* ya estaba */ }
      // Sin esto, el coste seguiría creciendo con el reloj aunque no haya
      // ninguna sesión abierta, y el número que se le enseña al cliente
      // dejaría de significar nada.
      this._abiertaEn = null
      this._cerrandoAdrede = false
    }
  }

  async stop () {
    this._corriendo = false
    if (this._resto.length) {
      // El resto puede ser el final de la última frase.
      this._enviar(aPcm16(this._resto))
      this._resto = []
    }
    await this._cerrarSesion()
    this._quitarSalidas?.()
    this._pendiente = []
    this.emit('estado', 'parado')
  }

  /**
   * Cierra la sesión también cuando el proceso se va por donde no debe.
   *
   * Sin esto, un cierre brusco deja la sesión facturando 3 horas y ocupando
   * una plaza — y entonces la SIGUIENTE reunión del cliente no conecta. Es el
   * fallo que no se ve al probar y aparece el día que importa.
   */
  _registrarSalidas () {
    if (this._quitarSalidas) return
    const cerrarYa = () => {
      const ws = this._ws
      if (ws?.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'Terminate' })); ws.close() } catch { /* nada que hacer */ }
      }
    }
    const sucesos = ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']
    for (const s of sucesos) process.on(s, cerrarYa)
    this._quitarSalidas = () => {
      for (const s of sucesos) process.removeListener(s, cerrarYa)
      this._quitarSalidas = null
    }
  }

  /** Coste aproximado de lo consumido, para enseñárselo al usuario. */
  costeAproximadoUsd (usdPorHora = 0.45) {
    const seg = this.stats.segundosSesion
      + (this._abiertaEn ? (Date.now() - this._abiertaEn) / 1000 : 0)
    return +(seg / 3600 * usdPorHora).toFixed(4)
  }
}

module.exports = { AssemblyLiveTranscriber, SAMPLE_RATE, MODELO, CIERRES }
module.exports._internos = {
  aPcm16, construirUrl, MUESTRAS_TROZO, MS_TROZO, MS_TROZO_MIN, MS_TROZO_MAX,
  MAX_CONEXIONES_MIN, ESPERAS_MS, MAX_BUFFER_S, RELEVAR_A_LOS_MS, TOPE_SESION_MS,
}
