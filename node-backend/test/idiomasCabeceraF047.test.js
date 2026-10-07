/**
 * F047 — el idioma de la reunión queda escrito, y una conversación vieja sin él
 * es italiano.
 *
 * Dos mitades del mismo criterio:
 *
 *  - Lo que `empezarSesion` escribe: la cabecera del `.jsonl` y la fila de
 *    `sessions` llevan el idioma. Se ejecuta el tramo REAL de `mainApp.js`
 *    (patrón de la casa, `mainAppSesionF030.test.js`) con el `Autosave` y la
 *    base de datos de verdad sobre un directorio temporal, porque el criterio
 *    es sobre lo que queda en disco.
 *  - Lo que se lee: las reuniones grabadas antes de la V2 no traen `idioma` en
 *    la cabecera —eran todas italiano— y `listarConversaciones` y
 *    `leerConversacion` tienen que decirlo así.
 *
 * Ni aquí ni en ningún sitio se renombra el campo `it` de las líneas: sigue
 * siendo «el texto original» (PLAN.md §17.3).
 */

'use strict'

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { Autosave } = require('../src/autosave')
const { obtenerIdioma } = require('../src/idiomas')
const { percentil, duracionMs, costeStt, costeLlm } = require('../src/coste')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const FUENTE = fs.readFileSync(MAIN_APP, 'utf8')

/** Saca de `mainApp.js` el tramo entre dos anclas, y falla si no está donde debe. */
function tramo (desde, hasta) {
  const i = FUENTE.indexOf(desde)
  const j = FUENTE.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return FUENTE.slice(i, j)
}

let raiz, db

before(async () => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'idioma-cabecera-'))
  // `db.js` lee la carpeta de datos al cargarse: hay que decirla antes del `require`.
  process.env.DB_DATA_DIR = path.join(raiz, 'datos')
  db = require('../src/db')
  await db.init()
})

after(() => {
  db.vaciar()
  fs.rmSync(raiz, { recursive: true, force: true })
})

describe('F047 — empezarSesion escribe el idioma en la cabecera y en la fila de sessions', () => {
  /**
   * Ejecuta el tramo real que abre la fila y la cabecera. Con `idioma` como
   * octavo nombre el tramo lo ve; sin él, no existe, que es como lo ejecuta
   * `mainAppSesionF030.test.js` (siete nombres) y por eso tiene que valer.
   */
  function abrirSesion (...idioma) {
    const codigo = tramo('const idSesion = db.startSession',
      'const { motor, resumen, traductor: traductorSesion }') + '\nreturn { idSesion, autosave }'
    const app = { getPath: () => raiz, getVersion: () => '0.9.0' }
    const nombres = ['db', 'Autosave', 'path', 'app', 'perfil', 'ctx', 'claves']
    const valores = [db, Autosave, path, app, { nombre: 'Omar' }, { nombre: 'Negociación' }, { stt: 'a', llm: 'b' }]
    if (idioma.length) { nombres.push('idioma'); valores.push(idioma[0]) }
    const { idSesion, autosave } = new Function(...nombres, codigo)(...valores)
    autosave.cerrar()
    return {
      cabecera: Autosave.leer(autosave.ruta).entradas[0],
      fila: db.get('SELECT language FROM sessions WHERE id = ?', [idSesion]),
    }
  }

  test('sin decir idioma, como lo ejecuta la prueba de F030: «it» en las dos', () => {
    const { cabecera, fila } = abrirSesion()
    assert.strictEqual(cabecera.tipo, 'cabecera')
    assert.strictEqual(cabecera.idioma, 'it')
    assert.strictEqual(fila.language, 'it')
  })

  test('con la entrada del registro: «it»; con otro idioma, ese mismo, sin tocar nada más', () => {
    const it = abrirSesion(obtenerIdioma('it'))
    assert.strictEqual(it.cabecera.idioma, 'it')
    assert.strictEqual(it.fila.language, 'it')

    // No hay segundo idioma todavía: una entrada de mentira basta para ver que
    // lo que recibe el motor es lo que queda escrito.
    const otro = abrirSesion({ codigo: 'zz' })
    assert.strictEqual(otro.cabecera.idioma, 'zz')
    assert.strictEqual(otro.fila.language, 'zz')
    assert.strictEqual(otro.cabecera.perfil.nombre, 'Omar', 'y el resto de la cabecera sigue donde estaba')
  })
})

describe('F047 — una conversación vieja, sin idioma en la cabecera, se lista y se lee como «it»', () => {
  /** Las dos funciones reales de `mainApp.js`, sobre las reuniones de `userData`. */
  function lectores (userData) {
    const app = { getPath: () => userData }
    const listar = new Function(
      'Autosave', 'path', 'app', 'console', 'percentil', 'duracionMs', 'costeStt', 'costeLlm',
      `${tramo('function listarConversaciones', "ipcMain.handle('app:listarConversaciones'")}\n return listarConversaciones`,
    )(Autosave, path, app, console, percentil, duracionMs, costeStt, costeLlm)
    const { leerConversacion } = new Function(
      'Autosave',
      `${tramo('function ensamblarPreguntas', "ipcMain.handle('app:leerConversacion'")}\n return { leerConversacion }`,
    )(Autosave)
    return { listar, leerConversacion }
  }

  test('la de v0.9 es «it»; la de ahora, con idioma, conserva el suyo', () => {
    const userData = fs.mkdtempSync(path.join(raiz, 'userdata-'))
    const dir = path.join(userData, 'reuniones')
    fs.mkdirSync(dir, { recursive: true })

    // Tal como la dejaba v0.9: la cabecera sin `idioma`, y las frases con `it`.
    const vieja = path.join(dir, 'sesion-20260920-100000-3.jsonl')
    fs.writeFileSync(vieja, [
      { t: '2026-09-20T10:00:00.000Z', tipo: 'cabecera', perfil: { nombre: 'Omar' }, contexto: null,
        version: '0.9.0', inicio: '2026-09-20T10:00:00.000Z', id: 3, claves: { stt: true, llm: true } },
      { t: '2026-09-20T10:00:05.000Z', tipo: 'frase', it: 'Buongiorno a tutti.', es: 'Buenos días a todos.', ms: 900 },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')

    // Una de ahora, con el campo que escribe `guardarCabecera`.
    const nueva = new Autosave({ directorio: dir, idSesion: '4', inicio: new Date('2026-10-08T10:00:00Z') })
    nueva.abrir()
    nueva.guardarCabecera({ perfil: { nombre: 'Omar' }, idioma: 'en' })
    nueva.escribir({ tipo: 'frase', it: 'Good morning, everyone.', es: 'Buenos días a todos.', ms: 800 })
    nueva.cerrar()

    const { listar, leerConversacion } = lectores(userData)
    const lista = listar()
    assert.strictEqual(lista.length, 2)
    assert.strictEqual(lista.find(c => c.ruta === vieja).idioma, 'it')
    assert.strictEqual(lista.find(c => c.ruta === nueva.ruta).idioma, 'en')

    assert.strictEqual(leerConversacion(vieja).idioma, 'it')
    assert.strictEqual(leerConversacion(vieja).frases[0].it, 'Buongiorno a tutti.',
      'y el texto original sigue en el campo «it»')
    assert.strictEqual(leerConversacion(nueva.ruta).idioma, 'en')
  })
})
