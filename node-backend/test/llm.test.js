/**
 * Pruebas de la llamada al modelo de lenguaje configurado por el usuario.
 *
 * Corren **sin red**: `fetch` entra inyectado, así que aquí se comprueba lo
 * que es nuestro —a qué proveedor se manda, cómo se arma la petición, y sobre
 * todo **qué NO sale en los mensajes de error**— sin gastar una llamada.
 *
 * Lo que más importa de este archivo: **la clave del usuario no puede aparecer
 * en ningún error**. Un mensaje de error acaba pintado en el panel, copiado a
 * un informe y pegado en un correo.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')

const { crearLlamador, proveedorDeClave, MODELOS, LISTA_DE_MODELOS, _internos } = require('../src/llm')

const CLAVE = {
  anthropic: 'sk-ant-api03-CLAVEFALSA1234',
  openai: 'sk-proj-CLAVEFALSA1234',
  gemini: 'AIzaSyCLAVEFALSA1234',
}

/** `fetch` de mentira: apunta la petición y devuelve lo que se le diga. */
function fetchFalso (respuesta) {
  const peticiones = []
  const fetchImpl = async (url, opciones) => {
    peticiones.push({ url, opciones, cuerpo: JSON.parse(opciones.body) })
    if (respuesta instanceof Error) throw respuesta
    return respuesta
  }
  return { fetchImpl, peticiones }
}

const okCon = datos => ({ ok: true, status: 200, json: async () => datos })
const falloCon = (status, texto) => ({ ok: false, status, text: async () => texto })

describe('el proveedor se deduce del prefijo de la clave', () => {
  test('cada prefijo lleva a su proveedor', () => {
    assert.strictEqual(proveedorDeClave(CLAVE.anthropic), 'anthropic')
    assert.strictEqual(proveedorDeClave(CLAVE.openai), 'openai')
    assert.strictEqual(proveedorDeClave(CLAVE.gemini), 'gemini')
  })

  test('una clave de Anthropic NO se confunde con una de OpenAI', () => {
    // Las dos empiezan por "sk-": el orden de las comprobaciones es lo único
    // que las separa, y mandarla al proveedor equivocado le entrega la clave
    // del usuario a una empresa que no es la suya.
    assert.strictEqual(proveedorDeClave('sk-ant-loquesea'), 'anthropic')
  })

  test('lo que no se reconoce no se adivina', () => {
    assert.strictEqual(proveedorDeClave('pegué-cualquier-cosa'), null)
    assert.strictEqual(proveedorDeClave(''), null)
    assert.strictEqual(proveedorDeClave(undefined), null)
  })

  test('sin clave o con una clave rara, no se construye el llamador', () => {
    assert.throws(() => crearLlamador({ clave: '' }), /falta la clave/)
    assert.throws(() => crearLlamador({ clave: 'xyz' }), /Anthropic.*OpenAI.*Google/s)
  })
})

describe('la petición de cada proveedor', () => {
  test('Anthropic: clave en cabecera, prompt en system, y devuelve el texto', async () => {
    const { fetchImpl, peticiones } = fetchFalso(okCon({ content: [{ text: 'Certo, ci penso io.' }] }))
    const llamar = crearLlamador({ clave: CLAVE.anthropic, fetchImpl })

    const texto = await llamar('eres un intérprete', 'la pregunta')

    assert.strictEqual(texto, 'Certo, ci penso io.')
    const p = peticiones[0]
    assert.match(p.url, /^https:\/\/api\.anthropic\.com\//)
    assert.strictEqual(p.opciones.headers['x-api-key'], CLAVE.anthropic)
    assert.strictEqual(p.opciones.headers['anthropic-version'], '2023-06-01')
    assert.strictEqual(p.cuerpo.model, MODELOS.anthropic)
    assert.strictEqual(p.cuerpo.system, 'eres un intérprete')
    assert.deepStrictEqual(p.cuerpo.messages, [{ role: 'user', content: 'la pregunta' }])
  })

  test('OpenAI: system y user como dos mensajes, y modo JSON solo si se pide', async () => {
    const { fetchImpl, peticiones } = fetchFalso(okCon({ choices: [{ message: { content: '{"resumen":"x"}' } }] }))
    const llamar = crearLlamador({ clave: CLAVE.openai, fetchImpl })

    await llamar('sistema', 'usuario')
    assert.strictEqual(peticiones[0].cuerpo.response_format, undefined)

    await llamar('sistema', 'usuario', { json: true })
    assert.deepStrictEqual(peticiones[1].cuerpo.response_format, { type: 'json_object' })
    assert.deepStrictEqual(
      peticiones[1].cuerpo.messages.map(m => m.role), ['system', 'user']
    )
  })

  test('Google: la clave va en cabecera y NUNCA en la URL', async () => {
    // El cliente heredado la manda como `?key=…`. Una URL acaba en los
    // registros de error y en cualquier traza que alguien pegue en un informe.
    const { fetchImpl, peticiones } = fetchFalso(
      okCon({ candidates: [{ content: { parts: [{ text: 'Va bene.' }] } }] })
    )
    const llamar = crearLlamador({ clave: CLAVE.gemini, fetchImpl })

    const texto = await llamar('sistema', 'usuario', { json: true })

    assert.strictEqual(texto, 'Va bene.')
    assert.ok(!peticiones[0].url.includes(CLAVE.gemini), `la URL lleva la clave: ${peticiones[0].url}`)
    assert.strictEqual(peticiones[0].opciones.headers['x-goog-api-key'], CLAVE.gemini)
    assert.strictEqual(peticiones[0].cuerpo.generationConfig.responseMimeType, 'application/json')
  })

  test('se puede fijar otro modelo sin tocar el código', async () => {
    const { fetchImpl, peticiones } = fetchFalso(okCon({ content: [{ text: 'ok' }] }))
    const llamar = crearLlamador({ clave: CLAVE.anthropic, modelo: 'otro-modelo', fetchImpl })
    await llamar('s', 'u')
    assert.strictEqual(peticiones[0].cuerpo.model, 'otro-modelo')
  })

  test('las vallas de markdown se quitan antes de devolver', async () => {
    const { fetchImpl } = fetchFalso(okCon({ content: [{ text: '```json\n{"resumen":"x"}\n```' }] }))
    const llamar = crearLlamador({ clave: CLAVE.anthropic, fetchImpl })
    assert.strictEqual(await llamar('s', 'u'), '{"resumen":"x"}')
  })
})

describe('los fallos se cuentan sin filtrar la clave', () => {
  test('un error del proveedor llega con su código y su motivo', async () => {
    const { fetchImpl } = fetchFalso(falloCon(429, 'rate limit exceeded'))
    const llamar = crearLlamador({ clave: CLAVE.openai, fetchImpl })

    await assert.rejects(() => llamar('s', 'u'), err => {
      assert.match(err.message, /openai 429/)
      assert.match(err.message, /rate limit exceeded/)
      assert.ok(!err.message.includes(CLAVE.openai), 'el error no puede llevar la clave')
      return true
    })
  })

  test('un fallo de red no reenvía la URL, que con Google llevaría la clave', async () => {
    const err = new Error(`request to https://generativelanguage.googleapis.com/?key=${CLAVE.gemini} failed`)
    const { fetchImpl } = fetchFalso(err)
    const llamar = crearLlamador({ clave: CLAVE.gemini, fetchImpl })

    await assert.rejects(() => llamar('s', 'u'), e => {
      assert.ok(!e.message.includes(CLAVE.gemini), `se filtró la clave: ${e.message}`)
      assert.match(e.message, /no se pudo hablar con gemini/)
      return true
    })
  })

  test('si el proveedor no contesta, se dice que se agotó el plazo', async () => {
    // Sin plazo, la tarjeta se queda en «Preparando…» el resto de la reunión.
    const expirado = new Error('The operation was aborted due to timeout')
    expirado.name = 'TimeoutError'
    const { fetchImpl } = fetchFalso(expirado)
    const llamar = crearLlamador({ clave: CLAVE.openai, fetchImpl, plazoMs: 3000 })

    await assert.rejects(() => llamar('s', 'u'), /no respondió en 3 s/)
  })

  test('el plazo viaja en la petición, no es decorativo', async () => {
    const { fetchImpl, peticiones } = fetchFalso(okCon({ choices: [{ message: { content: 'ok' } }] }))
    const llamar = crearLlamador({ clave: CLAVE.openai, fetchImpl })
    await llamar('s', 'u')
    assert.ok(peticiones[0].opciones.signal, 'la petición tiene que llevar señal de aborto')
  })
})

describe('cosas menores que igual se rompen solas', () => {
  test('una respuesta sin el campo esperado devuelve cadena vacía, no revienta', () => {
    assert.strictEqual(_internos.API.anthropic.texto({}), '')
    assert.strictEqual(_internos.API.openai.texto({ choices: [] }), '')
    assert.strictEqual(_internos.API.gemini.texto(null), '')
  })
})

describe('los modelos por defecto', () => {
  test('ninguno es un alias móvil', () => {
    // `PLAN.md` §10 «Instalación, claves y coste visible» → «Dos bombas de
    // facturación», punto 2 (líneas 852-855): «si se fija un modelo por
    // defecto, nombrar la versión exacta».
    // Un `-latest` cambia de modelo, de precio y de comportamiento
    // bajo los pies, y el día que cambie nadie lo relacionará con una
    // respuesta peor. Es la trampa concreta que una prueba sí puede vigilar.
    for (const [prov, modelo] of Object.entries(MODELOS)) {
      assert.doesNotMatch(modelo, /-latest$/, `${prov} apunta a un alias móvil: ${modelo}`)
      assert.ok(modelo.length > 0)
    }
  })

  test('el de Gemini es un Flash-Lite, que es el que NO dobla de precio en 2027', () => {
    // `PLAN.md` §10, «Dos bombas de facturación», punto 2 (líneas 852-855),
    // [verificado]: 3.6/3.7/3.8 Flash doblan el 1-1-2027 y
    // 3.5 Flash —sin Lite— ya está por encima de ese precio doblado. Cuando
    // este modelo se retire, el 404 de Google va a sugerir justo uno de esos:
    // esta prueba es lo que impide seguir la sugerencia sin pensar.
    assert.match(MODELOS.gemini, /-flash-lite$/, `${MODELOS.gemini} no es Flash-Lite`)
  })

  test('cada proveedor sabe dónde se consultan los modelos vivos', () => {
    for (const prov of Object.keys(MODELOS)) {
      assert.match(LISTA_DE_MODELOS[prov] || '', /^GET https:\/\//, `falta la lista de ${prov}`)
    }
  })
})

describe('un 404 es accionable, no sólo un número', () => {
  test('dice qué modelo se pidió y dónde mirar los que siguen vivos', async () => {
    // Es el fallo que ya pasó con gemini-2.0-flash y el que volverá a pasar
    // cuando se retire el de ahora. Quien lo sufra no tendrá este contexto.
    const { fetchImpl } = fetchFalso(
      falloCon(404, 'This model models/gemini-3.5-flash-lite is no longer available.')
    )
    const llamar = crearLlamador({ clave: CLAVE.gemini, fetchImpl })

    await assert.rejects(() => llamar('s', 'u'), err => {
      assert.match(err.message, /gemini 404/)
      assert.match(err.message, /gemini-3\.5-flash-lite/, 'tiene que nombrar el modelo que se pidió')
      assert.match(err.message, /v1beta\/models/, 'tiene que decir dónde mirar los vivos')
      assert.ok(!err.message.includes(CLAVE.gemini), 'y sin la clave')
      return true
    })
  })

  test('cada proveedor manda a SU lista, no a la de Google', async () => {
    const { fetchImpl } = fetchFalso(falloCon(404, 'model not found'))
    const llamar = crearLlamador({ clave: CLAVE.anthropic, fetchImpl })
    await assert.rejects(() => llamar('s', 'u'), /api\.anthropic\.com\/v1\/models/)
  })

  test('los demás errores NO llevan esa coletilla', async () => {
    // Si se enganchara a todos, un 429 pasajero mandaría a revisar la lista de
    // modelos, que es exactamente la pista equivocada.
    const { fetchImpl } = fetchFalso(falloCon(429, 'rate limit exceeded'))
    const llamar = crearLlamador({ clave: CLAVE.openai, fetchImpl })
    await assert.rejects(() => llamar('s', 'u'), err => {
      assert.match(err.message, /rate limit exceeded/)
      assert.doesNotMatch(err.message, /v1\/models/)
      return true
    })
  })
})
