/**
 * geminiLive.js
 * Transcripción de italiano en vivo con Gemini 3.5 Transcribe Live.
 *
 * Sustituye a `transcriber.js` (whisper.cpp local) como camino por defecto, y
 * con él desaparece todo lo que costó el día de ayer: el modelo de 465 MB, el
 * runtime de MSVC, las nueve DLL de microarquitectura, el número de hilos y el
 * veredicto de CPU que podía equivocarse.
 *
 * Medido contra el audio de prueba `[medido]`:
 *   · WER 0,0% sobre 17 palabras (voz sintética limpia: en reunión real será
 *     peor, y eso sigue `[por medir]`)
 *   · primer parcial a los 1.478 ms de empezar a hablar
 *   · **texto final 298 ms después de que la persona calla**, que es la
 *     latencia que el usuario percibe. En el HP Pavilion, whisper local daba
 *     1.983 ms: la nube es 7x más rápida en un equipo flojo.
 *
 * ## Lo que este módulo resuelve, y es el riesgo nº 1 del proyecto
 *
 * **Una sesión de transcripción en vivo dura como máximo unos 10 minutos**, y
 * las reuniones del cliente pasan de 60. Eso son seis a nueve costuras por
 * reunión, y cada una puede tragarse una frase.
 *
 * El diseño sale de tres intentos medidos, no de razonar:
 *
 * 1. **Rotar por reloj, sin más: pierde audio.** Medido: de doce frases
 *    llegaron truncadas cinco, y la pérdida CRECÍA en cada relevo hasta
 *    quedarse en «la consegna alla prossima settimana». El relevo caía a mitad
 *    de frase.
 * 2. **Rotar en silencio: ya no pierde, pero duplica.** Doce frases producían
 *    catorce transcripciones, porque la sesión sucesora se abría mientras
 *    alguien hablaba, oía media frase y emitía ese pedazo.
 * 3. **Lo que funciona:** abrir el socket de la sucesora por adelantado pero
 *    **no darle audio hasta el relevo**, y hacer el relevo en un silencio de
 *    verdad. Medido: doce frases, doce transcripciones, cinco rotaciones, nada
 *    perdido y nada duplicado.
 *
 * Para saber dónde hay silencio no hace falta nuestro propio detector: Gemini
 * emite `voiceActivity` con `ACTIVITY_START` y `ACTIVITY_END`. Y hay que seguir
 * **las dos** transiciones — encender la bandera en el final y no apagarla al
 * volver a hablar la deja encendida de un silencio viejo, que es exactamente
 * lo que hizo fallar el primer intento.
 *
 * ## Interfaz
 *
 * Es la misma forma que `pipeline.alimentar()`, para que el resto de la app no
 * note el cambio de motor. Eventos:
 *
 *   'parcial'    { texto }                 mientras habla, para pintar en vivo
 *   'frase'      { texto, ms, sesion }     frase cerrada
 *   'rotacion'   { de, a, motivo }
 *   'estado'     'conectando' | 'escuchando' | 'reconectando' | 'parado'
 *   'error'      Error
 */

'use strict'

const { EventEmitter } = require('events')

const URL_BASE = 'wss://generativelanguage.googleapis.com/ws/'
  + 'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

const MODELO = 'gemini-3.5-transcribe-live'

/** Lo que el modelo exige: PCM 16 bits, 16 kHz, mono, little-endian. */
const SAMPLE_RATE = 16000
const MS_TROZO = 100
const MUESTRAS_TROZO = SAMPLE_RATE * MS_TROZO / 1000     // 1.600 muestras

/**
 * Cuándo se abre la sucesora. El tope del servidor son ~10 minutos; se deja
 * un margen amplio a propósito, porque el relevo espera un silencio y en una
 * reunión puede tardar en llegar. Sobra tiempo: en dos minutos de conversación
 * hay decenas de pausas.
 */
const ABRIR_SUCESORA_MS = 7 * 60 * 1000

/**
 * Tope duro. Si a los 9 minutos todavía no ha habido un silencio, se releva
 * igual: una costura pequeña es mejor que dejar que el servidor cierre por su
 * cuenta, que sí perdería la frase en curso.
 */
const RELEVO_FORZOSO_MS = 9 * 60 * 1000

/**
 * Si el audio lleva este tiempo sin poder enviarse, se fuerza una reconexión
 * aunque el socket NO haya avisado de que se cerró.
 *
 * Lo destapó una prueba: un socket puede quedarse medio abierto —la conexión
 * TCP viva y el servidor mudo— y entonces `readyState` sigue diciendo 1, el
 * evento `close` nunca llega, y sin esto el audio se acumularía en memoria
 * para siempre sin que nadie reconecte. Es el fallo que aparecería en el
 * minuto 50 de una reunión, cuando ya no hay forma de arreglarlo.
 */
const SIN_ENVIAR_MS = 5000

/** Reintentos de conexión, con espera creciente. */
const ESPERAS_RECONEXION_MS = [500, 1000, 2000, 4000, 8000]

/**
 * Cuánto audio se guarda mientras no hay socket. A 16 kHz y 16 bits son
 * 32 KB/s, así que 60 s son ~2 MB: barato, y cubre una caída de red normal.
 * Pasado eso se descarta lo más viejo y se avisa, en vez de crecer sin
 * límite hasta que la app se queda sin memoria en el minuto 50.
 */
const MAX_BUFFER_S = 60

/** Float32 [-1,1] a PCM16 little-endian, que es lo que pide el modelo. */
function aPcm16 (muestras) {
  const b = Buffer.alloc(muestras.length * 2)
  for (let i = 0; i < muestras.length; i++) {
    const v = Math.max(-1, Math.min(1, muestras[i]))
    b.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return b
}

/**
 * Una sesión de transcripción: un socket con su ciclo de vida.
 *
 * No sabe nada de rotaciones. Eso lo decide el transcriptor, que es quien ve
 * las dos sesiones a la vez.
 */
class Sesion extends EventEmitter {
  constructor (id, apiKey, idioma, glosario) {
    super()
    this.id = id
    this.apiKey = apiKey
    this.idioma = idioma
    this.glosario = glosario
    this.abiertaEn = null
    this.lista = false
    this.hablando = false
    this.recibeAudio = false     // en silencio hasta el relevo: ver punto 3
    this.ws = null
  }

  async abrir (timeoutMs = 20000) {
    const ws = new WebSocket(`${URL_BASE}?key=${encodeURIComponent(this.apiKey)}`)
    this.ws = ws

    ws.addEventListener('message', ev => this._mensaje(ev))
    ws.addEventListener('close', ev => {
      this.lista = false
      this.emit('cerrada', { code: ev.code, reason: String(ev.reason || '') })
    })
    ws.addEventListener('error', () => this.emit('fallo', new Error(`sesión ${this.id}: socket`)))

    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`sesión ${this.id}: ${timeoutMs} ms sin conectar`)), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(t); res() }, { once: true })
      ws.addEventListener('close', ev => {
        clearTimeout(t)
        rej(new Error(`sesión ${this.id}: cerró antes de abrir (${ev.code})`))
      }, { once: true })
    })

    // El glosario del contexto de proyecto entra como vocabulario propio: es
    // lo que hace que las siglas y los nombres del cliente se transcriban bien.
    const transcripcion = { languageCodes: [this.idioma] }
    if (this.glosario?.length) transcripcion.customVocabulary = this.glosario

    ws.send(JSON.stringify({
      setup: { model: `models/${MODELO}`, inputAudioTranscription: transcripcion },
    }))

    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`sesión ${this.id}: sin setupComplete`)), timeoutMs)
      this.once('lista', () => { clearTimeout(t); res() })
      this.once('cerrada', e => { clearTimeout(t); rej(new Error(`sesión ${this.id}: cerró en el setup (${e.code})`)) })
    })

    this.abiertaEn = Date.now()
    return this
  }

  async _mensaje (ev) {
    const bruto = typeof ev.data === 'string' ? ev.data : await ev.data.text()
    let m
    try { m = JSON.parse(bruto) } catch { return }

    if (m.setupComplete !== undefined) { this.lista = true; this.emit('lista'); return }

    const cont = m.serverContent || {}
    const parcial = m.interimInputTranscription?.text ?? cont.interimInputTranscription?.text
    const final = m.inputTranscription?.text ?? cont.inputTranscription?.text

    if (parcial) this.emit('parcial', parcial)
    if (final) this.emit('final', final)

    // Las DOS transiciones. Seguir sólo el final deja la bandera encendida de
    // un silencio anterior y el relevo cae a mitad de frase.
    const v = m.voiceActivity?.type
    if (v === 'ACTIVITY_START') { this.hablando = true; this.emit('voz', true) }
    if (v === 'ACTIVITY_END') { this.hablando = false; this.emit('voz', false) }
  }

  /** Devuelve false si no pudo enviarse, para que el llamante guarde el audio. */
  enviar (pcm) {
    if (!this.recibeAudio || !this.lista || this.ws?.readyState !== 1) return false
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: { mimeType: `audio/pcm;rate=${SAMPLE_RATE}`, data: pcm.toString('base64') },
      },
    }))
    return true
  }

  get edadMs () { return this.abiertaEn ? Date.now() - this.abiertaEn : 0 }

  cerrar () {
    this.recibeAudio = false
    try { this.ws?.close() } catch { /* ya estaba cerrado */ }
  }
}

class GeminiLiveTranscriber extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.idioma]     BCP-47, por defecto 'it-IT'
   * @param {string[]} [opts.glosario] términos del contexto de proyecto
   */
  constructor ({ apiKey, idioma = 'it-IT', glosario = [], crearSesion } = {}) {
    super()
    if (!apiKey && !crearSesion) throw new Error('hace falta una API key de Gemini')
    this.apiKey = apiKey
    /**
     * Fábrica de sesiones, inyectable. Existe para que la lógica de relevo
     * —que es la que falló dos veces al medirla— se pueda probar sin red y de
     * forma determinista. La lección de este proyecto es que una decisión
     * enterrada detrás de una llamada al exterior no se puede comprobar, y
     * entonces se blinda sola.
     */
    this._crearSesion = crearSesion
    this.idioma = idioma
    this.glosario = glosario

    this._activa = null
    this._sucesora = null
    this._siguienteId = 1
    this._pendiente = []          // muestras sin enviar (arranque o reconexión)
    this._resto = []              // muestras que no llenan un trozo de 100 ms
    this._corriendo = false
    this._rotando = false
    this._reconectando = false
    this._descartadasS = 0
    this._avisadoDelHueco = false
    this._ultimoEnvioOk = 0

    this.stats = { frases: 0, rotaciones: 0, reconexiones: 0, segundosAudio: 0 }
  }

  async start () {
    if (this._corriendo) return
    this._corriendo = true
    this.emit('estado', 'conectando')
    this._activa = await this._nuevaSesion()
    this._activa.recibeAudio = true
    this._ultimoEnvioOk = Date.now()
    this.emit('estado', 'escuchando')
  }

  async _nuevaSesion () {
    const id = this._siguienteId++
    const s = this._crearSesion
      ? this._crearSesion(id)
      : new Sesion(id, this.apiKey, this.idioma, this.glosario)
    s.on('parcial', texto => { if (s === this._activa) this.emit('parcial', { texto }) })
    s.on('final', texto => {
      // Sólo la activa cuenta. Durante el solape las dos oirían lo mismo y
      // saldrían duplicados — medido: 14 transcripciones para 12 frases.
      if (s !== this._activa) return
      const t = (texto || '').trim()
      if (!t) return
      this.stats.frases++
      this.emit('frase', { texto: t, ms: Date.now(), sesion: s.id })
    })
    s.on('voz', () => this._quizaRelevar())
    s.on('cerrada', e => this._sesionCerrada(s, e))
    s.on('fallo', err => this.emit('error', err))
    await s.abrir()
    return s
  }

  /**
   * Alimenta el transcriptor. Misma firma que `pipeline.alimentar()`.
   * @param {Float32Array|number[]} muestras  16 kHz mono, rango [-1,1]
   */
  alimentar (muestras) {
    if (!this._corriendo || !muestras?.length) return
    this.stats.segundosAudio += muestras.length / SAMPLE_RATE

    for (let i = 0; i < muestras.length; i++) this._resto.push(muestras[i])
    while (this._resto.length >= MUESTRAS_TROZO) {
      const trozo = this._resto.splice(0, MUESTRAS_TROZO)
      this._enviarTrozo(aPcm16(trozo))
    }
    this._vigilarEnvio()
    this._quizaAbrirSucesora()
  }

  _enviarTrozo (pcm) {
    if (this._activa?.enviar(pcm)) { this._ultimoEnvioOk = Date.now(); return }
    // Sin socket: se guarda. Es lo que permite que una caída de red no se
    // coma la frase, sólo la retrase.
    this._pendiente.push(pcm)
    const maxTrozos = MAX_BUFFER_S * 1000 / MS_TROZO
    while (this._pendiente.length > maxTrozos) {
      this._pendiente.shift()
      this._descartadasS += MS_TROZO / 1000
      // Se avisa en cuanto empieza a perderse, no al final. Estar tirando
      // audio es grave y el usuario tiene que verlo mientras pasa, no después.
      if (!this._avisadoDelHueco) {
        this._avisadoDelHueco = true
        this.emit('error', new Error(
          `sin conexión desde hace ${MAX_BUFFER_S} s: se está perdiendo audio`))
      }
    }
  }

  /**
   * Fuerza la reconexión si el audio no sale, aunque el socket no haya avisado.
   * Ver `SIN_ENVIAR_MS`: sin esto, un socket medio abierto acumula audio para
   * siempre y nadie reconecta nunca.
   */
  _vigilarEnvio () {
    if (!this._corriendo || this._reconectando) return
    if (!this._ultimoEnvioOk) return
    if (Date.now() - this._ultimoEnvioOk < SIN_ENVIAR_MS) return
    this._ultimoEnvioOk = Date.now()      // no reintentar en bucle
    this._sesionCerrada(this._activa, { code: 0, reason: 'sin envíos: socket mudo' })
  }

  _vaciarPendiente () {
    while (this._pendiente.length) {
      if (!this._activa?.enviar(this._pendiente[0])) return
      this._pendiente.shift()
    }
    this._ultimoEnvioOk = Date.now()
    if (this._descartadasS > 0) {
      // Se dice, no se calla: el usuario tiene derecho a saber que hay un
      // hueco en su transcripción.
      this.emit('error', new Error(
        `se perdieron ${this._descartadasS.toFixed(1)} s de audio por falta de conexión`))
      this._descartadasS = 0
      this._avisadoDelHueco = false
    }
  }

  /** Abre la sucesora por adelantado, pero SIN darle audio. */
  async _quizaAbrirSucesora () {
    if (!this._corriendo || this._sucesora || this._rotando) return
    if (!this._activa || this._activa.edadMs < ABRIR_SUCESORA_MS) return
    this._rotando = true
    try {
      const s = await this._nuevaSesion()
      s.recibeAudio = false        // muda hasta el relevo: así no oye media frase
      this._sucesora = s
    } catch (err) {
      this.emit('error', new Error(`no se pudo preparar el relevo: ${err.message}`))
    } finally {
      this._rotando = false
    }
  }

  /**
   * El relevo ocurre en un silencio de verdad. Si a los 9 minutos no ha
   * habido ninguno, se fuerza: una costura pequeña es mejor que dejar que el
   * servidor cierre y se pierda la frase en curso.
   */
  _quizaRelevar () {
    if (!this._sucesora || !this._activa) return
    const callado = !this._activa.hablando
    const forzoso = this._activa.edadMs > RELEVO_FORZOSO_MS
    if (!callado && !forzoso) return

    const vieja = this._activa
    this._activa = this._sucesora
    this._sucesora = null
    this._activa.recibeAudio = true
    this.stats.rotaciones++
    this.emit('rotacion', {
      de: vieja.id, a: this._activa.id,
      motivo: callado ? 'silencio' : 'tope de sesión sin silencio',
    })
    this._vaciarPendiente()
    // Se cierra con retraso: si quedaba un final en vuelo, que llegue.
    setTimeout(() => vieja.cerrar(), 1000)
  }

  /** Cierre inesperado de la sesión activa: reconectar sin perder el audio. */
  async _sesionCerrada (s, ev) {
    if (s !== this._activa || !this._corriendo || this._reconectando) return
    this._reconectando = true
    this.emit('estado', 'reconectando')
    this.stats.reconexiones++

    for (const espera of ESPERAS_RECONEXION_MS) {
      if (!this._corriendo) break
      await new Promise(r => setTimeout(r, espera))
      try {
        const nueva = await this._nuevaSesion()
        nueva.recibeAudio = true
        this._activa = nueva
        this._vaciarPendiente()
        this._reconectando = false
        this.emit('estado', 'escuchando')
        return
      } catch { /* siguiente espera */ }
    }
    this._reconectando = false
    this.emit('error', new Error(
      `no se pudo reconectar tras ${ESPERAS_RECONEXION_MS.length} intentos `
      + `(el servidor cerró con ${ev.code})`))
  }

  async stop () {
    this._corriendo = false
    // El resto que no llena un trozo se manda igual: puede ser el final de la
    // última frase, y perderlo es perder justo lo que alguien acaba de decir.
    if (this._resto.length) {
      this._activa?.enviar(aPcm16(this._resto))
      this._resto = []
    }
    await new Promise(r => setTimeout(r, 800))   // margen para el último final
    this._activa?.cerrar()
    this._sucesora?.cerrar()
    this._activa = this._sucesora = null
    this._pendiente = []
    this.emit('estado', 'parado')
  }
}

module.exports = { GeminiLiveTranscriber, SAMPLE_RATE, MODELO }
module.exports._internos = {
  Sesion, aPcm16, ABRIR_SUCESORA_MS, RELEVO_FORZOSO_MS, MAX_BUFFER_S,
  MUESTRAS_TROZO, SIN_ENVIAR_MS,
}
