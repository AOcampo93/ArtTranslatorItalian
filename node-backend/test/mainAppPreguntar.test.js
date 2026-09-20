/**
 * F033 — el botón «→ Pregunta» de una burbuja: IPC `app:preguntar`.
 *
 * ## Por qué se prueba así
 *
 * `mainApp.js` no se puede `require` desde una prueba (pide `electron` en la
 * primera línea), así que se repite el patrón de `mainAppErrores.test.js`:
 * se **extrae el tramo real del archivo** — el manejador tal como
 * `ipcMain.handle` lo registraría — y se ejecuta con un `sesion` de mentira
 * alrededor. `MotorRespuestas.forzar()` ya se prueba a fondo sin red en
 * `respuestas.test.js`; lo que falta probar AQUÍ es lo que decide este
 * manejador cuando NO hay a quién preguntarle — sin clave de LLM, o sin
 * reunión— y que el intento queda registrado en el `.jsonl` sea cual sea el
 * resultado.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const FUENTE = fs.readFileSync(MAIN_APP, 'utf8')

/** Saca el tramo entre dos anclas, y falla si no está donde debe. */
function tramo (desde, hasta) {
  const i = FUENTE.indexOf(desde)
  const j = FUENTE.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return FUENTE.slice(i, j)
}

/**
 * Captura el manejador real de `app:preguntar`, con un `sesion` inyectado
 * (o `null`, la reunión ya terminada).
 */
function capturarManejador (sesion) {
  const codigo = tramo('let nPreguntaManual = 0', "ipcMain.handle('app:guardarClaves'")
  const registrados = {}
  const ipcMain = { handle: (canal, fn) => { registrados[canal] = fn } }
  const pintado = []
  const aRenderer = (canal, datos) => pintado.push({ canal, datos })
  const fabrica = new Function('ipcMain', 'aRenderer', 'sesion', codigo)
  fabrica(ipcMain, aRenderer, sesion)
  return { manejador: registrados['app:preguntar'], pintado }
}

/** Una sesión de mentira, con un `autosave` que sólo apunta lo que le piden guardar. */
function sesionFalsa ({ motor } = {}) {
  const guardado = []
  return {
    motor: motor || null,
    autosave: { guardarPregunta: entrada => guardado.push(entrada) },
    guardado,
  }
}

describe('F033 — IPC app:preguntar sin clave de LLM: dice por qué, no se calla', () => {
  test('sin `sesion.motor`, la tarjeta dice que falta la clave (F021: sin JSON crudo)', () => {
    const s = sesionFalsa()
    const { manejador, pintado } = capturarManejador(s)

    const r = manejador(null, { it: 'Il budget copre la manutenzione', es: 'El presupuesto lo cubre' })

    assert.strictEqual(r.ok, true, 'la burbuja ya quedó "enviada": el clic sirvió de algo')
    assert.ok(r.id, 'abre una tarjeta, aunque no vaya a haber respuesta')

    const pregunta = pintado.find(p => p.canal === 'app:pregunta')
    const respuesta = pintado.find(p => p.canal === 'app:respuesta')
    assert.ok(pregunta, 'se pinta la tarjeta de la pregunta')
    assert.strictEqual(pregunta.datos.it, 'Il budget copre la manutenzione')

    assert.ok(respuesta, 'se dice algo, nunca se queda callado')
    assert.strictEqual(respuesta.datos.texto, null)
    assert.match(respuesta.datos.mensaje, /Sin clave de IA/)
    assert.match(respuesta.datos.mensaje, /Ajustes/)
    assert.doesNotMatch(respuesta.datos.mensaje, /[{}]/, 'nunca JSON crudo, F021')
  })

  test('sin reunión en marcha, también se dice —mismo contrato que "Otra"—', () => {
    const { manejador, pintado } = capturarManejador(null)

    const r = manejador(null, { it: 'Ciao', es: 'Hola' })

    assert.strictEqual(r.ok, false)
    const respuesta = pintado.find(p => p.canal === 'app:respuesta')
    assert.ok(respuesta)
    assert.strictEqual(respuesta.datos.error, undefined, 'contrato nuevo: `mensaje`, no `.error`')
    assert.match(respuesta.datos.mensaje, /reunión ya no está en marcha/)
  })

  test('con motor, se llama a `forzar()` y se pinta la pregunta que emite', () => {
    const emitidas = []
    const motor = {
      forzar: (it, es) => { emitidas.push({ it, es }); return 'q7' },
    }
    const s = sesionFalsa({ motor })
    const { manejador } = capturarManejador(s)

    const r = manejador(null, { it: 'Hai finito il report', es: '¿Terminaste el informe?' })

    assert.deepStrictEqual(r, { ok: true, id: 'q7' })
    assert.deepStrictEqual(emitidas, [{ it: 'Hai finito il report', es: '¿Terminaste el informe?' }])
  })
})

describe('F033 — cada pulsación queda registrada en el .jsonl, sea cual sea el resultado', () => {
  test('sin clave de LLM, igualmente se guarda con `manual: true`', () => {
    const s = sesionFalsa()
    const { manejador } = capturarManejador(s)

    manejador(null, { it: 'Il budget copre la manutenzione', es: 'El presupuesto lo cubre' })

    assert.strictEqual(s.guardado.length, 1)
    assert.deepStrictEqual(s.guardado[0], {
      it: 'Il budget copre la manutenzione', es: 'El presupuesto lo cubre', manual: true,
    })
  })

  test('con motor, también se guarda —es el intento del usuario, no la respuesta—', () => {
    const motor = { forzar: () => 'q1' }
    const s = sesionFalsa({ motor })
    const { manejador } = capturarManejador(s)

    manejador(null, { it: 'Hai finito il report', es: null })

    assert.strictEqual(s.guardado.length, 1)
    assert.strictEqual(s.guardado[0].manual, true)
  })

  test('tres pulsaciones en la misma sesión dejan tres líneas, no una', () => {
    const s = sesionFalsa()
    const { manejador } = capturarManejador(s)

    manejador(null, { it: 'uno' })
    manejador(null, { it: 'dos' })
    manejador(null, { it: 'tres' })

    assert.strictEqual(s.guardado.length, 3)
    assert.strictEqual(s.preguntasManuales, 3,
      'es el número que va en el resumen al parar: cuántas se le escapan al detector')
  })
})
