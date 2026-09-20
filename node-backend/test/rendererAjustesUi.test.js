/**
 * F041 — ajustes de interfaz que sólo viven en CSS: el gutter, las dos
 * columnas al ensanchar y el arrastre de la cabecera.
 *
 * ## Por qué esto no usa el patrón de `montar()` de los otros ficheros
 *
 * Las demás pruebas del renderer extraen un bloque de JavaScript real y lo
 * corren contra un DOM mínimo. Aquí el criterio ESTÁ en el CSS —padding,
 * `@media`, `-webkit-app-region`— y el proyecto no trae un motor de estilos
 * (Node no aplica CSS). Lo que sí se puede comprobar sin inventar nada es que
 * la regla que el criterio pide está escrita en el bloque real de `app.html`,
 * leyendo el archivo tal cual se sirve. Es la misma idea del patrón de la
 * casa —el bloque real, no una copia— aplicada a estilos en vez de a
 * funciones.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const html = fs.readFileSync(APP_HTML, 'utf8')

/**
 * Cuerpos `{ ... }` de TODAS las reglas que empiezan por `selector` (puede
 * repetirse dentro de un `@media`, como pasa con `#conversacion`).
 */
function reglas (selector) {
  const re = new RegExp(selector.replace(/[.#]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  return [...html.matchAll(re)].map(m => m[1])
}

/** La primera regla de `selector`, o la primera que además contenga `conQue`. */
function regla (selector, conQue) {
  const todas = reglas(selector)
  if (conQue) return todas.find(c => c.includes(conQue)) || null
  return todas[0] || null
}

describe('F041 — padding: ningún elemento toca el borde de la ventana', () => {
  test('hay un gutter común de al menos 16px', () => {
    const raiz = regla(':root')
    assert.ok(raiz, 'no se encontró `:root { ... }`')
    const m = raiz.match(/--gutter:\s*(\d+)px/)
    assert.ok(m, 'no se encontró la variable --gutter')
    assert.ok(Number(m[1]) >= 16, `--gutter es de ${m[1]}px, se pidió >= 16px`)
  })

  // La cabecera, la lista de la conversación, el panel de preguntas y las
  // tarjetas de "Preparar" son las cuatro zonas que el cliente señaló
  // pegadas al borde en la v0.6.0 probada.
  for (const selector of ['header', '#conversacion', '#listaPreguntas', '.tarjeta']) {
    test(`\`${selector}\` usa el gutter común`, () => {
      const cuerpo = regla(selector, 'padding')
      assert.ok(cuerpo, `no se encontró \`${selector} { ... }\` con padding`)
      assert.match(cuerpo, /padding:[^;]*var\(--gutter\)/,
        `\`${selector}\` no referencia var(--gutter) en su padding`)
    })
  }
})

describe('F041 — dos columnas al ensanchar la ventana (>= 900px)', () => {
  test('a partir de 900px, #envivo pasa a fila (traducción izquierda, preguntas derecha)', () => {
    const m = html.match(/@media \(min-width:\s*900px\)\s*\{([\s\S]*?)\n  \}\n/)
    assert.ok(m, 'no se encontró el `@media (min-width: 900px) { ... }` de la vista en vivo')
    assert.match(m[1], /main#envivo\s*\{\s*flex-direction:\s*row/,
      'a >= 900px la vista en vivo tiene que pasar a fila (columnas lado a lado)')
  })

  test('angosta (por defecto, sin la media query) la vista en vivo sigue en columna', () => {
    const cuerpo = regla('main')
    assert.ok(cuerpo, 'no se encontró `main { ... }`')
    assert.match(cuerpo, /flex-direction:\s*column/,
      'por debajo de 900px main tiene que seguir en columna, como pide F035')
  })
})

describe('F041 — Detener: un doble clic en la cabecera no maximiza la ventana', () => {
  test('la cabecera entera ya NO es zona de arrastre', () => {
    const cuerpo = regla('header')
    assert.ok(cuerpo, 'no se encontró `header { ... }`')
    assert.doesNotMatch(cuerpo, /-webkit-app-region:\s*drag/,
      'con la cabecera entera en `drag`, un doble clic cerca de un botón la deja en zona de arrastre '
      + 'y Windows lo trata como el doble clic de una barra de título: maximiza')
  })

  test('el arrastre se reduce al texto de la marca, lejos de los controles', () => {
    const cuerpo = regla('.marca')
    assert.ok(cuerpo, 'no se encontró `.marca { ... }`')
    assert.match(cuerpo, /-webkit-app-region:\s*drag/,
      'la ventana tiene que poder arrastrarse desde algún sitio: el texto de la marca')
  })

  test('«Detener» es un <button> descendiente directo de <header>, sin contenedor intermedio', () => {
    const cabecera = html.match(/<header>[\s\S]*?<\/header>/)
    assert.ok(cabecera, 'no se encontró <header>...</header>')
    assert.match(cabecera[0], /<button class="parar[^>]*"\s+id="btnParar">/,
      'btnParar tiene que colgar directo de <header>, o un contenedor sin `no-drag` propio lo taparía')
  })
})
