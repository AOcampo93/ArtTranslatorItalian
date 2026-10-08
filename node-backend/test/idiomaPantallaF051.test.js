/**
 * F051 — la pantalla de idioma, de punta a punta en el renderer.
 *
 * Cubre los criterios de aceptación que se ven en la interfaz:
 *
 *  (a) al abrir solo se ve la pantalla de idioma; al elegir inglés, el panel de
 *      inicio muestra EN → ES y «Cambiar idioma»;
 *  (b) el idioma elegido llega a `empezar` y a `comprobar`, y con la escucha activa
 *      no se puede cambiar;
 *  (d) Conversaciones etiqueta IT/EN, y una reunión vieja sin idioma sale como IT.
 *
 * ## Cómo se prueba
 *
 * Las demás pruebas del renderer extraen un tramo de `app.html` y lo ejecutan con
 * los nombres que ese tramo necesita. Esta necesita el recorrido ENTERO —abrir,
 * elegir, comprobar, escuchar, detener—, así que ejecuta el `<script>` completo
 * contra un DOM de mentira armado desde el MARCADO real: cada elemento con `id`
 * nace con las clases que trae el HTML (`oculto` incluido). Así «al abrir solo se
 * ve #idioma» se comprueba sobre lo que de verdad nace visible, y no sobre lo que
 * la prueba cree que nace visible.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { Autosave } = require('../src/autosave')
const { percentil, duracionMs, costeStt, costeLlm } = require('../src/coste')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const HTML = fs.readFileSync(APP_HTML, 'utf8')
const SCRIPT = HTML.slice(HTML.indexOf('<script>\n') + '<script>\n'.length, HTML.lastIndexOf('</script>'))

/** Las pantallas que ocupan la ventana, en el orden del marcado. */
const PANTALLAS = ['idioma', 'inicio', 'preparar', 'perfiles', 'conversaciones', 'envivo']

// ── Un DOM de mentira ────────────────────────────────────────────────────────

class Nodo {
  constructor (tag = 'div') {
    this.tag = tag
    this.id = ''
    this.hijos = []
    this._clases = new Set()
    this._texto = ''
    this.value = ''
    this.disabled = false
    this.placeholder = ''
    this.escuchas = []
    this.classList = {
      add: (...c) => c.forEach(x => this._clases.add(x)),
      remove: (...c) => c.forEach(x => this._clases.delete(x)),
      contains: c => this._clases.has(c),
      toggle: (c, forzar) => {
        const poner = forzar === undefined ? !this._clases.has(c) : Boolean(forzar)
        if (poner) this._clases.add(c); else this._clases.delete(c)
        return poner
      },
    }
  }

  get className () { return [...this._clases].join(' ') }
  set className (v) { this._clases = new Set(String(v).split(/\s+/).filter(Boolean)) }
  // Como el DOM de verdad: el texto propio más el de los hijos.
  get textContent () { return this._texto + this.hijos.map(h => h.textContent).join('') }
  set textContent (v) { this._texto = String(v); this.hijos = [] }
  set innerHTML (v) { this._texto = ''; this.hijos = [] }

  append (...n) { this.hijos.push(...n) }
  appendChild (n) { this.hijos.push(n); return n }
  prepend (n) { this.hijos.unshift(n) }
  remove () {}
  addEventListener (tipo, fn) { if (tipo === 'click') this.escuchas.push(fn) }

  encaja (sel) {
    const id = sel.match(/^#([\w-]+)/)
    if (id) return this.id === id[1]
    const clase = sel.match(/^\.([\w-]+)/)
    return Boolean(clase) && this._clases.has(clase[1])
  }

  querySelector (sel) {
    for (const h of this.hijos) {
      if (h.encaja(sel)) return h
      const dentro = h.querySelector(sel)
      if (dentro) return dentro
    }
    return null
  }

  querySelectorAll (sel) {
    const r = []
    for (const h of this.hijos) {
      if (h.encaja(sel)) r.push(h)
      r.push(...h.querySelectorAll(sel))
    }
    return r
  }
}

/**
 * Un nodo por cada elemento con `id` del marcado real, con sus clases, su `disabled`,
 * su `placeholder` y el texto que trae antes de su primer hijo.
 */
function nodosDelMarcado () {
  const cuerpo = HTML.slice(HTML.indexOf('<body>'), HTML.indexOf('<script src="audio.js">'))
    .replace(/<!--[\s\S]*?-->/g, '')
  const porId = new Map()
  for (const m of cuerpo.matchAll(/<([a-z0-9]+)\b([^>]*)>/g)) {
    const id = m[2].match(/\bid="([^"]+)"/)?.[1]
    if (!id) continue
    const n = new Nodo(m[1])
    n.id = id
    n.className = m[2].match(/\bclass="([^"]*)"/)?.[1] || ''
    n.placeholder = m[2].match(/\bplaceholder="([^"]*)"/)?.[1] || ''
    n.disabled = /\sdisabled(\s|$)/.test(m[2].replace(/"[^"]*"/g, '""'))
    n._texto = cuerpo.slice(m.index + m[0].length).match(/^[^<]*/)[0].trim()
    porId.set(id, n)
  }
  return porId
}

/** Ejecuta el `<script>` entero de `app.html` y devuelve cómo manejarlo. */
function montar ({ api = null, hash = '' } = {}) {
  const porId = nodosDelMarcado()
  const nodo = id => {
    const n = porId.get(id)
    assert.ok(n, `no hay ningún elemento con id="${id}" en el marcado`)
    return n
  }

  const document = {
    querySelector: sel => porId.get(sel.match(/^#([\w-]+)/)?.[1]) || null,
    querySelectorAll: () => [],
    createElement: tag => new Nodo(tag),
  }
  class CapturaAudio {
    static soportado () { return false }
    static nivel () { return 0 }
    async empezar () { return { entradaHz: 48000, salidaHz: 16000, etiqueta: 'de prueba' } }
    detener () {}
  }
  const consola = { log () {}, warn () {}, error () {} }

  new Function('window', 'document', 'location', 'CapturaAudio', 'console', SCRIPT)(
    { app: api }, document, { hash }, CapturaAudio, consola)

  const asentar = () => new Promise(resolver => setImmediate(resolver))
  return {
    nodo,
    /** Pulsa como lo haría el usuario: un botón deshabilitado no recibe el clic. */
    async pulsar (id) {
      const n = nodo(id)
      if (n.disabled) return
      await n.onclick?.()
      for (const f of n.escuchas) await f()
      await asentar()
    },
    texto: id => nodo(id).textContent,
    visibles: () => PANTALLAS.filter(id => !nodo(id).classList.contains('oculto')),
    asentar,
  }
}

/** Un puente con el proceso principal que apunta lo que le llega. */
function apiFalsa (sobre = {}) {
  const llamadas = { elegirIdioma: [], empezar: [], comprobar: [] }
  const api = {
    leerIdioma: async () => ({ idioma: null }),
    elegirIdioma: async codigo => { llamadas.elegirIdioma.push(codigo); return { ok: true, idioma: codigo } },
    empezar: async datos => { llamadas.empezar.push(datos); return { ok: true } },
    comprobar: async datos => { llamadas.comprobar.push(datos); return {} },
    parar: async () => ({}),
    audio () {},
    listarPerfiles: async () => [],
    listarConversaciones: async () => [],
    alParcial () {}, alFrase () {}, alReemplazo () {}, alPregunta () {},
    alRespuesta () {}, alAvisoPreguntas () {}, alContexto () {}, alEstado () {},
    ...sobre,
  }
  return { api, llamadas }
}

// ── (a) La pantalla de idioma, primero ───────────────────────────────────────

describe('F051 — la pantalla de idioma es lo primero que se ve', () => {
  test('criterio 1: al abrir solo se ve #idioma; al elegir inglés, el panel de inicio con EN → ES y «Cambiar idioma»', async () => {
    const p = montar()
    assert.deepStrictEqual(p.visibles(), ['idioma'], 'al abrir solo puede verse la pantalla de idioma')
    assert.match(p.texto('elegir-it'), /^Italiano → Español/)
    assert.match(p.texto('elegir-en'), /^Inglés → Español/)

    await p.pulsar('elegir-en')

    assert.deepStrictEqual(p.visibles(), ['inicio'], 'elegido el idioma, se entra al panel de inicio de siempre')
    assert.strictEqual(p.texto('chipIdioma'), 'EN → ES')
    assert.strictEqual(p.texto('cambiarIdioma'), 'Cambiar idioma')
    // Los textos que nombraban el italiano siguen al idioma elegido.
    assert.match(p.texto('subInicio'), /del inglés/)
    assert.match(p.texto('textoVacio'), /en inglés/)
    assert.match(p.nodo('pContexto').placeholder, /inglés/)
    assert.match(p.nodo('pfContexto').placeholder, /inglés/)

    // «Cambiar idioma» vuelve a la pantalla de idioma, con el elegido marcado.
    await p.pulsar('cambiarIdioma')
    assert.deepStrictEqual(p.visibles(), ['idioma'])
    assert.ok(p.nodo('elegir-en').classList.contains('sel'), 'el inglés sale marcado')
    assert.ok(!p.nodo('elegir-it').classList.contains('sel'), 'y el italiano no')

    // Y volver al italiano devuelve cada texto a como estaba.
    await p.pulsar('elegir-it')
    assert.strictEqual(p.texto('chipIdioma'), 'IT → ES')
    assert.match(p.texto('subInicio'), /del italiano/)
    assert.match(p.texto('textoVacio'), /en italiano/)
  })

  test('el último idioma elegido, recordado por el proceso principal, sale marcado al abrir', async () => {
    const { api } = apiFalsa({ leerIdioma: async () => ({ idioma: 'en' }) })
    const p = montar({ api })
    await p.asentar()

    assert.deepStrictEqual(p.visibles(), ['idioma'], 'la pantalla sale en cada arranque, haya recuerdo o no')
    assert.ok(p.nodo('elegir-en').classList.contains('sel'))
    assert.ok(!p.nodo('ultimo-en').classList.contains('oculto'), 'dice «Último elegido», no solo lo pinta de verde')
    assert.ok(!p.nodo('elegir-it').classList.contains('sel'))
    assert.ok(p.nodo('ultimo-it').classList.contains('oculto'))
  })
})

// ── (b) El idioma llega a empezar y a comprobar; escuchando no se cambia ─────

describe('F051 — el idioma elegido viaja con la reunión', () => {
  test('criterio 2: «Comprobar» y «Escuchar» mandan el idioma elegido', async () => {
    for (const codigo of ['it', 'en']) {
      const { api, llamadas } = apiFalsa()
      const p = montar({ api })
      await p.pulsar(`elegir-${codigo}`)
      assert.deepStrictEqual(llamadas.elegirIdioma, [codigo], 'el proceso principal se entera de la elección')

      p.nodo('pNombre').value = 'Omar'
      await p.pulsar('btnProbar')
      assert.strictEqual(llamadas.comprobar.length, 1)
      assert.strictEqual(llamadas.comprobar[0].idioma, codigo, '`comprobar` recibe el idioma elegido')

      await p.pulsar('btnEscuchar')
      assert.strictEqual(llamadas.empezar.length, 1)
      assert.strictEqual(llamadas.empezar[0].idioma, codigo, '`empezar` recibe el idioma elegido')
      assert.deepStrictEqual(p.visibles(), ['envivo'])
    }
  })

  test('criterio 2: con la escucha activa no se puede cambiar, y al detenerla sí', async () => {
    const { api, llamadas } = apiFalsa()
    const p = montar({ api })
    await p.pulsar('elegir-en')
    p.nodo('pNombre').value = 'Omar'
    await p.pulsar('btnSaltar')
    await p.pulsar('btnEscuchar')
    assert.deepStrictEqual(p.visibles(), ['envivo'], 'escuchando')

    // El botón vive en el panel de inicio, que escuchando no se ve; la puerta es
    // independiente de eso, así que se fuerzan los dos caminos.
    await p.pulsar('cambiarIdioma')
    await p.pulsar('elegir-it')
    assert.deepStrictEqual(p.visibles(), ['envivo'], 'la pantalla de idioma no se abre escuchando')
    assert.deepStrictEqual(llamadas.elegirIdioma, ['en'], 'ni se le pide al proceso principal otro idioma')
    assert.strictEqual(p.texto('chipIdioma'), 'EN → ES')

    await p.pulsar('btnParar')
    await p.pulsar('cambiarIdioma')
    assert.deepStrictEqual(p.visibles(), ['idioma'], 'parada la escucha, vuelve a poderse')
  })

  test('si el proceso principal se niega, el idioma no cambia y se dice por qué', async () => {
    const motivo = 'Hay una reunión en marcha. Detenla para cambiar de idioma.'
    const { api } = apiFalsa({ elegirIdioma: async () => ({ ok: false, motivo }) })
    const p = montar({ api })

    await p.pulsar('elegir-en')

    assert.deepStrictEqual(p.visibles(), ['idioma'], 'se queda en la pantalla de idioma')
    assert.strictEqual(p.texto('avisoIdioma'), motivo)
    assert.ok(!p.nodo('avisoIdioma').classList.contains('oculto'))
    assert.strictEqual(p.texto('chipIdioma'), 'IT → ES')
  })
})

// ── (d) La etiqueta de idioma de Conversaciones ──────────────────────────────

describe('F051 — Conversaciones etiqueta cada reunión con su idioma', () => {
  /** El tramo real de `listarConversaciones` de `mainApp.js`, sobre las reuniones de `userData`. */
  function listadorReal (userData) {
    const fuente = fs.readFileSync(MAIN_APP, 'utf8')
    const i = fuente.indexOf('function listarConversaciones')
    const j = fuente.indexOf("ipcMain.handle('app:listarConversaciones'", i)
    assert.ok(i > 0 && j > i, 'no se encontró listarConversaciones en mainApp.js')
    return new Function('Autosave', 'path', 'app', 'console', 'percentil', 'duracionMs', 'costeStt', 'costeLlm',
      `${fuente.slice(i, j)}\n return listarConversaciones`)(
      Autosave, path, { getPath: () => userData }, console, percentil, duracionMs, costeStt, costeLlm)
  }

  test('criterio 4: la lista y el detalle dicen IT o EN; una reunión vieja sin idioma sale como IT', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'idioma-f051-'))
    const dir = path.join(userData, 'reuniones')
    fs.mkdirSync(dir, { recursive: true })

    // Una reunión de antes de la V2: la cabecera NO trae `idioma`.
    fs.writeFileSync(path.join(dir, 'sesion-vieja.jsonl'), [
      { tipo: 'cabecera', inicio: '2026-09-19T10:15:00.000Z', perfil: { nombre: 'Omar' }, contexto: { nombre: 'Rossi vieja' } },
      { tipo: 'frase', it: 'Ciao', es: 'Hola', t: 1, ms: 300 },
    ].map(l => JSON.stringify(l)).join('\n') + '\n')

    // Una de la V2 en inglés, escrita por el autoguardado de verdad.
    const a = new Autosave({ directorio: dir, idSesion: '2', inicio: new Date('2026-10-08T09:00:00Z') })
    a.abrir()
    a.guardarCabecera({ perfil: { nombre: 'Omar' }, contexto: { nombre: 'Acme inglesa' }, idioma: 'en' })
    a.guardarFrase({ it: 'Good morning', es: 'Buenos días' })
    a.cerrar()

    const listar = listadorReal(userData)
    const lista = listar()
    const { api } = apiFalsa({
      listarConversaciones: async () => lista,
      leerConversacion: async ruta => ({
        idioma: lista.find(c => c.ruta === ruta).idioma,
        frases: [{ it: 'Good morning', es: 'Buenos días' }], preguntas: [],
      }),
    })
    const p = montar({ api })
    await p.pulsar('elegir-it')
    await p.pulsar('irConversaciones')

    const filas = p.nodo('listaConversaciones').querySelectorAll('.tarjeta-lista')
    assert.strictEqual(filas.length, 2)
    const etiquetaDe = contiene => {
      const fila = filas.find(f => f.querySelector('.titulo-fila').textContent.includes(contiene))
      return fila.querySelector('.badge-idioma').textContent
    }
    assert.strictEqual(etiquetaDe('Rossi vieja'), 'IT', 'la reunión vieja, sin idioma en la cabecera, es IT')
    assert.strictEqual(etiquetaDe('Acme inglesa'), 'EN')

    // El detalle lleva la misma etiqueta.
    const fila = filas.find(f => f.querySelector('.titulo-fila').textContent.includes('Acme inglesa'))
    await fila.querySelector('.ver-fila').onclick()
    assert.strictEqual(p.nodo('detalleConversacion').querySelector('.badge-idioma').textContent, 'EN')
  })
})
