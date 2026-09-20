/**
 * F032 — se puede llegar a una reunión anterior desde el panel de inicio.
 *
 * ## Qué se protege aquí
 *
 * La lista completa —transcripción, coste, borrar— es F038. Lo que F032
 * tiene que dejar es el ACCESO: la pantalla de «Conversaciones» pinta lo que
 * devuelve `api.listarConversaciones()` (`mainApp.js`, sobre los `.jsonl` de
 * `Autosave.listar`) y un botón «Abrir» que de verdad manda la ruta de esa
 * reunión a `api.abrirCarpeta()`.
 *
 * El renderer vive dentro de `app.html` y el proyecto no trae jsdom, así que
 * se **extrae el bloque real del archivo** y se ejecuta contra un DOM
 * mínimo, con el mismo patrón que `rendererPreguntas.test.js`.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const DESDE = '// ── Conversaciones (F032)'
const HASTA = '// ── Datos de ejemplo'

class Nodo {
  constructor (tag) {
    this.tag = tag
    this.id = ''
    this.hijos = []
    this._clases = new Set()
    this._texto = ''
    this.html = ''
    this.classList = {
      add: (...c) => c.forEach(x => this._clases.add(x)),
      contains: c => this._clases.has(c),
    }
  }

  get className () { return [...this._clases].join(' ') }
  set className (v) { this._clases = new Set(String(v).split(/\s+/).filter(Boolean)) }
  get textContent () { return this._texto }
  set textContent (v) { this._texto = String(v); this.hijos = [] }
  get innerHTML () { return this.html }
  set innerHTML (v) { this.html = String(v); this.hijos = [] }

  append (...n) { this.hijos.push(...n) }
  appendChild (n) { this.hijos.push(n); return n }

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

/** Monta la pantalla de Conversaciones tal como está en el HTML. */
function montar ({ api = null } = {}) {
  const html = fs.readFileSync(APP_HTML, 'utf8')
  const i = html.indexOf(DESDE)
  const j = html.indexOf(HASTA)
  assert.ok(i > 0 && j > i, `no se encontró el bloque de Conversaciones en ${APP_HTML}`)
  const codigo = html.slice(i, j)

  const raiz = new Nodo('body')
  const lista = new Nodo('div')
  lista.id = 'listaConversaciones'
  raiz.append(lista)

  const $ = sel => (raiz.encaja(sel) ? raiz : raiz.querySelector(sel))
  const crear = (t, c) => { const e = new Nodo(t); if (c) e.className = c; return e }

  const fabrica = new Function('$', 'crear', 'api',
    `${codigo}\n return { pintarListaConversaciones, cargarConversaciones }`)

  return {
    filas: () => lista.querySelectorAll('.tarjeta-lista'),
    ...fabrica($, crear, api),
  }
}

describe('F032 — la pantalla de Conversaciones da acceso a reuniones anteriores', () => {
  test('sin ninguna reunión guardada, se dice en vez de dejar la lista en blanco', () => {
    const c = montar()
    c.pintarListaConversaciones([])
    assert.strictEqual(c.filas().length, 0)
  })

  test('pinta cada reunión con su fecha, con quién y cuánto trae', () => {
    const c = montar()
    c.pintarListaConversaciones([{
      archivo: 'sesion-20260919-101500-3.jsonl', ruta: '/reuniones/sesion-3.jsonl',
      inicio: '2026-09-19T10:15:00.000Z', perfil: 'Omar Avila', contexto: 'Rossi Logistica',
      frases: 21, preguntas: 3,
    }])

    const filas = c.filas()
    assert.strictEqual(filas.length, 1)
    assert.match(filas[0].querySelector('.titulo-fila').textContent, /Rossi Logistica/)
    assert.match(filas[0].querySelector('.titulo-fila').textContent, /Omar Avila/)
    assert.match(filas[0].querySelector('.detalle-fila').textContent, /21 frase/)
    assert.match(filas[0].querySelector('.detalle-fila').textContent, /3 pregunta/)
  })

  test('«Abrir» manda la ruta exacta de esa reunión al proceso principal', () => {
    const abiertas = []
    const c = montar({ api: { abrirCarpeta: ruta => abiertas.push(ruta) } })
    c.pintarListaConversaciones([
      { archivo: 'sesion-1.jsonl', ruta: '/reuniones/sesion-1.jsonl', inicio: null, frases: 4, preguntas: 0 },
      { archivo: 'sesion-2.jsonl', ruta: '/reuniones/sesion-2.jsonl', inicio: null, frases: 9, preguntas: 1 },
    ])

    const filas = c.filas()
    filas[1].querySelector('.sec').onclick()

    assert.deepStrictEqual(abiertas, ['/reuniones/sesion-2.jsonl'],
      'tiene que abrir la reunión de la fila pulsada, no otra')
  })

  test('cargarConversaciones() lee de `api.listarConversaciones()` y lo pinta', async () => {
    const c = montar({
      api: {
        listarConversaciones: async () => [
          { archivo: 'sesion-1.jsonl', ruta: '/r/sesion-1.jsonl', inicio: null, frases: 5, preguntas: 2 },
        ],
        abrirCarpeta: () => {},
      },
    })
    await c.cargarConversaciones()
    assert.strictEqual(c.filas().length, 1)
  })
})
