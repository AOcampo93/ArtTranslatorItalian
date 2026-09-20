/**
 * F042 — el estado de las claves en Ajustes: qué hay guardado y «Probar» con
 * el campo vacío.
 *
 * Reporte del cliente tras v0.7.0: la sesión de las 15:36 SÍ tenía clave
 * guardada (transcribió y tradujo con IA), pero Ajustes no lo decía en
 * ningún sitio — los campos se vacían al guardar y muestran «•••» tanto si
 * hay clave como si no. Dos arreglos, cada uno con su prueba:
 *
 *  1. `app:estadoClaves` añade los 4 últimos caracteres de cada clave
 *     guardada (nunca más), para poder pintar «Guardada ✓ (termina en
 *     …xxxx)».
 *  2. Los manejadores de «Probar» prueban la clave YA GUARDADA cuando el
 *     campo llega vacío, en vez de fallar con «falta la clave» — que es
 *     justo lo que pasaba siempre, porque el campo se vacía al guardar.
 *
 * Mismo patrón de la casa que `mainAppProbarClaves.test.js` y
 * `mainAppPreguntar.test.js`: se extrae el tramo real de `mainApp.js` y se
 * ejecuta con dobles alrededor.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const FUENTE = fs.readFileSync(MAIN_APP, 'utf8')

function tramo (desde, hasta) {
  const i = FUENTE.indexOf(desde)
  const j = FUENTE.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return FUENTE.slice(i, j)
}

describe('F042 — app:estadoClaves dice si hay clave guardada, con sus 4 últimos caracteres', () => {
  function montar (raizUserData) {
    // De `guardarClaves` (que usa `safeStorage`) a justo antes de
    // `ipcMain.handle('app:guardarClaves'` — así no arrastra los otros
    // manejadores de en medio (`app:empezar`, `app:audio`…), que no hacen
    // falta aquí y piden dobles que esta prueba no monta. El manejador de
    // `app:estadoClaves` se extrae aparte, con su propio tramo.
    const codigoClaves = tramo('const RUTA_CLAVES', "\n// ── Informes a la nube")
    const codigoEstado = tramo('function ultimos4', "\nasync function probarClaveStt")
    const app = { getPath: () => raizUserData }
    // Un cifrado de mentira: reversible y suficiente para probar la lógica,
    // sin depender de que el sistema de pruebas tenga `safeStorage` real.
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: s => Buffer.from(s, 'utf8'),
      decryptString: b => b.toString('utf8'),
    }
    const { guardarClaves, leerClaves } = new Function(
      'fs', 'path', 'app', 'safeStorage',
      `${codigoClaves}\n return { guardarClaves, leerClaves }`,
    )(fs, path, app, safeStorage)
    const registrados = {}
    const ipcMain = { handle: (canal, fn) => { registrados[canal] = fn } }
    new Function('ipcMain', 'leerClaves', 'safeStorage', 'leerTokenInformes', codigoEstado)(
      ipcMain, leerClaves, safeStorage, () => null)
    return { registrados, guardarClaves, leerClaves }
  }

  test('sin ninguna clave guardada: los dos booleanos en falso y sin últimos 4', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'claves-'))
    const { registrados } = montar(raiz)
    const estado = registrados['app:estadoClaves']()
    assert.deepStrictEqual(estado.stt, false)
    assert.deepStrictEqual(estado.llm, false)
    assert.strictEqual(estado.sttUltimos4, null)
    assert.strictEqual(estado.llmUltimos4, null)
  })

  test('con las dos claves guardadas: booleanos en verdadero y los 4 últimos caracteres, nunca más', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'claves-'))
    const { registrados, guardarClaves } = montar(raiz)
    guardarClaves({ stt: 'assemblyai-clave-de-verdad-1234', llm: 'AIzaSyCLAVEDEVERDADabcd' })

    const estado = registrados['app:estadoClaves']()
    assert.strictEqual(estado.stt, true)
    assert.strictEqual(estado.llm, true)
    assert.strictEqual(estado.sttUltimos4, '1234')
    assert.strictEqual(estado.llmUltimos4, 'abcd')
    // Nunca más de 4: ni la clave entera, ni un trozo más largo.
    assert.strictEqual(estado.sttUltimos4.length, 4)
    assert.ok(!JSON.stringify(estado).includes('assemblyai-clave-de-verdad'),
      'la clave entera no puede viajar en el estado')
  })
})

describe('F042 — «Probar» con el campo vacío prueba la clave YA GUARDADA', () => {
  function montar ({ sttGuardada, llmGuardada } = {}) {
    const codigo = tramo("// F042: «Probar» con el campo vacío", "\n\n/**")
    const llamadasStt = []
    const llamadasLlm = []
    const probarClaveStt = clave => { llamadasStt.push(clave); return { ok: true } }
    const probarClaveLlm = clave => { llamadasLlm.push(clave); return { ok: true } }
    const leerClaves = () => ({ stt: sttGuardada, llm: llmGuardada })
    const registrados = {}
    const ipcMain = { handle: (canal, fn) => { registrados[canal] = fn } }
    new Function('ipcMain', 'probarClaveStt', 'probarClaveLlm', 'leerClaves', codigo)(
      ipcMain, probarClaveStt, probarClaveLlm, leerClaves)
    return { registrados, llamadasStt, llamadasLlm }
  }

  test('campo vacío y clave guardada: se prueba la guardada, no «falta la clave»', () => {
    const { registrados, llamadasStt, llamadasLlm } = montar({ sttGuardada: 'stt-guardada', llmGuardada: 'llm-guardada' })
    registrados['app:probarClaveStt'](null, '')
    registrados['app:probarClaveLlm'](null, '')
    assert.deepStrictEqual(llamadasStt, ['stt-guardada'])
    assert.deepStrictEqual(llamadasLlm, ['llm-guardada'])
  })

  test('campo con texto: se prueba lo escrito, no la guardada', () => {
    const { registrados, llamadasStt } = montar({ sttGuardada: 'stt-guardada' })
    registrados['app:probarClaveStt'](null, 'lo-que-escribio-el-usuario')
    assert.deepStrictEqual(llamadasStt, ['lo-que-escribio-el-usuario'])
  })

  test('campo vacío y sin clave guardada: se sigue pasando vacío (queda «falta la clave»)', () => {
    const { registrados, llamadasStt } = montar({ sttGuardada: undefined })
    registrados['app:probarClaveStt'](null, '')
    assert.deepStrictEqual(llamadasStt, [undefined])
  })
})
