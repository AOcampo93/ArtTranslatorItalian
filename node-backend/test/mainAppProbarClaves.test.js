/**
 * F036 — el botón «Probar» de cada clave en Ajustes.
 *
 * `mainApp.js` no se puede `require` desde una prueba (pide `electron` en la
 * primera línea), así que aquí se repite el patrón de `mainAppErrores.test.js`
 * y `mainAppSesionF030.test.js`: se **extrae el tramo real del archivo** —
 * `probarClaveStt` y `probarClaveLlm`, cada uno fuente exacta— y se ejecuta
 * con dobles alrededor: un `AssemblyLiveTranscriber` de mentira que sólo
 * apunta qué llamó, y un `crearLlamador` de mentira que no toca la red.
 *
 * Un criterio por bloque:
 *  1. Botón con resultado verde/rojo y mensaje en castellano → `ok`/`mensaje`.
 *  2. La prueba de AssemblyAI siempre pasa por `stop()` (que es quien manda
 *     `Terminate` y respeta el freno de ritmo; eso ya se prueba a fondo en
 *     `assemblyLive.test.js` — aquí sólo hace falta que `probarClaveStt` no
 *     se salte esa salida ni en el camino feliz ni en el de error).
 *  3. La prueba del LLM dice proveedor y modelo.
 *  4. Ninguno de los dos resultados lleva la clave, ni siquiera cuando el
 *     error que lanza el proveedor la trae dentro.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { clasificarError, proveedorDeClave, MODELOS, NOMBRE_PROVEEDOR } = require('../src/llm')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const FUENTE = fs.readFileSync(MAIN_APP, 'utf8')

function tramo (desde, hasta) {
  const i = FUENTE.indexOf(desde)
  const j = FUENTE.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return FUENTE.slice(i, j)
}

// La clave con forma real que nunca puede llegar al renderer, con el prefijo
// AIza que trae el error saneado a "AIza****" — igual criterio que F021.
const CLAVE_REAL = 'AIzaSyCLAVEDEVERDAD1234567890ABCDEFG'

describe('F036 — probarClaveStt', () => {
  function montar ({ falla, registroConexionesStt = { marcas: [] } } = {}) {
    const codigo = tramo('async function probarClaveStt', 'async function probarClaveLlm')
    const llamadas = []
    const opciones = []
    class TranscriptorFalso {
      constructor (opts) { opciones.push(opts); this.apiKey = opts.apiKey }
      async start () {
        llamadas.push('start')
        if (falla) throw falla
      }
      async stop () { llamadas.push('stop') }
    }
    const fabrica = new Function(
      'AssemblyLiveTranscriber', 'clasificarError', 'registroConexionesStt',
      `${codigo}\n return probarClaveStt`)
    return {
      probarClaveStt: fabrica(TranscriptorFalso, clasificarError, registroConexionesStt),
      llamadas, opciones,
    }
  }

  test('sin clave, no llama a nada y dice que falta en castellano', async () => {
    const { probarClaveStt, llamadas } = montar()
    const r = await probarClaveStt('')
    assert.deepStrictEqual(llamadas, [])
    assert.strictEqual(r.ok, false)
    assert.match(r.mensaje, /Falta la clave/)
  })

  test('con la clave buena: verde, mensaje en castellano, y pasa por start() y stop()', async () => {
    const { probarClaveStt, llamadas } = montar()
    const r = await probarClaveStt(CLAVE_REAL)
    assert.strictEqual(r.ok, true)
    assert.match(r.mensaje, /Clave válida/)
    assert.deepStrictEqual(llamadas, ['start', 'stop'])
    assert.ok(!r.mensaje.includes(CLAVE_REAL), 'la clave no puede salir en el mensaje')
  })

  test('con la clave mala: rojo, mensaje de clasificarError (F021), y stop() se llama igual', async () => {
    const { probarClaveStt, llamadas } = montar({
      falla: new Error(`cerró al abrir: 1008 credenciales rechazadas (clave ${CLAVE_REAL})`),
    })
    const r = await probarClaveStt(CLAVE_REAL)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(typeof r.mensaje, 'string')
    // `stop()` es quien manda Terminate y respeta el freno de conexiones
    // (assemblyLive.test.js); esta prueba sólo exige que se llegue a llamar.
    assert.deepStrictEqual(llamadas, ['start', 'stop'])
    assert.ok(!r.mensaje.includes(CLAVE_REAL), 'un fallo del servidor no puede colar la clave')
  })

  test('corrección: la conexión de prueba entra en el mismo registro de conexiones que la reunión', async () => {
    // El freno de ritmo (assemblyLive.test.js) es del REGISTRO, no de la
    // instancia: si `probarClaveStt` no pasara `registroConexionesStt`, cada
    // pulsación de «Probar» abriría con una ventana vacía y nunca contaría
    // para el cupo de la sesión real ni al revés. Aquí se comprueba que el
    // registro compartido, tal cual se lo pasa `probarClaveStt`, es el mismo
    // objeto en las tres llamadas — la prueba real del freno, con marcas de
    // verdad, ya vive en assemblyLive.test.js.
    const registroConexionesStt = { marcas: [] }
    const { probarClaveStt, opciones } = montar({ registroConexionesStt })
    await probarClaveStt(CLAVE_REAL)
    await probarClaveStt(CLAVE_REAL)
    assert.strictEqual(opciones.length, 2)
    assert.strictEqual(opciones[0].registroConexiones, registroConexionesStt)
    assert.strictEqual(opciones[1].registroConexiones, registroConexionesStt)
  })
})

describe('F036 — probarClaveLlm', () => {
  function montar ({ respuesta, error } = {}) {
    const codigo = tramo('async function probarClaveLlm', "ipcMain.handle('app:probarClaveStt'")
    const llamadas = []
    const crearLlamadorFalso = ({ clave }) => {
      llamadas.push(clave)
      return async () => {
        if (error) throw error
        return { texto: respuesta || 'ok', tokensEntrada: 3, tokensSalida: 1, modelo: 'x' }
      }
    }
    const fabrica = new Function(
      'crearLlamador', 'clasificarError', 'proveedorDeClave', 'MODELOS', 'NOMBRE_PROVEEDOR',
      `${codigo}\n return probarClaveLlm`)
    return {
      probarClaveLlm: fabrica(crearLlamadorFalso, clasificarError, proveedorDeClave, MODELOS, NOMBRE_PROVEEDOR),
      llamadas,
    }
  }

  test('sin clave, mensaje en castellano y no llama a nada', async () => {
    const { probarClaveLlm, llamadas } = montar()
    const r = await probarClaveLlm('')
    assert.deepStrictEqual(llamadas, [])
    assert.strictEqual(r.ok, false)
    assert.match(r.mensaje, /Falta la clave/)
  })

  test('con una clave de Gemini: dice el proveedor y el modelo que se usará', async () => {
    const { probarClaveLlm } = montar()
    const r = await probarClaveLlm(CLAVE_REAL)
    assert.strictEqual(r.ok, true)
    assert.ok(r.mensaje.includes(NOMBRE_PROVEEDOR.gemini), `falta el proveedor en «${r.mensaje}»`)
    assert.ok(r.mensaje.includes(MODELOS.gemini), `falta el modelo en «${r.mensaje}»`)
    assert.ok(!r.mensaje.includes(CLAVE_REAL), 'la clave no puede salir en el mensaje')
  })

  test('con la clave mala: mensaje de clasificarError (F021), nunca el error crudo', async () => {
    const { probarClaveLlm } = montar({
      error: new Error(`gemini 401: {"error":{"message":"API key not valid","clave":"${CLAVE_REAL}"}}`),
    })
    const r = await probarClaveLlm(CLAVE_REAL)
    assert.strictEqual(r.ok, false)
    assert.match(r.mensaje, /no es válida/)
    assert.ok(!r.mensaje.includes(CLAVE_REAL), 'un 401 con la clave dentro no puede llegar crudo')
  })
})

describe('F036 — el estado que vuelve al renderer nunca contiene la clave', () => {
  // Recorre las cuatro combinaciones (éxito/fallo × STT/LLM) y comprueba el
  // objeto entero serializado, no sólo `.mensaje`: si algún día se añade un
  // campo nuevo al resultado, esta prueba lo vigila igual.
  test('ni en éxito ni en fallo, para ninguna de las dos pruebas', async () => {
    const codigoStt = tramo('async function probarClaveStt', 'async function probarClaveLlm')
    class TranscriptorFalla {
      constructor () {}
      async start () { throw new Error(`cerró al abrir: 1008 (${CLAVE_REAL})`) }
      async stop () {}
    }
    class TranscriptorOk {
      constructor () {}
      async start () {}
      async stop () {}
    }
    const probarStt = ok => new Function(
      'AssemblyLiveTranscriber', 'clasificarError', 'registroConexionesStt',
      `${codigoStt}\n return probarClaveStt`,
    )(ok ? TranscriptorOk : TranscriptorFalla, clasificarError, { marcas: [] })

    const codigoLlm = tramo('async function probarClaveLlm', "ipcMain.handle('app:probarClaveStt'")
    const probarLlm = ok => new Function(
      'crearLlamador', 'clasificarError', 'proveedorDeClave', 'MODELOS', 'NOMBRE_PROVEEDOR',
      `${codigoLlm}\n return probarClaveLlm`,
    )(() => async () => {
      if (!ok) throw new Error(`gemini 401: clave ${CLAVE_REAL} inválida`)
      return { texto: 'ok', tokensEntrada: 1, tokensSalida: 1, modelo: 'x' }
    }, clasificarError, proveedorDeClave, MODELOS, NOMBRE_PROVEEDOR)

    const resultados = await Promise.all([
      probarStt(true)(CLAVE_REAL), probarStt(false)(CLAVE_REAL),
      probarLlm(true)(CLAVE_REAL), probarLlm(false)(CLAVE_REAL),
    ])
    for (const r of resultados) {
      assert.ok(!JSON.stringify(r).includes(CLAVE_REAL), `se coló la clave en ${JSON.stringify(r)}`)
    }
  })
})

describe('F036 (corrección) — el freno de conexiones es del proceso, no de la instancia', () => {
  test('la sesión real y las dos pruebas de Ajustes usan el mismo registro compartido', () => {
    // Comprobación a nivel de fuente: las pruebas de arriba ya demuestran que
    // `probarClaveStt` recibe ese registro; esta comprueba que es el MISMO
    // que usa la sesión real de la reunión (`empezarSesion`) y la prueba de
    // la pantalla de preparación (`app:comprobar`) — las tres construcciones
    // de `AssemblyLiveTranscriber` del archivo.
    assert.match(FUENTE, /const registroConexionesStt = \{ ?marcas: \[\] ?\}/,
      'debe declararse un registro de conexiones compartido a nivel de módulo')
    const usos = FUENTE.match(/registroConexiones:\s*registroConexionesStt/g) || []
    assert.strictEqual(usos.length, 3,
      `las tres construcciones de AssemblyLiveTranscriber deben compartir el registro (encontradas: ${usos.length})`)
  })
})
