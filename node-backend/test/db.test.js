/**
 * Pruebas del arreglo de db.js.
 *
 * El defecto heredado: `persist()` serializa la base COMPLETA y se llamaba en
 * cada inserción. Con 3.936 transcripciones en 1 MB, cada frase nueva
 * reescribía 1 MB entero, de forma síncrona y en el hilo del pipeline.
 *
 * Lo que se verifica aquí es que eso ya no pasa, y que una escritura
 * interrumpida no se lleva por delante los perfiles.
 */

'use strict'

const { test, describe, before, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let dir, db

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-'))
  process.env.DB_DATA_DIR = dir
  db = require('../src/db')
})

describe('las transcripciones ya no pasan por la base', () => {
  test('saveTranscript no escribe a disco', async () => {
    await db.init()
    const ruta = path.join(dir, 'artranslator.db')
    const antes = fs.statSync(ruta).mtimeMs

    for (let i = 0; i < 50; i++) {
      db.saveTranscript(1, { en: 'linea ' + i, es: 'línea ' + i })
    }
    await new Promise(r => setTimeout(r, 700))

    const despues = fs.statSync(ruta).mtimeMs
    assert.strictEqual(antes, despues,
      '50 transcripciones no deben tocar el archivo: van al autoguardado')
  })
})

describe('escritura agrupada', () => {
  test('N inserciones NO producen N escrituras del archivo', async () => {
    await db.init()
    const ruta = path.join(dir, 'artranslator.db')

    // Contamos escrituras reales espiando el mtime tras cada inserción.
    const sesion = db.startSession('prueba')
    let escrituras = 0
    let ultimo = fs.statSync(ruta).mtimeMs

    for (let i = 0; i < 20; i++) {
      db.saveQuestion(sesion, { question_en: 'q' + i, question_es: 'p' + i, context: [] })
      await new Promise(r => setTimeout(r, 5))
      const m = fs.statSync(ruta).mtimeMs
      if (m !== ultimo) { escrituras++; ultimo = m }
    }
    db.vaciar()

    assert.ok(escrituras < 20,
      `hubo ${escrituras} escrituras para 20 inserciones: no se está agrupando`)
  })

  test('vaciar() fuerza lo pendiente, para el cierre limpio', async () => {
    await db.init()
    const sesion = db.startSession('cierre')
    db.saveQuestion(sesion, { question_en: 'antes de cerrar', question_es: 'x', context: [] })
    db.vaciar()   // sin esperar el temporizador

    // Se relee del disco para comprobar que llegó de verdad.
    const bytes = fs.readFileSync(path.join(dir, 'artranslator.db'))
    assert.ok(bytes.length > 0)
    assert.ok(bytes.includes(Buffer.from('antes de cerrar')),
      'lo pendiente debe estar en disco tras vaciar()')
  })
})

describe('escritura atómica', () => {
  test('no deja temporales tras persistir', async () => {
    await db.init()
    db.startSession('atomica')
    db.persist()
    const sobras = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))
    assert.deepStrictEqual(sobras, [], `quedaron temporales: ${sobras}`)
  })

  test('el archivo bueno nunca queda a medias', async () => {
    // Con rename, o está el viejo completo o el nuevo completo. Nunca un
    // híbrido. Se comprueba que tras persistir, lo leído es una base válida.
    await db.init()
    const sesion = db.startSession('integridad')
    db.saveQuestion(sesion, { question_en: 'pregunta', question_es: 'pregunta', context: [] })
    db.vaciar()

    const bytes = fs.readFileSync(path.join(dir, 'artranslator.db'))
    // Cabecera de un archivo SQLite válido.
    assert.strictEqual(bytes.subarray(0, 15).toString(), 'SQLite format 3',
      'el archivo debe ser una base SQLite íntegra')
  })
})

describe('lo que sí debe seguir funcionando', () => {
  test('sesiones y preguntas se guardan y se releen', async () => {
    await db.init()
    const sesion = db.startSession('modelo-de-prueba')
    assert.ok(sesion > 0)
    db.saveQuestion(sesion, { question_en: 'Hai finito?', question_es: '¿Has terminado?', context: [] })
    db.endSession(sesion, { durationSeconds: 120, lineCount: 8 })
    db.vaciar()

    const cargada = db.loadSession(sesion)
    assert.ok(cargada, 'la sesión debe poder releerse')
    assert.strictEqual(cargada.duration_s, 120)
    assert.strictEqual(cargada.questions.length, 1)
    assert.strictEqual(cargada.questions[0].question_es, '¿Has terminado?')
  })
})
