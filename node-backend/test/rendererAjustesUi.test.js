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
  // pegadas al borde en la v0.6.0 probada. F042: `#perfiles` y
  // `#conversaciones` no tenían NINGUNA regla de padding — su contenido sí
  // tocaba el borde, y nadie lo había visto porque F041 solo revisó estas
  // cuatro zonas.
  for (const selector of ['header', '#conversacion', '#listaPreguntas', '.tarjeta', '#perfiles', '#conversaciones']) {
    test(`\`${selector}\` usa el gutter común`, () => {
      const cuerpo = regla(selector, 'padding')
      assert.ok(cuerpo, `no se encontró \`${selector} { ... }\` con padding`)
      assert.match(cuerpo, /padding:[^;]*var\(--gutter\)/,
        `\`${selector}\` no referencia var(--gutter) en su padding`)
    })
  }
})

describe('F042 — dos columnas al ensanchar la ventana (>= 600px, antes 900)', () => {
  // El cliente lo pidió tras probar v0.7.0: a 900px casi nunca llegaba a
  // verlo — la ventana estándar es de 440px, y ensancharla hasta 900 es
  // mucho más gesto del que alguien hace a media reunión.
  test('a partir de 600px, #envivo pasa a fila (traducción izquierda, preguntas derecha)', () => {
    const m = html.match(/@media \(min-width:\s*600px\)\s*\{([\s\S]*?)\n  \}\n/)
    assert.ok(m, 'no se encontró el `@media (min-width: 600px) { ... }` de la vista en vivo')
    assert.match(m[1], /main#envivo\s*\{\s*flex-direction:\s*row/,
      'a >= 600px la vista en vivo tiene que pasar a fila (columnas lado a lado)')
  })

  // F045: pedido del cliente — el reparto 50/50 nuevo es solo para la
  // columna angosta (por debajo de 600px, ver `rendererVentanaColumna.test.js`).
  // A >= 600px se queda el 60/40 de siempre.
  test('F045: a partir de 600px el reparto vuelve a 60/40, no se queda en 50/50', () => {
    const m = html.match(/@media \(min-width:\s*600px\)\s*\{([\s\S]*?)\n  \}\n/)
    assert.ok(m, 'no se encontró el `@media (min-width: 600px) { ... }` de la vista en vivo')
    assert.match(m[1], /#conversacion\s*\{[^}]*flex:\s*6\s+1\s+0/,
      'a >= 600px #conversacion tiene que volver a flex: 6 1 0')
    assert.match(m[1], /#preguntas\s*\{[^}]*flex:\s*4\s+1\s+0/,
      'a >= 600px #preguntas tiene que volver a flex: 4 1 0')
  })

  test('ya no queda una media query a 900px para esto: el umbral bajó, no se duplicó', () => {
    assert.doesNotMatch(html, /@media \(min-width:\s*900px\)/,
      'un 900px que quedara junto al 600px nuevo dejaría dos criterios contradictorios')
  })

  test('angosta (por defecto, sin la media query) la vista en vivo sigue en columna', () => {
    const cuerpo = regla('main')
    assert.ok(cuerpo, 'no se encontró `main { ... }`')
    assert.match(cuerpo, /flex-direction:\s*column/,
      'por debajo de 600px main tiene que seguir en columna, como pide F035')
  })
})

describe('F042 — Conversaciones: los botones bajan a su propia fila a menos de 600px', () => {
  // Reporte del cliente: a 440px (la ventana estándar) Abrir/Ver/Borrar
  // quedaban apretados al lado del texto de la tarjeta.
  test('a <= 600px, `.tarjeta-lista` pasa a columna y las acciones ocupan el ancho', () => {
    const m = html.match(/@media \(max-width:\s*600px\)\s*\{([\s\S]*?)\n  \}\n/)
    assert.ok(m, 'no se encontró el `@media (max-width: 600px) { ... }` de las tarjetas de lista')
    assert.match(m[1], /\.tarjeta-lista\s*\{\s*flex-direction:\s*column/,
      'a <= 600px `.tarjeta-lista` tiene que apilar el texto y las acciones')
    assert.match(m[1], /\.tarjeta-lista \.acciones-fila\s*\{\s*width:\s*100%/,
      'las acciones tienen que ocupar el ancho, no quedarse apretadas a un lado')
  })

  test('por defecto (ancha) `.tarjeta-lista` sigue en fila, como antes', () => {
    const cuerpo = regla('.tarjeta-lista')
    assert.ok(cuerpo, 'no se encontró `.tarjeta-lista { ... }`')
    assert.match(cuerpo, /display:\s*flex/)
    assert.doesNotMatch(cuerpo, /flex-direction:\s*column/,
      'la regla base no puede forzar columna: eso es solo del <= 600px')
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
