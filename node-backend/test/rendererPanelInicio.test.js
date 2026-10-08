/**
 * F032 — al abrir la app se ve una sola pantalla, no el formulario.
 *
 * ## F051 cambió esto a propósito
 *
 * Hasta F050 la pantalla que nacía a la vista era el panel de inicio (`#inicio`).
 * Desde F051 es la de idioma (`#idioma`), que sale en cada arranque, y el panel de
 * inicio nace oculto y aparece al elegir idioma. Lo que no cambia es el criterio
 * de F032: UNA sola pantalla a la vista, y el panel de inicio con sus cinco accesos.
 * (Que al elegir inglés aparezca el panel con EN → ES lo ejercita
 * `idiomaPantallaF051.test.js`, que ejecuta el script.)
 *
 * ## Por qué se prueba así
 *
 * Esto es sobre lo que el usuario ve en el PRIMER pintado, antes de que
 * corra ningún script: si `#preparar` naciera visible, la pantalla de idioma
 * aparecería un instante y desaparecería de inmediato, o directamente ambas
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

describe('F032/F051 — al abrir se ve una sola pantalla, la de idioma, criterio 1', () => {
  before(() => assert.ok(fs.existsSync(APP_HTML)))

  test('#idioma nace a la vista (F051: antes era #inicio)', () => {
    assert.strictEqual(esOculto('idioma'), false,
      'la pantalla de idioma tiene que verse nada más abrir la app')
  })

  test('el panel de inicio, el asistente, la pantalla en vivo, perfiles y conversaciones nacen ocultos', () => {
    for (const id of ['inicio', 'preparar', 'envivo', 'perfiles', 'conversaciones']) {
      assert.strictEqual(esOculto(id), true, `#${id} no puede empezar a la vista`)
    }
  })

  test('el panel de inicio tiene los cinco accesos que pidió el cliente', () => {
    for (const id of ['irNueva', 'irRapida', 'irPerfiles', 'irConversaciones', 'irAjustes']) {
      etiquetaDe(id)   // falla sola si no existe
    }
  })
})
