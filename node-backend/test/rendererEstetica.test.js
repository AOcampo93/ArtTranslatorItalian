/**
 * F034 — estética: barra de scroll discreta, botones con su color y el
 * piloto «AL AIRE».
 *
 * Las tres primeras pruebas leen la hoja de estilos tal cual está en
 * `app.html` (mismo patrón que `rendererPanelInicio.test.js`: sobre el
 * marcado y el CSS reales, sin extraer ni ejecutar nada, porque el criterio
 * es una propiedad del CSS, no un comportamiento). La del piloto sí extrae y
 * ejecuta el bloque real de `estado()` — es el mismo patrón que
 * `rendererBurbujas.test.js` — porque ahí el criterio es «se enciende
 * SOLO mientras escucha», que es comportamiento, no una regla de estilo.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const HTML = fs.readFileSync(APP_HTML, 'utf8')
const CSS = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'))

describe('F034 — barra de desplazamiento discreta, en todas las zonas', () => {
  before(() => assert.ok(fs.existsSync(APP_HTML)))

  test('el pulgar es discreto (6 px, rgba .18) y se distingue con hover (.32)', () => {
    assert.match(CSS, /::-webkit-scrollbar\s*\{[^}]*width:\s*6px/,
      '6 px es "discreto pero agarrable", no la barra ancha por defecto de Chromium')
    assert.match(CSS, /::-webkit-scrollbar-thumb\s*\{[^}]*rgba\(255,255,255,\.18\)/)
    assert.match(CSS, /::-webkit-scrollbar-thumb:hover\s*\{[^}]*rgba\(255,255,255,\.32\)/)
  })

  test('sin flechas de subir/bajar', () => {
    assert.match(CSS, /::-webkit-scrollbar-button\s*\{[^}]*display:\s*none/)
  })

  test('la regla es GLOBAL (`*::-webkit-scrollbar`): cubre las tres zonas de scroll y no sólo una', () => {
    // Un selector por zona (`#conversacion::-webkit-scrollbar`, etc.) sería
    // fácil de dejar corto el día que aparezca una cuarta zona con scroll
    // (como pasó con perfiles y conversaciones, F032). El selector universal
    // es la única forma de que "en todas las zonas" no dependa de acordarse.
    assert.match(CSS, /\*::-webkit-scrollbar\s*\{/)
  })
})

describe('F034 — Escuchar en verde, Parar en rojo, grande y siempre visible', () => {
  test('el botón por defecto (Escuchar) usa el color "ok" (verde)', () => {
    assert.match(CSS, /\n\s*button\s*\{[^}]*background:\s*var\(--ok\)/)
  })

  test('`button.parar` es rojo y más grande que un botón normal', () => {
    const m = CSS.match(/button\.parar\s*\{([^}]*)\}/)
    assert.ok(m, 'tiene que existir la regla button.parar')
    assert.match(m[1], /background:\s*var\(--mal\)/)
    assert.match(m[1], /padding:\s*8px 20px/, 'más grande que el padding por defecto (8px 16px es el normal, pero en horizontal manda el 20px)')
  })

  test('#btnParar usa la clase "parar" (roja), no "sec" (gris/transparente)', () => {
    const etiqueta = HTML.match(/<button[^>]*\bid="btnParar"[^>]*>/)
    assert.ok(etiqueta, 'no se encontró #btnParar')
    assert.match(etiqueta[0], /class="[^"]*\bparar\b/)
    assert.doesNotMatch(etiqueta[0], /class="[^"]*\bsec\b/,
      'con "sec" el botón sería gris y transparente, no rojo')
  })

  test('#btnParar vive en <header>, fuera de cualquier zona con scroll: no puede quedar bajo el desplazamiento', () => {
    const header = HTML.slice(HTML.indexOf('<header>'), HTML.indexOf('</header>'))
    assert.match(header, /id="btnParar"/)
  })
})

// ── El piloto «AL AIRE»: comportamiento, no sólo estilo ─────────────────────
const DESDE = '// ── Estado de pantalla ─'
const HASTA = '// El p50 del rótulo'

describe('F034 — piloto «AL AIRE»: rojo con pulso al escuchar, ámbar al conectar, apagado el resto', () => {
  function montarEstado () {
    const i = HTML.indexOf(DESDE)
    const j = HTML.indexOf(HASTA)
    assert.ok(i > 0 && j > i, 'no se encontró el bloque de estado() en app.html')
    const codigo = HTML.slice(i, j)

    // Un DOM mínimo: sólo lo que usa `estado()`.
    function elemento () {
      let clases = new Set()
      return {
        get className () { return [...clases].join(' ') },
        set className (v) { clases = new Set(String(v).split(/\s+/).filter(Boolean)) },
        textContent: '',
      }
    }
    const nodos = { punto: elemento(), txtEstado: elemento(), piloto: elemento() }
    const $ = sel => nodos[sel.replace('#', '')]

    const fabrica = new Function('$', `${codigo}\n return { estado }`)
    return { ...fabrica($), piloto: nodos.piloto }
  }

  test('mientras escucha ("vivo"): el piloto se enciende rojo', () => {
    const { estado, piloto } = montarEstado()
    estado('vivo', 'Escuchando')
    assert.strictEqual(piloto.className, 'piloto vivo')
  })

  test('al conectar ("aviso"): ámbar, no rojo', () => {
    const { estado, piloto } = montarEstado()
    estado('aviso', 'Conectando')
    assert.strictEqual(piloto.className, 'piloto conectando')
  })

  test('detenido (sin clase): apagado, ni rojo ni ámbar', () => {
    const { estado, piloto } = montarEstado()
    estado('vivo', 'Escuchando')     // primero se enciende...
    estado('', 'Detenido')           // ...y al parar, se apaga
    assert.strictEqual(piloto.className, 'piloto')
  })

  test('un fallo ("mal") tampoco lo deja encendido: sólo "vivo" es rojo y sólo "aviso" es ámbar', () => {
    const { estado, piloto } = montarEstado()
    estado('mal', 'Sin conexión')
    assert.strictEqual(piloto.className, 'piloto')
  })
})
