/**
 * F032 — al abrir la app se ve un panel de inicio, no el formulario.
 *
 * ## Por qué se prueba así
 *
 * Esto es sobre lo que el usuario ve en el PRIMER pintado, antes de que
 * corra ningún script: si `#preparar` naciera visible, el panel de inicio
 * aparecería un instante y desaparecería de inmediato, o directamente ambos
 * se verían a la vez. Eso está codificado en las clases `oculto` del propio
 * marcado, así que esta prueba lee el HTML tal cual —sin extraer ni ejecutar
 * el `<script>`, que es el patrón que usan `rendererBurbujas.test.js` y
 * `rendererPreguntas.test.js` para el COMPORTAMIENTO— y comprueba qué
 * pantalla nace visible y cuáles no.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const HTML = fs.readFileSync(APP_HTML, 'utf8')

/** La etiqueta de apertura de `<TAG id="ID" ...>`, tal como esté en el archivo. */
function etiquetaDe (id) {
  const m = HTML.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`))
  assert.ok(m, `no se encontró ningún elemento con id="${id}" en ${APP_HTML}`)
  return m[0]
}

const esOculto = id => /class="[^"]*\boculto\b/.test(etiquetaDe(id))

describe('F032 — panel de inicio al abrir, criterio 1', () => {
  before(() => assert.ok(fs.existsSync(APP_HTML)))

  test('#inicio nace a la vista', () => {
    assert.strictEqual(esOculto('inicio'), false,
      'el panel de inicio tiene que verse nada más abrir la app')
  })

  test('el asistente, la pantalla en vivo, perfiles y conversaciones nacen ocultos', () => {
    for (const id of ['preparar', 'envivo', 'perfiles', 'conversaciones']) {
      assert.strictEqual(esOculto(id), true, `#${id} no puede empezar a la vista`)
    }
  })

  test('el panel de inicio tiene los cinco accesos que pidió el cliente', () => {
    for (const id of ['irNueva', 'irRapida', 'irPerfiles', 'irConversaciones', 'irAjustes']) {
      etiquetaDe(id)   // falla sola si no existe
    }
  })
})
