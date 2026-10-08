/**
 * F057 — la base de perfiles y contextos vive en `userData`, no junto a la app.
 *
 * Hasta la v0.9 `db.js` fijaba la ruta al ser requerido y `mainApp.js` no ponía
 * `DB_DATA_DIR`, así que empaquetada la base acababa en
 * `resources\node-backend\data\artranslator.db`. Extraer la versión siguiente en otra
 * carpeta dejaba al usuario sin perfiles ni contextos (PLAN.md §17.7).
 *
 * ## Cómo se prueba
 *
 * El criterio es del ARRANQUE, no de una función suelta: la ruta se decide en
 * `whenReady`, después de fijar `userData`, y un orden equivocado de los `require`
 * lo rompería sin que ninguna prueba de la función lo notara. Por eso la primera
 * prueba carga el `mainApp.js` de verdad con un `electron` de mentira, empaquetado,
 * y lee los perfiles por el IPC real. La base de la «carpeta de la app» la crea el
 * `db.js` de siempre, en otro proceso (el de esta prueba tiene el suyo ocupado).
 */

'use strict'

const { test, describe, after, mock } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'base-f057-'))
// Si `mainApp.js` no le diera a `db.js` la carpeta de `userData`, la base caería aquí
// y la prueba lo diría, en vez de abrir (y reescribir) la `node-backend/data` de verdad.
// Va antes de requerir nada de `src`: `db.js` lee la variable al cargarse.
process.env.DB_DATA_DIR = path.join(RAIZ, 'equivocada')

const SRC = path.join(__dirname, '..', 'src')
const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const { CARPETA_DE_DATOS, prepararBaseDeDatos } = require('../src/ajustes')
const db = require('../src/db')

after(() => { delete process.resourcesPath })

const huella = ruta => crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex')

/**
 * Corre `codigo` con el `db.js` y el `contexto.js` de verdad, sobre la base de
 * `carpeta`, en otro proceso, y devuelve lo que `codigo` retorna.
 */
function conLaBase (carpeta, codigo) {
  const guion = `
    const db = require(${JSON.stringify(path.join(SRC, 'db'))})
    const ctx = require(${JSON.stringify(path.join(SRC, 'contexto'))})
    ;(async () => {
      await db.init()
      const salida = await (async () => { ${codigo} })()
      db.vaciar()
      console.log(JSON.stringify(salida))
    })().catch(err => { console.error(err); process.exit(1) })`
  const texto = execFileSync(process.execPath, ['-e', guion], {
    env: { ...process.env, DB_DATA_DIR: carpeta }, encoding: 'utf8',
  })
  return JSON.parse(texto.trim().split('\n').pop())   // `db.init` escribe su propia línea antes
}

/**
 * Carga el `mainApp.js` de verdad con un `electron` de mentira y devuelve los
 * manejadores IPC y el arranque (`app.whenReady().then(...)`) para esperarlo.
 */
function arrancarMainApp ({ appData, empaquetada }) {
  const rutas = {}
  const manejadores = new Map()
  let arranque = null
  const app = {
    isPackaged: empaquetada,
    // Como Electron: `userData` sale del nombre de la app, salvo que alguien lo fije antes de `ready`.
    getPath: nombre => rutas[nombre] || (nombre === 'appData' ? appData : path.join(appData, 'ArtTranslatorV2')),
    setPath: (nombre, ruta) => { rutas[nombre] = ruta },
    whenReady: () => ({ then: f => { arranque = Promise.resolve().then(f); return arranque } }),
    on () {}, quit () {}, exit () {},
  }
  class BrowserWindow {
    constructor () { this.webContents = { session: { setDisplayMediaRequestHandler () {} }, send () {} } }
    on () {}
    setContentProtection () {}
    loadFile () {}
    isDestroyed () { return false }
    getBounds () { return {} }
    destroy () {}
    static getAllWindows () { return [] }
  }
  const electron = {
    app,
    BrowserWindow,
    ipcMain: { handle: (canal, f) => manejadores.set(canal, f), on () {} },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: {},
    dialog: {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  }

  const cargar = Module._load
  Module._load = function (peticion, ...resto) {
    return peticion === 'electron' ? electron : cargar.call(this, peticion, ...resto)
  }
  try { require(MAIN_APP) } finally { Module._load = cargar }
  return { manejadores, arranque }
}

describe('F057 — la base de perfiles y contextos vive en userData', () => {
  test('el primer arranque empaquetado copia la base de la app, los perfiles se leen de userData y el original queda intacto', async () => {
    const appData = path.join(RAIZ, 'AppData', 'Roaming')
    const userData = path.join(appData, CARPETA_DE_DATOS)
    const recursos = path.join(RAIZ, 'ArtTranslatorV2-win', 'resources')
    const carpetaDeLaApp = path.join(recursos, 'node-backend', 'data')
    const original = path.join(carpetaDeLaApp, 'artranslator.db')

    // La base de la v0.9: junto a la app, con un perfil y un contexto.
    conLaBase(carpetaDeLaApp, `
      ctx.crearPerfil({ nombre: 'Omar Avila', edad: 34, ocupacion: 'Responsable técnico' })
      ctx.crearContexto({ nombre: 'Rossi Logistica', glosario: 'SAP, ERP' })
      return null`)
    const huellaOriginal = huella(original)
    assert.ok(!fs.existsSync(path.join(userData, 'artranslator.db')), 'userData no tiene base todavía')

    process.resourcesPath = recursos
    const { manejadores, arranque } = arrancarMainApp({ appData, empaquetada: true })
    await arranque

    assert.ok(fs.existsSync(path.join(userData, 'artranslator.db')),
      'la base está en userData (la carpeta que fija F051), no junto a la app')
    assert.deepStrictEqual((await manejadores.get('app:listarPerfiles')()).map(p => p.nombre), ['Omar Avila'],
      'los perfiles de la v0.9 se leen de ahí')
    assert.deepStrictEqual((await manejadores.get('app:listarContextos')()).map(c => c.nombre), ['Rossi Logistica'])

    // Lo que la app escribe a partir de ahora va a userData y no toca el original.
    await manejadores.get('app:guardarPerfil')({}, { nombre: 'Marta Ruiz' })
    db.vaciar()
    assert.strictEqual(huella(original), huellaOriginal, 'la base de la carpeta de la app no se mueve ni se toca')
    assert.deepStrictEqual(conLaBase(userData, 'return ctx.listarPerfiles().map(p => p.nombre)'),
      ['Marta Ruiz', 'Omar Avila'], 'el perfil nuevo quedó en la base de userData')
    assert.ok(!fs.existsSync(process.env.DB_DATA_DIR), 'y nunca se abrió la ruta de desarrollo')
  })
})

describe('F057 — prepararBaseDeDatos: lo que no debe hacer', () => {
  /** Una «carpeta de la app» con una base dentro, y un userData que aún no existe. */
  function escenario () {
    const raiz = fs.mkdtempSync(path.join(RAIZ, 'esc-'))
    const recursos = path.join(raiz, 'resources')
    const origen = path.join(recursos, 'node-backend', 'data', 'artranslator.db')
    fs.mkdirSync(path.dirname(origen), { recursive: true })
    fs.writeFileSync(origen, 'la base de la v0.9')
    const userData = path.join(raiz, 'userData')
    return { recursos, origen, userData, destino: path.join(userData, 'artranslator.db') }
  }
  const appFalsa = (isPackaged, userData) => ({ isPackaged, getPath: () => userData })

  test('en desarrollo no toca nada y deja la ruta de siempre', () => {
    const e = escenario()
    const r = prepararBaseDeDatos({ app: appFalsa(false, e.userData), recursos: e.recursos })
    assert.deepStrictEqual(r, { carpeta: null, copiada: false })
    assert.ok(!fs.existsSync(e.userData))
  })

  test('si userData ya tiene base, no se pisa', () => {
    const e = escenario()
    fs.mkdirSync(e.userData)
    fs.writeFileSync(e.destino, 'la base de la V2')
    const r = prepararBaseDeDatos({ app: appFalsa(true, e.userData), recursos: e.recursos })
    assert.deepStrictEqual(r, { carpeta: e.userData, copiada: false })
    assert.strictEqual(fs.readFileSync(e.destino, 'utf8'), 'la base de la V2')
  })

  test('si copiar falla, se registra y la app sigue con la carpeta de userData, sin dejar restos', () => {
    const e = escenario()
    // Un directorio donde debería haber un archivo: copiar eso falla en cualquier sistema.
    fs.rmSync(e.origen)
    fs.mkdirSync(e.origen)
    const registro = mock.method(console, 'error', () => {})
    let r
    try {
      r = prepararBaseDeDatos({ app: appFalsa(true, e.userData), recursos: e.recursos })
    } finally {
      registro.mock.restore()
    }
    assert.strictEqual(r.carpeta, e.userData, 'sigue adelante: db.init crea una base nueva ahí')
    assert.strictEqual(r.copiada, false)
    assert.ok(r.error, 'dice por qué')
    assert.strictEqual(registro.mock.callCount(), 1)
    assert.match(String(registro.mock.calls[0].arguments[0]), /\[datos\]/)
    assert.deepStrictEqual(fs.readdirSync(e.userData), [], 'ni base a medias ni archivo temporal')
    assert.ok(fs.statSync(e.origen).isDirectory(), 'y el original no se toca')
  })
})
