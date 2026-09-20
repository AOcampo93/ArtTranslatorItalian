/**
 * F032 — `listarConversaciones()`: la fuente de la pantalla «Conversaciones».
 *
 * Lee de los `.jsonl` de verdad (`Autosave.listar`/`Autosave.leer`), no de la
 * tabla `sessions`: es la fuente que el no negociable §0.3 garantiza
 * completa. Esta prueba escribe una reunión real con `Autosave` sobre un
 * directorio temporal y comprueba que `listarConversaciones()` cuenta bien
 * sus frases y preguntas, y que un archivo ilegible no tira abajo la lista
 * entera.
 *
 * `mainApp.js` no se puede `require` desde una prueba (pide `electron` en la
 * primera línea), así que se sigue el patrón de la casa
 * (`mainAppSesionF030.test.js`): se extrae el tramo real y se ejecuta con un
 * `app` de mentira sobre un directorio temporal, pero con `Autosave` de
 * VERDAD.
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

function construir (raizUserData) {
  // El final corta justo antes de que `listarConversaciones()` se registre
  // como manejador de IPC (F038 añade más manejadores justo después, que
  // aquí no hacen falta y que necesitarían un `ipcMain` de mentira).
  const codigo = tramo('function listarConversaciones', "ipcMain.handle('app:listarConversaciones'")
  const app = { getPath: () => raizUserData }
  const fabrica = new Function(
    'Autosave', 'path', 'app', 'console', 'percentil', 'duracionMs', 'costeStt', 'costeLlm',
    `${codigo}\n return listarConversaciones`
  )
  return fabrica(Autosave, path, app, console, percentil, duracionMs, costeStt, costeLlm)
}

describe('F032 — listarConversaciones() cuenta frases y preguntas de cada reunión guardada', () => {
  test('lee la cabecera, cuenta frases y preguntas, y tolera un archivo roto', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'conversaciones-'))
    const dir = path.join(raiz, 'reuniones')

    const a = new Autosave({ directorio: dir, idSesion: '9', inicio: new Date('2026-09-19T10:00:00Z') })
    a.abrir()
    a.guardarCabecera({ perfil: { nombre: 'Omar Ávila' }, contexto: { nombre: 'Rossi Logistica' } })
    a.guardarFrase({ it: 'Ciao', es: 'Hola' })
    a.guardarFrase({ it: 'Grazie', es: 'Gracias' })
    a.guardarPregunta({ it: 'Hai finito?', es: '¿Terminaste?' })
    a.cerrar()

    // Un archivo que no es JSON de verdad: `listarConversaciones()` no puede
    // caerse entero por una reunión ilegible.
    fs.writeFileSync(path.join(dir, 'sesion-rota.jsonl'), 'esto no es json\n')

    const listarConversaciones = construir(raiz)
    const lista = listarConversaciones()

    assert.strictEqual(lista.length, 2, 'la buena y la rota, las dos aparecen')
    const buena = lista.find(c => c.frases > 0 || c.preguntas > 0)
    assert.ok(buena, 'la reunión con datos tiene que estar')
    assert.strictEqual(buena.perfil, 'Omar Ávila')
    assert.strictEqual(buena.contexto, 'Rossi Logistica')
    assert.strictEqual(buena.frases, 2)
    assert.strictEqual(buena.preguntas, 1)
    assert.ok(buena.ruta.endsWith('.jsonl'))

    const rota = lista.find(c => c.archivo === 'sesion-rota.jsonl')
    assert.ok(rota, 'el archivo roto no hace caer la lista')
    assert.strictEqual(rota.frases, 0)
  })

  // F042: `traducirLinea` (mainApp.js) escribía la frase con `escribir()`
  // directo, sin `tipo`, así que filtrar por `tipo === 'frase'` a secas
  // dejaba esta lista en 0 — MEDIDO: una reunión real de 28 frases se leía
  // como «0 frases · sin frases medidas». La corrección cuenta también las
  // líneas sin `tipo` que sí llevan `it` (frase de verdad), y las nuevas ya
  // se graban con `tipo: 'frase'` explícito (comprobado arriba).
  test('F042: cuenta también las frases guardadas sin `tipo` (defecto de versiones anteriores)', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'conversaciones-'))
    const dir = path.join(raiz, 'reuniones')

    const a = new Autosave({ directorio: dir, idSesion: '10', inicio: new Date('2026-09-20T15:36:00Z') })
    a.abrir()
    a.guardarCabecera({ perfil: { nombre: 'Omar Oliveira' } })
    // Como escribía `traducirLinea` antes de F042: sin `tipo`.
    a.escribir({ it: 'Ciao', es: 'Hola', ms: 300 })
    a.escribir({ it: 'Come va?', es: '¿Cómo va?', ms: 250 })
    // Una pregunta también lleva `it`, pero con su propio `tipo`: no debe
    // contarse como frase.
    a.guardarPregunta({ it: 'Hai finito?', es: '¿Terminaste?' })
    a.cerrar()

    const listarConversaciones = construir(raiz)
    const [reunion] = listarConversaciones()
    assert.strictEqual(reunion.frases, 2, `debía contar 2 frases sin tipo, dio ${reunion.frases}`)
  })
})
