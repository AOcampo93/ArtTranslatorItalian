/**
 * F052 — informes: siempre los números, la conversación solo con permiso, y se
 * registra el interruptor (PLAN.md §17.5 y §0.22).
 *
 * Una prueba por criterio de aceptación, y los datos son INVENTADOS: ningún texto de
 * aquí sale de una reunión real.
 *
 *  (a) encendido manda `completo`, apagado manda `metricas`, y un `no` que dejó la
 *      v0.9 se lee como `metricas`;
 *  (b) un `.jsonl` recortado a métricas no lleva ni una palabra del perfil, del
 *      contexto ni de lo que se dijo, en ninguna cadena;
 *  (c) tras apagar el interruptor, la cabecera de la siguiente reunión lleva el modo
 *      y el cambio con su hora, y la siguiente ya no;
 *  (d) Ajustes y el LEEME dicen el texto de §17.5;
 *  y las dos métricas nuevas: «Otra respuesta» y `recuperoPrincipio`;
 *  y la ronda 2: el interruptor se lee antes de cada pendiente, una reunión que cambia de
 *  modo entre empezar y parar sube lo más restrictivo, y un `encolar` en plena tanda no se
 *  pierde.
 *
 * ## Cómo se prueba (c)
 *
 * El criterio es del RECORRIDO —guardar el interruptor, empezar una reunión, mirar su
 * archivo—, y un eslabón mal conectado lo rompería sin que ninguna función suelta lo
 * notara. Por eso se carga el `mainApp.js` de verdad, como en `baseDatosF057.test.js`,
 * con un `electron` de mentira y con el transcriptor y Marian de mentira (la reunión
 * no oye ni traduce nada). Y con el `informes.token.json` de esta máquina SUSTITUIDO por
 * uno que apunta a un receptor de mentira en 127.0.0.1: esta máquina puede tener el de
 * verdad, y parar la reunión subiría el archivo de prueba al servidor de verdad. Así,
 * además, se ve lo que sube.
 */

'use strict'

const { test, describe, after } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const http = require('http')

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'informes-f052-'))
// Antes de requerir nada de `src`: `db.js` lee la variable al cargarse.
process.env.DB_DATA_DIR = path.join(RAIZ, 'base')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')
const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const LEEME = path.join(__dirname, '..', '..', 'LEEME-WINDOWS.txt')

const db = require('../src/db')
const { Autosave } = require('../src/autosave')
const { leerAjustes } = require('../src/ajustes')
const { partirTurno, arrastrar, acabaCerrada } = require('../src/frases')
const { sanear } = require('../src/llm')
const { normalizarModo, masRestrictivo, recortarInformeAMetricas, ColaDeInformes } = require('../src/informes')

after(async () => {
  db.vaciar()
  await cargada?.receptor.cerrar()
})

// ── Utilidades ──────────────────────────────────────────────────────────────

/** Saca de `mainApp.js` el tramo entre dos anclas, y falla si no está donde debe. */
function tramo (desde, hasta) {
  const fuente = fs.readFileSync(MAIN_APP, 'utf8')
  const i = fuente.indexOf(desde)
  const j = fuente.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return fuente.slice(i, j)
}

const esperar = ms => new Promise(r => setTimeout(r, ms))
async function hasta (cond, queEsperaba) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await esperar(5)
  }
  assert.fail(`nunca ocurrió: ${queEsperaba}`)
}

/**
 * Un receptor de mentira en 127.0.0.1 (puerto efímero) que apunta lo que le suben.
 * `retardoMs(n)` hace esperar la respuesta de la subida n-ésima, y `alRecibir(n)` corre en
 * cuanto esa subida llega entera: lo justo para ejercer lo que pasa MIENTRAS una sube.
 */
function iniciarReceptor ({ retardoMs = () => 0, alRecibir = () => {} } = {}) {
  const recibidos = []
  const servidor = http.createServer((req, res) => {
    const trozos = []
    req.on('data', t => trozos.push(t))
    req.on('end', () => {
      recibidos.push({ cuerpo: Buffer.concat(trozos).toString('utf8'), cabeceras: req.headers })
      const n = recibidos.length
      alRecibir(n)
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') }, retardoMs(n))
    })
  })
  return new Promise(resolver => servidor.listen(0, '127.0.0.1', () => resolver({
    url: `http://127.0.0.1:${servidor.address().port}/informes`,
    recibidos,
    cerrar: () => new Promise(fin => { servidor.close(fin); servidor.closeAllConnections() }),
  })))
}

// ── El `mainApp.js` de verdad ───────────────────────────────────────────────

let cargada = null

/**
 * Carga `mainApp.js` una vez y devuelve cómo hablarle: `ipc(canal, ...args)` llama al
 * manejador real, y `nuevoUserData()` lo pone a trabajar en una carpeta limpia (cada
 * prueba la suya, para que los cambios de una no entren en la cabecera de otra).
 */
async function cargarMainApp () {
  if (cargada) return cargada

  const receptor = await iniciarReceptor()
  const manejadores = new Map()
  const estado = { userData: fs.mkdtempSync(path.join(RAIZ, 'ud-')) }
  let arranque = null
  const app = {
    isPackaged: false,
    getPath: () => estado.userData,
    getVersion: () => '1.0.0-prueba',
    setPath () {},
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
  // Cifrado reversible y nada más: lo que se prueba no es `safeStorage`.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: s => Buffer.from(s, 'utf8'),
    decryptString: b => b.toString('utf8'),
  }
  const electron = {
    app,
    BrowserWindow,
    ipcMain: { handle: (canal, f) => manejadores.set(canal, f), on () {} },
    safeStorage,
    shell: {},
    dialog: {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  }

  // La reunión no oye ni traduce: el transcriptor y Marian son de mentira.
  class TranscriptorFalso extends EventEmitter {
    constructor () { super(); this.stats = { frases: 0, turnosForzados: 0 } }
    async start () {}
    async stop () {}
    alimentar () {}
    costeAproximadoUsd () { return '0.00' }
  }
  const marianFalso = {
    cargar: async () => {}, descargar: async () => false, estaListo: () => true,
    traducir: async () => ({ es: 'x', ms: 1 }),
  }
  // El `informes.token.json` que lee la app es el de mentira, que apunta al receptor de esta
  // prueba (ver el comentario de arriba): nada sale de la máquina.
  const fsConElTokenDeMentira = new Proxy(fs, {
    get (original, nombre) {
      if (nombre === 'readFileSync') {
        return (ruta, ...resto) => {
          if (String(ruta).endsWith('informes.token.json')) return JSON.stringify({ token: 'token-de-prueba', url: receptor.url })
          return original.readFileSync(ruta, ...resto)
        }
      }
      const v = original[nombre]
      return typeof v === 'function' ? v.bind(original) : v
    },
  })

  const cargar = Module._load
  Module._load = function (peticion, padre, ...resto) {
    if (peticion === 'electron') return electron
    if (padre?.filename === MAIN_APP) {
      if (peticion === 'fs') return fsConElTokenDeMentira
      if (peticion.endsWith(path.join('src', 'assemblyLive'))) return { AssemblyLiveTranscriber: TranscriptorFalso }
      if (peticion.endsWith(path.join('src', 'translator'))) return marianFalso
    }
    return cargar.call(this, peticion, padre, ...resto)
  }
  let modulo
  try { modulo = require(MAIN_APP) } finally { Module._load = cargar }
  await arranque

  cargada = {
    modulo,
    receptor,
    ipc: (canal, ...args) => manejadores.get(canal)({}, ...args),
    nuevoUserData: () => { estado.userData = fs.mkdtempSync(path.join(RAIZ, 'ud-')); return estado.userData },
    rutaAjustes: () => path.join(estado.userData, 'ajustes.json'),
    reuniones: () => {
      const dir = path.join(estado.userData, 'reuniones')
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map(f => path.join(dir, f)) : []
    },
  }
  return cargada
}

// ── El Ajustes de verdad, contra un DOM de mentira ──────────────────────────

class Nodo {
  constructor () {
    this.value = ''
    this.checked = false
    this._texto = ''
    this._clases = new Set()
    this._alEventos = {}
    this.classList = {
      add: (...c) => c.forEach(x => this._clases.add(x)),
      remove: (...c) => c.forEach(x => this._clases.delete(x)),
      contains: c => this._clases.has(c),
      toggle: (c, on) => { on ? this._clases.add(c) : this._clases.delete(c) },
    }
  }

  get textContent () { return this._texto }
  set textContent (v) { this._texto = String(v) }
  addEventListener (tipo, fn) { this._alEventos[tipo] = fn }
}

/** El bloque de Ajustes de `app.html` (el mismo que ejecuta `rendererAjustesEstadoClavesF042.test.js`). */
function montarAjustes (api) {
  const html = fs.readFileSync(APP_HTML, 'utf8')
  const i = html.indexOf('// ── Informe de la reunión (')
  const j = html.indexOf('// ── Ajustes: probar claves (F036)')
  assert.ok(i > 0 && j > i, 'no se encontró el bloque de Ajustes en app.html')
  const nodos = {}
  for (const id of ['ajustes', 'chkPermitirEnvio', 'txtInformes', 'kSTT', 'kLLM', 'estadoStt', 'estadoLlm',
    'btnAjustes', 'btnCerrarAjustes', 'btnGuardarAjustes']) nodos[id] = new Nodo()
  const $ = sel => nodos[sel.replace('#', '')] || null
  const { abrirAjustes } = new Function('$', 'api', `${html.slice(i, j)}\n return { abrirAjustes }`)($, api)
  return { nodos, abrirAjustes }
}

// ── (a) El interruptor ──────────────────────────────────────────────────────

describe('F052 (a) — encendido manda completo, apagado manda metricas, un «no» guardado se lee como metricas', () => {
  test('lo que Ajustes manda al guardar, y cómo pinta lo que le devuelven', async () => {
    const guardadas = []
    const api = {
      guardarClaves: async claves => { guardadas.push(claves) },
      estadoClaves: async () => ({ stt: false, llm: false, informes: 'metricas', informesDisponibles: true }),
    }
    const { nodos, abrirAjustes } = montarAjustes(api)

    // Encendido (como viene): completo.
    await nodos.btnGuardarAjustes.onclick()
    // Apagado: metricas, ya no `no`.
    nodos.chkPermitirEnvio.checked = false
    nodos.chkPermitirEnvio._alEventos.change()
    await nodos.btnGuardarAjustes.onclick()
    assert.deepStrictEqual(guardadas, [{ informes: 'completo' }, { informes: 'metricas' }])

    // Y al abrir, `metricas` es apagado (antes solo lo era `no`).
    nodos.chkPermitirEnvio.checked = true
    await abrirAjustes()
    assert.strictEqual(nodos.chkPermitirEnvio.checked, false)
  })

  test('un «no» de la v0.9 llega como metricas por el estado de las claves, por obtenerModo y por masRestrictivo', async () => {
    const h = await cargarMainApp()
    h.nuevoUserData()
    const cola = h.modulo._internos.obtenerColaInformes()

    // Lo mismo que `normalizarModo`, valor por valor: la regla está en dos sitios (el manejador del
    // estado la lleva en línea, porque otra prueba lo ejecuta suelto) y esto los mantiene de acuerdo.
    // '' es lo que `guardarClaves` borra: nada guardado, o sea el valor por defecto.
    const esperados = { '': 'completo', completo: 'completo', metricas: 'metricas', no: 'metricas', raro: 'metricas' }
    for (const [guardado, modo] of Object.entries(esperados)) {
      await h.ipc('app:guardarClaves', { informes: guardado })
      assert.strictEqual((await h.ipc('app:estadoClaves')).informes, modo, `estado con «${guardado}»`)
      assert.strictEqual(cola.obtenerModo(), modo, `obtenerModo con «${guardado}»`)
      assert.strictEqual(normalizarModo(guardado), modo, `normalizarModo con «${guardado}»`)
    }

    // El que vale es el más restrictivo, y un pendiente sin modo (de antes de F039b) cuenta como completo.
    assert.strictEqual(masRestrictivo('no', 'completo'), 'metricas')
    assert.strictEqual(masRestrictivo('completo', 'no'), 'metricas')
    assert.strictEqual(masRestrictivo(undefined, 'completo'), 'completo')
  })
})

// ── (b) Solo métricas = ni una palabra ──────────────────────────────────────

describe('F052 (b) — recortado a métricas, no queda ninguna palabra de los textos', () => {
  const PERFIL = {
    id: 3, nombre: 'Valdemar Quintanilla Ibarra', edad: 47, ocupacion: 'Cartógrafo submarino',
    contexto: 'Coleccionista de sellos postales de Andorra, hijo de pescadores',
  }
  const CONTEXTO = {
    nombre: 'Auditoría Zafiro Naranja', tipo_reunion: 'negociación', tipo_proyecto: 'Reconversión de astilleros',
    contexto: 'Se discute la cláusula penal por el cargamento de mármol retrasado',
    glosario: 'Tramontana, Pergamino, Gaviota',
  }
  const T = '2026-10-08T10:00:00.000Z'
  const CAMBIOS = [{ t: '2026-10-07T18:30:00.000Z', a: 'metricas' }]
  const LINEAS = [
    { t: T, tipo: 'cabecera', perfil: PERFIL, contexto: CONTEXTO, version: '1.0.0', inicio: T, id: 12,
      claves: { stt: true, llm: true }, idioma: 'it', modoInforme: 'metricas', cambiosModo: CAMBIOS },
    { t: T, tipo: 'frase', it: 'Buongiorno signor Valdemar, il carico di marmo arriverà martedì',
      es: 'Buenas tardes señor Valdemar, la carga de mármol llegará el martes', ms: 812, msTranscribir: 400,
      msTraducir: 412, traductor: 'llm', motivo: null, forzado: true, msTurno: 6100, msHolgura: 240,
      acabaEnPuntuacion: true, motivoCorte: 'silencio', arrastre: false, msProvisional: null, cierre: 'frase',
      empiezaAMedias: false, recuperoPrincipio: true },
    { t: T, it: 'Un viejo comentario sobre el ritardo del cargamento', es: 'Lo mismo, igual', ms: 90 },
    { t: T, tipo: 'pregunta', it: 'Può confermare la data di consegna del marmo?',
      es: '¿Puede confirmar la fecha de entrega del mármol?', respuesta: 'Confermo la consegna', manual: false },
    { t: T, tipo: 'respuestaLlm', it: 'Può confermare la data di consegna del marmo?', es: '¿Puede confirmar?',
      manual: false, texto: 'Confermo la consegna per martedì mattina, signor Valdemar', tokensEntrada: 310,
      tokensSalida: 22, modelo: 'claude-haiku-4-5-20251001', mensaje: 'Quota esaurita per Quintanilla' },
    { t: T, tipo: 'otraRespuesta' },
    { t: T, tipo: 'error', mensaje: 'ENOENT: no existe C:\\Users\\vquintanilla\\Documentos\\sesion-zafiro.txt',
      detalle: 'Traceback del Zafiro', codigo: 'ENOENT' },
    // Los dos que atacó la revisión: un término como CLAVE de un objeto, y una clave de
    // vocabulario con una frase dentro.
    { tipo: 'x', terminos: { Tramontana: 3 } },
    { tipo: 'frase', motivo: 'Valdemar pidió el mármol' },
    // Una cabecera con basura en cada campo que sale tal cual: ninguno tiene la forma de lo
    // que debería ser (una hora, una versión, un código de idioma, uno de los dos modos).
    { t: 'Valdemar', tipo: 'cabecera', version: 'Valdemar pidió el mármol', inicio: 'Zafiro Naranja',
      id: 'Quintanilla', idioma: 'Tramontana pidió', modoInforme: 'Pergamino',
      cambiosModo: [{ t: 'Gaviota', a: 'metricas' }, { t: T, a: 'Pergamino' }],
      claves: { stt: 'Tramontana', llm: true }, perfil: 'Valdemar Quintanilla', contexto: ['Zafiro'] },
  ]
  // Lo que hay en esos tres que no puede salir (no se saca de los campos: en la cabecera con
  // basura hay valores legítimos, como el modo `metricas`, que sí salen).
  const BASURA = ['Tramontana', 'Valdemar pidió el mármol', 'Zafiro Naranja', 'Quintanilla', 'Tramontana pidió',
    'Pergamino', 'Gaviota', 'Valdemar Quintanilla', 'Zafiro']
  // La última línea de un archivo cortado a media escritura: texto de la reunión sin cerrar.
  const CORTADA = '{"t":"2026-10-08T10:05:00.000Z","tipo":"frase","it":"Il signor Valdemar ha detto che il marmo non'

  /** Todas las cadenas de un árbol: los valores y, con `conClaves`, también las claves. */
  function cadenas (valor, conClaves = true, salida = []) {
    if (typeof valor === 'string') salida.push(valor)
    else if (Array.isArray(valor)) valor.forEach(v => cadenas(v, conClaves, salida))
    else if (valor && typeof valor === 'object') {
      for (const [k, v] of Object.entries(valor)) { if (conClaves) salida.push(k); cadenas(v, conClaves, salida) }
    }
    return salida
  }
  const sinAcentos = t => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const palabrasDe = textos => new Set(textos.flatMap(t => sinAcentos(t).match(/\p{L}{4,}/gu) || []))

  test('un barrido de todas las cadenas del resultado no encuentra ninguna palabra de 4 letras o más de esos textos', () => {
    const original = LINEAS.map(l => JSON.stringify(l)).join('\n') + '\n' + CORTADA + '\n'
    const salida = recortarInformeAMetricas(original)

    // Las palabras que NO pueden salir: las de todo lo que el usuario escribió o dijo. Los nombres de
    // los campos y los vocabularios (`tipo`, `llm`, `claude-haiku…`) no cuentan: no son suyos.
    const palabras = palabrasDe([
      ...cadenas([PERFIL, CONTEXTO], false),
      ...LINEAS.slice(1).flatMap(l => ['it', 'es', 'respuesta', 'texto', 'mensaje', 'detalle', 'motivo']
        .map(c => l[c]).filter(v => typeof v === 'string')),
      ...BASURA,
      CORTADA.slice(CORTADA.indexOf('"it":"') + 6),
    ])
    assert.ok(palabras.size > 60, `el barrido sería vacío con tan pocas palabras (${palabras.size})`)
    // Y esas palabras estaban en el original: un barrido que no puede fallar no prueba nada.
    const paraBuscar = sinAcentos(original)
    assert.ok([...palabras].every(p => paraBuscar.includes(p)))

    const escapadas = []
    for (const linea of salida.split('\n').filter(Boolean)) {
      const texto = sinAcentos(cadenas(JSON.parse(linea)).join('\n')) // claves incluidas
      for (const p of palabras) if (texto.includes(p)) escapadas.push(p)
    }
    assert.deepStrictEqual(escapadas, [], 'palabras que han salido')

    // Y lo que sí tiene que salir, que son los números.
    const [cab, frase, sinTipo, pregunta, respuesta, otra, error, terminos, motivo, basura, ilegible] =
      salida.split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.deepStrictEqual(cab, {
      tipo: 'cabecera', t: T, version: '1.0.0', inicio: T, idioma: 'it', id: 12,
      claves: { stt: true, llm: true }, modoInforme: 'metricas', cambiosModo: CAMBIOS,
      perfil: { nombreLen: PERFIL.nombre.length, ocupacionLen: PERFIL.ocupacion.length,
        contextoLen: PERFIL.contexto.length, tieneEdad: true },
      contexto: { nombreLen: CONTEXTO.nombre.length, tipoReunionLen: CONTEXTO.tipo_reunion.length,
        tipoProyectoLen: CONTEXTO.tipo_proyecto.length, contextoLen: CONTEXTO.contexto.length,
        glosarioLen: CONTEXTO.glosario.length },
    })
    assert.strictEqual(frase.itLen, LINEAS[1].it.length)
    assert.strictEqual(frase.esLen, LINEAS[1].es.length)
    assert.strictEqual(frase.ms, 812)
    assert.strictEqual(frase.traductor, 'llm')
    assert.strictEqual(frase.motivoCorte, 'silencio')
    assert.strictEqual(frase.recuperoPrincipio, true, 'la bandera de F056 sale: es un booleano, no la palabra')
    assert.strictEqual(sinTipo.itLen, LINEAS[2].it.length)
    assert.strictEqual(pregunta.itLen, LINEAS[3].it.length)
    assert.strictEqual(pregunta.respuestaLen, LINEAS[3].respuesta.length)
    assert.strictEqual(respuesta.textoLen, LINEAS[4].texto.length)
    assert.strictEqual(respuesta.modelo, 'claude-haiku-4-5-20251001')
    assert.strictEqual(respuesta.tokensEntrada, 310)
    assert.deepStrictEqual(otra, { t: T, tipo: 'otraRespuesta' })
    assert.deepStrictEqual(error, { t: T, tipo: 'error', mensajeLen: LINEAS[6].mensaje.length,
      detalleLen: LINEAS[6].detalle.length, codigoLen: 6 })
    assert.deepStrictEqual(terminos, { tipo: 'x', terminos: {} }, 'la clave que es un término no sale')
    assert.deepStrictEqual(motivo, { tipo: 'frase', motivoLen: LINEAS[8].motivo.length }, 'una frase en `motivo` sale como longitud')
    assert.deepStrictEqual(basura, { tipo: 'cabecera', claves: { stt: true, llm: true }, cambiosModo: [],
      perfil: null, contexto: null }, 'de la cabecera con basura no sale ni un campo')
    assert.deepStrictEqual(ilegible, { tipo: 'ilegible', len: CORTADA.length })
  })
})

// ── (c) La cabecera lleva el interruptor ────────────────────────────────────

describe('F052 (c) — la cabecera de la siguiente reunión lleva el modo y el cambio con su hora', () => {
  test('apagar el interruptor se apunta, la siguiente cabecera lo lleva, y la que sigue ya no', async () => {
    const h = await cargarMainApp()
    h.nuevoUserData()
    const reunion = { perfil: { nombre: 'Valdemar Quintanilla' }, contexto: { nombre: 'Auditoría Zafiro' }, idioma: 'it' }

    await h.ipc('app:guardarClaves', { stt: 'clave-de-transcripcion-inventada' })
    // Encendido es como viene: guardarlo sin tocarlo no es un cambio.
    await h.ipc('app:guardarClaves', { informes: 'completo' })
    assert.strictEqual(leerAjustes(h.rutaAjustes()).cambiosModo, undefined, 'sin cambios no se apunta nada')

    const antes = Date.now()
    await h.ipc('app:guardarClaves', { informes: 'metricas' })
    const despues = Date.now()
    await h.ipc('app:guardarClaves', { informes: 'metricas' }) // Guardar otra vez, sin tocar nada
    const apuntados = leerAjustes(h.rutaAjustes()).cambiosModo
    assert.strictEqual(apuntados.length, 1, 'solo el cambio, no cada Guardar')
    assert.strictEqual(apuntados[0].a, 'metricas')
    assert.ok(Date.parse(apuntados[0].t) >= antes && Date.parse(apuntados[0].t) <= despues, 'con su hora')

    // La siguiente reunión: su cabecera lleva el modo y el cambio.
    assert.strictEqual((await h.ipc('app:empezar', reunion)).ok, true)
    const [primera] = h.reuniones()
    const cabecera1 = Autosave.leer(primera).entradas[0]
    assert.strictEqual(cabecera1.tipo, 'cabecera')
    assert.strictEqual(cabecera1.modoInforme, 'metricas')
    assert.deepStrictEqual(cabecera1.cambiosModo, apuntados)
    assert.strictEqual(cabecera1.perfil.nombre, 'Valdemar Quintanilla', 'el archivo de este equipo conserva el perfil entero')
    assert.strictEqual(leerAjustes(h.rutaAjustes()).cambiosModo, undefined, 'una vez escritos en una cabecera, se vacían')

    // Y lo que sube de esa reunión —solo números— sigue diciéndolo, sin el perfil.
    await h.ipc('app:parar')
    await hasta(() => h.receptor.recibidos.length === 1, 'la subida de la primera reunión')
    const subida = h.receptor.recibidos[0].cuerpo
    const cabeceraSubida = JSON.parse(subida.split('\n')[0])
    assert.strictEqual(cabeceraSubida.modoInforme, 'metricas')
    assert.deepStrictEqual(cabeceraSubida.cambiosModo, apuntados)
    assert.ok(!subida.includes('Valdemar') && !subida.includes('Zafiro'), 'ni el perfil ni el contexto')

    // La siguiente: el mismo modo, y el cambio ya no.
    assert.strictEqual((await h.ipc('app:empezar', reunion)).ok, true)
    const segunda = h.reuniones().find(r => r !== primera)
    const cabecera2 = Autosave.leer(segunda).entradas[0]
    assert.strictEqual(cabecera2.modoInforme, 'metricas')
    assert.deepStrictEqual(cabecera2.cambiosModo, [])
    await h.ipc('app:parar')
    await hasta(() => h.receptor.recibidos.length === 2, 'la subida de la segunda reunión')
    h.receptor.recibidos.length = 0
  })
})

// ── (d) Los textos ──────────────────────────────────────────────────────────

describe('F052 (d) — Ajustes y el LEEME dicen el texto de §17.5', () => {
  const TEXTO = 'Siempre se envían al equipo datos técnicos de cada reunión —tiempos, número de frases y versión—, '
    + 'nunca lo que se dijo. Con "Permitir el envío" encendido se envía también la conversación completa y tu '
    + 'perfil, para mejorar la traducción.'

  test('el aviso del informe es exactamente ese, en el marcado y al abrir Ajustes; sin subida se queda el aviso de siempre', async () => {
    const html = fs.readFileSync(APP_HTML, 'utf8')
    const parrafo = html.match(/<p class="ayuda" id="txtInformes">([\s\S]*?)<\/p>/)
    assert.ok(parrafo, 'no se encontró #txtInformes')
    assert.strictEqual(parrafo[1].replace(/\s+/g, ' ').trim(), TEXTO)

    const { nodos, abrirAjustes } = montarAjustes({
      estadoClaves: async () => ({ stt: false, llm: false, informes: 'completo', informesDisponibles: true }),
    })
    await abrirAjustes()
    assert.strictEqual(nodos.txtInformes.textContent, TEXTO)

    const sinSubida = montarAjustes({
      estadoClaves: async () => ({ stt: false, llm: false, informes: 'completo', informesDisponibles: false }),
    })
    await sinSubida.abrirAjustes()
    assert.match(sinSubida.nodos.txtInformes.textContent, /^La subida está desactivada en este equipo/)
  })

  test('el LEEME explica en «SOBRE LA PRIVACIDAD» qué sale siempre y qué solo con el interruptor encendido', () => {
    const texto = fs.readFileSync(LEEME, 'utf8')
    const desde = texto.indexOf('SOBRE LA PRIVACIDAD')
    const apartado = texto.slice(desde, texto.indexOf('SI ALGO NO VA')).replace(/\s+/g, ' ')
    assert.ok(desde > 0)
    assert.match(apartado, /Siempre salen datos técnicos/)
    assert.match(apartado, /Nunca sale lo que se dijo, ni tu perfil/)
    assert.match(apartado, /Con "Permitir el envío" encendido.*sale además la conversación completa.*tu perfil/)
  })
})

// ── Las dos métricas nuevas ─────────────────────────────────────────────────

describe('F052 — «Otra respuesta» y la primera palabra recuperada, sin texto', () => {
  test('cada «Otra respuesta» deja una línea con tipo y hora, y nada más', () => {
    const directorio = fs.mkdtempSync(path.join(RAIZ, 'otra-'))
    const autosave = new Autosave({ directorio, idSesion: 'f052' })
    autosave.abrir()
    const registrados = {}
    const ipcMain = { handle: (canal, fn) => { registrados[canal] = fn } }
    // El tramo real de los manejadores de `app:otraRespuesta` y `app:preguntar`.
    new Function('ipcMain', 'aRenderer', 'sesion',
      tramo("ipcMain.handle('app:otraRespuesta'", "ipcMain.handle('app:guardarClaves'"))(
      ipcMain, () => {}, { motor: { reintentar: () => true }, autosave })

    assert.deepStrictEqual(registrados['app:otraRespuesta'](null, 'p1'), { ok: true })
    registrados['app:otraRespuesta'](null, 'p2')
    autosave.cerrar()

    const { entradas } = Autosave.leer(autosave.ruta)
    assert.strictEqual(entradas.length, 2)
    for (const e of entradas) assert.deepStrictEqual(Object.keys(e), ['t', 'tipo'])
    assert.ok(entradas.every(e => e.tipo === 'otraRespuesta' && !Number.isNaN(Date.parse(e.t))))
  })

  test('recuperoPrincipio es un booleano y va en una línea por turno: la primera, o la que hereda la de su cola', async () => {
    const codigo = [
      tramo('const GRACIA_EN_VUELO_MS', '// ── La reunión'),
      tramo('sesion = {', "transcriptor.on('parcial'"),
      tramo("transcriptor.on('frase'", "transcriptor.on('estado'"),
      'return { sesion: s }',
    ].join('\n')
    const escritas = []
    const transcriptor = new EventEmitter()
    const traductor = { traducir: async texto => ({ es: `[es] ${texto}`, ms: 5, traductor: 'marian' }) }
    const autosave = { abierto: true, escribir: linea => escritas.push(linea), cerrar () {} }
    new Function(
      'transcriptor', 'traductor', 'traductorSesion', 'autosave', 'idSesion', 'motor', 'resumen',
      'aRenderer', 'db', 'console', 'sesion', 'partirTurno', 'arrastrar', 'acabaCerrada', 'sanear', codigo)(
      transcriptor, traductor, traductor, autosave, 7, { considerar: async () => null }, { registrar: () => false },
      () => {}, {}, console, null, partirTurno, arrastrar, acabaCerrada, sanear)
    const turno = (texto, extra = {}) => transcriptor.emit('frase', { texto, msTranscribir: 100, ...extra })

    // Un turno de dos oraciones, el servidor se comió «Il»: la bandera va en la primera línea, no en las dos.
    turno('Il cliente ha chiesto uno sconto. Poi vuole la consegna', { principioRecuperado: 'Il' })
    await hasta(() => escritas.length === 1, 'la primera línea')
    // El turno siguiente cierra la cola: es otro turno, sin recuperación.
    turno('entro lunedì. Grazie mille.')
    await hasta(() => escritas.length === 2, 'la línea que cierra la cola')
    // Un turno entero a medias con la palabra recuperada, y otro que lo continúa: la línea que los une la hereda.
    turno('Ma io non sono', { principioRecuperado: 'Ma' })
    turno('sicuro che funzioni.')
    await hasta(() => escritas.length === 3, 'la línea con el arrastre')

    assert.deepStrictEqual(escritas.map(l => l.recuperoPrincipio), [true, false, true])
    assert.deepStrictEqual(escritas.map(l => l.it), [
      'Il cliente ha chiesto uno sconto.',
      'Poi vuole la consegna entro lunedì. Grazie mille.',
      'Ma io non sono sicuro che funzioni.',
    ])
    assert.ok(escritas.every(l => !('principioRecuperado' in l)), 'la palabra no se guarda aparte, solo la bandera')
  })
})

// ── Ronda 2: la cola ────────────────────────────────────────────────────────

describe('F052 (ronda 2) — lo que la cola manda, y cuándo lo decide', () => {
  // El caso de la revisión, con datos inventados: una cabecera con perfil y contexto, y una frase.
  const TEXTO_IT = 'Il marmo arriva martedì'
  const JSONL = [
    '{"t":"2026-10-08T10:00:00.000Z","tipo":"cabecera","perfil":{"nombre":"Valdemar Quintanilla","edad":47},"contexto":{"nombre":"Auditoría Zafiro"}}',
    `{"t":"2026-10-08T10:00:01.000Z","tipo":"frase","it":"${TEXTO_IT}","es":"El mármol llega el martes","ms":800}`,
  ].join('\n') + '\n'
  const PALABRAS = ['Valdemar', 'Zafiro', 'marmo']
  const META = n => ({ maquina: 'pc-prueba', version: '1.0.0', reunion: `20261008-10000${n}-${n}` })

  /** Una carpeta con la cola y un `.jsonl` inventado por cada nombre. */
  function preparar (...nombres) {
    const dir = fs.mkdtempSync(path.join(RAIZ, 'cola-'))
    const rutas = nombres.map(n => {
      const ruta = path.join(dir, `sesion-${n}.jsonl`)
      fs.writeFileSync(ruta, JSONL)
      return ruta
    })
    return { dir, rutas }
  }
  const nueva = (dir, url, obtenerModo) => new ColaDeInformes({ directorioDatos: dir, token: 'token-de-prueba', url, obtenerModo })

  test('P1: el interruptor se lee antes de CADA pendiente: si se apaga mientras sube el primero, el segundo sale sin texto', async () => {
    let modo = 'completo'
    const r = await iniciarReceptor({
      retardoMs: n => (n === 1 ? 200 : 0),
      alRecibir: n => { if (n === 1) modo = 'metricas' }, // el usuario lo apaga mientras el primero sube
    })
    try {
      const { dir, rutas } = preparar('a', 'b')
      const cola = nueva(dir, r.url, () => modo)
      cola.encolar(rutas[0], META(1))
      cola.encolar(rutas[1], META(2))
      await cola.enviarPendientes()

      assert.strictEqual(r.recibidos.length, 2)
      for (const p of PALABRAS) assert.ok(r.recibidos[0].cuerpo.includes(p), `el primero salió con el envío encendido: «${p}»`)
      for (const p of PALABRAS) assert.ok(!r.recibidos[1].cuerpo.includes(p), `el segundo no puede llevar «${p}»`)
      assert.match(r.recibidos[1].cuerpo, new RegExp(`"itLen":${TEXTO_IT.length}`), 'y sí sus números')
    } finally {
      await r.cerrar()
    }
  })

  test('S3: un pendiente que se encola durante una tanda no se pierde', async () => {
    const r = await iniciarReceptor({ retardoMs: n => (n === 1 ? 200 : 0) })
    try {
      const { dir, rutas } = preparar('a', 'b')
      const cola = nueva(dir, r.url, () => 'completo')
      cola.encolar(rutas[0], META(1))
      const tanda = cola.enviarPendientes()
      await hasta(() => r.recibidos.length === 1, 'que el primero llegue al receptor')
      cola.encolar(rutas[1], META(2)) // la reunión que acaba de parar, mientras el receptor retiene la respuesta
      await tanda

      assert.strictEqual(r.recibidos.length, 2, 'el que se encoló durante la tanda también sube')
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(cola.rutaCola, 'utf8')), [], 'y la cola queda vacía')
    } finally {
      await r.cerrar()
    }
  })

  test('S1: lo que vale es lo más restrictivo entre el modo al empezar la reunión y el modo al parar', () => {
    const { dir, rutas } = preparar('a')
    let ahora = 'completo'
    const cola = nueva(dir, null, () => ahora)
    cola.encolar(rutas[0], META(1), { modoAlEmpezar: 'metricas' }) // empezó apagado, acaba encendido
    ahora = 'metricas'
    cola.encolar(rutas[0], META(2), { modoAlEmpezar: 'completo' }) // empezó encendido, acaba apagado
    ahora = 'completo'
    cola.encolar(rutas[0], META(3), { modoAlEmpezar: 'completo' })
    cola.encolar(rutas[0], META(4)) // sin modo al empezar: cuenta el de ahora
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cola.rutaCola, 'utf8')).map(p => p.modoAlEncolar),
      ['metricas', 'metricas', 'completo', 'completo'])
  })

  test('S1: empezar con el envío apagado y encenderlo antes de parar sube solo números; empezar y acabar encendido, la cabecera entera', async () => {
    const h = await cargarMainApp()
    h.nuevoUserData()
    h.receptor.recibidos.length = 0
    const reunion = { perfil: { nombre: 'Valdemar Quintanilla' }, contexto: { nombre: 'Auditoría Zafiro' }, idioma: 'it' }

    await h.ipc('app:guardarClaves', { stt: 'clave-de-transcripcion-inventada', informes: 'metricas' })
    assert.strictEqual((await h.ipc('app:empezar', reunion)).ok, true)
    await h.ipc('app:guardarClaves', { informes: 'completo' }) // lo enciende antes de parar
    await h.ipc('app:parar')
    await hasta(() => h.receptor.recibidos.length === 1, 'la subida de la reunión que empezó apagada')
    const apagada = h.receptor.recibidos[0].cuerpo
    assert.ok(!apagada.includes('Valdemar') && !apagada.includes('Zafiro'), 'sin el perfil ni el contexto')
    assert.strictEqual(JSON.parse(apagada.split('\n')[0]).modoInforme, 'metricas')

    // El contraste: empezar y acabar encendido sube la cabecera entera. Sin esto la prueba no distingue nada.
    assert.strictEqual((await h.ipc('app:empezar', reunion)).ok, true)
    await h.ipc('app:parar')
    await hasta(() => h.receptor.recibidos.length === 2, 'la subida de la reunión que empezó encendida')
    assert.ok(h.receptor.recibidos[1].cuerpo.includes('Valdemar'), 'el contraste: encendido de principio a fin, sube completo')
    h.receptor.recibidos.length = 0
  })
})
