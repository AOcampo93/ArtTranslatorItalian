/**
 * F042 — en Perfiles, el formulario solo aparece al pulsar «+ Agregar perfil».
 *
 * Reporte del cliente tras v0.7.0: el formulario de «Nuevo perfil» estaba
 * siempre a la vista, con placeholders («Omar Avila», «34»…) que parecían
 * datos ya guardados y no ejemplos. Ahora el formulario arranca oculto y solo
 * se abre con «+ Agregar perfil» o «Editar»; guardar o cancelar lo cierra.
 *
 * Mismo patrón de la casa que `rendererBurbujas.test.js`: se extrae el bloque
 * real de `app.html` y se ejecuta contra un DOM mínimo.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const DESDE = '// ── Perfiles (F032)'
const HASTA = '// ── Conversaciones (F032)'

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
  addEventListener (tipo, fn) { if (tipo === 'click') this.onclick = fn }

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
}

function montar () {
  const html = fs.readFileSync(APP_HTML, 'utf8')
  const i = html.indexOf(DESDE)
  const j = html.indexOf(HASTA)
  assert.ok(i > 0 && j > i, `no se encontró el bloque de Perfiles en ${APP_HTML}`)
  const codigo = html.slice(i, j)

  const raiz = new Nodo('body')
  for (const id of [
    'listaPerfiles', 'formPerfil', 'tituloFormPerfil',
    'pfNombre', 'pfEdad', 'pfOcupacion', 'pfContexto',
    'btnAgregarPerfil', 'btnGuardarPerfil', 'btnCancelarEdicionPerfil',
  ]) {
    const n = new Nodo(id.startsWith('btn') ? 'button' : id.startsWith('pf') ? 'input' : 'div')
    n.id = id
    // El formulario arranca oculto en el HTML real (F042); el DOM de mentira
    // tiene que arrancar igual, o esta prueba no comprobaría nada.
    if (id === 'formPerfil') n.classList.add('oculto')
    raiz.append(n)
  }

  const $ = sel => (raiz.encaja(sel) ? raiz : raiz.querySelector(sel))
  const crear = (t, c) => { const e = new Nodo(t); if (c) e.className = c; return e }
  const api = null

  const fabrica = new Function('$', 'crear', 'api', `${codigo}
    return { pintarListaPerfiles, cargarFormularioPerfil, mostrarFormularioPerfil }`)

  return {
    raiz,
    formVisible: () => raiz.querySelector('#formPerfil').oculto === false,
    ...fabrica($, crear, api),
  }
}

describe('F042 — el formulario de Perfiles arranca oculto', () => {
  test('al montar la pantalla, el formulario no se ve', () => {
    const a = montar()
    assert.strictEqual(a.formVisible(), false)
  })

  test('«+ Agregar perfil» lo abre, vacío', () => {
    const a = montar()
    a.raiz.querySelector('#btnAgregarPerfil').onclick()
    assert.strictEqual(a.formVisible(), true)
    assert.strictEqual(a.raiz.querySelector('#pfNombre').value, '')
  })

  test('«Editar» en una fila de la lista abre el formulario relleno con esos datos', () => {
    const a = montar()
    a.pintarListaPerfiles([{ id: 'p1', nombre: 'Omar Ávila', ocupacion: 'Responsable técnico', edad: 34 }])
    const btnEditar = a.raiz.querySelector('#listaPerfiles').hijos[0].hijos[1].hijos[1]
    btnEditar.onclick()

    assert.strictEqual(a.formVisible(), true)
    assert.strictEqual(a.raiz.querySelector('#pfNombre').value, 'Omar Ávila')
  })

  test('«Cancelar» cierra el formulario otra vez', () => {
    const a = montar()
    a.raiz.querySelector('#btnAgregarPerfil').onclick()
    assert.strictEqual(a.formVisible(), true)

    a.raiz.querySelector('#btnCancelarEdicionPerfil').onclick()

    assert.strictEqual(a.formVisible(), false)
  })

  test('los placeholders llevan «Ej.:», para no parecer datos ya guardados', () => {
    const html = fs.readFileSync(APP_HTML, 'utf8')
    const bloque = html.slice(html.indexOf('<!-- ══ Perfiles'), html.indexOf('<!-- ══ Conversaciones'))
    for (const id of ['pfNombre', 'pfEdad', 'pfOcupacion', 'pfContexto']) {
      const m = bloque.match(new RegExp(`id="${id}"[^>]*placeholder="([^"]*)"`))
      assert.ok(m, `no se encontró el placeholder de #${id}`)
      assert.match(m[1], /^Ej\.:/, `#${id} tiene el placeholder "${m[1]}", sin «Ej.:»`)
    }
  })
})
