/**
 * F038 — pantalla de Conversaciones: coste con procedencia, «Ver» y «Borrar».
 *
 * Mismo patrón que `rendererConversaciones.test.js` (F032): se extrae el
 * bloque real de `app.html` y se ejecuta contra un DOM mínimo.
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
      remove: (...c) => c.forEach(x => this._clases.delete(x)),
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

/** Monta la pantalla de Conversaciones, con `#detalleConversacion` incluido (F038). */
function montar ({ api = null, confirmar = () => true } = {}) {
  const html = fs.readFileSync(APP_HTML, 'utf8')
  const i = html.indexOf(DESDE)
  const j = html.indexOf(HASTA)
  assert.ok(i > 0 && j > i, `no se encontró el bloque de Conversaciones en ${APP_HTML}`)
  const codigo = html.slice(i, j)

  const raiz = new Nodo('body')
  const lista = new Nodo('div')
  lista.id = 'listaConversaciones'
  const detalle = new Nodo('div')
  detalle.id = 'detalleConversacion'
  detalle.classList.add('oculto')
  raiz.append(lista, detalle)

  const $ = sel => (raiz.encaja(sel) ? raiz : raiz.querySelector(sel))
  const crear = (t, c) => { const e = new Nodo(t); if (c) e.className = c; return e }

  // `confirm` es global bare, igual que el borrado de un perfil (misma
  // convención ya usada en `app.html`) — se inyecta como global de Node para
  // esta prueba, no como parámetro de la fábrica.
  global.confirm = confirmar

  const fabrica = new Function('$', 'crear', 'api',
    `${codigo}\n return { pintarListaConversaciones, cargarConversaciones, verConversacion, borrarConversacionDesdeUI, formatoUsd, formatoDuracion }`)

  return {
    filas: () => lista.querySelectorAll('.tarjeta-lista'),
    detalle,
    ...fabrica($, crear, api),
  }
}

describe('F038 — la lista dice duración, latencia y coste, con su procedencia', () => {
  test('criterio 1 y 4: cada cifra de coste enseña si es medida o estimada', () => {
    const c = montar()
    c.pintarListaConversaciones([{
      archivo: 'sesion-1.jsonl', ruta: '/r/sesion-1.jsonl', inicio: '2026-09-19T10:15:00.000Z',
      contexto: 'Rossi Logistica', frases: 21, preguntas: 3, duracionMs: 125000,
      latenciaP50: 150, latenciaP95: 400,
      costeSttUsd: 0.0156, costeSttProcedencia: 'tarifa verificada, duración medida',
      costeLlmUsd: 0.0004, costeLlmProcedencia: 'tokens medidos; tarifa de lista sin contrastar contra factura',
    }])

    const costeFila = c.filas()[0].querySelector('.coste-fila')
    assert.ok(costeFila, 'la fila trae un bloque de coste')
    assert.match(costeFila.textContent, /150 ms/)
    assert.match(costeFila.textContent, /400 ms/)
    assert.match(costeFila.textContent, /verificada/)
    assert.match(costeFila.textContent, /medid/i, 'dice que los tokens del LLM son medidos')
  })
})

describe('F038 — «Ver»: transcripción y preguntas con respuesta dentro de la app', () => {
  test('criterio 2: pide la reunión al proceso principal y pinta frases y preguntas', async () => {
    const pedidas = []
    const c = montar({
      api: {
        leerConversacion: async ruta => {
          pedidas.push(ruta)
          return {
            contexto: 'Rossi Logistica', perfil: 'Omar Ávila',
            frases: [{ it: 'Ciao', es: 'Hola' }],
            preguntas: [
              { it: 'Hai finito?', es: '¿Terminaste?', respuesta: 'Sì, ho finito.', manual: false },
              { it: 'Quando arrivi?', es: '¿Cuándo llegas?', respuesta: null, mensaje: 'Sin clave de IA' },
            ],
          }
        },
      },
    })

    await c.verConversacion({ ruta: '/r/sesion-1.jsonl', contexto: 'Rossi Logistica', perfil: 'Omar Ávila' })

    assert.deepStrictEqual(pedidas, ['/r/sesion-1.jsonl'])
    assert.strictEqual(c.detalle.classList.contains('oculto'), false, 'el detalle se muestra')

    const lineas = c.detalle.querySelectorAll('.linea-transcripcion')
    assert.strictEqual(lineas.length, 1)
    assert.match(lineas[0].textContent, /Ciao/)
    assert.match(lineas[0].textContent, /Hola/)

    const tarjetas = c.detalle.querySelectorAll('.tarjeta-pregunta-detalle')
    assert.strictEqual(tarjetas.length, 2)
    assert.match(tarjetas[0].querySelector('.respuesta-texto').textContent, /Sì, ho finito/)
    assert.match(tarjetas[1].querySelector('.respuesta-texto').textContent, /Sin respuesta/)
  })
})

describe('F038 — «Borrar»: pide confirmación y sólo borra si el usuario confirma', () => {
  test('criterio 3: confirmando, llama a `api.borrarConversacion()` con la ruta exacta', async () => {
    const borradas = []
    const c = montar({
      confirmar: () => true,
      api: {
        borrarConversacion: async ruta => { borradas.push(ruta); return { ok: true } },
        listarConversaciones: async () => [],
      },
    })

    await c.borrarConversacionDesdeUI({ ruta: '/r/sesion-2.jsonl', contexto: 'Rossi Logistica' })

    assert.deepStrictEqual(borradas, ['/r/sesion-2.jsonl'])
  })

  test('cancelando la confirmación, no se borra nada', async () => {
    const borradas = []
    const c = montar({
      confirmar: () => false,
      api: { borrarConversacion: async ruta => { borradas.push(ruta) } },
    })

    await c.borrarConversacionDesdeUI({ ruta: '/r/sesion-3.jsonl' })

    assert.deepStrictEqual(borradas, [])
  })
})
