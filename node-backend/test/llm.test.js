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

const { crearLlamador, proveedorDeClave, MODELOS, LISTA_DE_MODELOS, clasificarError, sanear, _internos } = require('../src/llm')

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

// ── F021: sanear() tacha cualquier cosa con forma de clave ──────────────────

describe('sanear() tacha cualquier cosa con forma de clave', () => {
  test('sk-, sk-ant- y sk-proj- se tachan sin perder el prefijo que dice de quién es', () => {
    assert.strictEqual(sanear('clave: sk-abcdefghijklmnop'), 'clave: sk-****')
    assert.strictEqual(sanear('clave: sk-ant-api03-abcdefgh'), 'clave: sk-ant-****')
    assert.strictEqual(sanear('clave: sk-proj-abcdefgh1234'), 'clave: sk-proj-****')
  })

  test('el 401 real de OpenAI, con la clave dentro, sale sin ella y legible', () => {
    // Cuerpo real de OpenAI (acortado): la clave viaja DENTRO del texto,
    // parcialmente redactada por ellos pero con formato de clave completo.
    const cuerpo = 'Incorrect API key provided: sk-proj-oQ8xxxxxxxxxxxxxxxxxxxxABCD. ' +
      'You can find your API key at https://platform.openai.com/account/api-keys.'
    const limpio = sanear(cuerpo)
    assert.ok(!limpio.includes('sk-proj-oQ8'), `la clave se coló: ${limpio}`)
    assert.match(limpio, /sk-proj-\*\*\*\*/)
    assert.match(limpio, /Incorrect API key provided/, 'el resto del texto sigue legible')
  })

  test('AIza… de Gemini se tacha', () => {
    assert.strictEqual(sanear('AIzaSyABCDEFGH12345678'), 'AIza****')
  })

  test('lo que va tras "Bearer " se tacha entero', () => {
    assert.strictEqual(sanear('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'), 'Authorization: Bearer ****')
  })

  test('32 hexadecimales seguidos —formato de AssemblyAI— se tachan', () => {
    const clave = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'   // 32 hex
    assert.strictEqual(clave.length, 32)
    assert.strictEqual(sanear(`clave: ${clave}`), 'clave: ****')
  })

  test('un texto sin nada con forma de clave no cambia', () => {
    assert.strictEqual(sanear('rate limit exceeded'), 'rate limit exceeded')
  })

  test('null y undefined no revientan', () => {
    assert.strictEqual(sanear(null), '')
    assert.strictEqual(sanear(undefined), '')
  })
})

// ── F021: clasificarError() — cuerpos REALES de cada proveedor ──────────────

describe('clasificarError() traduce el error técnico a una frase accionable', () => {
  test('400 de Gemini "API key not valid": clave_invalida, y la clave no sale', async () => {
    const cuerpoReal = JSON.stringify({
      error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
    })
    const { fetchImpl } = fetchFalso(falloCon(400, cuerpoReal))
    const llamar = crearLlamador({ clave: CLAVE.gemini, fetchImpl })

    await assert.rejects(() => llamar('s', 'u'), err => {
      const c = clasificarError(err)
      assert.strictEqual(c.tipo, 'clave_invalida')
      assert.match(c.mensaje, /Gemini/)
      assert.match(c.mensaje, /no es válida/)
      assert.match(c.mensaje, /Ajustes/)
      assert.doesNotMatch(c.mensaje, /[{}]/, 'la burbuja no lleva JSON')
      assert.ok(!c.detalle.includes(CLAVE.gemini))
      return true
    })
  })

  test('401 de OpenAI con "Incorrect API key provided: sk-proj-…": clave_invalida, y la clave NO sale ni en mensaje ni en detalle', async () => {
    // Es el caso medido en producción: OpenAI devuelve la clave con formato
    // real (aunque parcialmente redactada por ellos) dentro del 401.
    const claveEnElCuerpo = 'sk-proj-oQ8fALGO1234REAL5678SEISUNOMASOCHO'
    const cuerpoReal = JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${claveEnElCuerpo}. You can find your API key at https://platform.openai.com/account/api-keys.`,
        type: 'invalid_request_error', param: null, code: 'invalid_api_key',
      },
    })
    const { fetchImpl } = fetchFalso(falloCon(401, cuerpoReal))
    const llamar = crearLlamador({ clave: CLAVE.openai, fetchImpl })

    await assert.rejects(() => llamar('s', 'u'), err => {
      // El `Error` interno SÍ lleva la clave del cuerpo —`motivoDelFallo`
      // copia 200 caracteres tal cual, y ahí es donde OpenAI la mete—: es la
      // materia prima que el log necesita. Lo que no puede pasar es que
      // llegue así a `clasificarError()`.
      assert.ok(err.message.includes(claveEnElCuerpo), 'la prueba no está probando el caso real si el Error ya viene limpio')

      const c = clasificarError(err)
      assert.strictEqual(c.tipo, 'clave_invalida')
      assert.match(c.mensaje, /OpenAI/)
      assert.match(c.mensaje, /no es válida/)
      assert.ok(!c.mensaje.includes(claveEnElCuerpo), `la clave se coló en el mensaje: ${c.mensaje}`)
      assert.ok(!c.detalle.includes(claveEnElCuerpo), `la clave se coló en el detalle: ${c.detalle}`)
      assert.match(c.detalle, /sk-proj-\*\*\*\*/, 'el detalle sigue siendo legible, solo sin la clave')
      assert.doesNotMatch(c.mensaje, /[{}]/, 'nada de JSON en la burbuja')
      return true
    })
  })

  test('429 insufficient_quota: sin_credito, no clave_invalida', async () => {
    const cuerpoReal = JSON.stringify({
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota', param: null, code: 'insufficient_quota',
      },
    })
    const { fetchImpl } = fetchFalso(falloCon(429, cuerpoReal))
    const llamar = crearLlamador({ clave: CLAVE.openai, fetchImpl })

    await assert.rejects(() => llamar('s', 'u'), err => {
      const c = clasificarError(err)
      assert.strictEqual(c.tipo, 'sin_credito')
      assert.match(c.mensaje, /OpenAI/)
      assert.match(c.mensaje, /crédito/)
      return true
    })
  })

  test('401 authentication_error de Anthropic: clave_invalida', async () => {
    const cuerpoReal = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    const { fetchImpl } = fetchFalso(falloCon(401, cuerpoReal))
    const llamar = crearLlamador({ clave: CLAVE.anthropic, fetchImpl })

    await assert.rejects(() => llamar('s', 'u'), err => {
      const c = clasificarError(err)
      assert.strictEqual(c.tipo, 'clave_invalida')
      assert.match(c.mensaje, /Anthropic/)
      return true
    })
  })

  test('ENOTFOUND/ECONNREFUSED: sin_red', async () => {
    const enotfound = new Error('getaddrinfo ENOTFOUND api.openai.com')
    enotfound.code = 'ENOTFOUND'
    assert.deepStrictEqual(clasificarError(enotfound).tipo, 'sin_red')

    const econnrefused = new Error('connect ECONNREFUSED 127.0.0.1:443')
    econnrefused.code = 'ECONNREFUSED'
    assert.strictEqual(clasificarError(econnrefused).tipo, 'sin_red')
    assert.strictEqual(clasificarError(econnrefused).mensaje, 'Sin conexión a Internet.')

    // Y el camino real: `crearLlamador` ya envuelve cualquier fallo de fetch.
    const { fetchImpl } = fetchFalso(new Error('getaddrinfo ENOTFOUND api.anthropic.com'))
    const llamar = crearLlamador({ clave: CLAVE.anthropic, fetchImpl })
    await assert.rejects(() => llamar('s', 'u'), err => {
      assert.strictEqual(clasificarError(err).tipo, 'sin_red')
      return true
    })
  })

  test('AbortError por plazo: sin_respuesta, nombrando al proveedor', async () => {
    const expirado = new Error('The operation was aborted due to timeout')
    expirado.name = 'TimeoutError'
    const { fetchImpl } = fetchFalso(expirado)
    const llamar = crearLlamador({ clave: CLAVE.anthropic, fetchImpl, plazoMs: 3000 })

    await assert.rejects(() => llamar('s', 'u'), err => {
      const c = clasificarError(err)
      assert.strictEqual(c.tipo, 'sin_respuesta')
      assert.match(c.mensaje, /Anthropic/)
      assert.match(c.mensaje, /no respondió a tiempo/)
      assert.match(c.mensaje, /reintentará/)
      return true
    })

    // Un AbortError crudo, sin pasar por `crearLlamador`, también se reconoce.
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    assert.strictEqual(clasificarError(abort).tipo, 'sin_respuesta')
  })

  test('404 de modelo: modelo_inexistente, nombra el modelo y dónde mirar', async () => {
    const { fetchImpl } = fetchFalso(falloCon(404, 'This model models/gemini-3.5-flash-lite is no longer available.'))
    const llamar = crearLlamador({ clave: CLAVE.gemini, fetchImpl })

    await assert.rejects(() => llamar('s', 'u'), err => {
      const c = clasificarError(err)
      assert.strictEqual(c.tipo, 'modelo_inexistente')
      assert.match(c.mensaje, /Gemini/)
      assert.match(c.mensaje, /gemini-3\.5-flash-lite/)
      assert.match(c.mensaje, /v1beta\/models/)
      return true
    })
  })

  test('un código desconocido dice que es desconocido, y el detalle va aparte', async () => {
    const { fetchImpl } = fetchFalso(falloCon(500, 'internal server error, try again'))
    const llamar = crearLlamador({ clave: CLAVE.openai, fetchImpl })

    await assert.rejects(() => llamar('s', 'u'), err => {
      const c = clasificarError(err)
      assert.strictEqual(c.tipo, 'desconocido')
      assert.match(c.mensaje, /desconocido/)
      assert.doesNotMatch(c.mensaje, /internal server error/, 'el texto técnico no va en la burbuja')
      assert.match(c.detalle, /internal server error/, 'pero sí está disponible aparte')
      return true
    })
  })

  test('falta la clave / clave no reconocida: config, no red, y se clasifican igual', () => {
    assert.strictEqual(clasificarError(new Error('falta la clave del modelo de lenguaje')).tipo, 'clave_invalida')
    const c = clasificarError(new Error(
      'no se reconoce esa clave: se esperaba una de Anthropic (sk-ant-), OpenAI (sk-) o Google (AIza)'
    ))
    assert.strictEqual(c.tipo, 'clave_invalida')
    assert.match(c.mensaje, /Ajustes/)
  })
})
