/**
 * F032 — el asistente de «Preparar la reunión» avanza por pasos.
 *
 * ## Qué se protege aquí
 *
 * Pedido por el cliente tal cual: la pantalla de preparación enseñaba las
 * tres tarjetas A LA VEZ y había que rellenarlas siempre, aunque el perfil no
 * cambiara nunca. El criterio de F032 es "el siguiente aparece al cerrar el
 * anterior": el paso 2 no puede estar a la vista hasta que se cierre el 1, ni
 * el 3 hasta que se cierre el 2, ni el «Escuchar» final hasta que la
 * comprobación (o «Saltar») lo deje listo.
 *
 * El renderer vive dentro de `app.html` y el proyecto no trae jsdom, así que
 * se **extrae el bloque real del archivo** y se ejecuta contra un DOM
 * mínimo, con el mismo patrón que `rendererBurbujas.test.js`.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const DESDE = '// ── Formularios ─'
const HASTA = '// ── Arrancar y parar ─'

// ── Un DOM mínimo: lo justo que usa el asistente ────────────────────────────

class Nodo {
  constructor (tag) {
    this.tag = tag
    this.id = ''
    this.hijos = []
    this.disabled = false
    this._clases = new Set()
    this._texto = ''
    this._valor = ''
    this.html = ''
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
  set className (v) { this._clases = new Set(String(v).split(/\s+/).filter(Boolean)) }
  get textContent () { return this._texto }
  set textContent (v) { this._texto = String(v); this.hijos = [] }
  get value () { return this._valor }
  set value (v) { this._valor = v }
  get innerHTML () { return this.html }
  set innerHTML (v) { this.html = String(v); this.hijos = [] }
  get oculto () { return this._clases.has('oculto') }

  append (...n) { this.hijos.push(...n) }
  appendChild (n) { this.hijos.push(n); return n }
  addEventListener (tipo, fn) { if (tipo === 'input') this._alInput = fn }

  encaja (sel) {
    const id = sel.match(/^#([\w-]+)/)
    return Boolean(id) && this.id === id[1]
  }

  querySelector (sel) {
    for (const h of this.hijos) {
      if (h.encaja(sel)) return h
      const dentro = h.querySelector(sel)
      if (dentro) return dentro
    }
    return null
  }

  querySelectorAll () { return [] }
}

/** Monta el asistente tal como está en el HTML y devuelve las funciones y botones reales. */
function montar () {
  const html = fs.readFileSync(APP_HTML, 'utf8')
  const i = html.indexOf(DESDE)
  const j = html.indexOf(HASTA)
  assert.ok(i > 0 && j > i, `no se encontró el bloque del asistente en ${APP_HTML}`)
  const codigo = html.slice(i, j)

  const raiz = new Nodo('body')
  for (const id of [
    'pNombre', 'pEdad', 'pOcupacion', 'pContexto',
    'cNombre', 'cTipoReunion', 'cTipoProyecto', 'cContexto', 'cGlosario',
    'n1', 'n2', 'n3', 'btnEscuchar', 'pistaEscuchar', 'pasos',
    'btnProbar', 'btnSaltar', 'btnSiguiente1', 'btnSiguiente2', 'btnSiguiente3',
    'btnSinContexto', 'pasoPerfil', 'pasoContexto', 'pasoComprobacion', 'pasoFinal',
    'listaPerfilesPaso', 'formPerfilPaso',
  ]) {
    const n = new Nodo('div')
    n.id = id
    // Los pasos 2, 3 y final arrancan con `class="oculto"` en el HTML real
    // (F032: "el siguiente aparece al cerrar el anterior"); el DOM de
    // mentira tiene que arrancar igual, o esta prueba no comprobaría nada.
    // F041: el formulario de perfil nuevo arranca oculto también — el
    // cliente se quejó de que siempre estaba a la vista.
    if (['pasoContexto', 'pasoComprobacion', 'pasoFinal', 'formPerfilPaso'].includes(id)) n.classList.add('oculto')
    raiz.append(n)
  }
  // `btnSiguiente3` empieza deshabilitado en el HTML real (`disabled` en el
  // atributo); esta prueba comprueba que el paso 3 lo habilita, así que el
  // DOM de mentira tiene que arrancar igual de deshabilitado.
  raiz.querySelector('#btnSiguiente3').disabled = true
  // F045: `btnSiguiente3` también arranca con `class="sec"` en el HTML real
  // (secundario, gris, como «Saltar») — el destaque es de «Comprobar» hasta
  // la primera comprobación.
  raiz.querySelector('#btnSiguiente3').classList.add('sec')

  const $ = sel => (raiz.encaja(sel) ? raiz : raiz.querySelector(sel))
  const crear = (t, c) => { const e = new Nodo(t); if (c) e.className = c; return e }
  const document = { querySelectorAll: () => [] }
  const api = null   // DEMO: sin proceso principal, como al abrir el HTML suelto

  const fabrica = new Function('$', 'crear', 'api', 'document', `${codigo}
    return { mostrarPasoAsistente, reiniciarAsistente, seleccionarPerfilPaso, pintarListaPerfilesPaso }`)

  return {
    raiz,
    paso: id => raiz.querySelector(`#${id}`).oculto === false,
    formVisible: () => raiz.querySelector('#formPerfilPaso').oculto === false,
    ...fabrica($, crear, api, document),
  }
}

describe('F032 — el asistente avanza por pasos, no todo a la vez', () => {
  test('al abrir, solo el paso 1 está a la vista', () => {
    const a = montar()
    assert.strictEqual(a.paso('pasoPerfil'), true)
    assert.strictEqual(a.paso('pasoContexto'), false)
    assert.strictEqual(a.paso('pasoComprobacion'), false)
    assert.strictEqual(a.paso('pasoFinal'), false)
  })

  test('sin nombre de perfil, «Siguiente» del paso 1 no avanza', () => {
    const a = montar()
    a.raiz.querySelector('#btnSiguiente1').onclick()
    assert.strictEqual(a.paso('pasoPerfil'), true, 'el paso 1 sigue a la vista: falta el nombre')
    assert.strictEqual(a.paso('pasoContexto'), false)
  })

  test('el paso 2 aparece SOLO al cerrar el 1, y el 1 se cierra', () => {
    const a = montar()
    a.raiz.querySelector('#pNombre').value = 'Omar'

    a.raiz.querySelector('#btnSiguiente1').onclick()

    assert.strictEqual(a.paso('pasoPerfil'), false, 'el paso 1 se cierra al avanzar')
    assert.strictEqual(a.paso('pasoContexto'), true, 'el paso 2 aparece')
    assert.strictEqual(a.paso('pasoComprobacion'), false, 'el 3 todavía no')
  })

  test('el paso 3 aparece al cerrar el 2, con o sin contexto', () => {
    const a = montar()
    a.raiz.querySelector('#pNombre').value = 'Omar'
    a.raiz.querySelector('#btnSiguiente1').onclick()

    a.raiz.querySelector('#btnSiguiente2').onclick()

    assert.strictEqual(a.paso('pasoContexto'), false, 'el paso 2 se cierra al avanzar')
    assert.strictEqual(a.paso('pasoComprobacion'), true, 'el paso 3 aparece')
  })

  test('«Sin contexto para esta reunión» también avanza al paso 3', () => {
    const a = montar()
    a.raiz.querySelector('#pNombre').value = 'Omar'
    a.raiz.querySelector('#btnSiguiente1').onclick()
    a.raiz.querySelector('#cNombre').value = 'algo a medio escribir'

    a.raiz.querySelector('#btnSinContexto').onclick()

    assert.strictEqual(a.paso('pasoComprobacion'), true)
    assert.strictEqual(a.raiz.querySelector('#cNombre').value, '',
      '"sin contexto" limpia lo que hubiera a medio escribir')
  })

  test('el paso final («Escuchar») solo aparece tras «Saltar» o «Comprobar», y «Siguiente» del 3 lo revela', () => {
    const a = montar()
    a.raiz.querySelector('#pNombre').value = 'Omar'
    a.raiz.querySelector('#btnSiguiente1').onclick()
    a.raiz.querySelector('#btnSiguiente2').onclick()

    // Antes de comprobar (o saltar), «Siguiente» del paso 3 está deshabilitado.
    assert.strictEqual(a.raiz.querySelector('#btnSiguiente3').disabled, true)

    a.raiz.querySelector('#btnSaltar').onclick()
    assert.strictEqual(a.raiz.querySelector('#btnSiguiente3').disabled, false,
      '«Saltar» deja avanzar igual que «Comprobar»')

    a.raiz.querySelector('#btnSiguiente3').onclick()

    assert.strictEqual(a.paso('pasoComprobacion'), false, 'el paso 3 se cierra al avanzar')
    assert.strictEqual(a.paso('pasoFinal'), true, 'y aparece el paso final, con Escuchar listo')
    assert.strictEqual(a.raiz.querySelector('#btnEscuchar').disabled, false)
  })

  test('F042: «Saltar» avanza él solo al paso final, sin un segundo clic en «Siguiente»', () => {
    // Antes, «Saltar» sólo habilitaba «Siguiente»: el usuario tenía que
    // pulsar un segundo botón para que pasara algo, y el cliente lo leyó
    // como que «Saltar» no hacía nada.
    const a = montar()
    a.raiz.querySelector('#pNombre').value = 'Omar'
    a.raiz.querySelector('#btnSiguiente1').onclick()
    a.raiz.querySelector('#btnSiguiente2').onclick()

    a.raiz.querySelector('#btnSaltar').onclick()

    assert.strictEqual(a.paso('pasoComprobacion'), false, '«Saltar» cierra el paso 3 él solo')
    assert.strictEqual(a.paso('pasoFinal'), true, 'y ya deja ver el paso final, sin tocar «Siguiente»')
    assert.strictEqual(a.raiz.querySelector('#btnEscuchar').disabled, false)
  })

  test('reiniciarAsistente() vuelve al paso 1, para una reunión nueva desde cero', () => {
    const a = montar()
    a.raiz.querySelector('#pNombre').value = 'Omar'
    a.raiz.querySelector('#btnSiguiente1').onclick()
    a.raiz.querySelector('#btnSiguiente2').onclick()
    a.raiz.querySelector('#btnSaltar').onclick()
    a.raiz.querySelector('#btnSiguiente3').onclick()
    assert.strictEqual(a.paso('pasoFinal'), true)

    a.reiniciarAsistente()

    assert.strictEqual(a.paso('pasoPerfil'), true)
    assert.strictEqual(a.paso('pasoFinal'), false)
    assert.strictEqual(a.raiz.querySelector('#btnSiguiente3').disabled, true,
      'la próxima comprobación tiene que volver a hacerse')
  })
})

// F045 — pedido del cliente: el destaque (verde, sin clase `sec`) es de
// «Comprobar otra vez» hasta la primera comprobación; hecha esa, el
// destaque pasa a «Siguiente» y «Comprobar otra vez» queda secundario, gris,
// como «Saltar». `comprobarDemo()` no depende de `api` (usa `esperar`), así
// que esto corre igual de bien contra el bloque real, sin mocks.
describe('F045 — el destaque del paso 3 pasa de «Comprobar» a «Siguiente»', () => {
  test('antes de comprobar: «Comprobar» destacado, «Siguiente» secundario', () => {
    const a = montar()
    assert.strictEqual(a.raiz.querySelector('#btnProbar').classList.contains('sec'), false,
      '«Comprobar» empieza destacado (sin la clase secundaria)')
    assert.strictEqual(a.raiz.querySelector('#btnSiguiente3').classList.contains('sec'), true,
      '«Siguiente» empieza secundario, como «Saltar»')
  })

  test('tras «Comprobar», el destaque pasa a «Siguiente» y «Comprobar otra vez» queda gris', async () => {
    const a = montar()
    await a.raiz.querySelector('#btnProbar').onclick()

    assert.strictEqual(a.raiz.querySelector('#btnProbar').classList.contains('sec'), true,
      '«Comprobar otra vez» ya no es el destacado')
    assert.strictEqual(a.raiz.querySelector('#btnProbar').textContent, 'Comprobar otra vez')
    assert.strictEqual(a.raiz.querySelector('#btnSiguiente3').classList.contains('sec'), false,
      '«Siguiente» pasa a ser el destacado')
  })

  test('reiniciarAsistente() devuelve el destaque a «Comprobar», para la próxima reunión', async () => {
    const a = montar()
    await a.raiz.querySelector('#btnProbar').onclick()

    a.reiniciarAsistente()

    assert.strictEqual(a.raiz.querySelector('#btnProbar').classList.contains('sec'), false)
    assert.strictEqual(a.raiz.querySelector('#btnProbar').textContent, 'Comprobar')
    assert.strictEqual(a.raiz.querySelector('#btnSiguiente3').classList.contains('sec'), true)
  })
})

describe('F041 — el formulario de perfil nuevo no sale hasta pulsar «Agregar perfil»', () => {
  // Pedido del cliente tal cual: al preparar una reunión y elegir uno de los
  // perfiles guardados, el formulario para escribir uno NUEVO salía siempre,
  // encima, ya relleno con los datos del que se acababa de elegir. Ahora sólo
  // aparece al crear uno — aquí, pulsando el botón que pinta
  // `pintarListaPerfilesPaso()`.
  test('elegir un perfil de la lista OCULTA el formulario', () => {
    const a = montar()
    a.seleccionarPerfilPaso({ id: 'p1', nombre: 'Omar Avila' })
    assert.strictEqual(a.formVisible(), false, 'no hay nada que escribir: ya se eligió uno')
  })

  test('«+ Agregar perfil» (perfil nulo) MUESTRA el formulario', () => {
    const a = montar()
    a.seleccionarPerfilPaso({ id: 'p1', nombre: 'Omar Avila' })   // primero uno elegido: form oculto
    assert.strictEqual(a.formVisible(), false)

    a.seleccionarPerfilPaso(null)                                  // "+ Agregar perfil"

    assert.strictEqual(a.formVisible(), true, 'crear uno nuevo sí necesita el formulario')
    assert.strictEqual(a.raiz.querySelector('#pNombre').value, '',
      'y arranca vacío, no con los datos del perfil anterior')
  })

  test('el botón de la lista dice «Agregar perfil», no «Crear»', () => {
    const a = montar()
    a.pintarListaPerfilesPaso([{ id: 'p1', nombre: 'Omar Avila' }])
    const cont = a.raiz.querySelector('#listaPerfilesPaso')
    const textos = cont.hijos.map(h => h.textContent)
    assert.ok(textos.some(t => t.includes('Agregar perfil')),
      `se esperaba un botón «+ Agregar perfil» entre: ${JSON.stringify(textos)}`)
  })
})
