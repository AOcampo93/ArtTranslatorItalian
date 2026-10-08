/**
 * F054 — la licencia, lado de la app (PLAN.md §17.6 y §0.21).
 *
 * Una prueba por criterio de aceptación, y TODAS contra el servidor de licencias de verdad
 * (`vps/servidor.js`) en un puerto efímero de 127.0.0.1, con un par de claves generado aquí y
 * la licencia creada por la herramienta de administración (`licencias-cli.js`). Nada sale de
 * la máquina: la petición de la app es la inyectada (hacia ese servidor) y no el `net` de
 * Electron, que `node --test` no tiene (se comprobó a mano con Electron, ver `impl_F054.md`).
 *
 * ## Cómo se prueba
 *
 * El criterio es del RECORRIDO —arrancar la app, ver qué licencia tiene, intentar empezar una
 * reunión—, y un eslabón mal conectado lo rompería sin que ninguna función suelta lo notara
 * (que `app:empezar` no pregunte, que la reunión en curso no llegue a la licencia). Por eso se
 * carga el `mainApp.js` de verdad con un `electron` de mentira, empaquetado, como en
 * `baseDatosF057.test.js` y `informesF052.test.js`; el transcriptor y Marian son de mentira
 * (la reunión no oye ni traduce nada), y la huella de «la computadora» sale de un ejecutor de
 * comandos de mentira que contesta lo que contestarían `reg query` y PowerShell.
 *
 * Esta máquina puede tener el `informes.token.json` de verdad: se le oculta a `mainApp.js`
 * (`fsSinToken`), o parar la reunión de la prueba 4 subiría un informe al servidor real.
 *
 * Ronda 2: además, un «paquete» de mentira (`crearPaquete`) con la forma del de Windows —el código
 * en una carpeta que se llama `app.asar`, el backend y `shared` al lado, el manifiesto de
 * `herramientas/manifiesto-backend.js` dentro— para probar lo que depende de DÓNDE vive el código:
 * el `.exe` renombrado y el backend tocado.
 */

'use strict'

const { test, describe, after } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const Module = require('module')
const { execFileSync } = require('child_process')

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'licencia-f054-'))
// Antes de requerir nada de `src`: `db.js` lee la variable al cargarse.
process.env.DB_DATA_DIR = path.join(RAIZ, 'base')

const REPO = path.join(__dirname, '..', '..')
const MAIN_APP = path.join(REPO, 'electron-app', 'src', 'mainApp.js')
const CLI = path.join(REPO, 'vps', 'licencias-cli.js')
const { crearServidor } = require(path.join(REPO, 'vps', 'servidor'))
const MANIFIESTO = path.join(REPO, 'herramientas', 'manifiesto-backend.js')
const {
  calcularHuellas, herramientasDeWindows, estaEmpaquetada, normalizarEquipo, crearEjecutor, MS_DIA,
} = require(path.join(REPO, 'electron-app', 'src', 'licencia'))
const { verificarBackend } = require(path.join(REPO, 'electron-app', 'src', 'integridad'))
const { CARPETA_DE_DATOS } = require('../src/ajustes')
const db = require('../src/db')

const TOKEN = 'token-de-prueba-no-es-un-secreto-real'
const CONTACTO_SERVIDOR = 'soporte-servidor@ejemplo.test'
const CONTACTO_LICENCIA = 'soporte-cliente@ejemplo.test'

// El servidor registra cada activación con `console.log` y la licencia cuenta por qué no pudo activar
// con `console.error`: aquí se recogen en vez de imprimirse.
const lineasDeLog = []
console.log = (...args) => { lineasDeLog.push(args.join(' ')) }
console.error = (...args) => { lineasDeLog.push(args.join(' ')) }

const servidores = []
// Los enlaces al `node_modules` del repositorio que dejan los paquetes de mentira: se quitan ANTES de borrar
// la carpeta temporal, para que ningún borrado recursivo pueda llegar a las dependencias de verdad.
const enlaces = []
after(async () => {
  await Promise.all(servidores.map(s => new Promise(resolver => { s.closeAllConnections(); s.close(resolver) })))
  try { db.vaciar() } catch { /* nunca llegó a abrirse */ }
  for (const enlace of enlaces) { try { fs.unlinkSync(enlace) } catch { /* ya no está */ } }
  fs.rmSync(RAIZ, { recursive: true, force: true })
})

const sha = texto => crypto.createHash('sha256').update(texto).digest('hex')
const esperar = ms => new Promise(resolver => setTimeout(resolver, ms))
async function hasta (cond, queEsperaba) {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return
    await esperar(5)
  }
  assert.fail(`nunca ocurrió: ${queEsperaba}`)
}

// ── El servidor de verdad ───────────────────────────────────────────────────

/** El servidor real de `vps/` con una licencia recién creada, de `maximo` equipos. */
async function servidorDeLicencias (maximo = 6) {
  const dirInformes = fs.mkdtempSync(path.join(RAIZ, 'inf-'))
  const dirLicencias = fs.mkdtempSync(path.join(RAIZ, 'lic-'))
  const entorno = { ...process.env, LICENCIAS_DIRECTORIO: dirLicencias }
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args],
    { env: entorno, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const licencia = cli('crear', 'Cliente de prueba', String(maximo), CONTACTO_LICENCIA).trim()

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const servidor = crearServidor({
    token: TOKEN,
    directorioBase: dirInformes,
    licencias: {
      clavePrivada: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      directorio: dirLicencias,
      contacto: CONTACTO_SERVIDOR,
    },
  })
  await new Promise((resolver, rechazar) => { servidor.on('error', rechazar); servidor.listen(0, '127.0.0.1', resolver) })
  servidores.push(servidor)

  return {
    licencia,
    clavePublica: publicKey.export({ type: 'spki', format: 'pem' }),
    url: `http://127.0.0.1:${servidor.address().port}/informes/licencias/activar`,
    cli,
    /** La licencia tal como la guarda el servidor: sus equipos, con las huellas. */
    almacen: () => JSON.parse(fs.readFileSync(path.join(dirLicencias, 'licencias.json'), 'utf8')).licencias[licencia],
  }
}

/** POST con el `http` de Node, sin reutilizar conexiones, y la misma forma de respuesta que el `net` de verdad. */
function postHttp (url, cuerpo) {
  return new Promise((resolver, rechazar) => {
    const u = new URL(url)
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) },
    }, res => {
      const trozos = []
      res.on('data', t => trozos.push(t))
      res.on('end', () => resolver({ status: res.statusCode, texto: Buffer.concat(trozos).toString('utf8') }))
    })
    req.on('error', rechazar)
    req.end(cuerpo)
  })
}

/**
 * La red de la app: `caida` es no tener internet (la petición rechaza, como `net.fetch`); `retener`
 * es una promesa que la petición espera antes de salir, para que una respuesta llegue cuando la
 * prueba quiera; `enviadas` y `respondidas` cuentan lo que pasó por aquí.
 */
function crearRed () {
  const red = { caida: false, retener: null, enviadas: 0, respondidas: 0 }
  red.peticion = async ({ url, cuerpo }) => {
    red.enviadas += 1
    if (red.caida) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    if (red.retener) await red.retener
    const r = await postHttp(url, cuerpo)
    red.respondidas += 1
    return r
  }
  return red
}

// ── Las computadoras ────────────────────────────────────────────────────────

const GUID = n => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`
const PLACA = n => `4C4C4544-0050-3010-8030-B8C04F4C4E${String(n).padStart(2, '0')}`

/**
 * Una computadora de mentira: lo que contestarían `reg query` y PowerShell, y el nombre con acento y
 * espacio que el servidor rechazaría (400) si la app no lo normalizara. Con `regBloqueado`, `reg.exe`
 * falla como con la directiva `DisableRegistryTools`.
 */
function computadora (n, sobre = {}) {
  const pc = { nombre: `Oficina Gómez ${n}`, guid: GUID(n), placa: PLACA(n), regBloqueado: false, ...sobre, llamadas: [] }
  pc.ejecutar = async archivo => {
    pc.llamadas.push(path.basename(archivo))
    if (/reg\.exe$/i.test(archivo)) {
      if (pc.regBloqueado) return { ok: false, salida: '' }
      return { ok: true, salida: `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${pc.guid}\r\n\r\n` }
    }
    if (/powershell\.exe$/i.test(archivo)) return { ok: true, salida: `guid=${pc.guid}\r\nplaca=${pc.placa}\r\n` }
    return { ok: false, salida: '' }
  }
  return pc
}

// ── El `mainApp.js` de verdad ───────────────────────────────────────────────

class TranscriptorFalso extends EventEmitter {
  constructor () { super(); this.stats = { frases: 0, turnosForzados: 0 }; TranscriptorFalso.creados += 1 }
  async start () {}
  async stop () {}
  alimentar () {}
  costeAproximadoUsd () { return '0.00' }
}
TranscriptorFalso.creados = 0

const marianFalso = {
  cargar: async () => {}, descargar: async () => false, estaListo: () => true,
  traducir: async () => ({ es: 'x', ms: 1 }),
}

/** El `fs` que ve `mainApp.js`, sin el `informes.token.json` de esta máquina: sin token no se sube nada. */
const fsSinToken = new Proxy(fs, {
  get (original, nombre) {
    if (nombre === 'readFileSync') {
      return (ruta, ...resto) => {
        if (String(ruta).endsWith('informes.token.json')) throw Object.assign(new Error('ENOENT: sin token'), { code: 'ENOENT' })
        return original.readFileSync(ruta, ...resto)
      }
    }
    const v = original[nombre]
    return typeof v === 'function' ? v.bind(original) : v
  },
})

const nuevoUserData = () => fs.mkdtempSync(path.join(RAIZ, 'ud-'))

const PREFIJO_CIFRADO = 'CIFRADO:'
/**
 * Un `safeStorage` de mentira que sí cambia los bytes y que rechaza lo que no cifró él, como DPAPI
 * rechaza un archivo en claro: con uno reversible a secas, un archivo editado a mano pasaría por cifrado.
 */
const safeStorageFalso = {
  isEncryptionAvailable: () => true,
  encryptString: texto => Buffer.from(PREFIJO_CIFRADO + Buffer.from(texto, 'utf8').toString('base64'), 'utf8'),
  decryptString: bytes => {
    const texto = Buffer.from(bytes).toString('utf8')
    if (!texto.startsWith(PREFIJO_CIFRADO)) throw new Error('no es un archivo cifrado')
    return Buffer.from(texto.slice(PREFIJO_CIFRADO.length), 'base64').toString('utf8')
  },
}

/** Lo que `mainApp.js` dejó guardado de la licencia en `userData`, ya descifrado. */
const leerPermisoGuardado = userData => JSON.parse(
  safeStorageFalso.decryptString(fs.readFileSync(path.join(userData, 'licencia.permiso.json'))))

/**
 * Arranca el `mainApp.js` de verdad —un arranque— con un `electron` de mentira y devuelve cómo
 * hablarle. `crearLicencia` recibe lo que el arranque real no puede dar en una prueba: la red
 * hacia el servidor de esta prueba, los comandos de la computadora, el reloj y la ruta del
 * `licencia.json` (que aquí se escribe con la licencia y la clave pública del servidor, como el
 * paquete real). Cada llamada es un arranque nuevo: el mismo `userData` es la misma computadora
 * abriendo la app otra vez.
 *
 * `mainApp` es el archivo a cargar (el del repositorio, o el de un paquete de mentira). Con `appData`,
 * las rutas de la app son como las de Electron —`userData` sale de ahí salvo que se fije antes de
 * `ready`— y se puede ver dónde lo fijó la app; sin él, todo es `userData`. `cifrado: false` es un
 * sistema sin `safeStorage`.
 */
async function arrancar ({
  servidor, red, pc, userData = nuevoUserData(), empaquetada = true, ahora = Date.now, sinLicenciaJson = false,
  mainApp = MAIN_APP, appData = null, apuntarCadaMs, cifrado = true,
}) {
  const rutaConfiguracion = path.join(fs.mkdtempSync(path.join(RAIZ, 'cfg-')), 'licencia.json')
  if (!sinLicenciaJson) {
    fs.writeFileSync(rutaConfiguracion, JSON.stringify({ licencia: servidor.licencia, clavePublica: servidor.clavePublica, url: servidor.url }))
  }

  const manejadores = new Map()
  const rutas = {}
  let arranque = null
  const app = {
    isPackaged: empaquetada,
    getPath: nombre => rutas[nombre] || (appData ? (nombre === 'appData' ? appData : path.join(appData, 'por-defecto')) : userData),
    getVersion: () => '1.0.0',
    setPath: (nombre, ruta) => { if (appData) rutas[nombre] = ruta },
    whenReady: () => ({ then: f => { arranque = Promise.resolve().then(f); return arranque } }),
    on () {}, quit () {}, exit () {},
  }
  class BrowserWindow {
    constructor () { this.webContents = { session: { setDisplayMediaRequestHandler () {} }, send () {} } }
    on () {}
    setContentProtection () {}
    loadFile () {}
    isDestroyed () { return false }
    getBounds () { return {} }
    destroy () {}
    static getAllWindows () { return [] }
  }
  const electron = {
    app,
    BrowserWindow,
    ipcMain: { handle: (canal, f) => manejadores.set(canal, f), on () {} },
    safeStorage: { ...safeStorageFalso, isEncryptionAvailable: () => cifrado },
    shell: {},
    dialog: {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  }
  const inyectado = { rutaConfiguracion, peticion: red.peticion, ejecutar: pc.ejecutar, ahora, nombreEquipo: () => pc.nombre, apuntarCadaMs }

  const cargar = Module._load
  Module._load = function (peticion, padre, ...resto) {
    if (peticion === 'electron') return electron
    if (padre?.filename === mainApp) {
      if (peticion === 'fs') return fsSinToken
      if (peticion.endsWith(path.join('src', 'assemblyLive'))) return { AssemblyLiveTranscriber: TranscriptorFalso }
      if (peticion.endsWith(path.join('src', 'translator'))) return marianFalso
      if (peticion === './licencia') {
        const real = cargar.call(this, peticion, padre, ...resto)
        return { ...real, crearLicencia: opciones => real.crearLicencia({ ...opciones, ...inyectado }) }
      }
    }
    return cargar.call(this, peticion, padre, ...resto)
  }
  delete require.cache[mainApp]
  let modulo
  try { modulo = require(mainApp) } finally { Module._load = cargar }
  await arranque

  // Con `appData`, `userData` es el que fijó la app (o el de por defecto); lo que guarda la licencia va ahí.
  const efectivo = appData ? app.getPath('userData') : userData
  return {
    userData: efectivo,
    rutas,
    manejadores,
    licencia: modulo._internos?.licencia,
    ipc: (canal, ...args) => manejadores.get(canal)({}, ...args),
    rutaPermiso: path.join(efectivo, 'licencia.permiso.json'),
  }
}

/**
 * Un «paquete» de mentira con la forma del de Windows: el código de la app en una carpeta que se LLAMA
 * `app.asar` (para el código basta el nombre: la regla mira dónde vive, no que sea un asar de verdad),
 * y al lado `node-backend/src`, `shared` y el `node_modules` del backend (un enlace al del repositorio:
 * las dependencias pesan cientos de MB). El manifiesto lo genera el guion de verdad, como en la construcción.
 */
function crearPaquete ({ conManifiesto = true } = {}) {
  const raiz = fs.mkdtempSync(path.join(RAIZ, 'paquete-'))
  const recursos = path.join(raiz, 'resources')
  const codigo = path.join(recursos, 'app.asar', 'src')
  fs.mkdirSync(codigo, { recursive: true })
  const origen = path.join(REPO, 'electron-app', 'src')
  for (const nombre of fs.readdirSync(origen).filter(n => n.endsWith('.js'))) fs.copyFileSync(path.join(origen, nombre), path.join(codigo, nombre))
  fs.cpSync(path.join(REPO, 'node-backend', 'src'), path.join(recursos, 'node-backend', 'src'), { recursive: true })
  fs.cpSync(path.join(REPO, 'shared'), path.join(recursos, 'shared'), { recursive: true })
  const enlace = path.join(recursos, 'node-backend', 'node_modules')
  fs.symlinkSync(path.join(REPO, 'node-backend', 'node_modules'), enlace, 'junction')
  enlaces.push(enlace)
  const manifiesto = path.join(codigo, 'manifiesto-backend.json')
  if (conManifiesto) execFileSync(process.execPath, [MANIFIESTO, '--raiz', recursos, '--salida', manifiesto], { stdio: 'pipe' })
  return {
    recursos,
    manifiesto,
    mainApp: path.join(codigo, 'mainApp.js'),
    backend: archivo => path.join(recursos, 'node-backend', 'src', archivo),
    compartido: archivo => path.join(recursos, 'shared', archivo),
  }
}

/** Lo que dice `app:licencia`, que es lo que la interfaz pinta. */
const licenciaDe = app => app.ipc('app:licencia')
const CLAVE_STT = { stt: 'clave-de-prueba-no-es-un-secreto-real' }

// ── Criterios de aceptación ─────────────────────────────────────────────────

describe('F054 — la licencia en la app', () => {
  test('criterio 1: el primer arranque con red se activa solo, sin pantalla ni clic', async () => {
    const s = await servidorDeLicencias()
    const red = crearRed()
    const pc = computadora(1)

    const app = await arrancar({ servidor: s, red, pc })

    // Sin pantalla: la primera respuesta ya es `ok`, sin título ni texto que pintar.
    assert.deepStrictEqual(await licenciaDe(app), { estado: 'ok' })
    assert.strictEqual(red.enviadas, 1, 'una sola petición, la de activar')
    assert.ok(fs.existsSync(app.rutaPermiso), 'el permiso queda guardado para el siguiente arranque')

    // El servidor aceptó la petición (el nombre con acento y espacio ya viaja normalizado) y solo vio huellas con la licencia como sal.
    const [equipo] = s.almacen().equipos
    assert.strictEqual(s.almacen().equipos.length, 1)
    assert.strictEqual(equipo.nombre, 'Oficina-Gomez-1')
    assert.deepStrictEqual(equipo.maquinas, [sha(`${s.licencia}:${pc.guid}`)])
    assert.deepStrictEqual(equipo.placas, [sha(`${s.licencia}:${pc.placa.toLowerCase()}`)])

    // Y la puerta de `app:empezar` está abierta: sin clave falla por la clave, no por la licencia.
    const r = await app.ipc('app:empezar', { idioma: 'it' })
    assert.deepStrictEqual(r, { ok: false, motivo: 'Falta la clave de transcripción. Ponla en Ajustes.' })
  })

  test('criterio 2: con la respuesta tope hay pantalla de bloqueo con el contacto, y app:empezar y app:comprobar se niegan', async () => {
    const s = await servidorDeLicencias(1)
    const red = crearRed()
    assert.strictEqual((await licenciaDe(await arrancar({ servidor: s, red, pc: computadora(1) }))).estado, 'ok', 'el primer equipo ocupa la única plaza')

    const app = await arrancar({ servidor: s, red, pc: computadora(2) })
    const v = await licenciaDe(app)

    assert.strictEqual(v.estado, 'tope')
    assert.match(v.titulo, /ya está activada en 1 equipo, el máximo de la licencia/)
    assert.strictEqual(v.contacto, CONTACTO_LICENCIA, 'el contacto es el que mandó el servidor')
    assert.strictEqual(v.reintentar, false, 'volver a pedirlo no cambia nada')

    // Con una clave de transcripción, sin la puerta la reunión arrancaría: el rechazo es de la licencia.
    await app.ipc('app:guardarClaves', CLAVE_STT)
    const empezar = await app.ipc('app:empezar', { idioma: 'it' })
    assert.strictEqual(empezar.ok, false)
    assert.match(empezar.motivo, /el máximo de la licencia/)
    const comprobar = await app.ipc('app:comprobar', { idioma: 'it' })
    assert.deepStrictEqual([comprobar.red.mal, comprobar.red.valor], [true, 'sin licencia'])
    assert.strictEqual(TranscriptorFalso.creados, 0, 'ni la reunión ni la comprobación llegaron a abrir una sesión de transcripción')
  })

  test('criterio 3: sin red y con permiso vigente funciona; sin red y sin permiso, el aviso con «Reintentar»', async () => {
    const s = await servidorDeLicencias()
    const red = crearRed()
    const pc = computadora(1)
    const primero = await arrancar({ servidor: s, red, pc })
    assert.strictEqual((await licenciaDe(primero)).estado, 'ok')
    const enviadas = red.enviadas

    // Sin red, y con el permiso de hace un momento: abre y deja empezar. Intenta renovarlo en segundo
    // plano (en cada arranque), y como no hay red, el intento falla en silencio.
    red.caida = true
    const conPermiso = await arrancar({ servidor: s, red, pc, userData: primero.userData })
    assert.deepStrictEqual(await licenciaDe(conPermiso), { estado: 'ok' })
    assert.strictEqual(red.enviadas, enviadas + 1, 'el intento de renovación')
    assert.match((await conPermiso.ipc('app:empezar', { idioma: 'it' })).motivo, /clave de transcripción/)

    // Sin red y sin permiso: el aviso, con el botón, y la puerta cerrada.
    const sinPermiso = await arrancar({ servidor: s, red, pc: computadora(2) })
    const v = await licenciaDe(sinPermiso)
    assert.strictEqual(v.estado, 'sin_red')
    assert.strictEqual(v.titulo, 'Conéctate a internet una vez para activar')
    assert.strictEqual(v.reintentar, true)
    assert.match((await sinPermiso.ipc('app:empezar', { idioma: 'it' })).motivo, /Conéctate a internet/)

    // Vuelve la red y se pulsa «Reintentar»: se activa, y la puerta se abre.
    red.caida = false
    assert.deepStrictEqual(await sinPermiso.ipc('app:licenciaReintentar'), { estado: 'ok' })
    assert.match((await sinPermiso.ipc('app:empezar', { idioma: 'it' })).motivo, /clave de transcripción/)
  })

  test('criterio 4: una revocación que llega con la reunión en curso no la corta, y se aplica en el siguiente arranque', async () => {
    const s = await servidorDeLicencias()
    const red = crearRed()
    const pc = computadora(1)
    const primero = await arrancar({ servidor: s, red, pc })
    assert.strictEqual((await licenciaDe(primero)).estado, 'ok')
    s.cli('revocar', s.licencia)

    // Otro arranque: el permiso sigue vigente y la app sigue, y renueva en segundo plano. La respuesta
    // se retiene para que llegue cuando la reunión ya esté en marcha.
    let soltar
    red.retener = new Promise(resolver => { soltar = resolver })
    const app = await arrancar({ servidor: s, red, pc, userData: primero.userData })
    assert.deepStrictEqual(await licenciaDe(app), { estado: 'ok' })
    await hasta(() => red.enviadas === 2, 'que salga la renovación')

    await app.ipc('app:guardarClaves', CLAVE_STT)
    assert.strictEqual((await app.ipc('app:empezar', { idioma: 'it' })).ok, true, 'la reunión está en curso')

    // En plena reunión llega el 403 del servidor (la licencia está revocada).
    red.retener = null
    soltar()
    await hasta(() => red.respondidas === 2 && leerPermisoGuardado(app.userData).permiso === null, 'que la denegación se apunte')

    // No la corta: la licencia sigue `ok`, la reunión sigue en marcha (`yaCorriendo`) y se cierra por su cuenta.
    assert.deepStrictEqual(await licenciaDe(app), { estado: 'ok' })
    assert.deepStrictEqual(await app.ipc('app:empezar', { idioma: 'it' }), { ok: true, yaCorriendo: true })
    assert.strictEqual((await app.ipc('app:parar')).ok, true)

    // Y se aplica en el siguiente arranque: sin permiso, pide uno y el servidor dice que no.
    const siguiente = await arrancar({ servidor: s, red, pc, userData: primero.userData })
    const v = await licenciaDe(siguiente)
    assert.strictEqual(v.estado, 'denegada')
    assert.strictEqual(v.titulo, 'Esta copia no tiene una licencia válida')
    assert.strictEqual(v.contacto, CONTACTO_SERVIDOR)
    const creadas = TranscriptorFalso.creados
    assert.strictEqual((await siguiente.ipc('app:empezar', { idioma: 'it' })).ok, false)
    assert.strictEqual(TranscriptorFalso.creados, creadas, 'la reunión nueva no llegó a empezar')
  })

  test('criterio 5: el permiso de otra computadora, copiado aquí, no sirve', async () => {
    const s = await servidorDeLicencias()
    const red = crearRed()
    const a = computadora(1)
    const origen = await arrancar({ servidor: s, red, pc: a })
    assert.strictEqual((await licenciaDe(origen)).estado, 'ok')
    const permiso = fs.readFileSync(origen.rutaPermiso)

    // Sin red, para que la app no pueda arreglarlo pidiendo uno propio: lo que se ve es si ESE permiso vale.
    red.caida = true
    const copiado = pc => {
      const userData = nuevoUserData()
      fs.writeFileSync(path.join(userData, 'licencia.permiso.json'), permiso)
      return arrancar({ servidor: s, red, pc, userData })
    }

    // Control: el mismo archivo en la misma computadora vale (el permiso es bueno y está vigente).
    assert.strictEqual((await licenciaDe(await copiado(a))).estado, 'ok')

    // Otra computadora, con otras dos huellas: no vale.
    const otra = await copiado(computadora(2))
    assert.strictEqual((await licenciaDe(otra)).estado, 'sin_red')
    // Windows clonado en otra placa (la misma máquina, otra placa): tampoco. Basta con que difiera UNA de las dos.
    const clon = await copiado(computadora(1, { placa: PLACA(7) }))
    assert.strictEqual((await licenciaDe(clon)).estado, 'sin_red')

    await otra.ipc('app:guardarClaves', CLAVE_STT)
    assert.match((await otra.ipc('app:empezar', { idioma: 'it' })).motivo, /Conéctate a internet/)
    assert.strictEqual(s.almacen().equipos.length, 1, 'y ninguna ocupó plaza')
  })

  test('un permiso caducado, o con el reloj atrasado más de un día, no sirve sin red; con medio día de retraso sí', async () => {
    const s = await servidorDeLicencias()
    const red = crearRed()
    const pc = computadora(1)
    const primero = await arrancar({ servidor: s, red, pc })
    assert.strictEqual((await licenciaDe(primero)).estado, 'ok')

    red.caida = true
    const conReloj = async desplazamiento => licenciaDe(await arrancar({
      servidor: s, red, pc, userData: primero.userData, ahora: () => Date.now() + desplazamiento,
    }))
    assert.strictEqual((await conReloj(-MS_DIA / 2)).estado, 'ok', 'medio día de retraso es holgura de reloj, no trampa')
    assert.strictEqual((await conReloj(-2 * MS_DIA)).estado, 'sin_red', 'el reloj retrocedió: el permiso cuenta como caducado')
    assert.strictEqual((await conReloj(15 * MS_DIA)).estado, 'sin_red', 'pasaron los 14 días del permiso')
  })

  test('criterio 6: en desarrollo no hay licencia; empaquetada y sin licencia.json, falla cerrada', async () => {
    const red = crearRed()
    const pc = computadora(1)

    // `!app.isPackaged`: ni archivo, ni red, ni comandos, ni siquiera hace falta `licencia.json`.
    const desarrollo = await arrancar({ red, pc, empaquetada: false, sinLicenciaJson: true })
    assert.deepStrictEqual(await licenciaDe(desarrollo), { estado: 'ok' })
    assert.strictEqual(red.enviadas, 0)
    assert.deepStrictEqual(pc.llamadas, [], 'no se lanzó ningún proceso hijo para sacar la huella')
    assert.ok(!fs.existsSync(desarrollo.rutaPermiso), 'y no se escribió nada')
    assert.match((await desarrollo.ipc('app:empezar', { idioma: 'it' })).motivo, /clave de transcripción/)

    // Empaquetada y sin `licencia.json` (un paquete mal hecho): «Esta copia no tiene licencia».
    const sinLicencia = await arrancar({ red, pc, empaquetada: true, sinLicenciaJson: true })
    const v = await licenciaDe(sinLicencia)
    assert.strictEqual(v.estado, 'sin_licencia')
    assert.strictEqual(v.titulo, 'Esta copia no tiene licencia')
    assert.strictEqual(v.reintentar, false)
    assert.strictEqual((await sinLicencia.ipc('app:empezar', { idioma: 'it' })).ok, false)
    assert.strictEqual(red.enviadas, 0)
  })

  test('la huella lleva la licencia como sal, una placa basura vale null y el nombre cabe en el alfabeto del servidor', async () => {
    const licencia = 'a'.repeat(32)
    const GUID_1 = '11111111-2222-4333-8444-555555555555'
    const powershell = (guid, placa) => `guid=${guid}\r\nplaca=${placa}\r\n`
    const con = (guid, placa) => calcularHuellas({
      licencia,
      ejecutar: async archivo => (/reg\.exe$/i.test(archivo)
        ? { ok: true, salida: `    MachineGuid    REG_SZ    ${guid}\r\n` }
        : { ok: true, salida: powershell(guid, placa) }),
    })

    assert.deepStrictEqual(await con(GUID_1, '4C4C4544-0050-3010-8030-B8C04F4C4E32'), {
      maquina: sha(`${licencia}:${GUID_1}`),
      placa: sha(`${licencia}:4c4c4544-0050-3010-8030-b8c04f4c4e32`),
    })
    for (const basura of ['', '\r\n', 'To Be Filled By O.E.M.', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
      '00000000-0000-0000-0000-000000000000', '03000200-0400-0500-0006-000700080009']) {
      assert.strictEqual((await con(GUID_1, basura)).placa, null, `la placa «${basura.trim()}» no distingue nada`)
    }
    assert.strictEqual((await con('', PLACA(1))).maquina, null, 'sin MachineGuid no hay huella de máquina')

    // Si PowerShell falla (se agotó el plazo), se prueba una vez más antes de dar la placa por perdida.
    let intentos = 0
    const reintento = await calcularHuellas({
      licencia,
      ejecutar: async archivo => {
        if (/reg\.exe$/i.test(archivo)) return { ok: true, salida: `    MachineGuid    REG_SZ    ${GUID_1}\r\n` }
        intentos += 1
        return intentos === 1 ? { ok: false, salida: '' } : { ok: true, salida: powershell(GUID_1, PLACA(1)) }
      },
    })
    assert.strictEqual(intentos, 2)
    assert.strictEqual(reintento.placa, sha(`${licencia}:${PLACA(1).toLowerCase()}`))

    // El servidor solo acepta `[A-Za-z0-9._-]{1,64}` y sin `..`.
    assert.strictEqual(normalizarEquipo('Oficina Gómez 3'), 'Oficina-Gomez-3')
    assert.strictEqual(normalizarEquipo('PC..Ñandú  nuevo'), 'PC.Nandu-nuevo')
    assert.strictEqual(normalizarEquipo('x'.repeat(100)).length, 64)
    assert.strictEqual(normalizarEquipo(''), 'equipo')
  })

  // ── Ronda 2 ───────────────────────────────────────────────────────────────

  test('ronda 2, criterio 1: con isPackaged:false pero el código dentro de app.asar (el .exe renombrado) sigue pidiendo licencia, y userData y la base son los del paquete', async () => {
    // La regla, sola: dónde vive el código, no el nombre del ejecutable.
    assert.strictEqual(estaEmpaquetada({ isPackaged: false }, path.join(REPO, 'electron-app', 'src')), false, 'el repositorio es desarrollo')
    assert.strictEqual(estaEmpaquetada({ isPackaged: false }, 'C:\\Users\\yo\\ArtTranslatorV2\\resources\\app.asar\\src'), true, 'el .exe se llama electron.exe')
    assert.strictEqual(estaEmpaquetada({ isPackaged: false }, '/opt/ArtTranslatorV2/resources/app.asar/src'), true)
    assert.strictEqual(estaEmpaquetada({ isPackaged: false }, '/opt/ArtTranslatorV2/resources/app.asar.unpacked/x'), false, 'lo desempaquetado no es el código')
    assert.strictEqual(estaEmpaquetada({ isPackaged: true }, '/cualquier/sitio'), true)

    // El recorrido: `mainApp.js` dentro de «app.asar», con un `electron` que dice `isPackaged: false`.
    const paquete = crearPaquete()
    const appData = fs.mkdtempSync(path.join(RAIZ, 'appdata-'))
    const red = crearRed()
    const app = await arrancar({ red, pc: computadora(1), empaquetada: false, sinLicenciaJson: true, mainApp: paquete.mainApp, appData })

    // Sigue pidiendo licencia: sin `licencia.json` falla cerrada, y la puerta de `app:empezar` no se abre.
    const v = await licenciaDe(app)
    assert.strictEqual(v.estado, 'sin_licencia')
    await app.ipc('app:guardarClaves', CLAVE_STT)
    const creadas = TranscriptorFalso.creados
    assert.strictEqual((await app.ipc('app:empezar', { idioma: 'it' })).ok, false)
    assert.strictEqual(TranscriptorFalso.creados, creadas, 'la reunión no llegó a empezar')

    // `userData` y la base son los del paquete: la carpeta de siempre dentro de `appData`, y la base ahí, no junto a la app.
    assert.strictEqual(app.rutas.userData, path.join(appData, CARPETA_DE_DATOS))
    await app.ipc('app:guardarPerfil', { nombre: 'Perfil de prueba' })
    require(paquete.backend('db')).vaciar()
    assert.ok(fs.existsSync(path.join(app.rutas.userData, 'artranslator.db')), 'la base está en userData')
    assert.ok(!fs.existsSync(path.join(paquete.recursos, 'node-backend', 'data')), 'y no junto a la app, que es lo que pasaba en modo desarrollo')
  })

  test('ronda 2, criterio 3: un archivo del backend tocado → el backend no arranca y sale «Esta copia está modificada»; intacto → arranca', async () => {
    const red = crearRed()
    const pc = computadora(1)

    // Intacto: el backend carga y la licencia sigue su curso (aquí, sin `licencia.json`: `sin_licencia`, no `modificada`).
    const intacto = crearPaquete()
    const a = await arrancar({ red, pc, sinLicenciaJson: true, mainApp: intacto.mainApp })
    assert.strictEqual((await licenciaDe(a)).estado, 'sin_licencia')
    assert.deepStrictEqual(await a.ipc('app:listarPerfiles'), [], 'el backend está cargado: la base responde')
    assert.ok(a.manejadores.has('app:empezar'))

    // Tocado un solo archivo, DESPUÉS de generar el manifiesto: ni se ejecuta ni se carga nada de `node-backend`.
    const tocado = crearPaquete()
    fs.appendFileSync(tocado.backend('wav.js'), '\nglobalThis.__f054Tocado = true\n')
    const b = await arrancar({ red, pc, sinLicenciaJson: true, mainApp: tocado.mainApp })
    const v = await licenciaDe(b)
    assert.strictEqual(v.estado, 'modificada')
    assert.strictEqual(v.titulo, 'Esta copia está modificada; descárgala de nuevo')
    assert.strictEqual(v.reintentar, false)
    assert.strictEqual((await b.ipc('app:licenciaReintentar')).estado, 'modificada')
    assert.strictEqual(globalThis.__f054Tocado, undefined, 'el archivo tocado no llegó a ejecutarse')
    const delBackend = Object.keys(require.cache).filter(k => k.startsWith(path.join(tocado.recursos, 'node-backend') + path.sep))
    assert.deepStrictEqual(delBackend, [], 'no se cargó ningún módulo del backend')
    assert.deepStrictEqual([b.manejadores.has('app:empezar'), b.manejadores.has('app:comprobar')], [false, false], 'no hay forma de empezar nada')

    // Las tres maneras de no casar, y la basura del sistema no cuenta.
    const p = crearPaquete()
    const verificar = () => verificarBackend({ raiz: p.recursos, ruta: p.manifiesto })
    assert.deepStrictEqual(verificar(), { ok: true })
    fs.writeFileSync(path.join(path.dirname(p.backend('wav.js')), '.DS_Store'), 'x')
    fs.writeFileSync(path.join(path.dirname(p.compartido('prompts.js')), 'Thumbs.db'), 'x')
    assert.deepStrictEqual(verificar(), { ok: true }, 'los archivos que deja el explorador no bloquean a nadie')
    fs.writeFileSync(p.backend('extra.js'), '')
    assert.deepStrictEqual(verificar(), { ok: false, motivo: 'sobra node-backend/src/extra.js' })
    fs.rmSync(p.backend('extra.js'))
    const original = fs.readFileSync(p.backend('wav.js'))
    fs.rmSync(p.backend('wav.js'))
    assert.deepStrictEqual(verificar(), { ok: false, motivo: 'falta node-backend/src/wav.js' })
    fs.writeFileSync(p.backend('wav.js'), original)
    fs.appendFileSync(p.compartido('prompts.js'), ' ')
    assert.deepStrictEqual(verificar(), { ok: false, motivo: 'no coincide shared/prompts.js' })
    fs.rmSync(p.manifiesto)
    assert.deepStrictEqual(verificar(), { ok: false, motivo: 'falta el manifiesto' }, 'un paquete sin manifiesto no es uno bueno')
  })

  test('ronda 2, §0.21: con la licencia revocada y el reloj atrasado a mano, el primer arranque con red lo apunta y el siguiente bloquea', async () => {
    const s = await servidorDeLicencias()
    const red = crearRed()
    const pc = computadora(1)
    const primero = await arrancar({ servidor: s, red, pc })
    assert.strictEqual((await licenciaDe(primero)).estado, 'ok')
    s.cli('revocar', s.licencia)

    // Con el reloj quieto, a la app el permiso le parece de «hace una hora»: a los 3 días nunca llegaba, y no renovaba.
    const relojQuieto = () => Date.now() + 60 * 60 * 1000
    const segundo = await arrancar({ servidor: s, red, pc, userData: primero.userData, ahora: relojQuieto })
    assert.deepStrictEqual(await licenciaDe(segundo), { estado: 'ok' }, 'este arranque no se corta')
    await hasta(() => leerPermisoGuardado(primero.userData).permiso === null, 'que el 403 de la renovación se apunte')
    assert.strictEqual(red.enviadas, 2, 'renovó aunque el permiso fuera de hace una hora')

    const tercero = await arrancar({ servidor: s, red, pc, userData: primero.userData, ahora: relojQuieto })
    const v = await licenciaDe(tercero)
    assert.strictEqual(v.estado, 'denegada', 'y el siguiente arranque ya no tiene permiso: pide uno y el servidor dice que no')
    assert.strictEqual(v.contacto, CONTACTO_SERVIDOR)
  })

  test('ronda 2: la hora vista se apunta cada hora mientras la app corre y otra vez al cerrarla', async () => {
    const s = await servidorDeLicencias()
    const red = crearRed()
    let corrido = 0
    const app = await arrancar({ servidor: s, red, pc: computadora(1), ahora: () => Date.now() + corrido, apuntarCadaMs: 20 })
    assert.strictEqual((await licenciaDe(app)).estado, 'ok')
    const visto = () => leerPermisoGuardado(app.userData).ultimaVista
    const v0 = visto()

    corrido = 10 * 60 * 1000
    await hasta(() => visto() >= v0 + 9 * 60 * 1000, 'que el temporizador apunte la hora vista')

    corrido = 25 * 60 * 1000
    app.licencia.detener()
    assert.ok(visto() >= v0 + 24 * 60 * 1000, 'y al cerrar se apunta una última vez')
    corrido = 40 * 60 * 1000
    await esperar(80)
    assert.ok(visto() < v0 + 30 * 60 * 1000, 'cerrada, ya no queda ningún temporizador')
  })

  test('ronda 2: el permiso se guarda cifrado con safeStorage; un archivo en claro, editado a mano, no vale; sin cifrado disponible va en claro', async () => {
    const s = await servidorDeLicencias()
    const red = crearRed()
    const pc = computadora(1)
    const primero = await arrancar({ servidor: s, red, pc })
    assert.strictEqual((await licenciaDe(primero)).estado, 'ok')
    const guardado = fs.readFileSync(primero.rutaPermiso, 'utf8')
    assert.ok(guardado.startsWith(PREFIJO_CIFRADO), 'va cifrado')
    assert.ok(!guardado.includes('permiso') && !guardado.includes('ultimaVista'), 'y no se lee en el archivo')

    // Editarlo a mano (por ejemplo, `ultimaVista` a 0 para engañar al reloj) deja un archivo en claro: no es un permiso.
    const editado = leerPermisoGuardado(primero.userData)
    assert.ok(editado.permiso)
    editado.ultimaVista = 0
    fs.writeFileSync(primero.rutaPermiso, JSON.stringify(editado))
    red.caida = true
    assert.strictEqual((await licenciaDe(await arrancar({ servidor: s, red, pc, userData: primero.userData }))).estado, 'sin_red')

    // Sin `safeStorage` disponible (otro sistema) se guarda en claro, y así se vuelve a leer.
    red.caida = false
    const sinCifrado = await arrancar({ servidor: s, red, pc: computadora(2), cifrado: false })
    assert.strictEqual((await licenciaDe(sinCifrado)).estado, 'ok')
    assert.ok(JSON.parse(fs.readFileSync(sinCifrado.rutaPermiso, 'utf8')).permiso, 'en claro')
    red.caida = true
    assert.strictEqual((await licenciaDe(await arrancar({ servidor: s, red, pc: computadora(2), userData: sinCifrado.userData, cifrado: false }))).estado, 'ok')
  })

  test('ronda 2: con reg.exe bloqueado el MachineGuid se lee con PowerShell, en la misma llamada que la placa', async () => {
    const licencia = 'b'.repeat(32)
    const GUID_1 = '11111111-2222-4333-8444-555555555555'
    let llamadasAPowerShell = 0
    const sinReg = salida => async archivo => {
      if (/reg\.exe$/i.test(archivo)) return { ok: false, salida: '' }
      llamadasAPowerShell += 1
      return { ok: true, salida }
    }

    assert.deepStrictEqual(await calcularHuellas({ licencia, ejecutar: sinReg(`guid=${GUID_1.toUpperCase()}\r\nplaca=${PLACA(1)}\r\n`) }), {
      maquina: sha(`${licencia}:${GUID_1}`),
      placa: sha(`${licencia}:${PLACA(1).toLowerCase()}`),
    })
    assert.strictEqual(llamadasAPowerShell, 1, 'una sola llamada: la placa y el MachineGuid')
    assert.strictEqual((await calcularHuellas({ licencia, ejecutar: sinReg('guid=\r\nplaca=\r\n') })).maquina, null, 'sin ninguna de las dos vías no hay huella')

    // De punta a punta: un equipo con el registro bloqueado se activa solo, con la misma huella de máquina que daría reg.exe.
    const s = await servidorDeLicencias()
    const red = crearRed()
    const pc = computadora(1, { regBloqueado: true })
    assert.deepStrictEqual(await licenciaDe(await arrancar({ servidor: s, red, pc })), { estado: 'ok' })
    assert.deepStrictEqual(s.almacen().equipos[0].maquinas, [sha(`${s.licencia}:${pc.guid}`)])
  })

  test('ronda 2: la ruta de System32 sale de C:\\Windows, y el entorno solo vale si esa carpeta no existe', () => {
    const hostil = { SystemRoot: 'C:\\Users\\mala\\falsa', windir: 'C:\\Users\\mala\\falsa' }
    const consultadas = []
    const normal = herramientasDeWindows({ existe: ruta => { consultadas.push(ruta); return true }, entorno: hostil })
    assert.deepStrictEqual(consultadas, ['C:\\Windows\\System32'])
    assert.strictEqual(normal.reg, 'C:\\Windows\\System32\\reg.exe', 'con un SystemRoot hostil en el entorno, no se hace caso')
    assert.strictEqual(normal.powershell, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')

    assert.strictEqual(herramientasDeWindows({ existe: () => false, entorno: { SystemRoot: 'D:\\Windows' } }).reg, 'D:\\Windows\\System32\\reg.exe', 'Windows en otra unidad')
    assert.strictEqual(herramientasDeWindows({ existe: () => false, entorno: {} }).reg, 'C:\\Windows\\System32\\reg.exe')
  })

  test('el ejecutor de comandos: el plazo mata al proceso hijo que no contesta, y uno que contesta devuelve su salida', async () => {
    const pids = []
    const hijos = new Set()
    const anadir = hijos.add.bind(hijos)
    hijos.add = hijo => { pids.push(hijo.pid); return anadir(hijo) }
    const ejecutar = crearEjecutor(hijos)

    const t0 = Date.now()
    const colgado = await ejecutar(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { plazoMs: 200 })
    assert.deepStrictEqual(colgado, { ok: false, salida: '' })
    assert.ok(Date.now() - t0 < 3000, 'no espera a que el hijo acabe solo (60 s)')
    assert.strictEqual(hijos.size, 0, 'y no queda registrado como vivo')
    assert.throws(() => process.kill(pids[0], 0), { code: 'ESRCH' }, 'el proceso ya no existe')

    const bueno = await ejecutar(process.execPath, ['-e', 'console.log("hola")'], { plazoMs: 5000 })
    assert.deepStrictEqual([bueno.ok, bueno.salida.trim()], [true, 'hola'])
    assert.deepStrictEqual(await ejecutar('/no/existe/este-comando', [], { plazoMs: 1000 }), { ok: false, salida: '' })
  })
})
