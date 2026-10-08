'use strict'

/**
 * Licencias (F053): almacén en disco, activación con tope de equipos y permiso
 * firmado con Ed25519. Sin dependencias, como el resto del VPS.
 *
 * Lo comparten `servidor.js` (la ruta `POST /licencias/activar`) y
 * `licencias-cli.js` (la administración por ssh). Tener el almacén en un solo
 * sitio es lo que evita que el servidor y la herramienta lean el archivo de dos
 * maneras distintas.
 *
 * Un permiso es `{ licencia, huellas, emitido, caduca }` (milisegundos desde
 * 1970) en JSON, y la firma va sobre esos mismos bytes. La clave privada solo
 * existe en el entorno del VPS: aquí se carga a un `KeyObject` y no se vuelve a
 * tocar como texto ni se escribe en ningún log.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DIRECTORIO_POR_DEFECTO = '/datos/licencias'
const ARCHIVO_ALMACEN = 'licencias.json'
const ARCHIVO_CANDADO = 'licencias.lock'

const MAXIMO_POR_DEFECTO = 6 // equipos por licencia (PLAN §17.6)
const DIAS_POR_DEFECTO = 14 // vigencia del permiso (PLAN §17.6)
const DIAS_MAXIMOS = 365 // tope de cordura para LICENCIAS_DIAS: un permiso eterno anula la revocación
const MS_DIA = 24 * 60 * 60 * 1000
const REGISTRO_MAXIMO = 500 // líneas de activaciones que se conservan por licencia; el contador total no se recorta
const HUELLAS_POR_EQUIPO = 16 // un mismo equipo no acumula huellas sin límite aunque reinstalen Windows cien veces
const CONTACTO_POR_DEFECTO = 'Contacta a quien te entregó la aplicación.'

// Esperar al candado más de esto es que algo va mal; romperlo pasado el otro
// plazo es que quien lo tenía murió sin soltarlo (el contenedor se reinició
// justo en esos milisegundos). Nadie lo retiene de verdad más de unos ms.
const CANDADO_ESPERA_MS = 3000
const CANDADO_HUERFANO_MS = 10_000
const CANDADO_PAUSA_MS = 20

// Alfabetos cerrados: la licencia son 128 bits en hex; cada huella, el SHA-256
// que calcula la app (64 hex). Minúsculas, porque así los generamos todos.
const PATRON_LICENCIA = /^[0-9a-f]{32}$/
const PATRON_HUELLA = /^[0-9a-f]{64}$/

/** Directorio del almacén: el volumen del contenedor, o el que fije `LICENCIAS_DIRECTORIO` (pruebas y uso local de la herramienta). */
function directorioLicencias () {
  return process.env.LICENCIAS_DIRECTORIO || DIRECTORIO_POR_DEFECTO
}

function errorConCodigo (codigo, mensaje) {
  const error = new Error(mensaje)
  error.code = codigo
  return error
}

// ---------------------------------------------------------------------------
// Almacén
// ---------------------------------------------------------------------------

/**
 * Lee el almacén. Un archivo que no existe es un almacén vacío (el primer
 * arranque); uno que existe pero no se entiende **lanza**: seguir adelante con
 * uno vacío y escribirlo después borraría todas las licencias de golpe.
 */
function leerAlmacen (directorio) {
  let texto
  try {
    texto = fs.readFileSync(path.join(directorio, ARCHIVO_ALMACEN), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, licencias: {} }
    throw error
  }
  let almacen
  try {
    almacen = JSON.parse(texto)
  } catch {
    throw errorConCodigo('ALMACEN_ILEGIBLE', 'licencias.json no es JSON válido')
  }
  const licencias = almacen && almacen.licencias
  if (!licencias || typeof licencias !== 'object' || Array.isArray(licencias)) {
    throw errorConCodigo('ALMACEN_ILEGIBLE', 'licencias.json no tiene el formato esperado')
  }
  return almacen
}

/**
 * Escritura atómica: archivo temporal en el mismo directorio, `fsync` y
 * `rename`. Un corte de luz deja el archivo anterior entero o el nuevo entero,
 * nunca uno a medias; sin el `fsync`, algunos sistemas de archivos pueden
 * dejar el `rename` hecho y los datos sin bajar a disco. `writeFileSync` sobre
 * el descriptor repite la escritura hasta el último byte o lanza: un
 * `writeSync` suelto puede escribir de menos sin error cuando el disco se
 * llena, y el `rename` publicaría un JSON truncado que lo dejaría todo en 500.
 */
function escribirAlmacen (directorio, almacen) {
  fs.mkdirSync(directorio, { recursive: true })
  const destino = path.join(directorio, ARCHIVO_ALMACEN)
  const temporal = path.join(directorio, `.tmp-${crypto.randomUUID()}`)
  let descriptor
  try {
    descriptor = fs.openSync(temporal, 'wx', 0o600)
    fs.writeFileSync(descriptor, JSON.stringify(almacen, null, 2) + '\n')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporal, destino)
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch { /* ya se informa el error original */ } }
    try { fs.unlinkSync(temporal) } catch { /* puede que ni se creara */ }
    throw error
  }
}

function pausa (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Candado entre procesos para el ciclo leer → cambiar → escribir. Dentro del
 * servidor ese ciclo ya es síncrono —en Node eso basta para que dos peticiones
 * no se pisen—, pero la herramienta de administración es OTRO proceso sobre el
 * mismo archivo: sin candado, una activación que cae entre su lectura y su
 * escritura devolvería a la vida una licencia recién revocada, o un equipo recién
 * liberado. `open(..., 'wx')` es atómico, así que solo uno lo consigue.
 */
function conCandado (directorio, funcion) {
  fs.mkdirSync(directorio, { recursive: true })
  const candado = path.join(directorio, ARCHIVO_CANDADO)
  const limite = Date.now() + CANDADO_ESPERA_MS
  for (;;) {
    try {
      fs.closeSync(fs.openSync(candado, 'wx', 0o600))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    // Existe: o lo tiene alguien ahora mismo, o es un huérfano. El plazo se
    // comprueba en cada vuelta para que ningún fallo de permisos al consultarlo
    // o romperlo pueda convertir esto en un bucle sin salida.
    if (Date.now() > limite) throw errorConCodigo('ALMACEN_OCUPADO', 'el almacén de licencias sigue ocupado')
    let edad = 0
    try {
      edad = Date.now() - fs.statSync(candado).mtimeMs
    } catch { /* lo soltaron justo ahora: se reintenta tras la pausa */ }
    if (edad > CANDADO_HUERFANO_MS) {
      try {
        fs.unlinkSync(candado)
        continue
      } catch { /* otro lo rompió antes, o no hay permiso: se espera y se reintenta */ }
    }
    pausa(CANDADO_PAUSA_MS)
  }
  try {
    return funcion()
  } finally {
    try { fs.unlinkSync(candado) } catch { /* ya no está: nada que soltar */ }
  }
}

// ---------------------------------------------------------------------------
// Clave y permiso
// ---------------------------------------------------------------------------

/**
 * `KeyObject` Ed25519 a partir del texto del entorno. En un `.env` el PEM va en
 * una sola línea con `\n` literales (un salto real parte la variable); con
 * comillas dobles Compose los convierte en saltos y con `--env-file` las
 * comillas se quedan dentro. Se aceptan las tres formas. Los errores de
 * OpenSSL no llevan material de la clave, pero igual no se propaga el texto.
 */
function cargarClavePrivada (valor) {
  const pem = String(valor).trim().replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\\n/g, '\n')
  const clave = crypto.createPrivateKey(pem)
  if (clave.asymmetricKeyType !== 'ed25519') {
    throw errorConCodigo('CLAVE_NO_ED25519', 'la clave no es Ed25519')
  }
  return clave
}

/** Huella corta de la clave pública, para comprobar a simple vista que el VPS firma con la clave que la app lleva incrustada. */
function huellaClavePublica (clavePrivada) {
  const der = crypto.createPublicKey(clavePrivada).export({ type: 'spki', format: 'der' })
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)
}

/**
 * Convierte las opciones/entorno en lo que usa la ruta. Una clave ausente o
 * inservible deja `clave: null` —la ruta responde 503— y el resto del servidor
 * sigue; nunca se lanza, porque tirar el proceso por esto bajaría también la
 * subida de informes.
 */
function configurarLicencias ({ clavePrivada = '', directorio, dias, contacto } = {}) {
  let clave = null
  if (String(clavePrivada).trim()) {
    try {
      clave = cargarClavePrivada(clavePrivada)
    } catch (error) {
      console.error(`LICENCIAS_CLAVE_PRIVADA no es una clave Ed25519 PKCS8 válida (${error.code || 'sin código'}): la ruta de licencias responde 503`)
    }
  }

  let diasPermiso = DIAS_POR_DEFECTO
  if (dias !== undefined && dias !== null && String(dias).trim() !== '') {
    const n = Number(dias)
    if (Number.isInteger(n) && n >= 1 && n <= DIAS_MAXIMOS) {
      diasPermiso = n
    } else {
      console.error(`LICENCIAS_DIAS no es un entero de 1 a ${DIAS_MAXIMOS}: se usan ${DIAS_POR_DEFECTO}`)
    }
  }

  return {
    clave,
    huella: clave ? huellaClavePublica(clave) : null,
    directorio: directorio || directorioLicencias(),
    dias: diasPermiso,
    contacto: String(contacto || '').trim().slice(0, 300) || CONTACTO_POR_DEFECTO
  }
}

/** Permiso firmado: `permiso` es el JSON en base64url y `firma` la de Ed25519 sobre esos mismos bytes. */
function firmarPermiso (clavePrivada, { licencia, maquina, placa }, { ahora = Date.now(), dias = DIAS_POR_DEFECTO } = {}) {
  const bytes = Buffer.from(JSON.stringify({
    licencia,
    huellas: { maquina, placa },
    emitido: ahora,
    caduca: ahora + dias * MS_DIA
  }), 'utf8')
  return {
    permiso: bytes.toString('base64url'),
    firma: crypto.sign(null, bytes, clavePrivada).toString('base64url')
  }
}

// ---------------------------------------------------------------------------
// Activación
// ---------------------------------------------------------------------------

/**
 * Guarda una huella en un equipo. Solo se llama con las de una petición que ya
 * coincidió con él (`buscarEquipo`): guardar las de cualquier petición
 * convertía un solo acierto en identidad permanente (revisión de F053).
 */
function recuerda (lista, huella) {
  if (huella === null || lista.includes(huella)) return
  lista.push(huella)
  if (lista.length > HUELLAS_POR_EQUIPO) lista.splice(0, lista.length - HUELLAS_POR_EQUIPO)
}

/**
 * El equipo registrado al que corresponde esta petición, o `undefined` si es
 * una computadora nueva (PLAN §17.6). La placa manda: si coincide, es la misma
 * computadora aunque la máquina sea otra, que es lo que pasa al reinstalar
 * Windows. Si no coincide, la máquina solo basta cuando la placa no la
 * contradice: la petición no trae placa, o el equipo nunca tuvo una.
 *
 * Con «coincide cualquiera de las dos», una PC nueva entraba sin plaza con
 * presentar una sola vez el MachineGuid de otra ya activada (copiado con
 * regedit, o en una petición retocada). Ahora ese MachineGuid, con su placa de
 * verdad al lado, contradice la del equipo y cuenta como otro.
 */
function buscarEquipo (equipos, maquina, placa) {
  const porPlaca = placa === null ? undefined : equipos.find((e) => e.placas.includes(placa))
  if (porPlaca) return porPlaca
  return equipos.find((e) => e.maquinas.includes(maquina) && (placa === null || e.placas.length === 0))
}

/**
 * Decide una activación y la apunta. Devuelve `{ estado, resultado }`:
 * `estado` es lo que se responde (`permiso`, `tope` o `denegada`) y `resultado`
 * lo que queda en el registro y en el log (`nuevo`, `conocido`, `tope`,
 * `revocada` o `inexistente`). Quien llama firma el permiso.
 *
 * Todo el ciclo leer → decidir → escribir es síncrono y va dentro del candado:
 * dos activaciones simultáneas del 6.º y el 7.º equipo no pueden leer las dos
 * «5 usados». Un permiso solo se firma si la escritura ya salió bien; si el
 * disco falla, esto lanza y no se da permiso por una plaza que no quedó anotada.
 *
 * Un equipo es conocido según `buscarEquipo`: reinstalar Windows en la misma
 * computadora cambia la máquina y no la placa. Las huellas nuevas de una
 * petición que coincidió se guardan en el mismo equipo.
 */
function activarEquipo (directorio, { licencia, maquina, placa, equipo, version }, { ahora = new Date(), contacto = CONTACTO_POR_DEFECTO } = {}) {
  return conCandado(directorio, () => {
    const almacen = leerAlmacen(directorio)
    const lic = Object.hasOwn(almacen.licencias, licencia) ? almacen.licencias[licencia] : null
    // Una licencia que no existe no deja rastro en el almacén: si lo dejara,
    // cualquiera podría llenarlo de basura probando identificadores.
    if (!lic) return { estado: 'denegada', resultado: 'inexistente' }

    const iso = ahora.toISOString()
    const apunta = (resultado) => {
      lic.activaciones.push({ fecha: iso, maquina, placa, equipo, version, resultado })
      if (lic.activaciones.length > REGISTRO_MAXIMO) lic.activaciones.splice(0, lic.activaciones.length - REGISTRO_MAXIMO)
      lic.activacionesTotal = (lic.activacionesTotal || 0) + 1
      escribirAlmacen(directorio, almacen)
    }

    if (lic.revocada) {
      apunta('revocada')
      return { estado: 'denegada', resultado: 'revocada' }
    }

    const conocido = buscarEquipo(lic.equipos, maquina, placa)
    if (conocido) {
      conocido.nombre = equipo
      conocido.version = version
      conocido.ultima = iso
      recuerda(conocido.maquinas, maquina)
      recuerda(conocido.placas, placa)
      apunta('conocido')
      return { estado: 'permiso', resultado: 'conocido' }
    }

    if (lic.equipos.length < lic.maximo) {
      lic.equipos.push({
        nombre: equipo,
        version,
        primera: iso,
        ultima: iso,
        maquinas: [maquina],
        placas: placa === null ? [] : [placa]
      })
      apunta('nuevo')
      return { estado: 'permiso', resultado: 'nuevo' }
    }

    apunta('tope')
    return { estado: 'tope', resultado: 'tope', usados: lic.equipos.length, maximo: lic.maximo, contacto: lic.contacto || contacto }
  })
}

module.exports = {
  DIRECTORIO_POR_DEFECTO,
  ARCHIVO_ALMACEN,
  ARCHIVO_CANDADO,
  MAXIMO_POR_DEFECTO,
  DIAS_POR_DEFECTO,
  MS_DIA,
  REGISTRO_MAXIMO,
  CONTACTO_POR_DEFECTO,
  PATRON_LICENCIA,
  PATRON_HUELLA,
  directorioLicencias,
  leerAlmacen,
  escribirAlmacen,
  conCandado,
  cargarClavePrivada,
  huellaClavePublica,
  configurarLicencias,
  firmarPermiso,
  activarEquipo
}
