/**
 * F042 — Ajustes dice si hay clave guardada, con sus 4 últimos caracteres.
 *
 * Reporte del cliente tras v0.7.0: la sesión de las 15:36 SÍ tradujo con IA
 * (o sea, SÍ tenía clave guardada), pero Ajustes nunca lo decía — el campo se
 * vacía tras guardar y siempre muestra «•••», sin distinguir «nunca hubo
 * clave» de «la hay, pero el campo está vacío porque ya se guardó». Ahora
 * `abrirAjustes()` pinta, bajo cada campo, «Guardada ✓ (termina en …xxxx)» o
 * «Sin clave», con lo que trae `app:estadoClaves` (probado aparte, en
 * `mainAppClavesF042.test.js`).
 *
 * Mismo patrón de la casa que `rendererProbarClaves.test.js`: se extrae el
 * bloque real de `app.html` y se ejecuta contra un DOM mínimo.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const DESDE = '// ── Informe de la reunión (F039b)'
const HASTA = '// ── Ajustes: probar claves (F036)'

class Nodo {
  constructor (tag) {
    this.tag = tag
    this.id = ''
    this.value = ''
    this.disabled = false
    this._texto = ''
    this._clases = new Set()
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
  get textContent () { return this._texto }
  set textContent (v) { this._texto = String(v) }
  querySelectorAll () { return [] }
}

function montarDom () {
  const html = fs.readFileSync(APP_HTML, 'utf8')
  const i = html.indexOf(DESDE)
  const j = html.indexOf(HASTA)
  assert.ok(i > 0 && j > i, `no se encontró el bloque de Ajustes en ${APP_HTML}`)
  const codigo = html.slice(i, j)

  const nodos = {}
  for (const id of [
    'ajustes', 'modoInformes', 'txtInformes', 'kSTT', 'kLLM',
    'estadoStt', 'estadoLlm', 'btnAjustes', 'btnCerrarAjustes', 'btnGuardarAjustes',
  ]) {
    nodos[id] = new Nodo(id.startsWith('btn') ? 'button' : id.startsWith('k') ? 'input' : 'div')
    nodos[id].id = id
  }
  const $ = sel => nodos[sel.replace('#', '')] || null

  return { codigo, nodos, $ }
}

/** @param {object|null} api  `null` monta el modo de ejemplo (sin proceso principal) */
function montar (api) {
  const { codigo, nodos, $ } = montarDom()
  const fabrica = new Function('$', 'api', `${codigo}\n return { abrirAjustes, pintarEstadoClave }`)
  return { ...fabrica($, api), nodos }
}

describe('F042 — pintarEstadoClave: el mensaje bajo cada campo', () => {
  test('con clave guardada: verde y los 4 últimos caracteres', () => {
    const { pintarEstadoClave, nodos } = montar(null)
    pintarEstadoClave('Stt', true, 'abcd')
    assert.ok(nodos.estadoStt.classList.contains('ok'))
    assert.match(nodos.estadoStt.textContent, /Guardada ✓/)
    assert.match(nodos.estadoStt.textContent, /abcd/)
  })

  test('sin clave: «Sin clave», sin la clase `ok`', () => {
    const { pintarEstadoClave, nodos } = montar(null)
    pintarEstadoClave('Llm', false, null)
    assert.ok(!nodos.estadoLlm.classList.contains('ok'))
    assert.strictEqual(nodos.estadoLlm.textContent, 'Sin clave')
  })
})

describe('F042 — abrirAjustes() pinta el estado de las dos claves al abrir', () => {
  test('con las dos guardadas: los dos campos dicen «Guardada ✓» con sus 4 últimos caracteres', async () => {
    const api = {
      estadoClaves: async () => ({
        stt: true, llm: true, sttUltimos4: '1234', llmUltimos4: 'wxyz',
        informes: 'completo', informesDisponibles: true,
      }),
    }
    const { abrirAjustes, nodos } = montar(api)
    await abrirAjustes()
    assert.match(nodos.estadoStt.textContent, /Guardada ✓.*1234/)
    assert.match(nodos.estadoLlm.textContent, /Guardada ✓.*wxyz/)
  })

  test('sin ninguna guardada: los dos dicen «Sin clave»', async () => {
    const api = {
      estadoClaves: async () => ({
        stt: false, llm: false, sttUltimos4: null, llmUltimos4: null,
        informes: 'completo', informesDisponibles: true,
      }),
    }
    const { abrirAjustes, nodos } = montar(api)
    await abrirAjustes()
    assert.strictEqual(nodos.estadoStt.textContent, 'Sin clave')
    assert.strictEqual(nodos.estadoLlm.textContent, 'Sin clave')
  })

  test('en modo de ejemplo (sin proceso principal), no revienta', async () => {
    const { abrirAjustes, nodos } = montar(null)
    await abrirAjustes()
    assert.strictEqual(nodos.ajustes.classList.contains('oculto'), false)
  })
})
