/**
 * Pruebas de la geometría de la ventana en vivo (F035).
 *
 * `calcularBounds` es una función PURA: no toca `screen` ni abre ninguna
 * ventana. Se le pasa un `workArea` de mentira —un doble— tal como lo
 * entregaría `screen.getPrimaryDisplay()`, y eso es lo que exige el criterio
 * «la geometría se prueba con un doble de `screen`, sin abrir Electron».
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { calcularBounds, leerEstado, guardarEstado, ANCHO_POR_DEFECTO, MIN_WIDTH } =
  require('../src/ventanaEstado')

// Un doble de `screen.getPrimaryDisplay().workArea`: un monitor 1080p normal
// sin barra de tareas a la izquierda.
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 }

describe('F035 — al abrir sin posición guardada: angosta, alta, pegada al borde', () => {
  test('el alto es el del área de trabajo y el ancho es el angosto por defecto', () => {
    const b = calcularBounds({ workArea: WORK_AREA, guardado: null })
    assert.strictEqual(b.height, WORK_AREA.height)
    assert.strictEqual(b.width, ANCHO_POR_DEFECTO)
  })

  test('queda pegada al borde DERECHO: su borde derecho coincide con el del área de trabajo', () => {
    const b = calcularBounds({ workArea: WORK_AREA, guardado: null })
    assert.strictEqual(b.x + b.width, WORK_AREA.x + WORK_AREA.width)
    assert.strictEqual(b.y, WORK_AREA.y)
  })
})

describe('F035 — si el usuario movió o redimensionó la ventana, se respeta la próxima vez', () => {
  test('con un estado guardado que cabe en el área, se usa tal cual (no el valor por defecto)', () => {
    const guardado = { x: 100, y: 40, width: 500, height: 700 }
    const b = calcularBounds({ workArea: WORK_AREA, guardado })
    assert.deepStrictEqual(b, guardado)
  })

  test('un ancho guardado por debajo de minWidth se sube a minWidth, nunca se deja pasar', () => {
    const guardado = { x: 100, y: 40, width: 200, height: 700 }
    const b = calcularBounds({ workArea: WORK_AREA, guardado })
    assert.strictEqual(b.width, MIN_WIDTH)
  })

  test('un estado de un monitor que ya no está conectado (casi fuera del área) se descarta', () => {
    // Sólo 10 px visibles: por debajo del margen agarrable, se cae al valor
    // por defecto en vez de abrir una ventana que el cliente no sabría encontrar.
    const guardado = { x: WORK_AREA.width - 10, y: 0, width: 440, height: 900 }
    const b = calcularBounds({ workArea: WORK_AREA, guardado })
    assert.strictEqual(b.width, ANCHO_POR_DEFECTO, 'tuvo que descartar el guardado y volver al valor por defecto')
    assert.strictEqual(b.x + b.width, WORK_AREA.x + WORK_AREA.width)
  })
})

describe('F035 — persistencia del estado (leer/guardar), sin Electron', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ventana-estado-'))
  const ruta = path.join(dir, 'ventana.json')

  test('sin archivo, leerEstado devuelve null y no revienta', () => {
    assert.strictEqual(leerEstado(ruta), null)
  })

  test('lo que se guarda es lo mismo que se vuelve a leer', () => {
    const bounds = { x: 1200, y: 0, width: 440, height: 1040 }
    assert.ok(guardarEstado(ruta, bounds))
    assert.deepStrictEqual(leerEstado(ruta), bounds)
  })

  test('un archivo corrupto no rompe el arranque: se lee como si no hubiera nada', () => {
    fs.writeFileSync(ruta, '{ esto no es json')
    assert.strictEqual(leerEstado(ruta), null)
  })
})
