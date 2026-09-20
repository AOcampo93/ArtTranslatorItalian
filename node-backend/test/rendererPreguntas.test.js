/**
 * Pruebas del panel de preguntas de la interfaz.
 *
 * ## Por qué esto se prueba aquí, y por qué así
 *
 * El último tramo del no negociable de esta tarea —**un fallo del LLM se
 * dice**— no está en el motor: está en la función que pinta la tarjeta. El
 * motor puede emitir `{ texto: null, error }` impecablemente y, si el renderer
 * no mira ese campo, la tarjeta se queda en «Preparando…» el resto de la
 * reunión. Es el fallo que no se ve mirando la pantalla, porque parece que la
 * respuesta aún viene en camino.
 *
 * El renderer vive dentro de `app.html` y el proyecto no trae jsdom, así que se
 * **extrae el bloque real del archivo** y se ejecuta contra un DOM mínimo. No
 * es una copia del código: si alguien cambia esas funciones, esto las ejerce
 * cambiadas; si alguien las saca del bloque, la extracción falla y se ve.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const DESDE = '// ── Preguntas ─'
const HASTA = '// ── Contexto general ─'

// ── Un DOM mínimo: lo justo que usan las tres funciones ─────────────────────

class Nodo {
  constructor (tag) {
    this.tag = tag
    this.id = ''
    this.hijos = []
    this.dataset = {}
    this.onclick = null
    this._clases = new Set()
    this._texto = ''
    this.classList = {
      add: (...c) => c.forEach(x => this._clases.add(x)),
      remove: (...c) => c.forEach(x => this._clases.delete(x)),
      contains: c => this._clases.has(c),
      toggle: (c, on) => {
        const poner = on === undefined ? !this._clases.has(c) : Boolean(on)
        poner ? this._clases.add(c) : this._clases.delete(c)
        return poner
      },
    }
  }

  get className () { return [...this._clases].join(' ') }
  set className (v) { this._clases = new Set(String(v).split(/\s+/).filter(Boolean)) }
  get textContent () { return this._texto }
  set textContent (v) { this._texto = String(v); this.hijos = [] }
  get oculto () { return this._clases.has('oculto') }

  append (...n) { this.hijos.push(...n) }
  prepend (...n) { this.hijos.unshift(...n) }

  /** Soporta `#id`, `.clase` y `.clase[data-x="y"]`, que es todo lo que se usa. */
  encaja (sel) {
    const id = sel.match(/^#([\w-]+)/)
    if (id) return this.id === id[1]
    const clase = sel.match(/^\.([\w-]+)/)
    if (clase && !this._clases.has(clase[1])) return false
    const attr = sel.match(/\[data-([\w-]+)="([^"]*)"\]/)
    if (attr && this.dataset[attr[1]] !== attr[2]) return false
    return Boolean(clase || attr)
  }

  querySelector (sel) {
    for (const h of this.hijos) {
      if (h.encaja(sel)) return h
      const dentro = h.querySelector(sel)
      if (dentro) return dentro
    }
    return null
  }
}

/** Monta el panel tal como está en el HTML y devuelve las funciones reales. */
function montarPanel () {
  const html = fs.readFileSync(APP_HTML, 'utf8')
  const i = html.indexOf(DESDE)
  const j = html.indexOf(HASTA)
  assert.ok(i > 0 && j > i, `no se encontró el bloque de preguntas en ${APP_HTML}`)
  const codigo = html.slice(i, j)

  const raiz = new Nodo('body')
  for (const id of ['cuentaP', 'listaPreguntas', 'avisoPreguntas']) {
    const n = new Nodo('div')
    n.id = id
    if (id === 'avisoPreguntas') n.classList.add('oculto')
    raiz.append(n)
  }

  const document = { createElement: t => new Nodo(t) }
  const $ = sel => (raiz.encaja(sel) ? raiz : raiz.querySelector(sel))
  const crear = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e }

  const copiado = []
  const pedidas = []
  const api = { otraRespuesta: id => pedidas.push(id) }
  const navigator = { clipboard: { writeText: t => copiado.push(t) } }

  const fabrica = new Function('$', 'crear', 'api', 'navigator', 'setTimeout',
    `${codigo}\n return { pintarPregunta, pintarRespuesta, pintarAvisoPreguntas }`)

  return {
    raiz,
    copiado,
    pedidas,
    tarjeta: id => raiz.querySelector(`.pregunta[data-id="${id}"]`),
    ...fabrica($, crear, api, navigator, () => {}),
  }
}

describe('el panel de preguntas', () => {
  before(() => { assert.ok(fs.existsSync(APP_HTML)) })

  test('la pregunta se pinta en italiano Y en español', () => {
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report', es: '¿Has terminado el informe?' })

    const t = p.tarjeta('q1')
    assert.ok(t, 'la tarjeta tiene que existir')
    assert.strictEqual(t.querySelector('.q').textContent, 'Hai finito il report')
    assert.strictEqual(t.querySelector('.qes').textContent, '¿Has terminado el informe?')
    assert.strictEqual(p.raiz.querySelector('#cuentaP').textContent, '1')
  })

  test('mientras no hay respuesta, la tarjeta dice que la está preparando', () => {
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report', es: '¿Has terminado?' })
    const r = p.tarjeta('q1').querySelector('.respuesta')
    assert.ok(r.classList.contains('cargando'))
    assert.match(r.textContent, /Preparando/)
  })

  test('la respuesta sustituye el «Preparando…» y va solo en italiano', () => {
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report', es: '¿Has terminado?' })
    p.pintarRespuesta({ id: 'q1', texto: 'Sì, l\'ho finito ieri.' })

    const r = p.tarjeta('q1').querySelector('.respuesta')
    assert.strictEqual(r.textContent, 'Sì, l\'ho finito ieri.')
    assert.strictEqual(r.classList.contains('cargando'), false)
    assert.strictEqual(r.classList.contains('mal'), false)
  })

  test('un fallo del modelo SE PINTA: no se queda en «Preparando…» (F021: solo `mensaje`, nunca JSON)', () => {
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report', es: '¿Has terminado?' })
    p.pintarRespuesta({
      id: 'q1', texto: null,
      tipo: 'sin_credito',
      mensaje: 'OpenAI no tiene crédito: hay que recargar la cuenta.',
      detalle: 'openai 429: {"error":{"type":"insufficient_quota"}}',
    })

    const r = p.tarjeta('q1').querySelector('.respuesta')
    assert.strictEqual(r.classList.contains('cargando'), false, 'sigue diciendo que prepara')
    assert.ok(r.classList.contains('mal'))
    assert.match(r.textContent, /crédito/)
    assert.match(r.textContent, /Otra/, 'hay que decirle qué puede hacer')
    assert.doesNotMatch(r.textContent, /[{}]/, 'la burbuja no lleva JSON del proveedor')
    assert.doesNotMatch(r.textContent, /insufficient_quota/, 'el nombre de campo del proveedor no va en la burbuja')
  })

  test('el detalle técnico va APARTE, plegado, y solo aparece si lo hay', () => {
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report' })
    p.pintarRespuesta({
      id: 'q1', texto: null, tipo: 'desconocido',
      mensaje: 'Ocurrió un error desconocido al pedir la respuesta.',
      detalle: 'openai 500: internal server error',
    })

    const t = p.tarjeta('q1')
    const verDetalle = t.querySelector('.verDetalle')
    const caja = t.querySelector('.detalleError')

    assert.strictEqual(verDetalle.classList.contains('oculto'), false, 'hay detalle: el botón se enseña')
    assert.strictEqual(caja.classList.contains('oculto'), true, 'empieza plegado')
    assert.strictEqual(caja.textContent, 'openai 500: internal server error')

    verDetalle.onclick()
    assert.strictEqual(caja.classList.contains('oculto'), false, 'un clic lo despliega')
    verDetalle.onclick()
    assert.strictEqual(caja.classList.contains('oculto'), true, 'y otro lo vuelve a plegar')
  })

  test('sin detalle, el botón «Ver detalle» no se enseña', () => {
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report' })
    p.pintarRespuesta({ id: 'q1', texto: null, mensaje: 'Sin conexión a Internet.' })

    const t = p.tarjeta('q1')
    assert.strictEqual(t.querySelector('.verDetalle').classList.contains('oculto'), true)
    assert.strictEqual(t.querySelector('.detalleError').classList.contains('oculto'), true)
  })

  test('una respuesta buena esconde el «Ver detalle» de un fallo anterior', () => {
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report' })
    p.pintarRespuesta({ id: 'q1', texto: null, mensaje: 'Sin conexión a Internet.', detalle: 'ECONNREFUSED' })
    p.pintarRespuesta({ id: 'q1', texto: 'Sì, l\'ho finito ieri.' })

    const t = p.tarjeta('q1')
    assert.strictEqual(t.querySelector('.verDetalle').classList.contains('oculto'), true)
    assert.strictEqual(t.querySelector('.detalleError').classList.contains('oculto'), true)
  })

  test('un fallo sin mensaje también se pinta, con un motivo genérico', () => {
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report' })
    p.pintarRespuesta({ id: 'q1', texto: null })

    const r = p.tarjeta('q1').querySelector('.respuesta')
    assert.ok(r.classList.contains('mal'))
    assert.match(r.textContent, /no contestó/)
  })

  test('una respuesta para una tarjeta que no existe no rompe nada', () => {
    const p = montarPanel()
    p.pintarRespuesta({ id: 'q99', texto: 'ciao' })
    assert.strictEqual(p.tarjeta('q99'), null)
  })

  test('el aviso de «falta la clave» se enseña y se puede quitar', () => {
    const p = montarPanel()
    const a = p.raiz.querySelector('#avisoPreguntas')
    assert.strictEqual(a.oculto, true, 'empieza oculto')

    p.pintarAvisoPreguntas('Para ver aquí respuestas sugeridas, añade una clave en Ajustes.')
    assert.strictEqual(a.oculto, false)
    assert.match(a.textContent, /clave/)

    p.pintarAvisoPreguntas('')
    assert.strictEqual(a.oculto, true)
  })

  test('«Copiar» no copia un aviso de fallo al portapapeles', () => {
    // Se copia para pegarlo en el chat de la reunión: copiar el aviso de
    // fallo es peor que no copiar nada.
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report' })
    const copiar = p.tarjeta('q1').querySelector('.acciones').hijos[0]

    copiar.onclick()                                   // aún «Preparando…»
    p.pintarRespuesta({ id: 'q1', texto: null, mensaje: 'Sin conexión a Internet.' })
    copiar.onclick()                                   // ahora un fallo
    assert.deepStrictEqual(p.copiado, [])

    p.pintarRespuesta({ id: 'q1', texto: 'Sì, certo.' })
    copiar.onclick()
    assert.deepStrictEqual(p.copiado, ['Sì, certo.'])
  })

  test('«Otra» vuelve a poner «Preparando…» y pide otra redacción', () => {
    const p = montarPanel()
    p.pintarPregunta({ id: 'q1', it: 'Hai finito il report' })
    p.pintarRespuesta({ id: 'q1', texto: null, mensaje: 'Sin conexión a Internet.' })

    const otra = p.tarjeta('q1').querySelector('.acciones').hijos[1]
    otra.onclick()

    const r = p.tarjeta('q1').querySelector('.respuesta')
    assert.ok(r.classList.contains('cargando'))
    assert.strictEqual(r.classList.contains('mal'), false)
    assert.deepStrictEqual(p.pedidas, ['q1'])
  })
})
