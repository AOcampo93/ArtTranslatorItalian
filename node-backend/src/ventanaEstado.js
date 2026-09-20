/**
 * ventanaEstado.js — geometría de la ventana en vivo (F035).
 *
 * Pedido por el cliente: la ventana ya no compite con la de la reunión. Debe
 * abrir angosta (440 px), del alto entero del área de trabajo y pegada al
 * borde derecho — y si el usuario la mueve o la redimensiona, la próxima vez
 * abre donde la dejó.
 *
 * La geometría se calcula aquí, en una función PURA (`calcularBounds`) que no
 * toca Electron ni `screen`: así se prueba con un doble (un objeto que imita
 * el `workArea` que da `screen.getPrimaryDisplay()`), sin abrir una ventana de
 * verdad. `mainApp.js` es la única pieza que conoce Electron; le pasa el
 * `workArea` real y el estado guardado, y sólo aplica el resultado.
 */

'use strict'

const fs = require('fs')

const ANCHO_POR_DEFECTO = 440
const MIN_WIDTH = 380

/**
 * `x + width` puede colarse un poco fuera del área de trabajo si la pantalla
 * cambió de tamaño desde que se guardó (o desapareció, con dos monitores). Un
 * margen de 40 px es lo mínimo agarrable de una ventana; por debajo de eso el
 * hueco visible ya no sirve para nada y se prefiere el valor por defecto.
 */
const MARGEN_VISIBLE_PX = 40

/**
 * ¿El estado guardado tiene sentido dentro de ESTE `workArea`? Si la ventana
 * quedaría casi entera fuera de la pantalla actual (otro monitor que ya no
 * está conectado, o una resolución menor), se descarta y se vuelve al valor
 * por defecto en vez de abrir una ventana invisible que el cliente no sepa
 * encontrar.
 */
function cabeEnElArea (guardado, workArea) {
  if (!guardado) return false
  const { x, y, width, height } = guardado
  if (!(width > 0 && height > 0)) return false
  const visibleX = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x)
  const visibleY = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y)
  return visibleX >= MARGEN_VISIBLE_PX && visibleY >= MARGEN_VISIBLE_PX
}

/**
 * Calcula los `bounds` (`x`, `y`, `width`, `height`) de la ventana en vivo.
 *
 * Sin estado guardado (primer arranque, o uno que ya no cabe): angosta,
 * pegada al borde DERECHO del área de trabajo y con su alto entero — la
 * propuesta del cliente. Con estado guardado y válido: se respeta tal cual,
 * salvo el ancho, que nunca baja de `minWidth` (una ventana guardada más
 * angosta que eso, de una versión anterior, dejaría de poder usarse).
 */
function calcularBounds ({ workArea, guardado = null, anchoPorDefecto = ANCHO_POR_DEFECTO, minWidth = MIN_WIDTH }) {
  if (cabeEnElArea(guardado, workArea)) {
    return {
      x: guardado.x, y: guardado.y,
      width: Math.max(guardado.width, minWidth),
      height: guardado.height,
    }
  }
  // El ancho por defecto nunca es más ancho que el propio monitor: en un
  // portátil pequeño, 440 px pegados a la derecha con el resto vacío sería
  // absurdo, y `workArea.width` ya lo evita sin necesitar un caso aparte.
  const width = Math.min(anchoPorDefecto, workArea.width)
  return {
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height: workArea.height,
  }
}

/** Lee el estado guardado. `null` si no hay archivo o está corrupto: se cae al valor por defecto, no se rompe el arranque. */
function leerEstado (ruta) {
  try {
    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'))
    const { x, y, width, height } = datos || {}
    if ([x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n))) {
      return { x, y, width, height }
    }
    return null
  } catch {
    return null
  }
}

/** Guarda el estado. Un fallo de disco (permisos, disco lleno) no es motivo para tumbar la app: sólo se pierde el recuerdo de la posición. */
function guardarEstado (ruta, bounds) {
  try {
    fs.writeFileSync(ruta, JSON.stringify({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    }))
    return true
  } catch (err) {
    console.error('[ventana] no se pudo guardar la posición:', err.message)
    return false
  }
}

module.exports = { calcularBounds, leerEstado, guardarEstado, ANCHO_POR_DEFECTO, MIN_WIDTH }
