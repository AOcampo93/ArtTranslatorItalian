/**
 * Pruebas del punto donde la frase se convierte en número: el manejador de
 * `frase` de `mainApp.js`.
 *
 * ## Por qué se prueba aquí, y por qué así
 *
 * En la primera prueba real las 21 frases se guardaron con `ms` idéntico a
 * `msTraducir` y `msTranscribir: null`. El cronómetro arrancaba cuando el texto
 * YA había llegado, así que lo que el usuario leía como «retardo» era sólo la
 * pierna local y **subestimaba** lo que sentía — que es la dirección peligrosa
 * de equivocarse, porque un número optimista no se investiga.
 *
 * Ese defecto no vive en el transcriptor ni en el traductor: vive en las cinco
 * líneas de `mainApp.js` que arman la frase. Y `mainApp.js` no se puede
 * `require` desde una prueba, porque lo primero que hace es pedir `electron`.
 * Así que se **extrae el manejador real del archivo** y se ejecuta con piezas
 * de mentira alrededor, igual que se hace con el panel de preguntas del
 * renderer. No es una copia del código: si alguien lo cambia, esto lo ejerce
 * cambiado; si alguien lo saca de su sitio, la extracción falla y se ve.
 *
 * El autoguardado NO se finge: se escribe un `.jsonl` de verdad en un
 * directorio temporal y se lee de vuelta, porque el criterio es justo sobre lo
 * que queda escrito en disco.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const { Autosave } = require('../src/autosave')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const DESDE = "transcriptor.on('frase'"
const HASTA = "transcriptor.on('estado'"

const esperar = ms => new Promise(r => setTimeout(r, ms))

/** Espera a que se cumpla algo, en vez de dormir una cifra al azar. */
async function hasta (cond, queEsperaba) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await esperar(5)
  }
  assert.fail(`nunca ocurrió: ${queEsperaba}`)
}

/**
 * Monta el manejador real con un traductor, un renderer y una sesión falsos,
 * y un autoguardado de verdad sobre un directorio temporal.
 */
function montar ({ traducir }) {
  const fuente = fs.readFileSync(MAIN_APP, 'utf8')
  const i = fuente.indexOf(DESDE)
  const j = fuente.indexOf(HASTA)
  assert.ok(i > 0 && j > i, `no se encontró el manejador de frase en ${MAIN_APP}`)
  const codigo = fuente.slice(i, j)

  const directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'arttranslator-frase-'))
  const autosave = new Autosave({ directorio, idSesion: 'prueba' })
  autosave.abrir()

  const transcriptor = new EventEmitter()
  const pintado = []
  // Se apunta cuántas líneas había YA en el archivo en el instante de pintar:
  // es la única forma de comprobar el orden entre disco y pantalla sin
  // fiarse de leer el código.
  const aRenderer = (canal, datos) => pintado.push({
    canal, datos, lineasEnDisco: Autosave.leer(autosave.ruta).entradas.length,
  })
  const sesion = { frases: 0, motor: null, resumen: null }
  const traductor = { traducir }

  const fabrica = new Function('transcriptor', 'traductor', 'sesion', 'autosave', 'aRenderer',
    'console', codigo)
  fabrica(transcriptor, traductor, sesion, autosave, aRenderer, { error: () => {} })

  return {
    transcriptor,
    pintado,
    sesion,
    guardadas: () => Autosave.leer(autosave.ruta).entradas,
    burbujas: () => pintado.filter(x => x.canal === 'app:frase').map(x => x.datos),
    cerrar: () => { autosave.cerrar(); fs.rmSync(directorio, { recursive: true, force: true }) },
  }
}

describe('la frase que se guarda y se pinta', () => {
  before(() => { assert.ok(fs.existsSync(MAIN_APP)) })

  test('el .jsonl guarda las DOS piernas: nunca más un msTranscribir en null', async () => {
    const m = montar({ traducir: async () => ({ es: 'Tenía fiebre a 39.', ms: 7 }) })
    m.transcriptor.emit('frase', { texto: 'Avevo la febbre a 39.', msTranscribir: 412 })
    await hasta(() => m.guardadas().length === 1, 'que la frase llegue al disco')

    const e = m.guardadas()[0]
    assert.strictEqual(e.msTranscribir, 412, 'la pierna de oír se guarda tal cual')
    assert.strictEqual(typeof e.msTraducir, 'number')
    assert.strictEqual(e.forzado, false, 'hay que poder distinguir las frases troceadas')
    assert.ok(Object.values(e).every(v => v !== null), `hay un null en ${JSON.stringify(e)}`)
    m.cerrar()
  })

  test('el retardo guardado es la SUMA de oír y traducir, con reloj de pared', async () => {
    // Con el defecto viejo este número sería sólo el de traducir, o sea ~60 ms
    // cuando el usuario ha esperado ~470.
    //
    // Y el modelo declara MENOS de lo que tarda de verdad, a propósito: es la
    // única forma de distinguir el reloj de pared de `tr.ms`. Si se midiera con
    // lo que el modelo dice, la espera de una frase encolada detrás de otra
    // —que el usuario sufre— no aparecería en ninguna cifra. El umbral tiene
    // que ser DECLARADO estricto: ponerlo en `>= DECLARADO` deja pasar `tr.ms`,
    // que es exactamente lo que se quiere cazar.
    const DECLARADO = 55     // lo que el modelo dice que ha tardado
    const DORMIDO = 60       // lo que tarda de verdad
    const m = montar({
      traducir: async () => {
        await esperar(DORMIDO)
        return { es: 'Y la puerta se abrió.', ms: DECLARADO }
      },
    })
    m.transcriptor.emit('frase', { texto: 'E la porta si è aperta.', msTranscribir: 412 })
    await hasta(() => m.guardadas().length === 1, 'que la frase llegue al disco')

    const e = m.guardadas()[0]
    assert.ok(e.msTraducir > DECLARADO,
      `el reloj de pared tiene que pasar de los ${DECLARADO} ms que declara el modelo; `
      + `midió ${e.msTraducir}`)
    assert.ok(e.msTraducir >= DORMIDO - 5,
      `tardó ${DORMIDO} ms de verdad y midió ${e.msTraducir}`)
    assert.strictEqual(e.ms, e.msTranscribir + e.msTraducir, 'el total tiene que ser la suma')
    assert.ok(e.ms > 412, 'el total no puede ser menor que la pierna de oír')
    m.cerrar()
  })

  test('una frase de turno troceado queda marcada en el archivo', async () => {
    // Sin esta marca, en la próxima reunión real no se podría contar cuántas
    // frases parte el troceo, que es su único coste conocido.
    const m = montar({ traducir: async () => ({ es: 'Porque si no puede abrir', ms: 9 }) })
    m.transcriptor.emit('frase', {
      texto: 'Perché se non riesce ad aprire', msTranscribir: 260, forzado: true,
    })
    await hasta(() => m.guardadas().length === 1, 'que la frase llegue al disco')
    assert.strictEqual(m.guardadas()[0].forzado, true)
    m.cerrar()
  })

  test('la burbuja recibe exactamente lo mismo que el disco', async () => {
    // Si se separan, el usuario ve un número y el informe dice otro.
    const m = montar({ traducir: async () => ({ es: '¡Bravo!', ms: 3 }) })
    m.transcriptor.emit('frase', { texto: 'Brava!', msTranscribir: 201 })
    await hasta(() => m.burbujas().length === 1, 'que la burbuja salga')

    const e = m.guardadas()[0]
    const b = m.burbujas()[0]
    for (const campo of ['it', 'es', 'ms', 'msTranscribir', 'msTraducir', 'forzado']) {
      assert.deepStrictEqual(b[campo], e[campo], `el campo ${campo} no coincide`)
    }
    assert.strictEqual(m.sesion.frases, 1)
    m.cerrar()
  })

  test('el disco va ANTES que la pantalla (no negociable §0.3)', async () => {
    // Si la app muere repintando, la frase tiene que estar ya a salvo. Se
    // comprueba mirando el archivo en el instante mismo de pintar: con las dos
    // líneas al revés, aquí habría cero.
    const m = montar({ traducir: async () => ({ es: 'hola', ms: 1 }) })
    m.transcriptor.emit('frase', { texto: 'ciao', msTranscribir: 100 })
    await hasta(() => m.burbujas().length === 1, 'que la burbuja salga')

    const pintadaLaFrase = m.pintado.find(x => x.canal === 'app:frase')
    assert.strictEqual(pintadaLaFrase.lineasEnDisco, 1,
      'se pintó antes de que la frase estuviera escrita')
    m.cerrar()
  })

  test('si la traducción falla no se guarda una frase a medias, y se dice', async () => {
    const m = montar({ traducir: async () => { throw new Error('modelo no cargado') } })
    m.transcriptor.emit('frase', { texto: 'Cocciuta.', msTranscribir: 300 })
    await hasta(() => m.pintado.length > 0, 'que el fallo se cuente en pantalla')

    assert.deepStrictEqual(m.guardadas(), [], 'nada a medias en el archivo')
    const aviso = m.pintado.find(x => x.canal === 'app:estado')
    assert.match(aviso.datos.texto, /no se pudo traducir: modelo no cargado/)
    m.cerrar()
  })
})
