/**
 * F021 — que ningún error que cruce de `mainApp.js` al renderer lleve algo
 * con forma de clave, ni el JSON crudo de un proveedor.
 *
 * ## Por qué se prueba así
 *
 * `mainApp.js` no se puede `require` desde una prueba (pide `electron` en la
 * primera línea), así que aquí se repite el patrón de `mainAppFrase.test.js`
 * y `rendererPreguntas.test.js`: se **extrae el tramo real del archivo**,
 * fuente exacta, y se ejecuta con piezas de mentira alrededor. No es una
 * copia del código: si alguien cambia esas funciones, esto las ejerce
 * cambiadas; si alguien las saca de su sitio, la extracción falla con un
 * mensaje que dice justo eso.
 *
 * La auditoría mecánica de F021 marcó tres puntos de emisión en este
 * archivo que no son el motor de respuestas (ya cubierto en
 * `respuestas.test.js`): la traducción de Marian (`traducirOAvisar`), el
 * autoguardado (`guardarYPintar`) y el transcriptor de AssemblyAI
 * (`transcriptor.on('error', …)`). Los tres pasan por `sanear()` de
 * `llm.js`, que ya se prueba a fondo en `llm.test.js`; lo que hace falta
 * probar AQUÍ es que efectivamente lo llaman antes de `aRenderer`, con un
 * error cuyo `message` lleva una clave real dentro.
 *
 * El cuarto punto (`app:guardarClaves`) se prueba igual, capturando el
 * manejador real que `ipcMain.handle` registraría.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { sanear } = require('../src/llm')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const FUENTE = fs.readFileSync(MAIN_APP, 'utf8')

/** Saca el tramo entre dos anclas, y falla si no está donde debe. */
function tramo (desde, hasta) {
  const i = FUENTE.indexOf(desde)
  const j = FUENTE.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return FUENTE.slice(i, j)
}

// La clave con formato real que NUNCA puede llegar a `aRenderer`. Con el
// prefijo `sk-proj-`, que es justo el que trae el 401 medido de OpenAI.
const CLAVE = 'sk-proj-oQ8fALGO1234REAL5678SEISUNOMASOCHO'

describe('F021 — traducirOAvisar: un fallo de Marian con una clave dentro no llega crudo', () => {
  before(() => { assert.ok(fs.existsSync(MAIN_APP)) })

  function montar (traducirLinea) {
    const codigo = tramo('async function traducirOAvisar', 'function guardarYPintar')
    const pintado = []
    const aRenderer = (canal, datos) => pintado.push({ canal, datos })
    const fabrica = new Function('traducirLinea', 'aRenderer', 'sanear',
      `${codigo}\n return traducirOAvisar`)
    return { traducirOAvisar: fabrica(traducirLinea, aRenderer, sanear), pintado }
  }

  test('Marian falla con un mensaje que lleva una clave: no sale en el aviso', async () => {
    const { traducirOAvisar, pintado } = montar(async () => {
      throw new Error(`no se pudo cargar el modelo, clave residual: ${CLAVE}`)
    })

    const r = await traducirOAvisar('Ciao', {}, {})

    assert.strictEqual(r, null, 'un fallo de Marian no produce frase')
    assert.strictEqual(pintado.length, 1)
    assert.strictEqual(pintado[0].canal, 'app:estado')
    assert.ok(!pintado[0].datos.texto.includes(CLAVE), `se coló la clave: ${pintado[0].datos.texto}`)
    assert.match(pintado[0].datos.texto, /no se pudo traducir/)
    assert.match(pintado[0].datos.texto, /sk-proj-\*\*\*\*/)
  })

  test('sin fallo, Marian traduce normal y no avisa nada', async () => {
    const { traducirOAvisar, pintado } = montar(async () => ({ es: 'Ciao' }))
    const r = await traducirOAvisar('Ciao', {}, {})
    assert.deepStrictEqual(r, { es: 'Ciao' })
    assert.strictEqual(pintado.length, 0)
  })
})

describe('F021 — guardarYPintar: un fallo de disco con una clave dentro no llega crudo', () => {
  function montar (escribir) {
    const codigo = tramo('function guardarYPintar', 'function cerrarCola')
    const pintado = []
    const avisos = []
    const aRenderer = (canal, datos) => pintado.push({ canal, datos })
    const consola = { error: (...partes) => avisos.push(partes.map(String).join(' ')) }
    const fabrica = new Function('aRenderer', 'sanear', 'console',
      `${codigo}\n return guardarYPintar`)
    return { guardarYPintar: fabrica(aRenderer, sanear, consola), pintado, avisos }
  }

  test('el disco falla con un mensaje que lleva una clave: no sale en el aviso', () => {
    const s = {
      autosave: {
        abierto: true,
        escribir: () => { throw new Error(`ENOSPC al escribir, cabecera Authorization: Bearer ${CLAVE}`) },
        cerrar: () => {},
      },
      frases: 0,
    }
    const { guardarYPintar, pintado, avisos } = montar()
    guardarYPintar(s, { it: 'Ciao', es: 'Hola' })

    const aviso = pintado.find(p => p.canal === 'app:estado')
    assert.ok(aviso, 'tiene que avisar del fallo de disco')
    assert.ok(!aviso.datos.texto.includes(CLAVE), `se coló la clave: ${aviso.datos.texto}`)
    assert.match(aviso.datos.texto, /no se pudo guardar la frase/)
    assert.match(aviso.datos.texto, /Bearer \*\*\*\*/)
    // El log del proceso principal SÍ puede llevar el mensaje completo: no
    // cruza al renderer, y es lo que hace falta para depurar de verdad.
    assert.ok(avisos.some(a => a.includes(CLAVE)), 'el log interno conserva el detalle completo')
    // La burbuja se sigue pintando aunque falle el disco (frase, no fallo).
    assert.ok(pintado.some(p => p.canal === 'app:frase'))
  })

  test('sin fallo de disco, no hay aviso', () => {
    const s = { autosave: { abierto: true, escribir: () => {}, cerrar: () => {} }, frases: 0 }
    const { guardarYPintar, pintado } = montar()
    guardarYPintar(s, { it: 'Ciao', es: 'Hola' })
    assert.strictEqual(pintado.filter(p => p.canal === 'app:estado').length, 0)
  })
})

describe('F021 — el transcriptor: un error de AssemblyAI con una clave dentro no llega crudo', () => {
  function montar () {
    // Incluye 'estado' Y 'error': es el mismo tramo real que registra los
    // dos manejadores uno detrás del otro en `empezarSesion`.
    const codigo = tramo("transcriptor.on('estado', e => {", 'await transcriptor.start()')
      .replace('await transcriptor.start()', '')   // no hay socket real que abrir aquí

    const { EventEmitter } = require('events')
    const transcriptor = new EventEmitter()
    const pintado = []
    const aRenderer = (canal, datos) => pintado.push({ canal, datos })
    const fabrica = new Function('transcriptor', 'aRenderer', 'sanear', codigo)
    fabrica(transcriptor, aRenderer, sanear)
    return { transcriptor, pintado }
  }

  test('un error del transcriptor con una clave dentro sale saneado', () => {
    const { transcriptor, pintado } = montar()
    transcriptor.emit('error', new Error(`la conexión se cortó (1008: clave rechazada AIza${'B'.repeat(20)})`))

    assert.strictEqual(pintado.length, 1)
    assert.strictEqual(pintado[0].canal, 'app:estado')
    assert.ok(!pintado[0].datos.texto.includes(`AIza${'B'.repeat(20)}`), `se coló la clave: ${pintado[0].datos.texto}`)
    assert.match(pintado[0].datos.texto, /AIza\*\*\*\*/)
  })

  test('los estados normales se siguen traduciendo al castellano', () => {
    const { transcriptor, pintado } = montar()
    transcriptor.emit('estado', 'escuchando')
    assert.deepStrictEqual(pintado[0].datos, { clase: 'vivo', texto: 'Escuchando' })
  })
})

describe('F021 — IPC app:otraRespuesta sin reunión en marcha: usa el contrato nuevo, no `.error`', () => {
  function capturarManejador () {
    const codigo = tramo("ipcMain.handle('app:otraRespuesta'", "ipcMain.handle('app:guardarClaves'")
    const registrados = {}
    const ipcMain = { handle: (canal, fn) => { registrados[canal] = fn } }
    const pintado = []
    const aRenderer = (canal, datos) => pintado.push({ canal, datos })
    const fabrica = new Function('ipcMain', 'aRenderer', 'sesion', codigo)
    fabrica(ipcMain, aRenderer, undefined)
    return { manejador: registrados['app:otraRespuesta'], pintado }
  }

  test('sin `sesion.motor`, avisa con `mensaje` (no `error`) y sin JSON crudo', () => {
    const { manejador, pintado } = capturarManejador()

    const r = manejador(null, 'id-1')

    assert.deepStrictEqual(r, { ok: false })
    assert.strictEqual(pintado.length, 1)
    assert.strictEqual(pintado[0].canal, 'app:respuesta')
    assert.strictEqual(pintado[0].datos.error, undefined, 'no debe quedar el contrato viejo `.error`')
    assert.match(pintado[0].datos.mensaje, /vuelve a empezarla/)
  })
})

describe('F021 — IPC app:guardarClaves: un fallo de safeStorage no vuelve con una clave', () => {
  function capturarManejador (guardarClaves) {
    const codigo = tramo("ipcMain.handle('app:guardarClaves'", "ipcMain.handle('app:estadoClaves'")
    const registrados = {}
    const ipcMain = { handle: (canal, fn) => { registrados[canal] = fn } }
    const fabrica = new Function('ipcMain', 'guardarClaves', 'sanear', codigo)
    fabrica(ipcMain, guardarClaves, sanear)
    return registrados['app:guardarClaves']
  }

  test('el motivo del fallo sale saneado, no crudo', () => {
    const manejador = capturarManejador(() => {
      throw new Error(`no se pudo cifrar: clave vieja ${CLAVE} seguía en memoria`)
    })

    const r = manejador(null, { llm: 'algo' })

    assert.strictEqual(r.ok, false)
    assert.ok(!r.motivo.includes(CLAVE), `se coló la clave: ${r.motivo}`)
    assert.match(r.motivo, /sk-proj-\*\*\*\*/)
  })

  test('sin fallo, devuelve lo que guardó', () => {
    const manejador = capturarManejador(() => ({ llm: true, stt: false }))
    const r = manejador(null, { llm: 'algo' })
    assert.deepStrictEqual(r, { ok: true, guardadas: { llm: true, stt: false } })
  })
})
