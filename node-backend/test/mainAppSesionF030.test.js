/**
 * F030, ronda 2 — el cableado real de `empezarSesion` en `mainApp.js`.
 *
 * Motivo 3 de la revisión de corrección (y motivo 2 de la de arquitectura):
 * la única señal de `Autosave.detectarMezcla()` que de verdad funciona hoy
 * —«más de una cabecera»— depende ENTERA de que `mainApp.js` llame a
 * `autosave.guardarCabecera()` al abrir cada sesión. Esa llamada, y las dos
 * propiedades (`inicio`, `version`) que le pasa al constructor de `Autosave`,
 * no las ejercía ninguna prueba: se podían borrar las tres líneas y la suite
 * seguía en verde. Antes de F030 `guardarCabecera` era exactamente eso,
 * código muerto.
 *
 * `mainApp.js` no se puede `require` desde una prueba (pide `electron` en la
 * primera línea), así que se sigue el patrón de la casa
 * (`mainAppFrase.test.js`): se **extrae el tramo real** del archivo y se
 * ejecuta con un `db` y un `app` de mentira alrededor, pero con el
 * `Autosave` de VERDAD sobre un directorio temporal — el criterio es sobre
 * lo que queda escrito en disco.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { Autosave } = require('../src/autosave')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')

/** Saca del archivo el tramo entre dos anclas, y falla si no está donde debe. */
function tramo (fuente, desde, hasta) {
  const i = fuente.indexOf(desde)
  const j = fuente.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i,
    `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return fuente.slice(i, j)
}

describe('F030 — empezarSesion escribe inicio, version y cabecera de verdad', () => {
  before(() => { assert.ok(fs.existsSync(MAIN_APP)) })

  test('el archivo lleva la marca de tiempo y la primera línea es la cabecera con version, inicio e id', () => {
    const fuente = fs.readFileSync(MAIN_APP, 'utf8')
    const codigo = tramo(fuente, 'const idSesion = db.startSession', 'const { motor, resumen, traductor }')
      + '\nreturn { idSesion, inicio, autosave }'

    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'mainapp-sesion-'))
    const db = { startSession: () => 77 }
    const app = { getPath: () => raiz, getVersion: () => '0.5.0' }
    const perfil = { nombre: 'Omar' }
    const ctx = { nombre: 'Negociación' }

    // Los nombres de estos parámetros son los mismos identificadores libres
    // que usa el tramo extraído (`db`, `Autosave`, `path`, `app`, `perfil`,
    // `ctx`): si `mainApp.js` deja de usar alguno, `new Function` revienta
    // con un `ReferenceError` al ejecutar, no en silencio.
    const fabrica = new Function('db', 'Autosave', 'path', 'app', 'perfil', 'ctx', codigo)
    const { idSesion, inicio, autosave } = fabrica(db, Autosave, path, app, perfil, ctx)

    try {
      assert.strictEqual(idSesion, 77)
      assert.match(path.basename(autosave.ruta), /^sesion-\d{8}-\d{6}-77\.jsonl$/,
        'el nombre del archivo lleva la marca de tiempo de arranque (F030)')

      const { entradas } = Autosave.leer(autosave.ruta)
      assert.strictEqual(entradas.length, 1, 'solo la cabecera, todavía no hay ninguna frase')
      assert.strictEqual(entradas[0].tipo, 'cabecera',
        'la PRIMERA línea del archivo tiene que ser la cabecera')
      assert.strictEqual(entradas[0].version, '0.5.0',
        'la versión de la cabecera cae en this.version del constructor')
      assert.strictEqual(entradas[0].id, 77)
      assert.strictEqual(entradas[0].inicio, inicio.toISOString())
      assert.strictEqual(entradas[0].perfil.nombre, 'Omar')

      // Mutación documentada: si se borra `autosave.guardarCabecera(...)` de
      // `mainApp.js` (el estado del que partía esta tarea, código muerto),
      // `entradas` sale vacío y `entradas[0].tipo` revienta con un
      // TypeError — esta prueba cae. Verificado manualmente quitando esa
      // línea del tramo extraído antes de fabricar la función.
    } finally {
      autosave.cerrar()
      fs.rmSync(raiz, { recursive: true, force: true })
    }
  })
})
