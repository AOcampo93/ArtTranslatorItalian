/**
 * F035 — EN VIVO en columna: transcripción arriba, preguntas abajo,
 * contexto colapsado en un chip, todo cabiendo a 440 px.
 *
 * F045: el reparto de la columna angosta pasó de 60/40 a 50/50 (pedido del
 * cliente: a 440 px las preguntas quedaban demasiado pequeñas); la fila
 * ancha (>= 600px) se queda en 60/40, sin cambios — eso se prueba en
 * `rendererAjustesUi.test.js`, junto al resto de `@media`.
 *
 * La geometría de la VENTANA (alto del área de trabajo, ancho angosto,
 * pegada al borde, memoria de posición) se prueba aparte, sin Electron, en
 * `ventanaEstado.test.js`. Esto de aquí es el CSS de la pantalla en vivo:
 * se lee la hoja de estilos real de `app.html`, mismo patrón que
 * `rendererPanelInicio.test.js`.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const HTML = fs.readFileSync(APP_HTML, 'utf8')
const CSS = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'))

/** La primera regla `{...}` para el selector dado, tal como está en la hoja. */
function reglaDe (selector) {
  const escapado = selector.replace(/[.#]/g, '\\$&')
  const m = CSS.match(new RegExp(`${escapado}\\s*\\{([^}]*)\\}`))
  assert.ok(m, `no se encontró la regla "${selector}" en ${APP_HTML}`)
  return m[1]
}

describe('F035/F045 — transcripción arriba, preguntas abajo, reparto 50/50', () => {
  before(() => assert.ok(fs.existsSync(APP_HTML)))

  test('main#envivo va en columna, no en fila', () => {
    assert.match(reglaDe('main'), /flex-direction:\s*column/)
  })

  test('F045: #conversacion (arriba) y #preguntas (abajo) se reparten 50/50 del alto', () => {
    assert.match(reglaDe('#conversacion'), /flex:\s*5\s+1\s+0/)
    assert.match(reglaDe('#preguntas'), /flex:\s*5\s+1\s+0/)
  })

  test('#preguntas ya no es la columna de la derecha: sin ancho fijo ni borde a la izquierda', () => {
    const r = reglaDe('#preguntas')
    assert.doesNotMatch(r, /width:\s*330px/, 'ese ancho fijo era de la maqueta de dos columnas')
    assert.doesNotMatch(r, /border-left:\s*1px/)
    assert.match(r, /border-top:\s*1px/, 'ahora el separador es horizontal, porque queda debajo')
  })

  test('las burbujas envuelven el texto y no se salen del ancho angosto', () => {
    assert.match(reglaDe('.burbuja'), /overflow-wrap:\s*break-word/)
  })
})

describe('F035 — el contexto general vive colapsado en un chip', () => {
  test('el "summary" cerrado es una píldora pequeña (border-radius 999px), no una barra a lo ancho', () => {
    const r = reglaDe('#contexto summary')
    assert.match(r, /border-radius:\s*999px/)
    assert.match(r, /display:\s*inline-flex/, 'inline-flex y no un bloque a lo ancho: eso es lo que lo hace un chip')
  })

  test('el contenedor #contexto ya no pinta una barra de ancho completo detrás del chip', () => {
    const r = reglaDe('#contexto')
    assert.doesNotMatch(r, /border-top:\s*1px solid var\(--linea\)/,
      'esa línea a lo ancho era la barra completa de la maqueta anterior')
  })
})
