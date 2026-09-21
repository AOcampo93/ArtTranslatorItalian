/**
 * F045 — Ajustes simplificados: «Modo de transcripción» se oculta, el
 * selector de tres modos del informe se oculta y en su lugar manda un
 * interruptor único «Permitir el envío», encendido por defecto.
 *
 * El toggle-en-sí (qué pinta al abrir, qué manda al guardar) ya se prueba
 * con el patrón de `montar()` de la casa en
 * `rendererAjustesEstadoClavesF042.test.js`. Esto de aquí es el MARCADO: que
 * la sección de transcripción está oculta pero sigue en el HTML, que el
 * selector viejo de tres modos está oculto y no borrado, y que el
 * interruptor nuevo empieza marcado (encendido) en el HTML servido — mismo
 * patrón que `rendererVentanaColumna.test.js` para leer el archivo real.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const HTML = fs.readFileSync(APP_HTML, 'utf8')

/** El `<section ...>...</section>` de Ajustes que contiene el `<h2>` dado. */
function seccionDe (titulo) {
  const i = HTML.indexOf(`<h2>${titulo}</h2>`)
  assert.ok(i > 0, `no se encontró "<h2>${titulo}</h2>" en ${APP_HTML}`)
  const inicio = HTML.lastIndexOf('<section', i)
  const fin = HTML.indexOf('</section>', i)
  assert.ok(inicio > 0 && fin > inicio, `no se encontró la sección de "${titulo}"`)
  return HTML.slice(inicio, fin)
}

describe('F045 — «Modo de transcripción» se oculta, no se borra', () => {
  test('la sección lleva la clase oculto', () => {
    const seccion = seccionDe('Modo de transcripción')
    assert.match(seccion, /<section class="tarjeta oculto">/,
      'la sección de Nube/Local tiene que arrancar oculta')
  })

  test('Nube y Local siguen en el marcado (el código no se borró)', () => {
    const seccion = seccionDe('Modo de transcripción')
    assert.match(seccion, /<b>Nube<\/b>/)
    assert.match(seccion, /<b>Local<\/b>/)
  })
})

describe('F045 — el informe: selector de tres modos oculto, interruptor único visible', () => {
  const seccion = seccionDe('Informe de la reunión')

  test('el selector viejo (#modoInformes) está oculto, no borrado', () => {
    assert.match(seccion, /<div class="modo oculto" id="modoInformes">/)
    assert.match(seccion, /data-valor="completo"/, 'las tres opciones siguen en el marcado')
  })

  test('hay un aviso de que se generan y envían informes', () => {
    assert.match(seccion, /se generan informes/i)
    assert.match(seccion, /optimizaci[oó]n de la app/i)
  })

  test('el interruptor «Permitir el envío» está en el marcado y NO oculto', () => {
    assert.match(seccion, /<input type="checkbox" id="chkPermitirEnvio" checked>/,
      'tiene que empezar marcado: encendido por defecto')
    assert.doesNotMatch(seccion, /class="interruptor oculto"/)
    assert.match(seccion, /Permitir el envío/)
  })
})

describe('F045 — «de qué se está hablando» vive dentro de la conversación', () => {
  test('#contexto es hijo de #conversacion, no un hermano suelto de #envivo', () => {
    const iConversacion = HTML.indexOf('<div id="conversacion">')
    const iCierreConversacion = HTML.indexOf('</div>\n\n  <aside id="preguntas">')
    const iContexto = HTML.indexOf('<details id="contexto"')
    assert.ok(iConversacion > 0 && iCierreConversacion > iConversacion,
      'no se encontró el contenedor #conversacion completo')
    assert.ok(iContexto > iConversacion && iContexto < iCierreConversacion,
      '#contexto tiene que estar dentro de #conversacion, antes de que cierre')
  })
})
