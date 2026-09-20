/**
 * Pruebas del motor de preguntas y respuestas sugeridas.
 *
 * Todo corre **sin red**: el LLM entra inyectado por el constructor, así que
 * aquí se ejerce lo único que es nuestro —qué se responde, qué no, qué no se
 * repite y qué pasa cuando el modelo falla— sin gastar una sola llamada.
 *
 * Lo que de verdad muerde, y por qué cada caso está aquí:
 *
 *  · **El triaje.** Una fórmula social se detecta como pregunta pero no puede
 *    gastar una llamada. Sin esta prueba, un cambio en `questionDetector` que
 *    se lleve por delante el triaje multiplica la factura del cliente sin que
 *    nada se vea raro en pantalla.
 *  · **La repetición.** La misma pregunta reformulada llena el panel de ruido
 *    justo cuando el usuario necesita leer una sola cosa.
 *  · **El fallo.** Si el modelo cae y nadie lo dice, la tarjeta se queda en
 *    «Preparando…» el resto de la reunión. Es el fallo que no se ve mirando la
 *    pantalla, porque parece que aún está pensando.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')

const { MotorRespuestas, MotorResumen, MAX_CARACTERES, _internos } = require('../src/respuestas')
const { analizar } = require('../src/questionDetector')

/**
 * LLM de mentira: apunta cada llamada y devuelve lo que se le diga.
 * `respuesta` puede ser un texto, una función o un Error a lanzar.
 */
function llmFalso (respuesta = 'Certo, ci penso io.') {
  const llamadas = []
  const llamar = async (sistema, usuario, opciones) => {
    llamadas.push({ sistema, usuario, opciones })
    const r = typeof respuesta === 'function' ? respuesta(llamadas.length) : respuesta
    if (r instanceof Error) throw r
    return r
  }
  return { llamar, llamadas }
}

/** Espera al próximo evento, con plazo para que un fallo no cuelgue la prueba. */
function esperar (emisor, evento, ms = 1000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no llegó "${evento}" en ${ms} ms`)), ms)
    emisor.once(evento, d => { clearTimeout(t); resolve(d) })
  })
}

/**
 * Pregunta y espera la redacción.
 *
 * El oyente se pone ANTES de llamar a `considerar`, y no es un detalle de la
 * prueba: `considerar` dispara la redacción sin esperarla —la pregunta se
 * pinta antes de que el modelo conteste— así que quien escuche después llega
 * tarde.
 */
async function preguntarYEsperar (m, it, es) {
  const espera = esperar(m, 'respuesta')
  const id = await m.considerar(it, es)
  return { id, respuesta: await espera }
}

/** Deja correr las microtareas pendientes del motor. */
const asentar = () => new Promise(x => setImmediate(x))

/** Recoge todos los eventos de un tipo mientras dura la prueba. */
function recoger (emisor, evento) {
  const vistos = []
  emisor.on(evento, d => vistos.push(d))
  return vistos
}

// ── Criterio 1: el triaje local decide qué merece una llamada ───────────────

describe('el triaje local decide qué merece una llamada al LLM', () => {
  test('una afirmación no llega al LLM', async () => {
    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar })
    const preguntas = recoger(m, 'pregunta')

    const id = await m.considerar('Il cliente ha chiesto di anticipare la consegna', 'El cliente…')

    assert.strictEqual(id, null)
    assert.strictEqual(llamadas.length, 0)
    assert.deepStrictEqual(preguntas, [])
  })

  test('«come stai» SÍ es pregunta, pero no gasta una llamada', async () => {
    // Que el detector la marque es lo que hace esta prueba necesaria: sin
    // triaje, esta frase costaría dinero en cada reunión.
    assert.strictEqual(analizar('Come stai').esPregunta, true)

    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar })

    assert.strictEqual(await m.considerar('Come stai', '¿Cómo estás?'), null)
    assert.strictEqual(llamadas.length, 0)
    assert.strictEqual(m.stats.descartadas, 1)
    assert.strictEqual(m.stats.detectadas, 0)
  })

  test('«mi senti» tampoco: es la pregunta de toda videollamada', async () => {
    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar })
    assert.strictEqual(await m.considerar('Mi senti bene adesso'), null)
    assert.strictEqual(llamadas.length, 0)
  })

  test('un fragmento de dos palabras no se responde', async () => {
    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar })
    assert.strictEqual(await m.considerar('Che dici'), null)
    assert.strictEqual(llamadas.length, 0)
  })

  test('una pregunta de trabajo sí llega, y una sola vez', async () => {
    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar })

    const { id } = await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino', '¿Ya has hablado…?')

    assert.strictEqual(id, 'q1')
    assert.strictEqual(llamadas.length, 1)
    assert.strictEqual(m.stats.respondidas, 1)
  })

  test('una frase vacía no cuenta ni como analizada', async () => {
    const { llamar } = llmFalso()
    const m = new MotorRespuestas({ llamar })
    assert.strictEqual(await m.considerar('   '), null)
    assert.strictEqual(m.stats.analizadas, 0)
  })

  test('sin función de LLM el motor no se construye', () => {
    assert.throws(() => new MotorRespuestas({}), /llamar al LLM/)
  })
})

// ── Criterio 2: no se responde dos veces la misma pregunta ──────────────────

describe('no se responde dos veces la misma pregunta reformulada', () => {
  test('la reformulación no gasta una segunda llamada', async () => {
    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar })
    const preguntas = recoger(m, 'pregunta')

    await preguntarYEsperar(m, "Quanto tempo ci vuole per completare l'integrazione")
    const segunda = await m.considerar("Quanto tempo serve per l'integrazione")

    assert.strictEqual(segunda, null, 'la reformulación no debe abrir otra tarjeta')
    assert.strictEqual(llamadas.length, 1)
    assert.strictEqual(preguntas.length, 1)
    assert.strictEqual(m.stats.descartadas, 1)
  })

  test('dos preguntas distintas sí se responden las dos', async () => {
    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar })

    await preguntarYEsperar(m, "Quanto tempo ci vuole per completare l'integrazione")
    await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino')

    assert.strictEqual(llamadas.length, 2)
    assert.strictEqual(m.stats.detectadas, 2)
  })

  test('dos preguntas de tema distinto no se confunden por empezar igual', () => {
    // El filo del triaje: se comparan sobre la más corta de las dos, que es lo
    // que rescata la reformulación. A partir de cinco palabras el ruido de la
    // apertura se diluye y siguen siendo distintas.
    assert.strictEqual(
      _internos.sonLaMisma('Come funziona il sistema di pagamento', 'Come funziona il modulo di magazzino'),
      false
    )
    assert.strictEqual(
      _internos.sonLaMisma("Quanto tempo ci vuole per completare l'integrazione", "Quanto tempo serve per l'integrazione"),
      true
    )
  })
})

// ── Criterio 3: respuesta en italiano, pregunta también en español ──────────

describe('la respuesta va solo en italiano; la pregunta también en español', () => {
  test('la pregunta se anuncia con su traducción y antes de la respuesta', async () => {
    const { llamar } = llmFalso()
    const m = new MotorRespuestas({ llamar })
    const orden = []
    m.on('pregunta', p => orden.push(['pregunta', p]))
    m.on('respuesta', r => orden.push(['respuesta', r]))

    await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino',
      '¿Ya has hablado con el proveedor del almacén?')

    assert.strictEqual(orden[0][0], 'pregunta', 'la pregunta se pinta antes de que el modelo conteste')
    assert.strictEqual(orden[1][0], 'respuesta')
    assert.strictEqual(orden[0][1].it, 'Hai già parlato con il fornitore del magazzino')
    assert.strictEqual(orden[0][1].es, '¿Ya has hablado con el proveedor del almacén?')
    assert.strictEqual(orden[0][1].motivo, 'verbo-2a')
  })

  test('la respuesta no lleva glosa al español', async () => {
    const { llamar } = llmFalso('Sì, ne ho parlato ieri.')
    const m = new MotorRespuestas({ llamar })

    const { respuesta } = await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino', '¿Ya has hablado…?')

    assert.deepStrictEqual(Object.keys(respuesta).sort(), ['id', 'texto'])
    assert.strictEqual(respuesta.texto, 'Sì, ne ho parlato ieri.')
  })

  test('al modelo se le pide italiano y se le da el contexto del usuario', async () => {
    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar, bloqueContexto: () => 'PERFIL\nOmar Ávila · Responsable técnico' })

    await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino')

    assert.match(llamadas[0].sistema, /ITALIANO/)
    assert.match(llamadas[0].sistema, /Omar Ávila/)
  })

  test('las frases anteriores viajan como contexto, sin repetir la pregunta', async () => {
    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar })

    await m.considerar('Il cliente ha chiesto di anticipare la consegna')
    await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino')

    const { usuario } = llamadas[0]
    assert.match(usuario, /Il cliente ha chiesto di anticipare la consegna/)
    assert.strictEqual(
      usuario.split('Hai già parlato con il fornitore del magazzino').length - 1, 1,
      'la pregunta aparece una vez, no también en la lista de lo anterior'
    )
  })
})

// ── Criterio 4: un fallo del LLM se dice ────────────────────────────────────

describe('un fallo del LLM se dice, no deja «Preparando…» para siempre', () => {
  test('si la llamada falla, llega una respuesta con tipo, mensaje y detalle (F021)', async () => {
    // El cuerpo tiene forma de lo que de verdad devuelve un proveedor: la
    // burbuja no puede acabar mostrando esto crudo (F021, medido con Google).
    const { llamar } = llmFalso(new Error('openai 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}'))
    const m = new MotorRespuestas({ llamar })

    const { respuesta } = await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino')

    assert.strictEqual(respuesta.texto, null)
    assert.strictEqual(respuesta.id, 'q1')
    assert.strictEqual(respuesta.tipo, 'sin_credito')
    assert.match(respuesta.mensaje, /OpenAI/)
    assert.match(respuesta.mensaje, /crédito/)
    assert.doesNotMatch(respuesta.mensaje, /[{}]/, 'nada de JSON en la burbuja')
    assert.strictEqual(respuesta.error, undefined, 'el campo viejo ya no se usa')
    assert.strictEqual(m.stats.fallos, 1)
    assert.strictEqual(m.stats.respondidas, 0)
  })

  test('la clave del usuario no sale ni en mensaje ni en detalle (401 real de OpenAI)', async () => {
    const claveEnElCuerpo = 'sk-proj-oQ8fALGO1234REAL5678SEISUNOMASOCHO'
    const { llamar } = llmFalso(new Error(
      `openai 401: {"error":{"message":"Incorrect API key provided: ${claveEnElCuerpo}."}}`
    ))
    const m = new MotorRespuestas({ llamar })

    const { respuesta } = await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino')

    assert.strictEqual(respuesta.tipo, 'clave_invalida')
    assert.ok(!respuesta.mensaje.includes(claveEnElCuerpo))
    assert.ok(!respuesta.detalle.includes(claveEnElCuerpo), `se coló en el detalle: ${respuesta.detalle}`)
    assert.match(respuesta.detalle, /sk-proj-\*\*\*\*/)
  })

  test('una respuesta vacía del modelo también se dice, como fallo desconocido con detalle aparte', async () => {
    const { llamar } = llmFalso('   ')
    const m = new MotorRespuestas({ llamar })

    const { respuesta } = await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino')

    assert.strictEqual(respuesta.texto, null)
    assert.strictEqual(respuesta.tipo, 'desconocido')
    assert.match(respuesta.mensaje, /desconocido/)
    assert.match(respuesta.detalle, /vacía/, 'el detalle técnico sigue disponible aparte')
  })

  test('si falla el bloque de contexto, también se dice', async () => {
    // El bloque sale de la base de datos y puede fallar. Si ese fallo se
    // escapara del try, no se emitiría nada y la tarjeta quedaría colgada.
    const { llamar } = llmFalso()
    const m = new MotorRespuestas({
      llamar,
      bloqueContexto: () => { throw new Error('la base de datos no responde') },
    })

    const { respuesta } = await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino')

    assert.strictEqual(respuesta.texto, null)
    assert.match(respuesta.detalle, /base de datos/)
  })

  test('«Otra» sobre una pregunta ya olvidada responde con un motivo', async () => {
    // `_vistas` solo recuerda las últimas MEMORIA, pero la tarjeta sigue en
    // pantalla toda la reunión: el botón tiene que contestar algo.
    const { llamar, llamadas } = llmFalso()
    const m = new MotorRespuestas({ llamar })

    const espera = esperar(m, 'respuesta')
    assert.strictEqual(m.reintentar('q99'), false)
    const r = await espera

    assert.strictEqual(r.id, 'q99')
    assert.strictEqual(r.texto, null)
    assert.match(r.mensaje, /antigua/)
    assert.strictEqual(llamadas.length, 0, 'no se gasta una llamada por un id que ya no existe')
  })
})

// ── «Otra» redacción ────────────────────────────────────────────────────────

describe('pedir otra redacción', () => {
  test('vuelve a llamar y le pide al modelo que cambie', async () => {
    const { llamar, llamadas } = llmFalso(n => `redacción ${n}`)
    const m = new MotorRespuestas({ llamar })

    const { respuesta: primera } = await preguntarYEsperar(m, 'Hai già parlato con il fornitore del magazzino')

    const segunda = esperar(m, 'respuesta')
    assert.strictEqual(m.reintentar('q1'), true)
    const r = await segunda

    assert.strictEqual(primera.texto, 'redacción 1')
    assert.strictEqual(r.texto, 'redacción 2')
    assert.match(llamadas[1].usuario, /otra forma/)
    assert.doesNotMatch(llamadas[0].usuario, /otra forma/)
  })
})

// ── Limpieza de lo que devuelve el modelo ───────────────────────────────────

describe('limpieza de la respuesta', () => {
  const motor = () => new MotorRespuestas({ llamar: async () => '' })

  test('quita las vallas de markdown', () => {
    assert.strictEqual(motor()._limpiar('```\nCerto, ci penso io.\n```'), 'Certo, ci penso io.')
  })

  test('quita las comillas que envuelven la respuesta entera', () => {
    assert.strictEqual(motor()._limpiar('«Certo, ci penso io.»'), 'Certo, ci penso io.')
    assert.strictEqual(motor()._limpiar('"Certo, ci penso io."'), 'Certo, ci penso io.')
  })

  test('NO parte una respuesta que solo empieza y acaba con comillas', () => {
    // Quitarle el primer y el último carácter la dejaba rota: «Certo." Poi "vediamo»
    const t = '"Certo." Poi "vediamo"'
    assert.strictEqual(motor()._limpiar(t), t)
  })

  test('corta en la última frase completa, no a mitad de palabra', () => {
    const frase = 'Direi due settimane per la parte tecnica. '
    const largo = frase.repeat(20)          // muy por encima del tope
    const t = motor()._limpiar(largo)

    assert.ok(t.length <= MAX_CARACTERES, `${t.length} caracteres`)
    assert.ok(t.endsWith('.'), `acaba en "${t.slice(-20)}"`)
    assert.ok(t.length > MAX_CARACTERES * 0.5, 'no se recorta más de la cuenta')
  })
})

// ── El panel de contexto general ────────────────────────────────────────────

describe('el panel de contexto general', () => {
  const RESUMEN = JSON.stringify({ resumen: 'Se negocia adelantar la entrega.', tema_nuevo: false })

  /** Reloj falso: así el intervalo de 2 minutos se prueba en milisegundos. */
  function reloj (t = 0) {
    const r = { t }
    r.ahora = () => r.t
    return r
  }

  test('no pide resumen hasta que hay conversación suficiente', async () => {
    const { llamar, llamadas } = llmFalso(RESUMEN)
    const m = new MotorResumen({ llamar, minFrases: 4 })

    for (const f of ['uno', 'due', 'tre']) assert.strictEqual(m.registrar(f), false)
    assert.strictEqual(llamadas.length, 0)

    const espera = esperar(m, 'contexto')
    assert.strictEqual(m.registrar('quattro'), true)
    await espera
    assert.strictEqual(llamadas.length, 1)
  })

  test('el resumen llega en español y dice si cambió el tema', async () => {
    const { llamar } = llmFalso(JSON.stringify({ resumen: 'Ahora se habla del presupuesto.', tema_nuevo: true }))
    const m = new MotorResumen({ llamar, minFrases: 1 })

    const espera = esperar(m, 'contexto')
    m.registrar('Il budget copre anche la manutenzione')
    const c = await espera

    assert.strictEqual(c.texto, 'Ahora se habla del presupuesto.')
    assert.strictEqual(c.temaNuevo, true)
    assert.strictEqual(m.stats.resumenes, 1)
  })

  test('respeta el intervalo: no resume otra vez antes de tiempo', async () => {
    const { llamar, llamadas } = llmFalso(RESUMEN)
    const r = reloj(1000)
    const m = new MotorResumen({ llamar, minFrases: 2, intervaloMs: 120_000, ahora: r.ahora })

    const primera = esperar(m, 'contexto')
    m.registrar('uno'); m.registrar('due')
    await primera
    await asentar()
    assert.strictEqual(llamadas.length, 1)

    r.t += 119_000
    m.registrar('tre'); m.registrar('quattro')
    await asentar()
    assert.strictEqual(llamadas.length, 1, 'todavía no han pasado los 2 minutos')

    const segunda = esperar(m, 'contexto')
    r.t += 2_000
    m.registrar('cinque')
    await segunda
    assert.strictEqual(llamadas.length, 2)
  })

  test('manda las frases en italiano y pide JSON', async () => {
    const { llamar, llamadas } = llmFalso(RESUMEN)
    const m = new MotorResumen({ llamar, minFrases: 2, bloqueContexto: () => 'REUNIÓN\nProyecto: Rossi' })

    const espera = esperar(m, 'contexto')
    m.registrar('Il cliente ha chiesto di anticipare la consegna', 'El cliente ha pedido…')
    m.registrar('Dobbiamo rivedere i tempi', 'Tenemos que revisar…')
    await espera

    assert.match(llamadas[0].usuario, /Il cliente ha chiesto di anticipare la consegna/)
    assert.doesNotMatch(llamadas[0].usuario, /El cliente ha pedido/)
    assert.match(llamadas[0].sistema, /Rossi/)
    assert.deepStrictEqual(llamadas[0].opciones, { json: true })
  })

  test('un fallo no pinta nada pero se reintenta al siguiente intervalo', async () => {
    let n = 0
    const llamar = async () => {
      if (++n === 1) throw new Error('sin red')
      return RESUMEN
    }
    const r = reloj(1000)
    const m = new MotorResumen({ llamar, minFrases: 1, intervaloMs: 60_000, ahora: r.ahora })
    const vistos = recoger(m, 'contexto')

    m.registrar('uno')
    await asentar()
    await asentar()
    assert.deepStrictEqual(vistos, [], 'el panel plegado no grita errores')
    assert.strictEqual(m.stats.fallos, 1)

    const espera = esperar(m, 'contexto')
    r.t += 61_000
    m.registrar('due')
    const c = await espera
    assert.strictEqual(c.texto, 'Se negocia adelantar la entrega.')
  })

  test('si el modelo devuelve prosa en vez de JSON, se aprovecha igual', () => {
    const { texto, temaNuevo } = _internos.interpretarResumen('Se habla de los plazos de entrega.')
    assert.strictEqual(texto, 'Se habla de los plazos de entrega.')
    assert.strictEqual(temaNuevo, false)
  })

  test('sin función de LLM el motor de resumen no se construye', () => {
    assert.throws(() => new MotorResumen({}), /llamar al LLM/)
  })
})
