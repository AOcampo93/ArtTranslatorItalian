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
  function montar ({ falla } = {}) {
    const codigo = tramo('async function probarClaveStt', 'async function probarClaveLlm')
    const llamadas = []
    class TranscriptorFalso {
      constructor ({ apiKey }) { this.apiKey = apiKey }
      async start () {
        llamadas.push('start')
        if (falla) throw falla
      }
      async stop () { llamadas.push('stop') }
    }
    const fabrica = new Function('AssemblyLiveTranscriber', 'clasificarError', `${codigo}\n return probarClaveStt`)
    return { probarClaveStt: fabrica(TranscriptorFalso, clasificarError), llamadas }
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
      'AssemblyLiveTranscriber', 'clasificarError', `${codigoStt}\n return probarClaveStt`,
    )(ok ? TranscriptorOk : TranscriptorFalla, clasificarError)

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
