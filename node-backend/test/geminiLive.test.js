/**
 * Pruebas del relevo de sesiones de Gemini Live.
 *
 * Este archivo existe porque el relevo **falló dos veces al medirlo**, y las
 * dos veces de una forma que un repaso de código no habría cazado:
 *
 *  1. Rotando por reloj se perdían cinco de doce frases, y la pérdida crecía
 *     en cada relevo. Causa: el relevo caía a mitad de frase.
 *  2. Rotando en silencio ya no se perdía nada, pero salían catorce
 *     transcripciones para doce frases. Causa: la sucesora se abría mientras
 *     alguien hablaba, oía media frase y emitía ese pedazo.
 *
 * Todo esto corre **sin red**, con una sesión falsa. Es deliberado: la lección
 * del proyecto es que una decisión que sólo se puede ejercer llamando al
 * exterior no se comprueba nunca, y entonces se blinda sola.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')

const { GeminiLiveTranscriber, _internos } = require('../src/geminiLive')
const { aPcm16, MUESTRAS_TROZO } = _internos

/** Sesión de mentira: registra lo que recibe y deja provocar los eventos. */
class SesionFalsa extends EventEmitter {
  constructor (id) {
    super()
    this.id = id
    this.lista = false
    this.hablando = false
    this.recibeAudio = false
    this.abiertaEn = null
    this.recibido = []
    this.cerrada = false
    this._edadFalsa = 0
  }

  async abrir () {
    this.lista = true
    this.abiertaEn = Date.now()
    this.emit('lista')
    return this
  }

  enviar (pcm) {
    if (!this.recibeAudio || !this.lista) return false
    this.recibido.push(pcm)
    return true
  }

  get edadMs () { return this._edadFalsa }
  set edadMs (v) { this._edadFalsa = v }

  cerrar () { this.cerrada = true; this.recibeAudio = false }

  // Atajos para guiar la prueba.
  habla () { this.hablando = true; this.emit('voz', true) }
  calla () { this.hablando = false; this.emit('voz', false) }
  diceFinal (t) { this.emit('final', t) }
  dicePartial (t) { this.emit('parcial', t) }
  seCae (code = 1011) { this.lista = false; this.emit('cerrada', { code, reason: 'prueba' }) }
  anunciaCierre (ms) { this.emit('goAway', ms) }
}

/** Transcriptor con sesiones falsas, y la lista de las creadas. */
function montar () {
  const creadas = []
  const t = new GeminiLiveTranscriber({
    apiKey: 'de-prueba',
    crearSesion: id => { const s = new SesionFalsa(id); creadas.push(s); return s },
  })
  return { t, creadas }
}

const trozo = (v = 0.5) => new Float32Array(MUESTRAS_TROZO).fill(v)

describe('conversión a PCM16', () => {
  test('little-endian y dos bytes por muestra', () => {
    const b = aPcm16([0, 1, -1])
    assert.strictEqual(b.length, 6)
    assert.strictEqual(b.readInt16LE(0), 0)
    assert.strictEqual(b.readInt16LE(2), 32767)
    assert.strictEqual(b.readInt16LE(4), -32767)
  })

  test('recorta fuera de rango en vez de desbordar', () => {
    // Sin el recorte, 2.0 daría 65534 y writeInt16LE lanzaría, tirando la
    // transcripción entera por un pico de audio.
    const b = aPcm16([2, -2, 1.0001])
    assert.strictEqual(b.readInt16LE(0), 32767)
    assert.strictEqual(b.readInt16LE(2), -32767)
    assert.doesNotThrow(() => aPcm16([1e9, -1e9, NaN]))
  })
})

describe('troceado a 100 ms', () => {
  test('acumula hasta llenar un trozo y no manda migajas', async () => {
    const { t, creadas } = montar()
    await t.start()
    t.alimentar(new Float32Array(500).fill(0.1))
    assert.strictEqual(creadas[0].recibido.length, 0, 'medio trozo no debe enviarse')
    t.alimentar(new Float32Array(MUESTRAS_TROZO - 500).fill(0.1))
    assert.strictEqual(creadas[0].recibido.length, 1, 'al completarse, se envía')
    assert.strictEqual(creadas[0].recibido[0].length, MUESTRAS_TROZO * 2)
  })

  test('al parar manda el resto, que puede ser el final de una frase', async () => {
    const { t, creadas } = montar()
    await t.start()
    t.alimentar(new Float32Array(700).fill(0.2))
    await t.stop()
    assert.strictEqual(creadas[0].recibido.length, 1,
      'perder el resto es perder justo lo que alguien acaba de decir')
  })
})

describe('el relevo de sesión — el riesgo nº 1', () => {
  test('la sucesora se abre por adelantado pero NO oye nada', async () => {
    // Éste es el arreglo del segundo fallo medido: si la sucesora recibe audio
    // desde que abre, oye media frase y emite ese fragmento.
    const { t, creadas } = montar()
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))

    assert.strictEqual(creadas.length, 2, 'debe haber preparado la sucesora')
    t.alimentar(trozo())
    assert.strictEqual(creadas[1].recibeAudio, false, 'la sucesora debe estar muda')
    assert.strictEqual(creadas[1].recibido.length, 0, 'y no haber recibido audio')
    assert.ok(creadas[0].recibido.length >= 2, 'la activa sí sigue recibiendo')
  })

  test('NO releva mientras alguien habla', async () => {
    // El primer fallo medido: relevar a mitad de frase truncaba la frase, y la
    // pérdida crecía en cada rotación.
    const { t, creadas } = montar()
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))

    creadas[0].habla()
    assert.strictEqual(t._activa.id, 1, 'relevar hablando parte la frase por la mitad')
  })

  test('releva en el primer silencio de verdad', async () => {
    const { t, creadas } = montar()
    const rotaciones = []
    t.on('rotacion', r => rotaciones.push(r))
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))

    creadas[0].habla()
    creadas[0].calla()

    assert.strictEqual(t._activa.id, 2, 'debe haber relevado')
    assert.strictEqual(creadas[1].recibeAudio, true, 'la nueva activa ya oye')
    assert.deepStrictEqual(rotaciones.map(r => r.motivo), ['silencio'])
  })

  test('sigue la bandera de voz en las DOS direcciones', async () => {
    // El bug exacto de la primera prueba: encender la bandera en ACTIVITY_END
    // y no apagarla en ACTIVITY_START la deja encendida de un silencio viejo,
    // y entonces el relevo cae a mitad de la frase siguiente.
    const { t, creadas } = montar()
    await t.start()
    creadas[0].calla()                         // silencio temprano
    creadas[0].habla()                         // y ahora vuelve a hablar
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))

    creadas[0].habla()                         // sigue hablando
    assert.strictEqual(t._activa.id, 1,
      'un silencio anterior no puede autorizar un relevo durante la frase de ahora')
  })

  test('si no llega ningún silencio, releva por el tope duro', async () => {
    // Mejor una costura pequeña que dejar que el servidor cierre por su cuenta
    // y se pierda la frase en curso.
    const { t, creadas } = montar()
    const rotaciones = []
    t.on('rotacion', r => rotaciones.push(r))
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))

    creadas[0].edadMs = _internos.RELEVO_FORZOSO_MS + 1
    creadas[0].habla()                         // hablando, sin silencio

    assert.strictEqual(t._activa.id, 2, 'pasado el tope duro hay que relevar igual')
    assert.match(rotaciones[0].motivo, /tope de sesión/)
  })

  test('la sesión vieja se cierra, pero no de inmediato', async () => {
    // Si quedaba un texto final en vuelo, cerrar en el acto lo perdería.
    const { t, creadas } = montar()
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))
    creadas[0].calla()

    assert.strictEqual(creadas[0].cerrada, false, 'no puede cerrarse en el mismo instante')
    await new Promise(r => setTimeout(r, 1200))
    assert.strictEqual(creadas[0].cerrada, true, 'pero sí poco después')
  })
})

describe('el aviso de cierre del servidor manda sobre nuestro reloj', () => {
  // Medido: el servidor cerró a los 9,84 min con código 1008 y el motivo
  // «failed to close the connection after receiving a GoAway signal». O sea que
  // avisa antes. Ese aviso es mejor dato que nuestra constante: si el tope
  // cambia, goAway lo refleja y la constante no.

  test('convierte las duraciones del protocolo', () => {
    assert.strictEqual(_internos.duracionAMs('540s'), 540000)
    assert.strictEqual(_internos.duracionAMs('1.5s'), 1500)
    assert.strictEqual(_internos.duracionAMs('basura'), null)
  })

  test('con el aviso, prepara la sucesora sin esperar al reloj', async () => {
    const { t, creadas } = montar()
    await t.start()
    assert.strictEqual(creadas.length, 1)

    creadas[0].anunciaCierre(60000)             // aún queda un minuto
    await new Promise(r => setTimeout(r, 20))
    assert.strictEqual(creadas.length, 2,
      'el aviso debe disparar la preparación aunque la sesión sea joven')
    assert.strictEqual(creadas[1].recibeAudio, false, 'y seguir muda hasta el relevo')
  })

  test('con tiempo de sobra, sigue esperando el silencio', async () => {
    const { t, creadas } = montar()
    await t.start()
    creadas[0].anunciaCierre(60000)
    await new Promise(r => setTimeout(r, 20))
    creadas[0].habla()
    assert.strictEqual(t._activa.id, 1,
      'queda un minuto: no hay prisa por cortar la frase')
  })

  test('si el cierre es inminente, releva aunque esté hablando', async () => {
    const { t, creadas } = montar()
    const rotaciones = []
    t.on('rotacion', r => rotaciones.push(r))
    await t.start()
    creadas[0].anunciaCierre(_internos.MARGEN_GOAWAY_MS - 5000)
    await new Promise(r => setTimeout(r, 20))
    creadas[0].habla()

    assert.strictEqual(t._activa.id, 2,
      'perder media frase es mejor que dejar que el servidor corte y perderla entera')
    assert.match(rotaciones[0].motivo, /el servidor anunció el cierre/)
  })

  test('un aviso sin tiempo legible no se ignora', async () => {
    // Si el campo viniera raro, tratarlo como "queda el margen justo" es lo
    // seguro: preparar el relevo. Ignorarlo dejaría que el servidor cortara.
    const { t, creadas } = montar()
    await t.start()
    creadas[0].anunciaCierre(null)
    await new Promise(r => setTimeout(r, 20))
    assert.strictEqual(creadas.length, 2, 'debe preparar la sucesora igual')
  })

  test('el aviso de una sesión que ya no es la activa se ignora', async () => {
    const { t, creadas } = montar()
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))
    creadas[0].calla()                          // relevo a la 2

    const antes = t._activa.id
    creadas[0].anunciaCierre(1000)              // la vieja avisa, ya da igual
    creadas[0].habla()
    assert.strictEqual(t._activa.id, antes, 'la sesión relevada ya no decide nada')
  })
})

describe('nada de duplicados en la costura', () => {
  test('sólo cuenta el texto de la sesión activa', async () => {
    // Durante el solape las dos sesiones oirían lo mismo. Medido sin este
    // filtro: catorce transcripciones para doce frases.
    const { t, creadas } = montar()
    const frases = []
    t.on('frase', f => frases.push(f.texto))
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))

    creadas[1].diceFinal('fragmento de la sucesora')   // todavía no es la activa
    creadas[0].diceFinal('frase buena')

    assert.deepStrictEqual(frases, ['frase buena'])
  })

  test('tras el relevo, cuenta la nueva y no la vieja', async () => {
    const { t, creadas } = montar()
    const frases = []
    t.on('frase', f => frases.push(f.texto))
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))
    creadas[0].calla()

    creadas[0].diceFinal('eco de la vieja')
    creadas[1].diceFinal('frase nueva')

    assert.deepStrictEqual(frases, ['frase nueva'])
  })

  test('los parciales también se filtran por sesión activa', async () => {
    const { t, creadas } = montar()
    const parciales = []
    t.on('parcial', p => parciales.push(p.texto))
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))

    creadas[1].dicePartial('parcial de la sucesora')
    creadas[0].dicePartial('parcial bueno')
    assert.deepStrictEqual(parciales, ['parcial bueno'])
  })

  test('un texto final vacío no produce burbuja', async () => {
    const { t, creadas } = montar()
    const frases = []
    t.on('frase', f => frases.push(f.texto))
    await t.start()
    creadas[0].diceFinal('   ')
    creadas[0].diceFinal('')
    assert.deepStrictEqual(frases, [])
  })
})

describe('caída de red: se retrasa el audio, no se pierde', () => {
  test('sin socket, el audio se guarda y se manda al reconectar', async () => {
    const { t, creadas } = montar()
    await t.start()
    creadas[0].lista = false            // como si el socket se hubiera ido
    t.alimentar(trozo()); t.alimentar(trozo()); t.alimentar(trozo())
    assert.strictEqual(creadas[0].recibido.length, 0)
    assert.strictEqual(t._pendiente.length, 3, 'debe haberlo guardado')

    // El vigilante tarda SIN_ENVIAR_MS en dispararse, y hace falta un
    // `alimentar` más para que lo compruebe: el audio de una reunión llega sin
    // parar, así que eso ocurre solo.
    await new Promise(r => setTimeout(r, _internos.SIN_ENVIAR_MS + 100))
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 900))
    const activa = t._activa
    assert.ok(activa.recibido.length >= 3,
      `la sesión nueva debe recibir lo guardado, recibió ${activa.recibido.length}`)
    assert.strictEqual(t._pendiente.length, 0)
  })

  test('el buffer no crece sin límite, y la pérdida se DICE', async () => {
    // Sin tope, una caída larga de red se come la memoria en el minuto 50. Y
    // callar el hueco sería peor: el usuario tiene derecho a saber que a su
    // transcripción le faltan segundos.
    const { t, creadas } = montar()
    const errores = []
    t.on('error', e => errores.push(e.message))
    await t.start()
    creadas[0].lista = false

    const trozosDemas = _internos.MAX_BUFFER_S * 10 + 50
    for (let i = 0; i < trozosDemas; i++) t.alimentar(trozo())
    assert.ok(t._pendiente.length <= _internos.MAX_BUFFER_S * 10,
      `guardó ${t._pendiente.length} trozos: el tope no se respeta`)

    await new Promise(r => setTimeout(r, _internos.SIN_ENVIAR_MS + 100))
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 900))
    assert.ok(errores.some(m => /se perdieron .* de audio|se está perdiendo audio/.test(m)),
      `debe avisar del hueco; errores: ${JSON.stringify(errores)}`)
  })

  test('reconecta con esperas crecientes y avisa del estado', async () => {
    const { t, creadas } = montar()
    const estados = []
    t.on('estado', e => estados.push(e))
    await t.start()
    creadas[0].seCae()
    await new Promise(r => setTimeout(r, 700))

    assert.ok(estados.includes('reconectando'), `estados: ${estados}`)
    assert.strictEqual(estados[estados.length - 1], 'escuchando')
    assert.strictEqual(t.stats.reconexiones, 1)
  })

  test('el cierre de una sesión que ya no es la activa se ignora', async () => {
    // Al relevar, la vieja se cierra a propósito. Tratarlo como caída
    // dispararía una reconexión falsa en cada rotación: seis por reunión.
    const { t, creadas } = montar()
    const estados = []
    await t.start()
    creadas[0].edadMs = _internos.ABRIR_SUCESORA_MS + 1
    t.alimentar(trozo())
    await new Promise(r => setTimeout(r, 20))
    creadas[0].calla()
    t.on('estado', e => estados.push(e))

    creadas[0].seCae(1000)
    await new Promise(r => setTimeout(r, 300))
    assert.ok(!estados.includes('reconectando'),
      'cerrar la sesión relevada no es una caída')
    assert.strictEqual(t.stats.reconexiones, 0)
  })
})

describe('contabilidad', () => {
  test('cuenta frases, rotaciones y segundos de audio', async () => {
    const { t, creadas } = montar()
    await t.start()
    t.alimentar(new Float32Array(SAMPLE_RATE_PRUEBA).fill(0.1))
    creadas[0].diceFinal('una')
    creadas[0].diceFinal('dos')
    assert.strictEqual(t.stats.frases, 2)
    assert.ok(Math.abs(t.stats.segundosAudio - 1) < 0.01,
      `contó ${t.stats.segundosAudio} s para 1 s de audio`)
  })

  test('sin API key ni fábrica, se niega a construirse', () => {
    assert.throws(() => new GeminiLiveTranscriber({}), /API key/)
  })
})

const SAMPLE_RATE_PRUEBA = 16000
