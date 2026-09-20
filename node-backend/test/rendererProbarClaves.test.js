/**
 * F036 — el botón «Probar» de cada clave, en pantalla.
 *
 * El renderer vive dentro de `app.html` y el proyecto no trae jsdom, así que
 * se **extrae el bloque real del archivo** y se ejecuta contra un DOM mínimo,
 * igual que `rendererBurbujas.test.js`. Lo que importa comprobar aquí es lo
 * que ya prueba a fondo `mainAppProbarClaves.test.js` (backend) NO puede
 * ver: que el botón pinte verde o rojo de verdad, con el mensaje que llegó, y
 * que mientras tanto no se quede diciendo «Probando…» para siempre.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const DESDE = '// ── Ajustes: probar claves (F036) ─'
const HASTA = '// ── Puente con el proceso principal ─'

// ── Un DOM mínimo: lo justo que usa este bloque ─────────────────────────────
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
    }
  }

  get className () { return [...this._clases].join(' ') }
  get textContent () { return this._texto }
  set textContent (v) { this._texto = String(v) }
}

function montarDom () {
  const html = fs.readFileSync(APP_HTML, 'utf8')
  const i = html.indexOf(DESDE)
  const j = html.indexOf(HASTA)
  assert.ok(i > 0 && j > i, `no se encontró el bloque de F036 en ${APP_HTML}`)
  const codigo = html.slice(i, j)

  const nodos = {}
  for (const id of ['kSTT', 'kLLM', 'btnProbarStt', 'btnProbarLlm', 'resultadoStt', 'resultadoLlm']) {
    nodos[id] = new Nodo(id.startsWith('btn') ? 'button' : id.startsWith('k') ? 'input' : 'p')
    nodos[id].id = id
  }
  const $ = sel => nodos[sel.replace('#', '')] || null

  return { codigo, nodos, $ }
}

/** @param {object|null} api  `null` monta el modo de ejemplo (sin proceso principal) */
function montar (api) {
  const { codigo, nodos, $ } = montarDom()
  const fabrica = new Function('$', 'api', `${codigo}\n return { probarClave, pintarResultadoClave }`)
  return { ...fabrica($, api), nodos }
}

describe('F036 — el botón «Probar»: cablea probarClave() con los ids correctos', () => {
  test('el bloque real registra los dos botones, cada uno con su clave y su función de la API', () => {
    const html = fs.readFileSync(APP_HTML, 'utf8')
    const i = html.indexOf(DESDE)
    const j = html.indexOf(HASTA)
    const codigo = html.slice(i, j)
    assert.match(codigo, /\$\('#btnProbarStt'\)\.onclick = \(\) => probarClave\('Stt', 'kSTT', c => api\.probarClaveStt\(c\)\)/)
    assert.match(codigo, /\$\('#btnProbarLlm'\)\.onclick = \(\) => probarClave\('Llm', 'kLLM', c => api\.probarClaveLlm\(c\)\)/)
    // Guardado: en un DOM que no monte estos botones (otras pruebas montan
    // este mismo tramo con un DOM más pequeño), cablearlos no debe reventar.
    assert.match(codigo, /if \(\$\('#btnProbarStt'\)\)/)
    assert.match(codigo, /if \(\$\('#btnProbarLlm'\)\)/)
  })
})

// Lo de arriba comprueba que cada botón queda atado a la función correcta;
// lo que sigue ejercita `probarClave` y `pintarResultadoClave` de verdad,
// que es donde vive toda la lógica que decide el verde/rojo y el mensaje.
describe('F036 — probarClave / pintarResultadoClave', () => {
  // F042: el campo vacío ya NO se rechaza en el renderer — se manda igual, y
  // es el proceso principal quien, con el campo vacío, prueba la clave YA
  // GUARDADA (`mainAppProbarClaves.test.js` prueba esa parte; aquí sólo
  // importa que el renderer no corte la llamada antes de que llegue).
  test('campo vacío: SÍ llama a la API, para poder probar la clave ya guardada', async () => {
    let llamado = false
    const api = { probarClaveStt: async c => { llamado = c; return { ok: true, mensaje: 'Clave válida: terminada en …abcd.' } } }
    const { probarClave, nodos } = montar(api)
    nodos.kSTT.value = '   '
    await probarClave('Stt', 'kSTT', c => api.probarClaveStt(c))
    assert.strictEqual(llamado, '', 'el campo vacío se manda tal cual, sin inventar nada en el renderer')
    assert.ok(!nodos.resultadoStt.classList.contains('oculto'))
    assert.ok(nodos.resultadoStt.classList.contains('ok'))
    assert.match(nodos.resultadoStt.textContent, /abcd/)
  })

  test('con la clave y éxito: verde, mensaje en pantalla, botón reactivado', async () => {
    const api = { probarClaveLlm: async () => ({ ok: true, mensaje: 'Clave válida: Gemini, se usará gemini-3.5-flash-lite.' }) }
    const { probarClave, nodos } = montar(api)
    nodos.kLLM.value = 'AIzaLoQueSea'
    nodos.btnProbarLlm.textContent = 'Probar'
    const espera = probarClave('Llm', 'kLLM', c => api.probarClaveLlm(c))
    assert.strictEqual(nodos.btnProbarLlm.disabled, true, 'se deshabilita mientras prueba')
    await espera
    assert.strictEqual(nodos.btnProbarLlm.disabled, false)
    assert.strictEqual(nodos.btnProbarLlm.textContent, 'Probar')
    assert.ok(nodos.resultadoLlm.classList.contains('ok'))
    assert.ok(!nodos.resultadoLlm.classList.contains('mal'))
    assert.match(nodos.resultadoLlm.textContent, /Gemini/)
  })

  test('con la clave y fallo: rojo con el mensaje que llegó, nunca la clave', async () => {
    const CLAVE = 'AIzaSyCLAVEDEVERDAD1234567890ABCDEFG'
    const api = { probarClaveStt: async () => ({ ok: false, mensaje: 'La clave de transcripción no es válida. Revísala en Ajustes.' }) }
    const { probarClave, nodos } = montar(api)
    nodos.kSTT.value = CLAVE
    await probarClave('Stt', 'kSTT', c => api.probarClaveStt(c))
    assert.ok(nodos.resultadoStt.classList.contains('mal'))
    assert.ok(!nodos.resultadoStt.classList.contains('ok'))
    assert.match(nodos.resultadoStt.textContent, /no es válida/)
    assert.ok(!nodos.resultadoStt.textContent.includes(CLAVE), 'la clave no puede llegar a pantalla')
  })

  test('en modo de ejemplo (sin proceso principal), no revienta y avisa que es demo', async () => {
    const { probarClave, nodos } = montar(null)
    nodos.kSTT.value = 'cualquier-cosa'
    await probarClave('Stt', 'kSTT', () => { throw new Error('no debería llamarse en modo demo') })
    assert.ok(nodos.resultadoStt.classList.contains('ok'))
    assert.match(nodos.resultadoStt.textContent, /demo/i)
  })
})
