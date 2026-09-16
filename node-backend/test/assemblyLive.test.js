/**
 * Pruebas del transcriptor de AssemblyAI.
 *
 * Lo que más importa aquí no es la transcripción —eso lo hace su servidor—
 * sino **la disciplina de sesión**, porque descuidarla cuesta dinero y deja al
 * cliente sin servicio:
 *
 *  · AssemblyAI factura por tiempo de socket abierto, no por audio enviado.
 *  · Una sesión que no se cierra con `Terminate` vive 3 horas y **se facturan
 *    las 3 horas completas**.
 *  · Y mientras vive ocupa una de las cinco plazas de concurrencia, así que
 *    una sesión huérfana **impide la siguiente reunión**.
 *
 * Está medido: una prueba abrió veinte conexiones en diez segundos sin mandar
 * `Terminate` y el servidor empezó a devolver «Too many concurrent sessions».
 *
 * Todo corre sin red, con un socket falso.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')

const { AssemblyLiveTranscriber, _internos } = require('../src/assemblyLive')
const { aPcm16, construirUrl, MUESTRAS_TROZO, MS_TROZO, MAX_CONEXIONES_MIN } = _internos

/** Socket de mentira: registra todo lo enviado y deja provocar los mensajes. */
class SocketFalso extends EventEmitter {
  constructor (url, clave) {
    super()
    this.url = url
    this.clave = clave
    this.readyState = 0
    this.binarios = []
    this.textos = []
    this.cerrado = false
    // Abre en el siguiente tic, como haría uno de verdad.
    setImmediate(() => { this.readyState = 1; this.emit('open') })
  }

  send (d) {
    if (typeof d !== 'string') { this.binarios.push(d); return }
    const m = JSON.parse(d)
    this.textos.push(m)
    // Un servidor de verdad acusa el Terminate con un Termination, y medido
    // tarda 1.067-1.224 ms. Sin esto, el cierre esperaría su plazo completo en
    // cada prueba y además no se ejercitaría el camino real.
    if (m.type === 'Terminate') {
      setTimeout(() => this.recibe({
        type: 'Termination', audio_duration_seconds: 0, session_duration_seconds: 0,
      }), 10)
    }
  }

  close () { this.cerrado = true; this.readyState = 3; this.emit('close', 1000, '') }

  // Atajos para guiar la prueba.
  recibe (obj) { this.emit('message', Buffer.from(JSON.stringify(obj))) }
  parcial (t) { this.recibe({ type: 'Turn', end_of_turn: false, transcript: t }) }
  final (t, orden = 0) { this.recibe({ type: 'Turn', end_of_turn: true, transcript: t, turn_order: orden }) }
  seCae (codigo = 1006) { this.readyState = 3; this.emit('close', codigo, 'caída') }
}

function montar (opts = {}) {
  const sockets = []
  const t = new AssemblyLiveTranscriber({
    apiKey: 'de-prueba',
    crearSocket: (url, clave) => { const s = new SocketFalso(url, clave); sockets.push(s); return s },
    ...opts,
  })
  return { t, sockets }
}

const trozo = (v = 0.4) => new Float32Array(MUESTRAS_TROZO).fill(v)
const esperar = ms => new Promise(r => setTimeout(r, ms))

describe('la URL lleva lo que el modelo necesita', () => {
  test('modelo, formato y frecuencia, como exige el protocolo', () => {
    const u = new URL(construirUrl({ idioma: 'it' }))
    assert.strictEqual(u.searchParams.get('speech_model'), 'universal-3-5-pro')
    assert.strictEqual(u.searchParams.get('encoding'), 'pcm_s16le')
    assert.strictEqual(u.searchParams.get('sample_rate'), '16000')
    assert.strictEqual(u.searchParams.get('language_code'), 'it')
  })

  test('sin idioma fijo, el modelo puede alternar entre idiomas', () => {
    // Útil si el cliente mete términos ingleses dentro de frases italianas,
    // que en una reunión sobre un ERP pasa constantemente.
    const u = new URL(construirUrl({ idioma: null }))
    assert.strictEqual(u.searchParams.get('language_code'), null)
  })

  test('el glosario del proyecto viaja como términos clave', () => {
    const u = new URL(construirUrl({ idioma: 'it', glosario: ['Rossi Logistica', 'SAP', 'WMS'] }))
    assert.deepStrictEqual(JSON.parse(u.searchParams.get('keyterms_prompt')),
      ['Rossi Logistica', 'SAP', 'WMS'])
  })

  test('el glosario se recorta a 100, que es el tope del servicio', () => {
    const muchos = Array.from({ length: 150 }, (_, i) => `termino${i}`)
    const u = new URL(construirUrl({ glosario: muchos }))
    assert.strictEqual(JSON.parse(u.searchParams.get('keyterms_prompt')).length, 100)
  })

  test('los términos vacíos no ocupan plaza', () => {
    const u = new URL(construirUrl({ glosario: ['SAP', '  ', '', 'ERP'] }))
    assert.deepStrictEqual(JSON.parse(u.searchParams.get('keyterms_prompt')), ['SAP', 'ERP'])
  })

  test('el contexto de la reunión se recorta a 1500 caracteres', () => {
    const u = new URL(construirUrl({ contexto: 'x'.repeat(4000) }))
    assert.strictEqual(u.searchParams.get('prompt').length, 1500)
  })

  test('sin glosario ni contexto no se mandan parámetros vacíos', () => {
    const u = new URL(construirUrl({ idioma: 'it', glosario: [], contexto: '' }))
    assert.strictEqual(u.searchParams.get('keyterms_prompt'), null)
    assert.strictEqual(u.searchParams.get('prompt'), null)
  })
})

describe('conversión y troceado del audio', () => {
  test('PCM16 little-endian, con recorte de picos', () => {
    const b = aPcm16([0, 1, -1, 2, -2])
    assert.strictEqual(b.readInt16LE(2), 32767)
    assert.strictEqual(b.readInt16LE(6), 32767, 'un pico por encima de 1 no puede desbordar')
    assert.strictEqual(b.readInt16LE(8), -32767)
  })

  test('los trozos son de 100 ms, dentro del rango que acepta el servidor', () => {
    // Fuera de 50-1000 ms el servidor cierra con 3007.
    const ms = MUESTRAS_TROZO / 16000 * 1000
    assert.ok(ms >= _internos.MS_TROZO_MIN && ms <= _internos.MS_TROZO_MAX,
      `${ms} ms está fuera del rango permitido`)
  })

  test('se envían frames binarios, nunca JSON', async () => {
    // El audio va en binario; mandarlo como JSON es un error silencioso.
    const { t, sockets } = montar()
    await t.start()
    t.alimentar(trozo())
    assert.strictEqual(sockets[0].binarios.length, 1)
    assert.ok(Buffer.isBuffer(sockets[0].binarios[0]))
    await t.stop()
  })

  test('acumula hasta completar un trozo', async () => {
    const { t, sockets } = montar()
    await t.start()
    t.alimentar(new Float32Array(600).fill(0.2))
    assert.strictEqual(sockets[0].binarios.length, 0, 'medio trozo no se manda')
    t.alimentar(new Float32Array(MUESTRAS_TROZO - 600).fill(0.2))
    assert.strictEqual(sockets[0].binarios.length, 1)
    await t.stop()
  })
})

describe('frases y parciales', () => {
  test('distingue el parcial del texto definitivo', async () => {
    const { t, sockets } = montar()
    const parciales = [], frases = []
    t.on('parcial', p => parciales.push(p.texto))
    t.on('frase', f => frases.push(f.texto))
    await t.start()

    sockets[0].parcial('Buongiorno a')
    sockets[0].parcial('Buongiorno a tutti')
    sockets[0].final('Buongiorno a tutti, iniziamo la riunione.')

    assert.deepStrictEqual(parciales, ['Buongiorno a', 'Buongiorno a tutti'])
    assert.deepStrictEqual(frases, ['Buongiorno a tutti, iniziamo la riunione.'])
    assert.strictEqual(t.stats.frases, 1)
    await t.stop()
  })

  test('un texto vacío no produce burbuja', async () => {
    const { t, sockets } = montar()
    const frases = []
    t.on('frase', f => frases.push(f.texto))
    await t.start()
    sockets[0].final('   ')
    sockets[0].parcial('')
    assert.deepStrictEqual(frases, [])
    await t.stop()
  })

  test('un mensaje de error del servidor llega como error, no se traga', async () => {
    const { t, sockets } = montar()
    const errores = []
    t.on('error', e => errores.push(e.message))
    await t.start()
    sockets[0].recibe({ type: 'Error', error: 'Unauthorized Connection: Too many concurrent sessions' })
    assert.match(errores[0], /Too many concurrent sessions/)
    await t.stop()
  })
})

describe('la disciplina de sesión — lo que cuesta dinero si se olvida', () => {
  test('al parar se manda Terminate ANTES de cerrar', async () => {
    // Cerrar sin Terminate deja la sesión viva hasta 3 horas, facturando, y
    // ocupando una de las cinco plazas de concurrencia.
    const { t, sockets } = montar()
    await t.start()
    await t.stop()
    const s = sockets[0]
    assert.deepStrictEqual(s.textos, [{ type: 'Terminate' }], 'falta el Terminate')
    assert.strictEqual(s.cerrado, true)
  })

  test('el resto de audio se manda antes de terminar', async () => {
    // Puede ser el final de la última frase, justo lo que alguien acaba de decir.
    const { t, sockets } = montar()
    await t.start()
    t.alimentar(new Float32Array(800).fill(0.3))
    await t.stop()
    assert.strictEqual(sockets[0].binarios.length, 1)
  })

  test('nunca hay dos sesiones vivas a la vez', async () => {
    // El diseño de relevo solapado que se hizo para Gemini quemaría aquí el
    // límite de concurrencia: con sesiones de 3 horas no hace falta.
    const { t, sockets } = montar()
    await t.start()
    t.alimentar(trozo())
    const vivas = sockets.filter(s => s.readyState === 1 && !s.cerrado)
    assert.strictEqual(vivas.length, 1, `hay ${vivas.length} sesiones abiertas`)
    await t.stop()
  })

  test('registra la duración facturada que informa el servidor', async () => {
    const { t, sockets } = montar()
    await t.start()
    sockets[0].recibe({ type: 'Termination', audio_duration_seconds: 6, session_duration_seconds: 7 })
    assert.strictEqual(t.stats.segundosSesion, 7)
    assert.ok(t.costeAproximadoUsd(0.45) > 0, 'debe poder decir cuánto lleva gastado')
    await t.stop()
  })

  test('el coste se calcula sobre el tiempo de SESIÓN, no de audio', async () => {
    // Es la diferencia que sorprende a todo el mundo: los silencios cuentan.
    const { t, sockets } = montar()
    await t.start()
    sockets[0].recibe({ type: 'Termination', audio_duration_seconds: 10, session_duration_seconds: 3600 })
    await t.stop()
    assert.strictEqual(t.costeAproximadoUsd(0.45), 0.45, 'una hora de socket es una hora facturada')
  })
})

describe('freno al ritmo de conexiones', () => {
  test('no abre más de las permitidas por minuto', async () => {
    // El plan gratuito da 5 conexiones nuevas por minuto y 5 concurrentes. Sin
    // freno, una racha de reconexiones deja al usuario sin servicio justo
    // cuando más lo necesita.
    const { t } = montar()
    await t.start()
    for (let i = 1; i < MAX_CONEXIONES_MIN; i++) t._conexiones.push(Date.now())
    assert.ok(t._esperaPorRitmo() > 0, 'al llegar al tope debe hacer esperar')
    t._conexiones = []
    assert.strictEqual(t._esperaPorRitmo(), 0, 'con la ventana limpia, no espera')
    await t.stop()
  })

  test('olvida las conexiones de hace más de un minuto', async () => {
    const { t } = montar()
    await t.start()
    t._conexiones = Array.from({ length: 10 }, () => Date.now() - 61000)
    assert.strictEqual(t._esperaPorRitmo(), 0, 'la ventana es móvil, de 60 s')
    await t.stop()
  })
})

describe('caída de red', () => {
  test('reconecta y avisa del estado', async () => {
    const { t, sockets } = montar()
    const estados = []
    t.on('estado', e => estados.push(e))
    t.on('error', () => {})
    await t.start()
    sockets[0].seCae(1006)
    await esperar(2200)

    assert.ok(estados.includes('reconectando'), `estados: ${estados}`)
    assert.strictEqual(estados[estados.length - 1], 'escuchando')
    assert.strictEqual(t.stats.reconexiones, 1)
    await t.stop()
  })

  test('explica el código de cierre en vez de soltar un número', async () => {
    const { t, sockets } = montar()
    const errores = []
    t.on('error', e => errores.push(e.message))
    await t.start()
    sockets[0].seCae(3008)
    await esperar(200)
    assert.match(errores[0], /tope de 3 horas/, `errores: ${errores}`)
    t._corriendo = false
  })

  test('sin conexión guarda el audio, no lo tira', async () => {
    const { t, sockets } = montar()
    t.on('error', () => {})
    await t.start()
    sockets[0].readyState = 3
    t.alimentar(trozo()); t.alimentar(trozo())
    assert.strictEqual(t._pendiente.length, 2)
    await t.stop()
  })

  test('lo guardado se vuelca al RITMO del audio, no de golpe', async () => {
    // Volcarlo de golpe hace que el servidor cierre con 3007 por recibir audio
    // más rápido que el tiempo real. Es un fallo que sólo aparece justo
    // después de una reconexión, o sea en el peor momento.
    const { t, sockets } = montar()
    t.on('error', () => {})
    await t.start()
    sockets[0].readyState = 3
    for (let i = 0; i < 5; i++) t.alimentar(trozo())

    sockets[0].readyState = 1
    t._ws = sockets[0]
    t._vaciarPendiente()
    await esperar(MS_TROZO * 1.5)
    assert.ok(sockets[0].binarios.length < 5,
      `mandó ${sockets[0].binarios.length} trozos de golpe: el servidor cerraría con 3007`)
    await esperar(MS_TROZO * 5)
    assert.strictEqual(sockets[0].binarios.length, 5, 'pero acaba mandándolos todos')
    t._corriendo = false
  })

  test('el buffer tiene tope y la pérdida se dice', async () => {
    const { t, sockets } = montar()
    const errores = []
    t.on('error', e => errores.push(e.message))
    await t.start()
    sockets[0].readyState = 3
    for (let i = 0; i < _internos.MAX_BUFFER_S * 10 + 30; i++) t.alimentar(trozo())

    assert.ok(t._pendiente.length <= _internos.MAX_BUFFER_S * 10)
    assert.ok(errores.some(m => /perdiendo audio/.test(m)),
      `debe avisar mientras ocurre; errores: ${JSON.stringify(errores)}`)
    t._corriendo = false
  })
})

describe('troceo de monólogos — que la pantalla no se quede en blanco', () => {
  // Medido en la primera prueba real (21 frases, 3,1 min): el hueco entre
  // frases fue 4,8 s de mediana, pero dos veces llegó a 33,6 s y a 65,6 s,
  // porque AssemblyAI cierra el turno por SILENCIO y quien narra sin pausas no
  // calla nunca. Una traductora en vivo que se queda un minuto en blanco no
  // sirve: cuando por fin escribe, la conversación ya pasó.

  test('un turno que se pasa del tope se corta con ForceEndpoint', async () => {
    const { t, sockets } = montar({ topeTurnoMs: 200 })
    const troceos = []
    t.on('troceo', x => troceos.push(x))
    await t.start()
    const s = sockets[0]

    t.alimentar(trozo())
    s.parcial('Perché se non riesce')
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [], 'un turno recién abierto no se toca')

    await esperar(260)
    s.parcial('Perché se non riesce ad aprire')   // el texto crece: sigue hablando
    t.alimentar(trozo())

    assert.deepStrictEqual(s.textos, [{ type: 'ForceEndpoint' }])
    assert.strictEqual(t.stats.turnosForzados, 1)
    assert.ok(troceos[0].msAbierto >= 200, `abierto ${troceos[0].msAbierto} ms`)

    // Y la frase que sale de un turno cortado lo dice, porque puede venir
    // partida y hay que poder contarlas en la reunión real.
    const frases = []
    t.on('frase', f => frases.push(f))
    s.final('Perché se non riesce ad aprire devo chiamare i pompieri')
    assert.strictEqual(frases[0].forzado, true)
    await t.stop()
  })

  test('NO se corta el turno que ya iba a cerrarse solo por silencio', async () => {
    // El servidor cierra el turno 201-257 ms después del silencio [medido].
    // Si el texto lleva más de ese rato sin crecer, el definitivo ya viene de
    // camino: forzar ahí no adelanta nada y parte la frase por gusto.
    const { t, sockets } = montar({ topeTurnoMs: 200, margenSilencioMs: 100 })
    await t.start()
    const s = sockets[0]

    t.alimentar(trozo())
    s.parcial('E la porta si è aperta')
    await esperar(300)
    t.alimentar(trozo())

    assert.deepStrictEqual(s.textos, [], 'el hablante ya había callado')
    assert.strictEqual(t.stats.turnosForzados, 0)

    // Y la contraprueba, para que esto no pase por no funcionar nunca: con el
    // MISMO turno pasado de tope, en cuanto el texto vuelve a crecer sí corta.
    s.parcial('E la porta si è aperta, finalmente')
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [{ type: 'ForceEndpoint' }])
    await t.stop()
  })

  test('un parcial repetido no cuenta como señal de que se sigue hablando', async () => {
    // El servidor puede reenviar el mismo parcial mientras nadie habla. Si eso
    // contara como vida, el vigilante trocearía silencios.
    const { t, sockets } = montar({ topeTurnoMs: 200, margenSilencioMs: 150 })
    await t.start()
    const s = sockets[0]

    t.alimentar(trozo())
    s.parcial('Allora')
    await esperar(250)
    s.parcial('Allora')                 // el mismo texto: nada nuevo se ha dicho
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [], 'se troceó un silencio')

    s.parcial('Allora io mi son detta') // ahora sí crece
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [{ type: 'ForceEndpoint' }])
    await t.stop()
  })

  test('sin turno abierto no se fuerza nada', async () => {
    const { t, sockets } = montar({ topeTurnoMs: 100 })
    await t.start()
    const s = sockets[0]

    t.alimentar(trozo())
    s.parcial('Brava')
    s.final('Brava!')
    await esperar(250)
    t.alimentar(trozo())

    assert.deepStrictEqual(s.textos, [], 'el turno ya estaba cerrado')
    await t.stop()
  })

  test('un fin de turno SIN TEXTO también suelta el turno', async () => {
    // El camino del texto vacío es el único que no pasa por ninguna otra
    // prueba, y es el que sostiene el orden de `this._turno = null` antes del
    // `if (!texto) return`. Si se invierten esas dos líneas, el turno muerto
    // sigue contando: el siguiente se corta al nacer y además hereda
    // `ultimoIntentoEn`, o sea que saldría marcado `forzado: true` sin que
    // nadie lo haya cortado — contaminando justo el dato con el que vamos a
    // contar, en la próxima reunión real, cuántas frases parte el troceo.
    const { t, sockets } = montar({ topeTurnoMs: 300, margenSilencioMs: 1000 })
    const frases = []
    t.on('frase', f => frases.push(f))
    await t.start()
    const s = sockets[0]

    t.alimentar(trozo())
    s.parcial('Allora io mi son detta')
    await esperar(350)
    s.final('   ')                    // llega el fin de turno, pero sin texto
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [], 'se cortó un turno que ya estaba cerrado')

    // Y el siguiente turno empieza limpio: ni reloj heredado ni marca heredada.
    s.parcial('E la porta')
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [], 'el turno nuevo apenas lleva unos ms')
    s.final('E la porta si è aperta.')
    assert.strictEqual(frases.length, 1, 'el final vacío no produce burbuja')
    assert.strictEqual(frases[0].forzado, false,
      'una frase que nadie cortó no puede salir marcada como troceada')
    await t.stop()
  })

  test('el reloj del turno empieza de cero en cada turno', async () => {
    // Si el reloj se arrastrara de un turno al siguiente, el segundo se
    // cortaría nada más empezar y las frases saldrían partidas en dos.
    const { t, sockets } = montar({ topeTurnoMs: 200, margenSilencioMs: 1000 })
    await t.start()
    const s = sockets[0]

    t.alimentar(trozo())
    s.parcial('Allora io mi son detta')
    await esperar(150)
    s.final('Allora io mi son detta, cosa facciamo?')
    s.parcial('Perché se non riesce')       // turno nuevo
    await esperar(100)
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [], 'el turno nuevo sólo lleva 100 ms')

    await esperar(150)
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [{ type: 'ForceEndpoint' }])
    await t.stop()
  })

  test('si el servidor ignora el corte, se vuelve a pedir', async () => {
    // Sin reintento, un ForceEndpoint perdido devuelve la pantalla en blanco
    // de 66 s y nadie se entera de por qué.
    const { t, sockets } = montar({ topeTurnoMs: 200, margenSilencioMs: 1000 })
    await t.start()
    const s = sockets[0]

    t.alimentar(trozo())
    s.parcial('uno')
    await esperar(260)
    t.alimentar(trozo())
    assert.strictEqual(s.textos.length, 1, 'primer intento')

    t.alimentar(trozo())
    assert.strictEqual(s.textos.length, 1, 'no se repite diez veces por segundo')

    await esperar(260)
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [{ type: 'ForceEndpoint' }, { type: 'ForceEndpoint' }])
    await t.stop()
  })

  test('cortar el turno NO recorta el audio', async () => {
    // El tope es del turno, no del micrófono: si el audio se cortara, se
    // perdería justo lo que el hablante dice en el corte.
    const { t, sockets } = montar({ topeTurnoMs: 200 })
    await t.start()
    const s = sockets[0]

    t.alimentar(trozo())
    s.parcial('uno')
    await esperar(260)
    s.parcial('uno due')
    for (let i = 0; i < 4; i++) t.alimentar(trozo())

    assert.strictEqual(s.textos.length, 1, 'se cortó el turno')
    assert.strictEqual(s.binarios.length, 5, 'los cinco trozos de audio salieron igual')
    await t.stop()
  })

  test('con el tope apagado no se trocea nunca', async () => {
    const { t, sockets } = montar({ topeTurnoMs: 0 })
    await t.start()
    const s = sockets[0]
    t.alimentar(trozo())
    s.parcial('uno')
    await esperar(300)
    s.parcial('uno due')
    t.alimentar(trozo())
    assert.deepStrictEqual(s.textos, [])
    assert.strictEqual(t.stats.turnosForzados, 0)
    await t.stop()
  })

  test('el tope por defecto es de 8 s', () => {
    // Elegido sobre la sesión real: p50 del hueco 4,8 s y p75 9,1 s, así que
    // deja en paz los turnos normales; y con el primer parcial (881-980 ms
    // [medido]) y el cierre (201-257 ms [medido]) la pantalla en blanco se
    // queda por debajo de 10 s.
    assert.strictEqual(_internos.TOPE_TURNO_MS, 8000)
    const { t } = montar()
    assert.strictEqual(t._topeTurnoMs, 8000)
  })
})

describe('el retardo de OÍR, sellado en la frase', () => {
  // Antes el cronómetro arrancaba cuando el texto YA había llegado, así que el
  // número que el usuario leía como «retardo» era sólo la traducción y
  // subestimaba lo que se percibe, que es la dirección peligrosa.

  test('la frase dice cuánto se tardó en oírla, medido desde el audio', async () => {
    // Aquí el audio NO se para mientras se espera el texto, porque en la
    // reunión tampoco se para: el audio del sistema sigue entrando a diez
    // bloques por segundo, también durante el silencio. Si el sello se tomara
    // del último trozo enviado, mediría siempre ~100 ms y diría que oír es
    // gratis; hay que medir desde el último audio que LLEGÓ al texto.
    const { t, sockets } = montar()
    const frases = []
    t.on('frase', f => frases.push(f))
    await t.start()

    t.alimentar(trozo())
    sockets[0].parcial('Avevo la febbre')        // este audio sí llegó al texto
    const t0 = Date.now()
    while (Date.now() - t0 < 250) { t.alimentar(trozo(0)); await esperar(10) }
    const esperado = Date.now() - t0
    sockets[0].final('Avevo la febbre a 39, stavo proprio male.')

    assert.strictEqual(frases.length, 1)
    assert.strictEqual(frases[0].forzado, false, 'este turno se cerró solo')
    assert.ok(frases[0].msTranscribir >= esperado - 30,
      `midió ${frases[0].msTranscribir} ms cuando se esperó ${esperado}`)
    assert.ok(frases[0].msTranscribir < esperado + 300,
      `midió de más: ${frases[0].msTranscribir} ms de ${esperado}`)
    await t.stop()
  })

  test('el sello no se hereda del turno anterior', async () => {
    // Si se heredara, la segunda frase cargaría con la espera de la primera y
    // el retardo que se enseña sería el de otra cosa.
    const { t, sockets } = montar()
    const frases = []
    t.on('frase', f => frases.push(f))
    await t.start()

    const correrAudio = async ms => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) { t.alimentar(trozo(0)); await esperar(10) }
      return Date.now() - t0
    }

    t.alimentar(trozo())
    sockets[0].parcial('Avevo la febbre')
    await correrAudio(300)
    sockets[0].final('Avevo la febbre a 39.')

    t.alimentar(trozo())
    sockets[0].parcial('E la porta')
    const segundaEspera = await correrAudio(70)
    sockets[0].final('E la porta si è aperta.')

    assert.ok(frases[1].msTranscribir < 250,
      `la segunda frase heredó ${frases[1].msTranscribir} ms de la primera`)
    assert.ok(frases[1].msTranscribir >= segundaEspera - 30,
      `no midió su propia espera: ${frases[1].msTranscribir} ms de ${segundaEspera}`)
    await t.stop()
  })

  test('el sello es siempre un número: nunca null', async () => {
    // El .jsonl escribía msTranscribir: null en las 21 frases de la prueba
    // real. Un hueco en el dato es un hueco en la medición.
    const { t, sockets } = montar()
    const frases = []
    t.on('frase', f => frases.push(f))
    await t.start()
    sockets[0].final('Brava!')            // sin audio previo y sin parciales
    assert.strictEqual(typeof frases[0].msTranscribir, 'number')
    assert.ok(Number.isFinite(frases[0].msTranscribir))
    assert.ok(frases[0].msTranscribir >= 0)
    await t.stop()
  })
})

describe('contrato', () => {
  test('sin clave ni socket inyectado, se niega a construirse', () => {
    assert.throws(() => new AssemblyLiveTranscriber({}), /API key/)
  })

  test('la clave viaja en la cabecera, no en la URL', async () => {
    // En la URL acabaría en registros de servidor y de proxy.
    const { t, sockets } = montar()
    await t.start()
    assert.ok(!sockets[0].url.includes('de-prueba'), 'la clave no puede ir en la URL')
    assert.strictEqual(sockets[0].clave, 'de-prueba')
    await t.stop()
  })
})
