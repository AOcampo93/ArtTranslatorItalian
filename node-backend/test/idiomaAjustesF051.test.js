/**
 * F051 — lo que el proceso principal hace con el idioma, y con el nombre y la
 * carpeta de datos de la app.
 *
 *  (b) elegir idioma lo recuerda, precarga el Marian de ese idioma y suelta el de
 *      los demás; con una reunión en marcha no se cambia nada;
 *  (c) la ventana y el `.exe` dicen ArtTranslatorV2 y, empaquetada, `userData`
 *      apunta a la carpeta de siempre.
 *
 * La carpeta de siempre NO es `Traductor Italiano` (lo que decía el plan): es
 * `art-translator-italian-diagnostico`, que es la que Electron sacaba del `name` del
 * `package.json` empaquetado en la v0.9 por no traer `productName`. Cómo se
 * comprobó está en el comentario de `CARPETA_DE_DATOS` (`ajustes.js`).
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const traductor = require('../src/translator')
const { CARPETA_DE_DATOS, fijarCarpetaDeDatos, leerAjustes, elegirIdioma } = require('../src/ajustes')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const PAQUETE = require('../../electron-app/package.json')

const MARIAN_IT = 'Xenova/opus-mt-it-es'
const MARIAN_EN = 'Xenova/opus-mt-en-es'

/** Un módulo de Marian que apunta qué le piden, sin cargar ningún modelo. */
function traductorFalso () {
  const t = {
    cargados: [],
    soltados: [],
    cargar: async (...args) => { t.cargados.push(args) },
    descargar: async modelo => { t.soltados.push(modelo) },
  }
  return t
}

const rutaAjustes = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ajustes-f051-')), 'ajustes.json')

describe('F051 — elegir idioma', () => {
  test('criterio 2: se recuerda, se precarga el Marian de ese idioma y se suelta el de los demás', () => {
    const ruta = rutaAjustes()
    const t = traductorFalso()

    const r = elegirIdioma({ codigo: 'en', hayReunion: false, ruta, traductor: t })

    assert.deepStrictEqual(r, { ok: true, idioma: 'en' })
    assert.deepStrictEqual(leerAjustes(ruta), { idioma: 'en' }, 'el último idioma queda en ajustes.json')
    assert.deepStrictEqual(t.cargados, [[MARIAN_EN, 'hello']], 'se precarga el Marian del inglés')
    assert.deepStrictEqual(t.soltados, [MARIAN_IT], 'y se suelta el del italiano')

    // Volver al italiano lo hace al revés.
    elegirIdioma({ codigo: 'it', hayReunion: false, ruta, traductor: t })
    assert.deepStrictEqual(leerAjustes(ruta), { idioma: 'it' })
    assert.deepStrictEqual(t.cargados.at(-1), [MARIAN_IT, 'ciao'])
    assert.strictEqual(t.soltados.at(-1), MARIAN_EN)
  })

  test('criterio 2: con una reunión en marcha no se cambia nada; y un idioma que no existe no se toma por italiano', () => {
    const ruta = rutaAjustes()
    const t = traductorFalso()
    elegirIdioma({ codigo: 'it', hayReunion: false, ruta, traductor: t })
    t.cargados.length = 0
    t.soltados.length = 0

    const enMarcha = elegirIdioma({ codigo: 'en', hayReunion: true, ruta, traductor: t })
    assert.strictEqual(enMarcha.ok, false)
    assert.match(enMarcha.motivo, /reunión en marcha/)
    assert.deepStrictEqual(leerAjustes(ruta), { idioma: 'it' }, 'lo guardado no se toca')
    assert.deepStrictEqual([t.cargados, t.soltados], [[], []], 'y no se carga ni se suelta ningún modelo')

    for (const codigo of ['xx', undefined, null]) {
      const r = elegirIdioma({ codigo, hayReunion: false, ruta, traductor: t })
      assert.strictEqual(r.ok, false, `${String(codigo)} no es un idioma`)
    }
    assert.deepStrictEqual(leerAjustes(ruta), { idioma: 'it' })
  })

  test('soltar un Marian lo saca de memoria, y se puede volver a cargar', async () => {
    assert.strictEqual(traductor.estaListo(MARIAN_IT), false)
    await traductor.cargar(MARIAN_IT)
    assert.strictEqual(traductor.estaListo(MARIAN_IT), true)

    assert.strictEqual(await traductor.descargar(MARIAN_IT), true, 'había algo que soltar')
    assert.strictEqual(traductor.estaListo(MARIAN_IT), false)
    assert.strictEqual(await traductor.descargar(MARIAN_IT), false, 'soltarlo otra vez no rompe nada')

    const { es } = await traductor.traducir('Buongiorno a tutti.')
    assert.ok(es.length > 0, 'tras soltarlo, traducir lo vuelve a cargar')
    await traductor.descargar(MARIAN_IT)
  })
})

describe('F051 — nombre y carpeta de datos (PLAN.md §17.7)', () => {
  /** Un `app` de Electron de mentira que apunta los `setPath`. */
  function appFalsa (empaquetada) {
    const app = {
      isPackaged: empaquetada,
      puestos: [],
      getPath: nombre => {
        assert.strictEqual(nombre, 'appData')
        return path.join(os.tmpdir(), 'AppData', 'Roaming')
      },
      setPath: (nombre, ruta) => { app.puestos.push([nombre, ruta]) },
    }
    return app
  }

  test('criterio 3: empaquetada, userData apunta a la carpeta de siempre; en desarrollo no se toca', () => {
    const empaquetada = appFalsa(true)
    const ruta = fijarCarpetaDeDatos(empaquetada)
    const esperada = path.join(os.tmpdir(), 'AppData', 'Roaming', 'art-translator-italian-diagnostico')
    assert.strictEqual(ruta, esperada)
    assert.deepStrictEqual(empaquetada.puestos, [['userData', esperada]])
    assert.strictEqual(CARPETA_DE_DATOS, 'art-translator-italian-diagnostico')

    const desarrollo = appFalsa(false)
    assert.strictEqual(fijarCarpetaDeDatos(desarrollo), null)
    assert.deepStrictEqual(desarrollo.puestos, [], 'en desarrollo no cambia nada de lo que pasa hoy')
  })

  test('criterio 3: mainApp la fija al cargar el módulo —`userData` no se puede cambiar tras `ready`— y la ventana, el .exe y el appId dicen ArtTranslatorV2', () => {
    const fuente = fs.readFileSync(MAIN_APP, 'utf8')
    // F054 (ronda 2): la llamada lleva el «empaquetada» de `licencia.js` como segundo argumento.
    const iFijar = fuente.search(/^fijarCarpetaDeDatos\(app(?:, EMPAQUETADA)?\)$/m)
    assert.ok(iFijar > 0, 'mainApp.js tiene que llamar a fijarCarpetaDeDatos(app) al cargar')
    assert.ok(iFijar < fuente.indexOf('app.whenReady()'), 'y antes de `ready`')

    assert.match(fuente, /new BrowserWindow\(\{[\s\S]*?title: 'ArtTranslatorV2'/, 'el título de la ventana')
    assert.match(fs.readFileSync(APP_HTML, 'utf8'), /<title>ArtTranslatorV2<\/title>/, 'y el de la página, que lo pisa al cargar')
    assert.strictEqual(PAQUETE.build.productName, 'ArtTranslatorV2', 'el .exe y la carpeta del paquete')
    assert.strictEqual(PAQUETE.build.appId, 'com.arturoocampo.arttranslatorv2')
  })
})
