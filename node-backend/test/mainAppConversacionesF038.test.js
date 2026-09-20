/**
 * F038 — conversaciones guardadas: coste, latencia, ver y borrar.
 *
 * Sigue el patrón de `mainAppConversaciones.test.js` (F032): `mainApp.js`
 * pide `electron` en la primera línea y no se puede `require`, así que se
 * extrae el tramo real del archivo y se ejecuta con un `app`/`Autosave` de
 * verdad sobre un directorio temporal — sólo `db` e `ipcMain` entran de
 * mentira, porque lo que se prueba es qué hace la función con lo que lee del
 * `.jsonl`, no SQLite ni IPC.
 *
 * Una prueba por criterio de aceptación de F038:
 *  1. `listarConversaciones()` trae duración, latencia p50/p95 y coste, cada
 *     cifra con su procedencia.
 *  2. `leerConversacion()`/`ensamblarPreguntas()` dan la transcripción y las
 *     preguntas con su respuesta.
 *  3. `borrarConversacion()` quita el `.jsonl` Y la fila de `sessions`.
 *  4. Cada coste dice si es medido o estimado (parte del criterio 1, pero se
 *     ejercita también con una reunión SIN llamadas al LLM, donde no hay
 *     tokens que medir).
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { Autosave } = require('../src/autosave')
const { percentil, duracionMs, costeStt, costeLlm } = require('../src/coste')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const FUENTE = fs.readFileSync(MAIN_APP, 'utf8')

function tramo (desde, hasta) {
  const i = FUENTE.indexOf(desde)
  const j = FUENTE.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return FUENTE.slice(i, j)
}

/** Una reunión guardada de verdad, con `Autosave`, para leer luego. */
function grabarReunion (dir, { frases = [], preguntas = [], respuestasLlm = [], cabecera = {} } = {}) {
  const a = new Autosave({ directorio: dir, idSesion: cabecera.id ?? '9', inicio: new Date('2026-09-19T10:00:00Z') })
  a.abrir()
  a.guardarCabecera({ perfil: { nombre: 'Omar Ávila' }, contexto: { nombre: 'Rossi Logistica' }, ...cabecera })
  // `mainApp.js` no llama a `guardarFrase()` (esa es una API de conveniencia
  // que nadie en producción usa): escribe la línea directamente con
  // `escribir({ tipo: 'frase', ... })`, y el campo de latencia que de verdad
  // acaba en el `.jsonl` es `ms` (el total, `traducirLinea` en `mainApp.js`),
  // no `msTotal`. Se reproduce aquí tal cual para no medir un campo fantasma.
  for (const f of frases) a.escribir({ tipo: 'frase', it: f.it, es: f.es, ms: f.ms })
  for (const p of preguntas) a.guardarPregunta(p)
  for (const r of respuestasLlm) a.guardarRespuestaLlm(r)
  a.cerrar()
  return a.ruta
}

describe('F038 — listarConversaciones() añade duración, latencia y coste (con procedencia)', () => {
  function construirListar (raizUserData) {
    const codigo = tramo('function listarConversaciones', "ipcMain.handle('app:listarConversaciones'")
    const app = { getPath: () => raizUserData }
    const fabrica = new Function(
      'Autosave', 'path', 'app', 'console', 'percentil', 'duracionMs', 'costeStt', 'costeLlm',
      `${codigo}\n return listarConversaciones`
    )
    return fabrica(Autosave, path, app, console, percentil, duracionMs, costeStt, costeLlm)
  }

  test('criterio 1: fecha, duración, frases, preguntas, latencia p50/p95 y coste con procedencia', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-coste-'))
    const dir = path.join(raiz, 'reuniones')
    grabarReunion(dir, {
      frases: [
        { it: 'Ciao', es: 'Hola', ms: 150 },
        { it: 'Grazie mille', es: 'Muchas gracias', ms: 400 },
      ],
      respuestasLlm: [
        { it: 'Hai finito?', es: '¿Terminaste?', manual: false, texto: 'Sì, ho finito.', tokensEntrada: 200, tokensSalida: 30, modelo: 'claude-haiku-4-5-20251001' },
      ],
    })
    // La marca `t` de cada línea la pone `escribir()` con `new Date()`, así
    // que para tener una duración > 0 que no dependa del reloj de verdad hay
    // que releer y comprobar contra lo que el propio código midió — no un
    // número fijo, que sería frágil ante cuánto tarda `node --test` en correr.

    const listar = construirListar(raiz)
    const lista = listar()
    assert.strictEqual(lista.length, 1)
    const c = lista[0]

    assert.strictEqual(c.perfil, 'Omar Ávila')
    assert.strictEqual(c.contexto, 'Rossi Logistica')
    assert.strictEqual(c.frases, 2)
    assert.strictEqual(c.preguntas, 1, 'la respuestaLlm no manual cuenta como pregunta detectada')
    assert.ok(Number.isFinite(c.duracionMs) && c.duracionMs >= 0)

    // Latencia p50/p95: medida sobre `ms` de las frases confirmadas.
    assert.strictEqual(c.latenciaP50, 150)
    assert.strictEqual(c.latenciaP95, 400)

    // Coste STT: tarifa verificada × duración medida.
    assert.ok(c.costeSttUsd >= 0)
    assert.match(c.costeSttProcedencia, /verificad/i)
    assert.match(c.costeSttProcedencia, /medid/i)

    // Coste LLM: tokens reales (medidos) de la única llamada.
    assert.ok(c.costeLlmUsd > 0)
    assert.match(c.costeLlmProcedencia, /token.*medid/i)
  })

  test('criterio 4: sin tokens reales, el coste LLM se estima por caracteres y lo dice', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-coste-est-'))
    const dir = path.join(raiz, 'reuniones')
    grabarReunion(dir, {
      respuestasLlm: [
        { it: 'Quanto costa?', es: '¿Cuánto cuesta?', manual: true, texto: 'Circa 500 euro.', tokensEntrada: null, tokensSalida: null, modelo: null },
      ],
    })

    const lista = construirListar(raiz)()
    const c = lista[0]
    assert.strictEqual(c.preguntas, 0, 'la respuestaLlm es manual: ya la cuenta la línea `pregunta` que aquí no existe')
    assert.ok(c.costeLlmUsd > 0)
    assert.match(c.costeLlmProcedencia, /estimad/i)
    assert.doesNotMatch(c.costeLlmProcedencia, /medid/i)
  })

  test('una reunión sin llamadas al LLM lo dice, no calla un coste que no puede saber', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-sin-llm-'))
    const dir = path.join(raiz, 'reuniones')
    grabarReunion(dir, { frases: [{ it: 'Ciao', es: 'Hola', ms: 100 }] })

    const c = construirListar(raiz)()[0]
    assert.strictEqual(c.costeLlmUsd, 0)
    assert.match(c.costeLlmProcedencia, /sin llamadas/i)
  })
})

describe('F038 — leerConversacion()/ensamblarPreguntas(): transcripción y preguntas con respuesta', () => {
  function construirLeer () {
    const codigo = tramo('function ensamblarPreguntas', "ipcMain.handle('app:leerConversacion'")
    const fabrica = new Function('Autosave', `${codigo}\n return { ensamblarPreguntas, leerConversacion }`)
    return fabrica(Autosave)
  }

  test('criterio 2: la transcripción trae las frases y las preguntas llegan con su respuesta', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-leer-'))
    const dir = path.join(raiz, 'reuniones')
    const ruta = grabarReunion(dir, {
      frases: [{ it: 'Buongiorno', es: 'Buenos días', ms: 80 }],
      // Detectada por el motor (F033 no la guarda como `pregunta`; F038 sí
      // la guarda, y sólo como `respuestaLlm`).
      respuestasLlm: [{ it: 'Hai già iniziato?', es: '¿Ya empezaste?', manual: false, texto: 'Sì, certo.', modelo: 'x' }],
      // Manual (F033: se guarda al pulsar el botón, antes de la respuesta) +
      // su respuesta llega después, como línea aparte (F038).
      preguntas: [{ it: 'Quanto tempo serve?', es: '¿Cuánto tiempo hace falta?', manual: true }],
    })
    // La respuesta de la pregunta manual llega en una línea `respuestaLlm`
    // aparte, tal como la escribe `montarMotores` de verdad.
    const a2 = new Autosave({ directorio: dir, idSesion: 'append' })
    a2.ruta = ruta
    a2.guardarRespuestaLlm({ it: 'Quanto tempo serve?', es: '¿Cuánto tiempo hace falta?', manual: true, texto: 'Due settimane.' })

    const { leerConversacion } = construirLeer()
    const datos = leerConversacion(ruta)

    assert.strictEqual(datos.frases.length, 1)
    assert.strictEqual(datos.frases[0].it, 'Buongiorno')
    assert.strictEqual(datos.frases[0].es, 'Buenos días')

    assert.strictEqual(datos.preguntas.length, 2)
    const detectada = datos.preguntas.find(p => p.it === 'Hai già iniziato?')
    assert.ok(detectada, 'la pregunta que sólo detectó el motor también aparece')
    assert.strictEqual(detectada.respuesta, 'Sì, certo.')

    const manual = datos.preguntas.find(p => p.it === 'Quanto tempo serve?')
    assert.ok(manual)
    assert.strictEqual(manual.manual, true)
    assert.strictEqual(manual.respuesta, 'Due settimane.', 'se empareja con su respuesta, aunque lleguen en líneas distintas')
  })

  test('una pregunta sin respuesta todavía se enseña igual, sin respuesta', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-sin-resp-'))
    const dir = path.join(raiz, 'reuniones')
    const ruta = grabarReunion(dir, { preguntas: [{ it: 'Ci vediamo domani?', manual: true }] })

    const { leerConversacion } = construirLeer()
    const datos = leerConversacion(ruta)
    assert.strictEqual(datos.preguntas.length, 1)
    assert.strictEqual(datos.preguntas[0].respuesta, null)
  })
})

describe('F038 — borrarConversacion(): quita el `.jsonl` y la fila de `sessions`', () => {
  test('criterio 3: borra el archivo y llama a `db.deleteSession()` con el id de la cabecera', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-borrar-'))
    const dir = path.join(raiz, 'reuniones')
    const ruta = grabarReunion(dir, { cabecera: { id: 42 } })
    assert.ok(fs.existsSync(ruta))

    const codigo = tramo('function borrarConversacion', "ipcMain.handle('app:borrarConversacion'")
    const borrados = []
    const db = { deleteSession: id => borrados.push(id) }
    const app = { getPath: () => raiz }
    const fabrica = new Function('Autosave', 'path', 'app', 'fs', 'db', 'console', `${codigo}\n return borrarConversacion`)
    const borrarConversacion = fabrica(Autosave, path, app, fs, db, console)

    const r = borrarConversacion(ruta)

    assert.strictEqual(r.ok, true)
    assert.strictEqual(fs.existsSync(ruta), false, 'el `.jsonl` desaparece')
    assert.deepStrictEqual(borrados, [42], 'se borra la sesión con el id de la cabecera de ESA reunión')
  })

  test('una ruta que no es de la carpeta de reuniones del usuario no se borra', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-borrar-fuera-'))
    const fueraDeLugar = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-otro-sitio-'))
    const rutaAjena = path.join(fueraDeLugar, 'sesion-falsa.jsonl')
    fs.writeFileSync(rutaAjena, '{}\n')

    const codigo = tramo('function borrarConversacion', "ipcMain.handle('app:borrarConversacion'")
    const db = { deleteSession: () => { throw new Error('no debería llamarse') } }
    const app = { getPath: () => raiz }
    const fabrica = new Function('Autosave', 'path', 'app', 'fs', 'db', 'console', `${codigo}\n return borrarConversacion`)
    const borrarConversacion = fabrica(Autosave, path, app, fs, db, console)

    const r = borrarConversacion(rutaAjena)

    assert.strictEqual(r.ok, false)
    assert.ok(fs.existsSync(rutaAjena), 'el archivo ajeno sigue donde estaba')
  })
})
