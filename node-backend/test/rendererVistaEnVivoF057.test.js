/**
 * F057 — la vista en vivo empieza limpia en cada reunión.
 *
 * Hasta ahora, al empezar otra reunión en la misma ejecución quedaban en pantalla
 * las burbujas, las preguntas, el contador y el resumen de la anterior, y con el
 * cambio de idioma se mezclaban italiano e inglés. Se limpia al EMPEZAR, no al
 * parar: parada la reunión, lo dicho todavía se puede leer.
 *
 * ## Cómo se prueba
 *
 * Como en `idiomaPantallaF051.test.js`: se ejecuta el `<script>` ENTERO de
 * `app.html` (en modo estricto, como en la ventana) contra un DOM de mentira armado
 * desde el marcado real, y los eventos del proceso principal (`alFrase`,
 * `alPregunta`…) los dispara la prueba por el mismo puente que usa la app. A
 * diferencia de aquel, el DOM de mentira SÍ quita los nodos con `remove()`: sin eso
 * no se vería si la pantalla quedó limpia.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const HTML = fs.readFileSync(APP_HTML, 'utf8')
const SCRIPT = HTML.slice(HTML.indexOf('<script>\n') + '<script>\n'.length, HTML.lastIndexOf('</script>'))

// ── Un DOM de mentira ────────────────────────────────────────────────────────

class Nodo {
  constructor (tag = 'div') {
    this.tag = tag
    this.id = ''
    this.hijos = []
    this.padre = null
    this._clases = new Set()
    this._texto = ''
    this.value = ''
    this.disabled = false
    this.placeholder = ''
    this.open = false
    this.dataset = {}
    this.escuchas = []
    // `abajo()` solo sigue el final si el usuario ya estaba abajo.
    this.scrollHeight = 0
    this.scrollTop = 0
    this.clientHeight = 0
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
  get textContent () { return this._texto + this.hijos.map(h => h.textContent).join('') }
  set textContent (v) { this._texto = String(v); this.hijos = [] }
  /** Solo entiende `<tag class="...">`, que es lo único que el renderer asigna por innerHTML. */
  set innerHTML (v) {
    this._texto = ''
    this.hijos = []
    for (const [, tag, clase] of String(v).matchAll(/<(\w+)(?:\s+class="([^"]*)")?\s*>/g)) {
      const n = new Nodo(tag)
      if (clase) n.className = clase
      this.append(n)
    }
  }

  append (...n) { for (const x of n) { x.padre = this; this.hijos.push(x) } }
  appendChild (n) { this.append(n); return n }
  prepend (n) { n.padre = this; this.hijos.unshift(n) }
  remove () {
    if (this.padre) this.padre.hijos = this.padre.hijos.filter(x => x !== this)
    this.padre = null
  }
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

/** Un nodo por cada elemento con `id` del marcado real, con sus clases y el texto que trae. */
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
    n.disabled = /\sdisabled(\s|$)/.test(m[2].replace(/"[^"]*"/g, '""'))
    n._texto = cuerpo.slice(m.index + m[0].length).match(/^[^<]*/)[0].trim()
    porId.set(id, n)
  }
  return porId
}

/**
 * Un puente con el proceso principal que guarda a quién avisar de cada evento:
 * `desde.frase({...})` es el proceso principal mandando una frase.
 */
function apiFalsa () {
  const desde = {}
  const api = {
    leerIdioma: async () => ({ idioma: null }),
    elegirIdioma: async codigo => ({ ok: true, idioma: codigo }),
    empezar: async () => ({ ok: true }),
    comprobar: async () => ({}),
    parar: async () => ({}),
    audio () {},
    listarPerfiles: async () => [],
    listarConversaciones: async () => [],
  }
  for (const [metodo, evento] of Object.entries({
    alParcial: 'parcial', alFrase: 'frase', alReemplazo: 'reemplazo', alPregunta: 'pregunta',
    alRespuesta: 'respuesta', alAvisoPreguntas: 'aviso', alContexto: 'contexto', alEstado: 'estado',
  })) api[metodo] = fn => { desde[evento] = fn }
  return { api, desde }
}

/** Ejecuta el `<script>` entero de `app.html` y devuelve cómo manejarlo. */
function montar (api) {
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
    { app: api }, document, { hash: '' }, CapturaAudio, consola)

  return {
    nodo,
    /** Pulsa como lo haría el usuario: un botón deshabilitado no recibe el clic. */
    async pulsar (id) {
      const n = nodo(id)
      if (n.disabled) return
      await n.onclick?.()
      for (const f of n.escuchas) await f()
      await new Promise(resolver => setImmediate(resolver))
    },
    burbujas: () => nodo('conversacion').querySelectorAll('.burbuja'),
    preguntas: () => nodo('listaPreguntas').hijos,
    visible: id => !nodo(id).classList.contains('oculto'),
  }
}

describe('F057 — la vista en vivo empieza limpia en cada reunión', () => {
  test('la reunión anterior sigue ahí al pararla, y al empezar otra no queda nada de ella', async () => {
    const { api, desde } = apiFalsa()
    const p = montar(api)

    // Primera reunión, en italiano: burbujas, preguntas y el resumen de «de qué se habla».
    await p.pulsar('elegir-it')
    p.nodo('pNombre').value = 'Omar'
    await p.pulsar('btnSaltar')
    await p.pulsar('btnEscuchar')

    desde.parcial('Dobbiamo rivedere')
    desde.frase({ id: 1, it: 'Il cliente ha chiesto di anticipare la consegna.', es: 'El cliente pidió adelantar la entrega.', ms: 400 })
    desde.frase({ id: 2, it: 'Dobbiamo rivedere i tempi.', es: 'Tenemos que revisar los plazos.', ms: 410 })
    desde.parcial('Quanto tempo')
    desde.pregunta({ id: 'q1', it: 'Quanto tempo ci vuole?', es: '¿Cuánto tiempo hace falta?' })
    desde.pregunta({ id: 'q2', it: 'Hai parlato con il team?', es: '¿Hablaste con el equipo?' })
    desde.contexto('Se negocia adelantar una entrega.')
    p.nodo('contexto').open = true

    assert.strictEqual(p.burbujas().length, 3, 'dos frases y una parcial')
    assert.strictEqual(p.preguntas().length, 2)
    assert.strictEqual(p.nodo('cuentaP').textContent, '2')
    assert.ok(p.visible('contexto'))
    assert.ok(!p.visible('vacio'))

    // Al PARAR no se limpia nada: el usuario todavía puede querer leerla.
    await p.pulsar('btnParar')
    assert.strictEqual(p.burbujas().length, 3, 'las burbujas siguen al parar')
    assert.strictEqual(p.preguntas().length, 2)
    assert.strictEqual(p.nodo('cuentaP').textContent, '2')

    // Segunda reunión, esta vez en inglés: «Cambiar idioma», preparar y escuchar de nuevo.
    await p.pulsar('cambiarIdioma')
    await p.pulsar('elegir-en')
    await p.pulsar('irNueva')
    await p.pulsar('btnSaltar')
    await p.pulsar('btnEscuchar')

    assert.strictEqual(p.burbujas().length, 0, 'ninguna burbuja de la reunión anterior')
    assert.strictEqual(p.preguntas().length, 0, 'ninguna pregunta')
    assert.strictEqual(p.nodo('cuentaP').textContent, '0', 'y el contador a cero')
    assert.ok(!p.visible('contexto'), 'el resumen de «de qué se habla» vuelve a ocultarse')
    assert.strictEqual(p.nodo('contexto').open, false, '...y plegado')
    assert.ok(!p.nodo('cuerpoContexto').textContent.includes('adelantar'), 'sin el texto de la anterior')
    assert.ok(p.visible('vacio'), 'vuelve el «Escuchando el audio de tu computadora»')
    assert.ok(!p.visible('retardo'), 'y el retardo de la anterior no se queda en la cabecera')

    // La reunión nueva se pinta limpia desde la primera palabra: lo que había en
    // curso (la parcial) no se queda enganchado a un nodo que ya no está.
    desde.parcial('Good morning')
    assert.strictEqual(p.burbujas().length, 1, 'la parcial nueva aparece')
    desde.frase({ id: 1, it: 'Good morning everyone.', es: 'Buenos días a todos.', ms: 380 })
    desde.pregunta({ id: 'q1', it: 'How long will it take?', es: '¿Cuánto tiempo te llevará?' })
    assert.deepStrictEqual(p.burbujas().map(b => b.querySelector('.it').textContent), ['Good morning everyone.'])
    assert.strictEqual(p.preguntas().length, 1)
    assert.strictEqual(p.nodo('cuentaP').textContent, '1', 'el contador cuenta desde uno')
  })
})
