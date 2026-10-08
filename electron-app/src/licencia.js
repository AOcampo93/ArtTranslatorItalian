/**
 * licencia.js — la licencia de esta copia, lado de la app (F054; PLAN.md §17.6 y §0.21).
 *
 * Al arrancar, la app calcula la huella de la computadora, busca el permiso que
 * guardó la vez anterior y, si no sirve, lo pide al servidor de licencias
 * (`vps/`, F053). El permiso es un JSON firmado con Ed25519 que se verifica sin
 * red con la clave pública incrustada.
 *
 * **Vive dentro de `app.asar` y es AUTOCONTENIDO: solo módulos de Node y de
 * Electron.** `node-backend` y `shared` viajan fuera del asar, en texto plano; si
 * esto dependiera de ellos, bastaría editar un archivo para saltárselo.
 *
 * Reglas que no se pueden torcer:
 *
 *  - **Nunca a mitad de reunión (§0.21).** El estado de la licencia lo fija la
 *    comprobación del arranque (o el botón «Reintentar», que solo existe con la
 *    pantalla de bloqueo a la vista). Una renovación en segundo plano jamás lo
 *    toca: si el servidor la deniega, solo retira el permiso guardado, y es el
 *    SIGUIENTE arranque el que tiene que pedir otro. Un permiso que caduca con
 *    la app abierta tampoco corta nada. La renovación se intenta en CADA arranque
 *    con red, no cuando el permiso «ya toca»: con un reloj atrasado a mano, «ya
 *    toca» no llegaba nunca y una licencia revocada seguía viva.
 *  - **Falla cerrada cuando no hay con qué comprobar** (falta `licencia.json`, no
 *    se puede leer la huella) **y abierta cuando es el servidor el que no
 *    contesta** (sin red, 429, 5xx, una respuesta que no se entiende): con un
 *    permiso vigente se sigue; sin él, «Conéctate a internet una vez para
 *    activar». Solo un 403 reconocido (`tope`, `denegada`) bloquea de verdad.
 *  - **«Empaquetada» se decide por dónde vive el código** (`estaEmpaquetada`), no
 *    por `app.isPackaged`, que en Electron solo compara el nombre del ejecutable.
 *    En desarrollo no hay licencia: ni archivo, ni red, ni procesos hijo.
 *
 * Lo que NO promete, dicho claro (PLAN.md §17.6, «Lo que no promete»): frena la
 * copia del zip a otra computadora, no a quien desarme el paquete.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')

const MS_DIA = 24 * 60 * 60 * 1000

// Decisiones del encargo de F054, no mediciones.
/** Cuánto puede haber retrocedido el reloj respecto a la última hora vista antes de dar el permiso por caducado. */
const RETROCESO_TOLERADO_MS = MS_DIA
/** Cada cuánto, con la app abierta, se apunta la hora vista (y otra vez al cerrar). */
const APUNTAR_HORA_CADA_MS = 60 * 60 * 1000

// Plazos `[por medir]` en los equipos del cliente. Holgados a propósito: arrancar PowerShell
// tarda cientos de milisegundos (`hardware.js`), pero un antivirus puede alargarlo mucho la
// primera vez, y quedarse sin la placa tiene un coste (ver `leerConPowerShell`).
const PLAZO_REGISTRO_MS = 5000
const PLAZO_POWERSHELL_MS = 10_000
const PLAZO_ACTIVACION_MS = 10_000

/** La placa que los fabricantes baratos dejan de serie: la repiten miles de computadoras. */
const PLACA_DE_SERIE = '03000200-0400-0500-0006-000700080009'

const PATRON_LICENCIA = /^[0-9a-f]{32}$/
const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Lo que el servidor acepta como versión (`vps/servidor.js`, PATRON_VERSION): otra cosa es un 400.
const PATRON_VERSION = /^\d{1,4}(?:\.\d{1,4}){1,3}(?:-[A-Za-z0-9.]{1,24})?$/
// https siempre; http solo hacia la propia máquina (las pruebas): una URL en claro en el paquete
// mandaría la licencia por la red sin cifrar.
const URL_PERMITIDA = /^(?:https:\/\/|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/)/i

// ── ¿Es esto el paquete? ───────────────────────────────────────────────

const PATRON_ASAR = /[\\/]app\.asar[\\/]/

/** ¿Vive este código dentro de un `app.asar`? `directorio` es el `__dirname` de quien pregunta. */
function enAsar (directorio = __dirname) {
  return PATRON_ASAR.test(directorio)
}

/**
 * «Empaquetada» se decide por dónde vive el código y no solo por `app.isPackaged`. En Electron,
 * esa propiedad únicamente compara el nombre del ejecutable con `electron.exe`: bastaba renombrar
 * `ArtTranslatorV2.exe` a `electron.exe` para que valiera `false`, y con ella «desarrollo»: sin
 * licencia, sin la carpeta de datos del paquete y con la base junto a la app. El código de la app
 * dentro de un asar solo puede ser el paquete (y con el fusible `onlyLoadAppFromAsar`, F055, no
 * hay otra forma de arrancarlo).
 */
function estaEmpaquetada (app, directorio = __dirname) {
  return Boolean(app?.isPackaged) || enAsar(directorio)
}

// ── Huella ─────────────────────────────────────────────────────────────

/**
 * La placa si sirve de algo para distinguir esta computadora, o `null`.
 *
 * Vale `null` la que viene vacía, la que no tiene forma de UUID, la de todo
 * ceros o todo F (y, ya puestos, cualquier UUID de un solo dígito repetido) y la
 * de serie. Si dos computadoras compartieran ese valor basura, el servidor las
 * tomaría por una sola: la segunda entraría sin plaza y la licencia dejaría de
 * contar equipos. Con `null`, la máquina (`MachineGuid`) hace sola de huella.
 */
function placaUtil (texto) {
  const uuid = String(texto ?? '').trim().toLowerCase()
  if (!PATRON_UUID.test(uuid)) return null
  if (/^(.)\1*$/.test(uuid.replace(/-/g, ''))) return null
  if (uuid === PLACA_DE_SERIE) return null
  return uuid
}

/** `sha256(licencia + ':' + valor)`: el servidor nunca ve el valor, y la misma placa da otra huella en otra licencia. */
function huellaDe (licencia, valor) {
  return crypto.createHash('sha256').update(`${licencia}:${valor}`).digest('hex')
}

/**
 * Rutas absolutas de las dos herramientas de Windows. `C:\Windows` va fija y el entorno
 * (`SystemRoot`) solo se mira si esa carpeta no existe (Windows instalado en otra unidad): con
 * el entorno por delante, quien lanza la app apuntaría `SystemRoot` a una carpeta suya con un
 * `reg.exe` y un `powershell.exe` de mentira que contesten los valores de otra computadora.
 * `existe` y `entorno` se inyectan para probarlo sin Windows.
 */
function herramientasDeWindows ({ existe = fs.existsSync, entorno = process.env } = {}) {
  const porDefecto = 'C:\\Windows'
  const raiz = existe(path.win32.join(porDefecto, 'System32'))
    ? porDefecto
    : (entorno.SystemRoot || entorno.windir || porDefecto)
  return {
    reg: path.win32.join(raiz, 'System32', 'reg.exe'),
    powershell: path.win32.join(raiz, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  }
}

async function leerMachineGuid (ejecutar, reg) {
  const r = await ejecutar(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
    { plazoMs: PLAZO_REGISTRO_MS })
  const m = r.ok ? /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(r.salida) : null
  return m ? m[1].toLowerCase() : null
}

// Una sola llamada a PowerShell para la placa y, de respaldo, el MachineGuid. Cada valor en su línea
// y con su nombre: si uno falla, el otro no puede pasar por él.
const PS_HUELLA = [
  "$ErrorActionPreference='SilentlyContinue'",
  "'guid=' + (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
  "'placa=' + (Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID",
].join('; ')

/**
 * Lo que PowerShell sabe de esta computadora: el UUID SMBIOS (la placa) y el MachineGuid.
 *
 * El MachineGuid es el respaldo de `reg.exe`: en equipos gestionados la directiva
 * `DisableRegistryTools` lo desactiva, y sin él la copia daría `sin_huella` para siempre aunque
 * el registro se pueda leer. Como PowerShell ya se lanza por la placa, va en la misma llamada.
 *
 * Si el comando FALLA (se agotó el plazo, PowerShell no arrancó) se prueba una vez más: la primera
 * ejecución tras el arranque puede tardar por el antivirus. Importa porque el permiso lleva las
 * DOS huellas y se comparan exactas; una placa que unas veces se lee y otras no obligaría a pedir
 * permiso otra vez, y sin red eso es «Conéctate a internet». Si el comando contesta y el valor es
 * basura, no se insiste: contestará lo mismo.
 */
async function leerConPowerShell (ejecutar, powershell) {
  for (let intento = 0; intento < 2; intento++) {
    const r = await ejecutar(powershell, ['-NoProfile', '-NonInteractive', '-Command', PS_HUELLA],
      { plazoMs: PLAZO_POWERSHELL_MS })
    if (r.ok) {
      const campo = nombre => new RegExp(`^${nombre}=[ \\t]*(\\S*)`, 'im').exec(r.salida)?.[1] ?? ''
      return { guid: campo('guid').toLowerCase(), placa: placaUtil(campo('placa')) }
    }
  }
  return { guid: '', placa: null }
}

/**
 * Las dos huellas de esta computadora: `{ maquina, placa }`, en hex. `maquina` es `null` si no se
 * pudo leer el `MachineGuid` ni con `reg.exe` ni con PowerShell (sin él no hay licencia que valga);
 * `placa` es `null` cuando no sirve (ver `placaUtil`).
 *
 * `ejecutar(archivo, args, { plazoMs })` devuelve `{ ok, salida }` y nunca rechaza. Las dos lecturas
 * corren a la vez: cada arranque paga lo que tarde la más lenta.
 */
async function calcularHuellas ({ licencia, ejecutar, herramientas = herramientasDeWindows() }) {
  const [porReg, porPowerShell] = await Promise.all([
    leerMachineGuid(ejecutar, herramientas.reg),
    leerConPowerShell(ejecutar, herramientas.powershell),
  ])
  const guid = porReg || porPowerShell.guid
  return {
    maquina: guid ? huellaDe(licencia, guid) : null,
    placa: porPowerShell.placa ? huellaDe(licencia, porPowerShell.placa) : null,
  }
}

/**
 * El nombre de la computadora en el alfabeto que exige el servidor
 * (`[A-Za-z0-9._-]{1,64}` y sin `..`): sin acentos, espacios a `-`, lo demás a `-`.
 * Con otro, el servidor da 400 y ese equipo no se activaría nunca.
 */
function normalizarEquipo (nombre) {
  const limpio = String(nombre ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .slice(0, 64)
  return limpio || 'equipo'
}

// ── Configuración incrustada ───────────────────────────────────────────

/**
 * `licencia.json`, que viaja dentro del paquete como `informes.token.json`:
 * `{ licencia, clavePublica, url }`. `null` si falta o está mal formado: sin ella
 * la copia no tiene licencia, y la app falla cerrada.
 */
function leerConfiguracion (ruta) {
  try {
    const cfg = JSON.parse(fs.readFileSync(ruta, 'utf8'))
    if (typeof cfg?.licencia !== 'string' || !PATRON_LICENCIA.test(cfg.licencia)) return null
    if (typeof cfg.url !== 'string' || !URL_PERMITIDA.test(cfg.url)) return null
    const clave = crypto.createPublicKey(cfg.clavePublica)
    if (clave.asymmetricKeyType !== 'ed25519') return null
    return { licencia: cfg.licencia, clave, url: cfg.url }
  } catch { return null }
}

// ── Permiso ────────────────────────────────────────────────────────────

/**
 * ¿Sirve este permiso en ESTA computadora? `guardado` es `{ permiso, firma }` (base64url,
 * como lo manda el servidor). Sirve si, a la vez:
 *
 *  - la firma verifica con la clave pública incrustada;
 *  - es de la licencia incrustada;
 *  - las DOS huellas del permiso son las de este equipo (la revisión de F053 lo pidió:
 *    con una sola, un MachineGuid copiado o un Windows clonado pasaba por otro equipo);
 *  - `caduca` está en el futuro;
 *  - el reloj no ha retrocedido más de un día desde la última hora vista (si no, mover el
 *    reloj atrás alargaría un permiso para siempre). `ultimaVista` es 0 si no hay.
 *
 * @returns {{ ok: true, datos: object } | { ok: false, motivo: string }}
 */
function verificarPermiso (guardado, { config, huellas, ahora, ultimaVista = 0 }) {
  if (typeof guardado?.permiso !== 'string' || typeof guardado?.firma !== 'string') return { ok: false, motivo: 'ausente' }

  let bytes
  try {
    bytes = Buffer.from(guardado.permiso, 'base64url')
    if (!crypto.verify(null, bytes, config.clave, Buffer.from(guardado.firma, 'base64url'))) return { ok: false, motivo: 'firma' }
  } catch { return { ok: false, motivo: 'firma' } }

  let datos
  try { datos = JSON.parse(bytes.toString('utf8')) } catch { return { ok: false, motivo: 'forma' } }
  if (!datos || typeof datos.licencia !== 'string' || !datos.huellas || typeof datos.huellas !== 'object'
    || !Number.isFinite(datos.emitido) || !Number.isFinite(datos.caduca)) return { ok: false, motivo: 'forma' }

  if (datos.licencia !== config.licencia) return { ok: false, motivo: 'licencia' }
  if (datos.huellas.maquina !== huellas.maquina || (datos.huellas.placa ?? null) !== huellas.placa) return { ok: false, motivo: 'huellas' }
  if (!(datos.caduca > ahora)) return { ok: false, motivo: 'caducado' }
  if (ultimaVista - ahora > RETROCESO_TOLERADO_MS) return { ok: false, motivo: 'reloj' }
  return { ok: true, datos }
}

/**
 * Lo guardado entre arranques: `{ permiso, firma, ultimaVista }`. Un archivo que falta o está roto vale
 * `{}`: es no tener permiso.
 *
 * `seguro` es `safeStorage` cuando hay cifrado (DPAPI en Windows) y `null` si no. Con cifrado SOLO vale
 * lo cifrado: un archivo en claro, que es lo que dejaría alguien que lo editó a mano para poner
 * `ultimaVista` en 0, no es un permiso. El cifrado no es un secreto contra quien se ponga a escribir
 * código (DPAPI es del usuario, y cualquier programa suyo puede cifrar): quita lo fácil, el Bloc de notas.
 */
function leerGuardado (ruta, seguro = null) {
  try {
    const crudo = fs.readFileSync(ruta)
    const datos = JSON.parse(seguro ? seguro.decryptString(crudo) : crudo.toString('utf8'))
    return datos && typeof datos === 'object' && !Array.isArray(datos) ? datos : {}
  } catch { return {} }
}

/** Temporal + `rename`: un corte a medias no deja un permiso truncado que el siguiente arranque tome por bueno. */
function escribirGuardado (ruta, datos, seguro = null) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true })
  const temporal = `${ruta}.${process.pid}.tmp`
  const texto = JSON.stringify(datos)
  fs.writeFileSync(temporal, seguro ? seguro.encryptString(texto) : texto, { mode: 0o600 })
  fs.renameSync(temporal, ruta)
}

// ── Lo que la app hace con una respuesta ───────────────────────────────

const recortar = (valor, maximo) => (typeof valor === 'string' ? valor.trim().slice(0, maximo) : '')
const equipos = n => (n === 1 ? '1 equipo' : `${n} equipos`)

/**
 * Lo que la interfaz pinta para cada estado: `{ estado, titulo, texto, contacto, reintentar }`.
 * Los textos se arman aquí, en el proceso principal, para que sean probables sin
 * interfaz y la pantalla se limite a ponerlos. `ok` y `comprobando` no llevan texto.
 */
function vistaDe (e) {
  const contacto = recortar(e.contacto, 300) || null
  switch (e.estado) {
    case 'ok':
    case 'comprobando':
      return { estado: e.estado }
    case 'sin_licencia':
      return {
        estado: e.estado, titulo: 'Esta copia no tiene licencia', contacto: null, reintentar: false,
        texto: 'A este paquete le falta su licencia, así que no puede activarse. Pide una copia nueva a quien te la entregó.',
      }
    case 'sin_huella':
      return {
        estado: e.estado, titulo: 'No se pudo identificar este equipo', contacto: null, reintentar: true,
        texto: 'ArtTranslatorV2 no consiguió leer el identificador de Windows de esta computadora. '
          + 'Vuelve a intentarlo; si sigue igual, avisa a quien te entregó la copia.',
      }
    case 'tope':
      return {
        estado: e.estado, contacto, reintentar: false,
        titulo: Number.isInteger(e.maximo) && e.maximo > 0
          ? `Esta copia ya está activada en ${equipos(e.maximo)}, el máximo de la licencia.`
          : 'Esta copia ya está activada en el máximo de equipos de la licencia.',
        texto: 'Para usarla en este equipo hay que liberar uno de los anteriores.',
      }
    case 'denegada':
      return {
        estado: e.estado, contacto, reintentar: false,
        titulo: 'Esta copia no tiene una licencia válida',
        texto: 'La licencia de esta copia no está activa.',
      }
    case 'modificada':
      return {
        estado: e.estado, titulo: 'Esta copia está modificada; descárgala de nuevo', contacto: null, reintentar: false,
        texto: 'Algunos archivos de ArtTranslatorV2 no son los originales. Descarga el paquete otra vez, '
          + 'extráelo en una carpeta nueva y ábrelo desde ahí. Si sigue igual, avisa a quien te entregó la copia.',
      }
    case 'sin_red':
      return {
        estado: e.estado, titulo: 'Conéctate a internet una vez para activar', contacto: null, reintentar: true,
        texto: 'ArtTranslatorV2 se activa solo, la primera vez que se abre con conexión; después funciona aunque no haya internet. '
          + 'Si ya estás conectado, revisa la fecha y la hora de Windows y vuelve a intentarlo en unos minutos.',
      }
    default:
      return {
        estado: 'error', titulo: 'No se pudo comprobar la licencia', contacto: null, reintentar: true,
        texto: 'Algo falló al comprobar la licencia de esta copia. Vuelve a intentarlo; si sigue igual, avisa a quien te entregó la copia.',
      }
  }
}

function conPlazo (promesa, ms) {
  let reloj
  const limite = new Promise((_, rechazar) => { reloj = setTimeout(() => rechazar(new Error('plazo')), ms) })
  return Promise.race([promesa, limite]).finally(() => clearTimeout(reloj))
}

/**
 * La petición de verdad: el módulo `net` de Electron, la pila de red de Chromium
 * (§0.13). Con el `https` de Node, un proxy corporativo con inspección TLS rompe la app
 * de forma indepurable a distancia; `net` usa el proxy y los certificados del sistema.
 * `require('electron')` va aquí dentro para que este archivo cargue también en Node.
 */
async function peticionPorDefecto ({ url, cuerpo, plazoMs }) {
  const { net } = require('electron')
  const control = new AbortController()
  const reloj = setTimeout(() => control.abort(), plazoMs)
  try {
    const r = await net.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuerpo, signal: control.signal,
    })
    return { status: r.status, texto: await r.text() }
  } finally { clearTimeout(reloj) }
}

/**
 * Ejecuta un comando con plazo y devuelve `{ ok, salida }`; nunca rechaza. Tres rutas de
 * muerte para el proceso hijo: el `timeout` de `execFile` lo mata al vencer el plazo; un
 * temporizador de respaldo lo mata (y suelta la promesa) si la devolución de llamada no
 * llegara nunca; y `hijos` permite a `detener()` matar los que sigan vivos al cerrar la app.
 */
function crearEjecutor (hijos) {
  return (archivo, args, { plazoMs }) => new Promise(resolver => {
    let hijo = null
    let respaldo = null
    let hecho = false
    const fin = resultado => {
      if (hecho) return
      hecho = true
      clearTimeout(respaldo)
      if (hijo) hijos.delete(hijo)
      resolver(resultado)
    }
    respaldo = setTimeout(() => {
      try { hijo?.kill('SIGKILL') } catch { /* ya no está */ }
      fin({ ok: false, salida: '' })
    }, plazoMs + 500)
    try {
      hijo = execFile(archivo, args,
        { timeout: plazoMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8' },
        (error, salida) => fin(error ? { ok: false, salida: '' } : { ok: true, salida: String(salida) }))
      hijos.add(hijo)
    } catch { fin({ ok: false, salida: '' }) }
  })
}

// ── La licencia ────────────────────────────────────────────────────────

/**
 * Crea la licencia de esta copia. Todo lo que toca el mundo se puede inyectar, para
 * probarla contra el servidor real sin Windows ni Electron:
 *
 * @param {object} o
 * @param {{ isPackaged: boolean, getPath: Function, getVersion: Function }} o.app
 * @param {boolean} [o.empaquetada]   por defecto, `estaEmpaquetada(app)`; `mainApp.js` pasa el mismo valor a `ajustes.js`
 * @param {{ isEncryptionAvailable: Function, encryptString: Function, decryptString: Function }} [o.safeStorage]
 *   con él, el permiso se guarda cifrado cuando hay cifrado disponible
 * @param {string} [o.rutaConfiguracion]  por defecto, `licencia.json` junto a este archivo
 * @param {string} [o.rutaPermiso]    por defecto, `licencia.permiso.json` en `userData`
 * @param {Function} [o.peticion]     `({ url, cuerpo, plazoMs }) => { status, texto }`; rechaza si no hay red
 * @param {Function} [o.ejecutar]     `(archivo, args, { plazoMs }) => { ok, salida }`
 * @param {Function} [o.ahora]        reloj, en ms desde 1970
 * @param {Function} [o.nombreEquipo] nombre de la computadora
 * @param {number} [o.apuntarCadaMs]  cada cuánto se apunta la hora vista con la app abierta (por defecto, 1 h)
 */
function crearLicencia (o = {}) {
  const { app, safeStorage } = o
  const empaquetada = o.empaquetada ?? estaEmpaquetada(app)
  const rutaConfiguracion = o.rutaConfiguracion || path.join(__dirname, 'licencia.json')
  const rutaPermiso = () => o.rutaPermiso || path.join(app.getPath('userData'), 'licencia.permiso.json')
  const hijos = new Set()
  const ejecutar = o.ejecutar || crearEjecutor(hijos)
  const peticion = o.peticion || peticionPorDefecto
  const ahora = o.ahora || Date.now
  const nombreEquipo = o.nombreEquipo || (() => os.hostname())
  const apuntarCadaMs = o.apuntarCadaMs ?? APUNTAR_HORA_CADA_MS

  let actual = { estado: 'comprobando' }
  let enCurso = null
  let relojDeLaHora = null
  // La configuración y las huellas de la última comprobación, para la renovación en segundo plano.
  let contexto = null

  const fijar = e => { actual = e; return vistaDe(e) }

  /** `safeStorage` si hay cifrado disponible (en Windows, desde `ready`); si no, el archivo va en claro. */
  const almacenSeguro = () => {
    try { return safeStorage?.isEncryptionAvailable() ? safeStorage : null } catch { return null }
  }
  const leer = () => leerGuardado(rutaPermiso(), almacenSeguro())

  /** Mezcla `cambios` en el archivo. Un fallo de escritura se dice y no tumba nada: este arranque ya está decidido. */
  function apuntar (cambios) {
    try {
      escribirGuardado(rutaPermiso(), { ...leer(), ...cambios }, almacenSeguro())
    } catch (error) {
      console.error('[licencia] no se pudo guardar el permiso:', error.code || error.name)
    }
  }

  /**
   * La hora vista solo sube con el reloj local. (Tras una activación la fija el servidor: ver `guardarPermiso`.)
   * Sin un permiso guardado que acompañar no escribe nada: si el archivo no se pudo leer (el descifrado falló
   * por un momento), escribir solo la hora lo pisaría y se perdería un permiso bueno.
   */
  function apuntarHoraVista () {
    const previo = leer()
    if (typeof previo.permiso !== 'string') return
    apuntar({ ultimaVista: Math.max(Number(previo.ultimaVista) || 0, ahora()) })
  }

  /**
   * Con la app abierta, la hora vista se apunta cada hora (y al cerrar, en `detener`): así «el reloj
   * retrocedió» se nota aunque la app lleve días abierta o no se cierre bien. Sin `unref`, el
   * temporizador mantendría vivo el proceso. Solo cambia el archivo; el estado de la licencia, nunca.
   */
  function vigilarReloj () {
    if (relojDeLaHora || !(apuntarCadaMs > 0)) return
    relojDeLaHora = setInterval(apuntarHoraVista, apuntarCadaMs)
    relojDeLaHora.unref?.()
  }

  /**
   * Pide un permiso. Devuelve `{ tipo: 'permiso', guardado, datos }`, `{ tipo: 'tope', maximo, contacto }`,
   * `{ tipo: 'denegada', contacto }` o `{ tipo: 'transitorio', motivo }`. Un 200 se verifica como
   * cualquier permiso: un proxy o un servidor mal desplegado que contesten 200 no abren nada.
   * Solo un 403 con un cuerpo que reconocemos cuenta como respuesta del servidor de licencias;
   * el 403 de una página de bloqueo corporativa es un fallo transitorio, no una baja.
   */
  async function activar ({ config, huellas }) {
    const version = String(app.getVersion())
    const cuerpo = JSON.stringify({
      licencia: config.licencia,
      huellas: { maquina: huellas.maquina, placa: huellas.placa },
      equipo: normalizarEquipo(nombreEquipo()),
      version: PATRON_VERSION.test(version) ? version : '0.0.0',
    })

    let respuesta
    try {
      respuesta = await conPlazo(peticion({ url: config.url, cuerpo, plazoMs: PLAZO_ACTIVACION_MS }), PLAZO_ACTIVACION_MS + 1000)
    } catch {
      return { tipo: 'transitorio', motivo: 'sin red' }
    }

    let json = null
    try { json = JSON.parse(respuesta.texto) } catch { /* no era JSON: se mira el estado */ }

    if (respuesta.status === 200 && typeof json?.permiso === 'string' && typeof json?.firma === 'string') {
      const guardado = { permiso: json.permiso, firma: json.firma }
      const v = verificarPermiso(guardado, { config, huellas, ahora: ahora() })
      return v.ok ? { tipo: 'permiso', guardado, datos: v.datos } : { tipo: 'transitorio', motivo: `permiso rechazado: ${v.motivo}` }
    }
    if (respuesta.status === 403 && json?.motivo === 'tope') {
      return { tipo: 'tope', usados: json.usados, maximo: json.maximo, contacto: json.contacto }
    }
    if (respuesta.status === 403 && json?.motivo === 'denegada') return { tipo: 'denegada', contacto: json.contacto }
    return { tipo: 'transitorio', motivo: `HTTP ${respuesta.status}` }
  }

  /**
   * Guarda un permiso nuevo, y con él la hora vista pasa a ser la del SERVIDOR, que es la que manda: no
   * la de un reloj local que puede estar mal. Si `ultimaVista` se hubiera quedado adelantada por un reloj
   * adelantado una vez, este es el momento en que se corrige; con un máximo a secas, esa hora errónea
   * obligaría a pedir permiso en cada arranque hasta que el calendario la alcanzara.
   */
  function guardarPermiso (r) {
    apuntar({ ...r.guardado, ultimaVista: r.datos.emitido })
  }

  /**
   * Renovación en segundo plano, en CADA arranque con el permiso vigente. Nunca cambia el estado de
   * la app en marcha (§0.21): una reunión empezada no se corta porque llegue un 403. Si el servidor
   * deniega, retira el permiso guardado; el siguiente arranque no lo encuentra, pide otro y el
   * servidor decide. Sin red no pasa nada: se sigue con el permiso que haya.
   */
  async function renovar () {
    if (!contexto) return
    const r = await activar(contexto)
    if (r.tipo === 'permiso') guardarPermiso(r)
    else if (r.tipo === 'tope' || r.tipo === 'denegada') apuntar({ permiso: null, firma: null })
  }

  async function comprobar () {
    if (!empaquetada) return fijar({ estado: 'ok', desarrollo: true })

    const config = leerConfiguracion(rutaConfiguracion)
    if (!config) return fijar({ estado: 'sin_licencia' })

    const huellas = await calcularHuellas({ licencia: config.licencia, ejecutar })
    if (!huellas.maquina) return fijar({ estado: 'sin_huella' })
    contexto = { config, huellas }

    const guardado = leer()
    const t = ahora()
    const valido = verificarPermiso(guardado, { config, huellas, ahora: t, ultimaVista: Number(guardado.ultimaVista) || 0 })
    if (valido.ok) {
      apuntar({ ultimaVista: Math.max(Number(guardado.ultimaVista) || 0, t, valido.datos.emitido) })
      vigilarReloj()
      // Siempre, y no solo cuando el permiso «ya toca»: con el reloj atrasado a mano, `t - emitido`
      // no llegaba nunca a tocar, y una licencia revocada seguía viva. Sin `await`: el arranque no
      // espera a una red que puede estar lenta, y un fallo no lo tumba.
      renovar().catch(() => {})
      return fijar({ estado: 'ok' })
    }

    const r = await activar(contexto)
    switch (r.tipo) {
      case 'permiso':
        guardarPermiso(r)
        vigilarReloj()
        return fijar({ estado: 'ok' })
      case 'tope':
        apuntar({ permiso: null, firma: null })
        return fijar({ estado: 'tope', maximo: r.maximo, contacto: r.contacto })
      case 'denegada':
        apuntar({ permiso: null, firma: null })
        return fijar({ estado: 'denegada', contacto: r.contacto })
      default:
        console.error(`[licencia] no se pudo activar ahora (${r.motivo})`)
        return fijar({ estado: 'sin_red' })
    }
  }

  async function comprobarSinLanzar () {
    try {
      return await comprobar()
    } catch (error) {
      console.error('[licencia] la comprobación falló:', error.code || error.name)
      return fijar({ estado: 'error' })
    }
  }

  /** La comprobación del arranque; quien la pide después recibe la misma. Nunca rechaza. */
  function iniciar () {
    if (!enCurso) enCurso = comprobarSinLanzar()
    return enCurso
  }

  /**
   * El botón «Reintentar». Con la licencia en orden no hace nada (así no se puede usar
   * para tocar el estado durante una reunión); si ya está comprobando, espera a esa.
   */
  function reintentar () {
    if (actual.estado === 'ok') return Promise.resolve(vistaDe(actual))
    if (actual.estado !== 'comprobando') {
      actual = { estado: 'comprobando' }
      enCurso = null
    }
    return iniciar()
  }

  return {
    iniciar,
    reintentar,

    /** `null` si se puede empezar o comprobar; si no, la frase que se le devuelve a quien lo pidió. */
    motivoDeNegativa () {
      if (actual.estado === 'ok') return null
      if (actual.estado === 'comprobando') return 'Comprobando la licencia de esta copia. Espera un momento.'
      return vistaDe(actual).titulo
    },

    /** Al cerrar la app: apunta la hora vista una última vez y mata los procesos hijo que sigan vivos. */
    detener () {
      if (relojDeLaHora) {
        apuntarHoraVista()
        clearInterval(relojDeLaHora)
        relojDeLaHora = null
      }
      for (const hijo of hijos) { try { hijo.kill('SIGKILL') } catch { /* ya no está */ } }
      hijos.clear()
    },
  }
}

module.exports = {
  crearLicencia, estaEmpaquetada, enAsar,
  // Para las pruebas y para la captura de pantalla de la interfaz:
  calcularHuellas, herramientasDeWindows, normalizarEquipo, crearEjecutor, vistaDe, MS_DIA,
}
