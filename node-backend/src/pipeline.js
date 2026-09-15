/**
 * pipeline.js
 * Del audio que llega en tiempo real a la frase traducida.
 *
 * Es la pieza que decide la latencia que el usuario percibe. Las dos anteriores
 * (transcriber, translator) se miden con un archivo completo; aquí el audio
 * llega a trozos y hay que decidir **cuándo cortar**, que es el problema real.
 *
 * Por qué no se corta cada 2 segundos, como hacía el proyecto base: el encoder
 * de Whisper procesa SIEMPRE una ventana de 30 s aunque el trozo sea de 2 s.
 * Cortar a ciegas multiplica el coste por el número de cortes. Aquí se corta
 * por **silencio**, que es donde además están las fronteras de frase.
 *
 * Defensas que vienen de la auditoría de fallos y no son obvias:
 *
 *  - **El watchdog comprueba que hay energía antes de forzar un decode.** El
 *    diseño original forzaba a los 6 s sin más; si la causa era un umbral de
 *    silencio mal puesto, forzar era decodificar silencio, y eso en italiano
 *    produce créditos de subtítulos inventados que el usuario leería como una
 *    frase real.
 *  - **Lista negra de alucinaciones.** Whisper en italiano alucina un repertorio
 *    conocido sobre silencio: "Sottotitoli e revisione a cura di…", "Amara.org".
 *  - **Guardia de repetición**, por si el decodificador entra en bucle.
 */

'use strict'

const { EventEmitter } = require('events')

const SAMPLE_RATE = 16000

// Umbral de energía para considerar que hay voz. El valor por defecto del
// proyecto base. Subirlo de más deja la app escuchando y sin transcribir nada.
const UMBRAL_VOZ = 0.008

// Silencio que cierra una frase. Menos que esto corta a mitad de frase; más,
// y la traducción llega tarde.
const SILENCIO_CIERRE_MS = 700

// Ninguna frase debería durar más que esto: si alguien habla sin pausas,
// cortamos igual para no dejar al usuario sin traducción.
const MAX_FRASE_MS = 12000

// Audio mínimo para molestarse en decodificar.
const MIN_FRASE_MS = 400

// Si entra audio con energía y no se decodifica nada en este tiempo, algo va
// mal con la segmentación y forzamos. Nunca se fuerza sobre silencio.
const WATCHDOG_MS = 6000

/** Las alucinaciones que Whisper produce en italiano sobre silencio. */
const ALUCINACIONES = [
  /sottotitoli e revisione a cura di/i,
  /sottotitoli\s+(creati|a cura)/i,
  /amara\.org/i,
  /www\.(amara|opensubtitles)/i,
  /grazie per aver guardato il video/i,
  /iscrivetevi al canale/i,
]

/** Energía media de un bloque de muestras. */
function rms (muestras) {
  if (!muestras.length) return 0
  let suma = 0
  for (let i = 0; i < muestras.length; i++) suma += muestras[i] * muestras[i]
  return Math.sqrt(suma / muestras.length)
}

/** Float32 [-1,1] a WAV PCM16, que es lo que come whisper-server. */
function aWav (muestras) {
  const pcm = Buffer.alloc(muestras.length * 2)
  for (let i = 0; i < muestras.length; i++) {
    const v = Math.max(-1, Math.min(1, muestras[i]))
    pcm.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const cab = Buffer.alloc(44)
  cab.write('RIFF', 0)
  cab.writeUInt32LE(36 + pcm.length, 4)
  cab.write('WAVE', 8)
  cab.write('fmt ', 12)
  cab.writeUInt32LE(16, 16)
  cab.writeUInt16LE(1, 20)
  cab.writeUInt16LE(1, 22)
  cab.writeUInt32LE(SAMPLE_RATE, 24)
  cab.writeUInt32LE(SAMPLE_RATE * 2, 28)
  cab.writeUInt16LE(2, 32)
  cab.writeUInt16LE(16, 34)
  cab.write('data', 36)
  cab.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([cab, pcm])
}

/** ¿El texto es una alucinación conocida o un bucle? */
function esBasura (texto) {
  const t = (texto || '').trim()
  if (t.length < 2) return true
  if (ALUCINACIONES.some(re => re.test(t))) return true

  // Bucle: el mismo grupo de 3 palabras repetido 3 veces o más.
  const palabras = t.toLowerCase().split(/\s+/).filter(Boolean)
  if (palabras.length >= 9) {
    const vistos = new Map()
    for (let i = 0; i + 3 <= palabras.length; i++) {
      const g = palabras.slice(i, i + 3).join(' ')
      const n = (vistos.get(g) || 0) + 1
      if (n >= 3) return true
      vistos.set(g, n)
    }
  }
  return false
}

/**
 * Eventos:
 *   'frase'   { it, es, msWhisper, msMarian, msTotal, segundosAudio }
 *   'estado'  'escuchando' | 'oigo-audio' | 'transcribiendo' | 'traduciendo'
 *   'descartada' { it, motivo }
 *   'error'   Error
 */
class Pipeline extends EventEmitter {
  /**
   * @param {object} deps
   * @param {{ transcribir: Function }} deps.transcriber
   * @param {{ traducir: Function }}    deps.translator
   * @param {object} [opts]
   */
  constructor ({ transcriber, translator }, opts = {}) {
    super()
    this.transcriber = transcriber
    this.translator = translator

    this.umbralVoz = opts.umbralVoz ?? UMBRAL_VOZ
    this.silencioCierreMs = opts.silencioCierreMs ?? SILENCIO_CIERRE_MS
    this.maxFraseMs = opts.maxFraseMs ?? MAX_FRASE_MS
    this.watchdogMs = opts.watchdogMs ?? WATCHDOG_MS

    // Glosario del contexto de proyecto: mejora siglas y nombres propios.
    this.prompt = opts.prompt || ''

    this._buffer = []          // muestras de la frase en curso
    this._muestrasSilencio = 0 // silencio acumulado al final del buffer
    this._huboVoz = false
    this._procesando = false
    this._cola = []
    this._corriendo = false
    this._ultimoDecode = 0
    this._energiaDesdeUltimoDecode = false
  }

  start () {
    if (this._corriendo) return
    this._corriendo = true
    this._reset()
    this._ultimoDecode = Date.now()
    this.emit('estado', 'escuchando')
  }

  /** Cierra lo pendiente y para. */
  async stop () {
    if (!this._corriendo) return
    this._corriendo = false
    if (this._huboVoz && this._buffer.length >= this._muestras(MIN_FRASE_MS)) {
      await this._cerrarFrase()
    }
    await this._vaciarCola()
    this._reset()
  }

  _reset () {
    this._buffer = []
    this._muestrasSilencio = 0
    this._huboVoz = false
    this._energiaDesdeUltimoDecode = false
  }

  _muestras (ms) { return Math.floor(SAMPLE_RATE * ms / 1000) }

  /**
   * Alimenta el pipeline con muestras nuevas.
   * @param {Float32Array|number[]} muestras  16 kHz mono, rango [-1,1]
   */
  alimentar (muestras) {
    if (!this._corriendo || !muestras?.length) return

    const energia = rms(muestras)
    const hayVoz = energia >= this.umbralVoz

    if (hayVoz) {
      if (!this._huboVoz) this.emit('estado', 'oigo-audio')
      this._huboVoz = true
      this._energiaDesdeUltimoDecode = true
      this._muestrasSilencio = 0
    } else if (this._huboVoz) {
      this._muestrasSilencio += muestras.length
    }

    // Antes de que hubiera voz no acumulamos: no tiene sentido decodificar
    // el silencio previo a que alguien empiece a hablar.
    if (this._huboVoz) {
      for (let i = 0; i < muestras.length; i++) this._buffer.push(muestras[i])
    }

    const duracionMs = this._buffer.length / SAMPLE_RATE * 1000
    const silencioMs = this._muestrasSilencio / SAMPLE_RATE * 1000

    if (this._huboVoz && silencioMs >= this.silencioCierreMs && duracionMs >= MIN_FRASE_MS) {
      this._cerrarFrase()
      return
    }
    if (duracionMs >= this.maxFraseMs) {
      this._cerrarFrase()
      return
    }
    this._comprobarWatchdog()
  }

  /**
   * Si entra audio con energía y llevamos demasiado sin decodificar, fuerza.
   *
   * La comprobación de energía es la parte importante: el diseño original
   * forzaba sin mirar, y si la causa era un umbral mal puesto, forzaba un
   * decode sobre silencio — o sea una alucinación garantizada.
   */
  _comprobarWatchdog () {
    if (!this._energiaDesdeUltimoDecode) return
    if (Date.now() - this._ultimoDecode < this.watchdogMs) return
    if (this._buffer.length < this._muestras(MIN_FRASE_MS)) return
    console.warn('[pipeline] watchdog: forzando decode tras', this.watchdogMs, 'ms')
    this._cerrarFrase()
  }

  /** Corta la frase en curso y la manda a procesar, sin bloquear la entrada. */
  _cerrarFrase () {
    const muestras = this._buffer
    this._reset()
    this._ultimoDecode = Date.now()
    if (muestras.length < this._muestras(MIN_FRASE_MS)) return

    this._cola.push(muestras)
    return this._bombearCola()
  }

  async _bombearCola () {
    if (this._procesando) return
    this._procesando = true
    try {
      while (this._cola.length) {
        await this._procesar(this._cola.shift())
      }
    } finally {
      this._procesando = false
    }
  }

  async _vaciarCola () {
    while (this._cola.length || this._procesando) {
      await new Promise(r => setTimeout(r, 30))
    }
  }

  async _procesar (muestras) {
    const t0 = Date.now()
    const segundosAudio = muestras.length / SAMPLE_RATE

    try {
      this.emit('estado', 'transcribiendo')
      const wav = aWav(muestras)
      const tr = await this.transcriber.transcribir(wav, { prompt: this.prompt })
      const it = (tr.texto || '').trim()

      if (!it) return
      if (esBasura(it)) {
        this.emit('descartada', { it, motivo: 'alucinación o bucle' })
        return
      }

      this.emit('estado', 'traduciendo')
      const tx = await this.translator.traducir(it)

      this.emit('frase', {
        it,
        es: tx.es,
        msWhisper: tr.ms,
        msMarian: tx.ms,
        msTotal: Date.now() - t0,
        segundosAudio: Number(segundosAudio.toFixed(2)),
      })
    } catch (err) {
      this.emit('error', err)
    } finally {
      this.emit('estado', 'escuchando')
    }
  }
}

module.exports = { Pipeline, SAMPLE_RATE }
module.exports._internos = { rms, aWav, esBasura, ALUCINACIONES }
