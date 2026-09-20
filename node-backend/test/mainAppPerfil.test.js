/**
 * F032 — un perfil ya guardado se reutiliza sin volver a escribirlo.
 *
 * Pedido por el cliente tal cual: "estar poniendo los perfiles a cada rato
 * no es bueno". Antes de esta tarea, `empezarSesion()` llamaba a
 * `contexto.crearPerfil(perfil)` en CADA reunión sin mirar si el perfil que
 * llegaba ya existía, así que cada «Escuchar» insertaba una fila nueva en
 * `profiles` aunque el usuario no hubiera tocado el formulario.
 *
 * `mainApp.js` no se puede `require` desde una prueba (pide `electron` en la
 * primera línea), así que se sigue el patrón de la casa
 * (`mainAppSesionF030.test.js`): se extrae el tramo real y se ejecuta con un
 * `contexto` de mentira que solo apunta las llamadas.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const FUENTE = fs.readFileSync(MAIN_APP, 'utf8')

function tramo (desde, hasta) {
  const i = FUENTE.indexOf(desde)
  const j = FUENTE.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return FUENTE.slice(i, j)
}

/** Un `contexto` de mentira que solo registra qué se le pidió. */
function contextoFalso () {
  const llamadas = []
  return {
    llamadas,
    crearPerfil: p => { llamadas.push(['crearPerfil', p]); return 42 },
    actualizarPerfil: (id, campos) => { llamadas.push(['actualizarPerfil', id, campos]) },
    activarPerfil: id => { llamadas.push(['activarPerfil', id]) },
    crearContexto: () => { llamadas.push(['crearContexto']); return 1 },
  }
}

/** Ejecuta solo el tramo que decide qué hacer con `perfil` y `ctx`, y devuelve el `perfil` final. */
function ejecutar (contexto, { perfil, ctx }) {
  const codigo = tramo(
    '// Se guardan para que el informe y los prompts los tengan.',
    'const glosario = (ctx?.glosario'
  ) + '\nreturn perfil'
  const fabrica = new Function('contexto', 'perfil', 'ctx', codigo)
  return fabrica(contexto, perfil, ctx)
}

describe('F032 — reutilizar un perfil guardado, no volver a escribirlo', () => {
  test('un perfil SIN id (nuevo) se crea una vez y queda activo', () => {
    const contexto = contextoFalso()
    const perfilFinal = ejecutar(contexto, { perfil: { nombre: 'Omar' }, ctx: null })

    assert.deepStrictEqual(
      contexto.llamadas.filter(l => l[0] === 'crearPerfil').length, 1,
      'un perfil nuevo sí se inserta, una sola vez'
    )
    assert.deepStrictEqual(contexto.llamadas, [
      ['crearPerfil', { nombre: 'Omar' }],
      ['activarPerfil', 42],
    ])
    assert.strictEqual(perfilFinal.id, 42, 'el id que devolvió crearPerfil queda en el perfil')
  })

  test('un perfil CON id (ya guardado) se actualiza, y NUNCA se vuelve a insertar', () => {
    const contexto = contextoFalso()
    const perfilFinal = ejecutar(contexto, {
      perfil: { id: 7, nombre: 'Omar Ávila', edad: 34, ocupacion: 'PM', contexto: 'sin italiano' },
      ctx: null,
    })

    const crea = contexto.llamadas.filter(l => l[0] === 'crearPerfil')
    assert.strictEqual(crea.length, 0, 'un perfil que ya existe no se vuelve a escribir')

    const actualiza = contexto.llamadas.find(l => l[0] === 'actualizarPerfil')
    assert.ok(actualiza, 'se actualiza con los datos actuales del formulario')
    assert.strictEqual(actualiza[1], 7)
    assert.deepStrictEqual(actualiza[2], {
      nombre: 'Omar Ávila', edad: 34, ocupacion: 'PM', contexto: 'sin italiano',
    })

    assert.deepStrictEqual(
      contexto.llamadas.find(l => l[0] === 'activarPerfil'), ['activarPerfil', 7],
      'queda marcado activo, para preseleccionarlo la próxima vez'
    )
    assert.strictEqual(perfilFinal.id, 7)
  })

  test('sin nombre no se toca la tabla de perfiles (conversación rápida sin perfil)', () => {
    const contexto = contextoFalso()
    ejecutar(contexto, { perfil: null, ctx: null })
    assert.deepStrictEqual(contexto.llamadas, [])
  })
})
