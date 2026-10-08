/**
 * integridad.js — que `node-backend/src` y `shared` sean los del paquete (F054, ronda 2).
 *
 * Esas dos carpetas viajan FUERA de `app.asar`, en texto plano (`extraResources`), y se cargan
 * en el mismo proceso que `licencia.js`: una línea editada en cualquiera de ellas la apagaría.
 * Contra eso, al construir se escribe un manifiesto con el SHA-256 de cada archivo
 * (`herramientas/manifiesto-backend.js`) que va DENTRO del asar —protegido por el fusible de
 * integridad del asar de F055— y la app lo compara ANTES de cargar nada de esas carpetas
 * (`mainApp.js`). Si falta un archivo, sobra uno o alguno no casa, el backend no se carga.
 *
 * **Autocontenido: solo `fs`, `path` y `crypto`.** Lo comparten la app (verifica) y el guion
 * (genera), para que no puedan discrepar en qué archivos cuentan ni en cómo se calcula cada hash.
 *
 * Lo que NO cubre: `node-backend/node_modules` (miles de archivos de terceros). Cambiar una
 * dependencia ahí sigue siendo trabajo de programador (PLAN.md §17.6, «Lo que no promete»).
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/** Carpetas que cuentan, relativas a la raíz (`resources/` en el paquete; la raíz del repositorio en desarrollo). */
const CARPETAS = ['node-backend/src', 'shared']

/**
 * Basura que el propio sistema deja en cualquier carpeta (el Finder, el Explorador de Windows). Node
 * no puede cargarla como módulo, y contarla bloquearía a un cliente por abrir la carpeta con el
 * explorador.
 */
const IGNORADOS = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

const VERSION_DEL_MANIFIESTO = 1
const RAIZ_POR_DEFECTO = path.join(__dirname, '..', '..')
const MANIFIESTO_POR_DEFECTO = path.join(__dirname, 'manifiesto-backend.json')

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function recorrer (raiz, carpeta, acumulado) {
  const absoluta = path.join(raiz, ...carpeta.split('/'))
  for (const entrada of fs.readdirSync(absoluta, { withFileTypes: true })) {
    if (IGNORADOS.has(entrada.name)) continue
    const relativa = `${carpeta}/${entrada.name}`
    if (entrada.isDirectory()) recorrer(raiz, relativa, acumulado)
    // Un enlace, un socket…: no es un archivo del paquete. Valor `null`: no casa con ningún hash.
    else acumulado[relativa] = entrada.isFile() ? sha256(fs.readFileSync(path.join(absoluta, entrada.name))) : null
  }
}

/**
 * El manifiesto de lo que hay ahora en `raiz`: `{ version, archivos: { 'node-backend/src/x.js': <sha256>, … } }`,
 * con las rutas siempre con `/` y ordenadas, para que el mismo contenido dé el mismo archivo.
 * Lanza si falta una de las carpetas.
 */
function calcularManifiesto (raiz = RAIZ_POR_DEFECTO) {
  const acumulado = {}
  for (const carpeta of CARPETAS) recorrer(raiz, carpeta, acumulado)
  return { version: VERSION_DEL_MANIFIESTO, archivos: Object.fromEntries(Object.entries(acumulado).sort(([a], [b]) => (a < b ? -1 : 1))) }
}

/**
 * Compara el manifiesto con lo que hay en `raiz`. `{ ok: true }` o `{ ok: false, motivo }` con el primer
 * archivo que falla: `falta`, `sobra` o `no coincide`.
 */
function verificarManifiesto (manifiesto, raiz = RAIZ_POR_DEFECTO) {
  const esperados = manifiesto?.archivos
  if (manifiesto?.version !== VERSION_DEL_MANIFIESTO || !esperados || typeof esperados !== 'object' || Array.isArray(esperados)) {
    return { ok: false, motivo: 'manifiesto ilegible' }
  }
  let actuales
  try {
    actuales = calcularManifiesto(raiz).archivos
  } catch (error) {
    return { ok: false, motivo: `no se pudo leer el backend (${error.code || error.name})` }
  }
  for (const [relativa, hash] of Object.entries(esperados)) {
    if (!Object.hasOwn(actuales, relativa)) return { ok: false, motivo: `falta ${relativa}` }
    if (actuales[relativa] !== hash) return { ok: false, motivo: `no coincide ${relativa}` }
  }
  for (const relativa of Object.keys(actuales)) {
    if (!Object.hasOwn(esperados, relativa)) return { ok: false, motivo: `sobra ${relativa}` }
  }
  return { ok: true }
}

/**
 * Lo que hace `mainApp.js` antes de su primer `require` de `node-backend` o `shared`: lee el manifiesto
 * que va dentro del asar y lo compara con las carpetas de al lado. Un paquete SIN manifiesto no es un
 * paquete bueno (se construyó mal, o se lo quitaron): falla cerrado.
 */
function verificarBackend ({ raiz = RAIZ_POR_DEFECTO, ruta = MANIFIESTO_POR_DEFECTO } = {}) {
  let manifiesto
  try {
    manifiesto = JSON.parse(fs.readFileSync(ruta, 'utf8'))
  } catch {
    return { ok: false, motivo: 'falta el manifiesto' }
  }
  return verificarManifiesto(manifiesto, raiz)
}

module.exports = { CARPETAS, calcularManifiesto, verificarManifiesto, verificarBackend }
