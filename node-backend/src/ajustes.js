/**
 * ajustes.js — lo que la app recuerda entre arranques, y dónde lo guarda (F051).
 *
 * Cuatro cosas que no dependen de Electron más que por un objeto `app` que se les
 * pasa, para poder probarlas sin abrir una ventana (el mismo reparto que
 * `ventanaEstado.js`): la carpeta de datos, la base de perfiles que vive en ella
 * (F057), el archivo `ajustes.json` y la elección de idioma que se guarda en él.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { obtenerIdioma, listarIdiomas } = require('./idiomas')
const { NOMBRE_DE_LA_BASE } = require('./db')

/**
 * La carpeta de datos de siempre dentro de `%APPDATA%` (PLAN.md §17.7).
 *
 * `[verificado]` el 08-10-2026 sobre la v0.9 ya construida: el `package.json` que
 * va DENTRO de `electron-app/dist/win-unpacked/resources/app.asar` trae
 * `name: "art-translator-italian-diagnostico"` y NO trae `productName` —el
 * `build.productName` ("Traductor Italiano") es de electron-builder y no se copia
 * a ese archivo—. Electron nombra la app con `productName` si lo hay y, si no,
 * con `name`, y de ese nombre sale `userData`. O sea que la v0.9 guardaba claves,
 * reuniones y ventana en `%APPDATA%\art-translator-italian-diagnostico`, NO en
 * `%APPDATA%\Traductor Italiano` como suponía el plan. Con el binario de
 * Electron 43.7.0 y ese mismo `package.json`, `app.name` da
 * `art-translator-italian-diagnostico`. Y fue la misma en todas las versiones: en
 * el historial de git, de la 0.1.0 a la 0.9.0, `name` nunca cambió y no hubo nunca
 * un `productName` en el nivel de arriba.
 *
 * Se fija a mano para que ni cambiar el `name` ni poner un `productName` en el
 * `package.json` dejen a la V2 sin las claves y las reuniones del usuario.
 */
const CARPETA_DE_DATOS = 'art-translator-italian-diagnostico'

/**
 * Pone `userData` en la carpeta de siempre. Se llama una vez, nada más cargar el
 * proceso principal: `userData` solo se puede cambiar antes de `ready`.
 *
 * En desarrollo (`!app.isPackaged`) no hace nada: ahí la carpeta es la que Electron
 * decide hoy y no se toca.
 *
 * @param {{ isPackaged: boolean, getPath: Function, setPath: Function }} app
 * @returns {string|null} la ruta que quedó fijada, o `null` si no se tocó nada
 */
function fijarCarpetaDeDatos (app) {
  if (!app.isPackaged) return null
  const ruta = path.join(app.getPath('appData'), CARPETA_DE_DATOS)
  app.setPath('userData', ruta)
  return ruta
}

/**
 * Dónde debe abrir `db.js` la base de perfiles y contextos, y, la primera vez,
 * llevarla ahí desde donde la dejó la versión anterior (F057, PLAN.md §17.7).
 *
 * La v0.9 la guardaba junto a la app, en `resources/node-backend/data`: extraer la
 * versión siguiente en otra carpeta dejaba al usuario sin perfiles ni contextos, y
 * cada versión futura lo habría repetido. En `userData` sobrevive a las
 * actualizaciones, como las claves y las reuniones.
 *
 * Empaquetada, si `userData` aún no tiene base y la carpeta de la app sí, se COPIA
 * (nunca se mueve ni se borra la original: es lo único que queda si algo sale
 * mal). La copia va a un nombre temporal y se renombra, para que un corte a medias
 * no deje en `userData` una base truncada que el siguiente arranque tomaría por
 * buena. Si copiar falla, se registra y se sigue con una base nueva y vacía: perder
 * de vista los perfiles molesta, pero una app que no abre por eso no se puede usar.
 * En desarrollo no se toca nada.
 *
 * Se llama desde `whenReady`, DESPUÉS de `fijarCarpetaDeDatos`: antes, `userData`
 * todavía es la carpeta que Electron saca del nombre.
 *
 * @param {object} p
 * @param {{ isPackaged: boolean, getPath: Function }} p.app
 * @param {string} [p.recursos]  `process.resourcesPath`: la carpeta `resources` de la
 *   app empaquetada, donde `extraResources` deja `node-backend`
 * @returns {{ carpeta: string|null, copiada: boolean, error?: string }}
 *   `carpeta` es lo que se pasa a `db.init`; `null`, la de desarrollo de siempre
 */
function prepararBaseDeDatos ({ app, recursos }) {
  if (!app.isPackaged) return { carpeta: null, copiada: false }

  const carpeta = app.getPath('userData')
  const destino = path.join(carpeta, NOMBRE_DE_LA_BASE)
  const temporal = destino + '.copiando'
  try {
    if (fs.existsSync(destino)) return { carpeta, copiada: false }
    if (!recursos) return { carpeta, copiada: false }
    const origen = path.join(recursos, 'node-backend', 'data', NOMBRE_DE_LA_BASE)
    if (!fs.existsSync(origen)) return { carpeta, copiada: false }

    fs.mkdirSync(carpeta, { recursive: true })
    try {
      fs.copyFileSync(origen, temporal)
      fs.renameSync(temporal, destino)
    } catch (err) {
      // Sin esto quedaría un `.copiando` a medias; si ni siquiera se puede borrar,
      // el siguiente arranque lo pisa al copiar, y la causa que importa es `err`.
      try { fs.rmSync(temporal, { force: true }) } catch { /* se queda */ }
      throw err
    }
    return { carpeta, copiada: true }
  } catch (err) {
    console.error('[datos] no se pudo llevar la base de perfiles a la carpeta de datos; '
      + 'se empieza con una vacía:', err.message)
    return { carpeta, copiada: false, error: err.message }
  }
}

/**
 * Lee `ajustes.json`. Sin archivo, o con uno roto, `{}`: faltar el recuerdo del
 * último idioma no es motivo para tumbar el arranque. Un idioma guardado que el
 * registro ya no conoce se olvida, en vez de marcar un botón que no existe.
 *
 * @returns {{ idioma?: string }}
 */
function leerAjustes (ruta) {
  try {
    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'))
    const ajustes = {}
    if (typeof datos?.idioma === 'string') {
      try { ajustes.idioma = obtenerIdioma(datos.idioma).codigo } catch { /* se olvida */ }
    }
    return ajustes
  } catch {
    return {}
  }
}

/**
 * Funde `parche` con lo que ya había y lo guarda. Un fallo de disco no tumba la
 * app —solo se pierde el recuerdo—, como en `ventanaEstado.guardarEstado`.
 *
 * @returns {boolean} si se pudo escribir
 */
function guardarAjustes (ruta, parche) {
  try {
    fs.writeFileSync(ruta, JSON.stringify({ ...leerAjustes(ruta), ...parche }))
    return true
  } catch (err) {
    console.error('[ajustes] no se pudo guardar:', err.message)
    return false
  }
}

/**
 * Lo que pasa cuando el usuario elige idioma (`app:elegirIdioma`): se recuerda, se
 * precarga el Marian de ese idioma y se suelta el de los demás.
 *
 * **Con una reunión en marcha no se cambia** y no se toca nada: soltar el Marian
 * en mitad de una traducción la rompería, y la sesión sigue en el idioma con el
 * que arrancó. Esta puerta y la de la interfaz (que no ofrece el botón escuchando)
 * son independientes a propósito: una interfaz rota no puede cambiar el idioma de
 * una reunión que ya factura.
 *
 * La precarga y la descarga van en segundo plano, sin esperarlas: entrar al panel
 * de inicio no puede quedarse mirando cuatro segundos de carga. Si la precarga
 * falla, la reunión lo volverá a intentar al empezar y dirá el motivo ahí.
 *
 * @param {object}  p
 * @param {string}  p.codigo      el idioma elegido; sin él no se asume ninguno
 * @param {boolean} p.hayReunion  si hay una sesión de transcripción abierta
 * @param {string}  p.ruta        el `ajustes.json`
 * @param {{ cargar: Function, descargar: Function }} p.traductor  el módulo de Marian
 * @returns {{ ok: true, idioma: string } | { ok: false, motivo: string }}
 */
function elegirIdioma ({ codigo, hayReunion, ruta, traductor }) {
  // `obtenerIdioma(undefined)` devuelve el italiano; aquí un código ausente es un
  // error de quien llama, no una elección.
  if (typeof codigo !== 'string') return { ok: false, motivo: 'Falta el idioma.' }

  let idioma
  try {
    idioma = obtenerIdioma(codigo)
  } catch (err) {
    return { ok: false, motivo: err.message }
  }
  if (hayReunion) {
    return { ok: false, motivo: 'Hay una reunión en marcha. Detenla para cambiar de idioma.' }
  }

  guardarAjustes(ruta, { idioma: idioma.codigo })

  traductor.cargar(idioma.modeloMarian, idioma.calentamientoMarian)
    .catch(err => console.error('[idioma] no se pudo precargar Marian:', err.message))
  for (const otro of listarIdiomas()) {
    if (otro.modeloMarian === idioma.modeloMarian) continue
    traductor.descargar(otro.modeloMarian)
      .catch(err => console.error('[idioma] no se pudo soltar Marian:', err.message))
  }
  return { ok: true, idioma: idioma.codigo }
}

module.exports = {
  CARPETA_DE_DATOS, fijarCarpetaDeDatos, prepararBaseDeDatos, leerAjustes, guardarAjustes, elegirIdioma,
}
