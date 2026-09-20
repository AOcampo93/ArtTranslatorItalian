/**
 * F040, corrección — `empezarSesion` no puede reventar antes de arrancar.
 *
 * El commit 4bd1ec8 metió `const { motor, resumen, traductor } =
 * montarMotores(...)` dentro de `empezarSesion`. Esa constante sombreaba el
 * módulo `traductor` (el `require` de la línea 39) en TODA la función por
 * ser `const`, que se iza a la cabeza del ámbito. Y unas líneas antes de esa
 * declaración, `empezarSesion` hace `await traductor.cargar()` pensando en
 * el módulo: caía en la zona muerta temporal de su propia sombra y lanzaba
 * `ReferenceError: Cannot access 'traductor' before initialization` en
 * cuanto alguien pulsaba «Empezar» — con clave puesta o sin ella, porque el
 * error pasa antes de que la clave importe.
 *
 * `mainAppSesionF030.test.js` no lo detectaba: su tramo empieza en
 * `const idSesion = db.startSession`, que es DESPUÉS de `traductor.cargar()`
 * — la sombra entraba en el tramo, pero el uso que la contradice se quedaba
 * fuera. Esta prueba ancla al principio REAL de `empezarSesion`, donde vive
 * `traductor.cargar()`, para que una sombra futura no vuelva a colarse en
 * silencio.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')

/** Saca del archivo el tramo entre dos anclas, y falla si no está donde debe. */
function tramo (fuente, desde, hasta) {
  const i = fuente.indexOf(desde)
  const j = fuente.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i,
    `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return fuente.slice(i, j)
}

describe('F040 (corrección) — empezarSesion no lanza ReferenceError antes de montar motores', () => {
  before(() => { assert.ok(fs.existsSync(MAIN_APP)) })

  test('con la clave puesta, el tramo real desde "async function empezarSesion" hasta montar la sesión corre sin lanzar', async () => {
    const fuente = fs.readFileSync(MAIN_APP, 'utf8')
    // El tramo empieza EN "async function empezarSesion" (con su cabecera),
    // así que lo que se extrae es una declaración de función sin cerrar:
    // hay que cerrarla y devolverla, no ejecutarla como si fueran
    // sentencias sueltas del cuerpo del `new Function` exterior.
    const codigo = tramo(fuente, 'async function empezarSesion', 'sesion = {')
      + '\nreturn { traductorSesion, idSesion, autosave }\n}'
      + '\nreturn empezarSesion'

    // Los nombres de estos parámetros son los identificadores libres que usa
    // el tramo (`sesion`, `leerClaves`, `contexto`, `AssemblyLiveTranscriber`,
    // `registroConexionesStt`, `traductor`, `db`, `path`, `app`, `Autosave`,
    // `montarMotores`): si `mainApp.js` deja de usar alguno, `new Function`
    // revienta con un `ReferenceError` al ejecutar, no en silencio — igual
    // que hace la sombra que esta prueba reproduce si vuelve.
    const fabrica = new Function(
      'sesion', 'leerClaves', 'contexto', 'AssemblyLiveTranscriber',
      'registroConexionesStt', 'traductor', 'db', 'path', 'app', 'Autosave',
      'montarMotores', codigo)

    const traductorModulo = { cargado: false, cargar: async function () { this.cargado = true } }
    const AssemblyLiveTranscriberFalso = class { constructor (opts) { this.opts = opts } }
    const contextoFalso = {
      actualizarPerfil: () => {}, crearPerfil: () => 1,
      activarPerfil: () => {}, crearContexto: () => {},
    }
    const db = { startSession: () => 91 }
    const app = { getPath: () => '/tmp/no-existe-arttranslator-f040', getVersion: () => '0.7.0' }
    const AutosaveFalso = class {
      constructor (opts) { this.opts = opts }
      abrir () {}
      guardarCabecera () {}
    }
    const montarMotoresFalso = () => ({ motor: 'M', resumen: 'R', traductor: 'llm-o-marian' })

    // `fabrica` no ejecuta el cuerpo de la reunión: sólo declara y devuelve
    // la función real `empezarSesion` con esas piezas de mentira cerradas
    // por closure.
    const ejecutar = fabrica(
      null, () => ({ stt: 'clave-falsa', llm: null }), contextoFalso,
      AssemblyLiveTranscriberFalso, {}, traductorModulo, db, path, app,
      AutosaveFalso, montarMotoresFalso)

    // Reproduce el ReferenceError: llamar al tramo real es justo lo que pasa
    // al pulsar «Empezar». Si la sombra sigue ahí, este `await` rechaza con
    // "Cannot access 'traductor' before initialization" y la prueba cae en
    // el `assert.doesNotReject`.
    await assert.doesNotReject(
      ejecutar({ perfil: null, contexto: null }),
      /Cannot access 'traductor' before initialization/,
    )

    const salida = await ejecutar({ perfil: null, contexto: null })
    assert.strictEqual(traductorModulo.cargado, true,
      'traductor.cargar() (el módulo, Marian) sí se llamó, sin lanzar')
    assert.strictEqual(salida.traductorSesion, 'llm-o-marian',
      'la constante de la sesión toma lo que eligió montarMotores, sin chocar con el módulo')
  })
})
