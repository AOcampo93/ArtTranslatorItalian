/**
 * mainApp.js — proceso principal del traductor.
 *
 * Orquesta la cadena entera:
 *
 *   audio del sistema (renderer)  →  AssemblyAI  →  italiano
 *                                 →  Marian local →  español   → burbujas
 *                                 →  LLM          →  preguntas y respuestas
 *
 * Whisper local ya no viaja en esta versión. Con él se fueron el modelo de
 * 465 MB, el runtime de MSVC, las nueve DLL de microarquitectura, el número de
 * hilos y el veredicto de CPU que podía equivocarse.
 *
 * Tres no negociables de PLAN.md §0 que viven aquí:
 *
 *  - **§0.1 `setContentProtection(true)`.** Sin esto, al compartir pantalla en
 *    Teams la reunión entera lee las respuestas que le soplamos al usuario.
 *  - **§0.2 nada escucha en `0.0.0.0`.** Esta versión no abre ningún puerto
 *    local: la transcripción va por WebSocket saliente. Si algún día vuelve el
 *    modo local, ahí sí habrá que fijar `127.0.0.1` explícito.
 *  - **§0.3 autoguardado desde la primera frase.** Un cierre accidental en el
 *    minuto 58 no puede borrar la reunión.
 *
 * Y uno propio de este proveedor, que cuesta dinero si se olvida: **la sesión
 * de transcripción se cierra siempre**, también si la ventana se cierra o el
 * proceso muere. Una sesión huérfana factura 3 horas y ocupa una de las cinco
 * plazas de concurrencia, o sea que impide la SIGUIENTE reunión del cliente.
 */

'use strict'

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

const BACK = path.join(__dirname, '..', '..', 'node-backend', 'src')
const { AssemblyLiveTranscriber } = require(path.join(BACK, 'assemblyLive'))
const traductor = require(path.join(BACK, 'translator'))
const contexto = require(path.join(BACK, 'contexto'))
const db = require(path.join(BACK, 'db'))
const { Autosave } = require(path.join(BACK, 'autosave'))
const { MotorRespuestas, MotorResumen } = require(path.join(BACK, 'respuestas'))
const { crearLlamador } = require(path.join(BACK, 'llm'))

let ventana = null
let sesion = null          // { transcriptor, traductor, autosave, inicio, ... }

// ── Claves, cifradas con la protección del sistema ────────────────────
const RUTA_CLAVES = () => path.join(app.getPath('userData'), 'claves.dat')

/**
 * `safeStorage` ata el cifrado al usuario Y a la máquina (DPAPI en Windows).
 * Eso es lo que queremos: si el archivo se copia a otro equipo, no sirve. Por
 * eso el export de perfiles NUNCA incluye claves.
 */
function guardarClaves (claves) {
  const actual = leerClaves()
  const fusion = { ...actual, ...claves }
  for (const k of Object.keys(fusion)) if (!fusion[k]) delete fusion[k]

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('el sistema no ofrece cifrado para guardar las claves')
  }
  fs.writeFileSync(RUTA_CLAVES(), safeStorage.encryptString(JSON.stringify(fusion)), { mode: 0o600 })
  return Object.keys(fusion)
}

function leerClaves () {
  try {
    const bruto = fs.readFileSync(RUTA_CLAVES())
    return JSON.parse(safeStorage.decryptString(bruto))
  } catch { return {} }
}

// ── Ventana ───────────────────────────────────────────────────────────
function crearVentana () {
  ventana = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0B0F14',
    title: 'Traductor Italiano',
    webPreferences: {
      preload: path.join(__dirname, 'preloadApp.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // §0.1 — que la sala no vea las respuestas sugeridas al compartir pantalla.
  ventana.setContentProtection(true)

  // `audio: 'loopback'` entrega lo que SUENA en el equipo, no el micrófono.
  // Es solo-Windows y es lo que evita que el usuario configure nada.
  //
  // 'loopback' a secas y NO 'loopbackWithMute': con mute el usuario deja de
  // oír la reunión, que es exactamente lo contrario de lo que quiere.
  ventana.webContents.session.setDisplayMediaRequestHandler((peticion, callback) => {
    callback({ video: peticion.frame, audio: 'loopback' })
  }, { useSystemPicker: true })

  ventana.loadFile(path.join(__dirname, 'renderer', 'app.html'))

  // Cerrar la ventana tiene que cerrar la sesión de transcripción. Si no, se
  // queda facturando hasta 3 horas y bloquea la siguiente reunión.
  ventana.on('close', ev => {
    if (!sesion) return
    ev.preventDefault()
    pararSesion('ventana cerrada').finally(() => { ventana?.destroy() })
  })
  ventana.on('closed', () => { ventana = null })
}

const aRenderer = (canal, datos) => {
  if (ventana && !ventana.isDestroyed()) ventana.webContents.send(canal, datos)
}

// ── Preguntas, respuestas y contexto general ──────────────────────────
/**
 * Monta los dos motores que hablan con el LLM y los engancha a la interfaz.
 *
 * **Si no hay clave de LLM, la reunión sigue.** Las burbujas de traducción son
 * el producto; las respuestas sugeridas son el extra. Lo que no puede pasar es
 * que el panel se quede mudo sin decir por qué: se manda el motivo y ahí queda
 * escrito mientras dure la reunión.
 *
 * El proveedor sale del prefijo de la clave (ver `node-backend/src/llm.js`):
 * el usuario pega una sola clave en Ajustes y no elige nada más.
 */
function montarMotores ({ perfil, ctx, claveLlm }) {
  let llamar = null
  let motivo = 'Para ver aquí respuestas sugeridas, añade una clave en Ajustes.'

  if (claveLlm) {
    try {
      llamar = crearLlamador({ clave: claveLlm })
    } catch (err) {
      motivo = err.message
    }
  }
  if (!llamar) {
    aRenderer('app:avisoPreguntas', motivo)
    return { motor: null, resumen: null }
  }

  // El bloque se construye UNA vez y con el perfil y el contexto explícitos.
  // Sin pasarlos, `buildContextBlock()` leería el perfil ACTIVO de la base de
  // datos, y `crearPerfil` inserta con activo = 0: los prompts se quedarían sin
  // saber quién es el usuario justo en la parte donde más pesa.
  let bloque = ''
  try {
    bloque = contexto.buildContextBlock({ perfil, contexto: ctx }).bloque
  } catch (err) {
    console.error('[contexto] no se pudo construir el bloque:', err.message)
  }
  const bloqueContexto = () => bloque

  // Se limpia el aviso: si el usuario acaba de pegar la clave y ha vuelto a
  // empezar, el cartel de la reunión anterior ya no dice la verdad.
  aRenderer('app:avisoPreguntas', '')

  const motor = new MotorRespuestas({ llamar, bloqueContexto })
  motor.on('pregunta', p => aRenderer('app:pregunta', { id: p.id, it: p.it, es: p.es }))
  // La respuesta puede venir con `texto: null` y un error: se reenvía tal cual
  // para que la tarjeta lo diga en vez de quedarse en «Preparando…».
  motor.on('respuesta', r => aRenderer('app:respuesta', r))

  const resumen = new MotorResumen({ llamar, bloqueContexto })
  resumen.on('contexto', c => aRenderer('app:contexto', c.texto))

  return { motor, resumen }
}

// ── La reunión ────────────────────────────────────────────────────────
async function empezarSesion ({ perfil, contexto: ctx }) {
  if (sesion) return { ok: true, yaCorriendo: true }

  const claves = leerClaves()
  if (!claves.stt) {
    return { ok: false, motivo: 'Falta la clave de transcripción. Ponla en Ajustes.' }
  }

  // Se guardan para que el informe y los prompts los tengan.
  if (perfil?.nombre) contexto.crearPerfil(perfil)
  if (ctx?.nombre) contexto.crearContexto(ctx)

  const glosario = (ctx?.glosario || '').split(/[,\n·;]+/).map(s => s.trim()).filter(Boolean)

  const transcriptor = new AssemblyLiveTranscriber({
    apiKey: claves.stt,
    idioma: 'it',
    glosario,
    // El contexto va en italiano porque describe el audio que va a oír.
    contexto: [ctx?.tipo_proyecto && `Progetto: ${ctx.tipo_proyecto}.`,
               ctx?.contexto].filter(Boolean).join(' '),
  })

  // Marian se carga una vez y se queda en memoria. Tarda unos 500 ms la
  // primera vez, así que se hace ANTES de abrir la sesión de transcripción:
  // esa sí cuesta dinero mientras está abierta.
  await traductor.cargar()

  const idSesion = db.startSession('assemblyai/universal-3-5-pro')
  const autosave = new Autosave({
    directorio: path.join(app.getPath('userData'), 'reuniones'),
    idSesion: String(idSesion),
  })
  autosave.abrir()

  const { motor, resumen } = montarMotores({ perfil, ctx, claveLlm: claves.llm })
  sesion = { transcriptor, autosave, idSesion, motor, resumen, inicio: Date.now(), frases: 0 }

  transcriptor.on('parcial', p => aRenderer('app:parcial', p.texto))

  // `msTranscribir` lo sella el transcriptor: es la pierna de OÍR, y sin ella
  // el cronómetro arrancaba con el texto YA en la mano, o sea que medía sólo
  // la traducción. Las 21 frases de la primera prueba real salieron con `ms`
  // idéntico a `msTraducir` y `msTranscribir: null` [medido]: lo que el usuario
  // leía como «retardo» era media cadena, y por tanto SUBESTIMABA lo que
  // sentía, que es la dirección peligrosa de equivocarse.
  transcriptor.on('frase', async ({ texto, msTranscribir, forzado }) => {
    const t0 = Date.now()
    try {
      const tr = await traductor.traducir(texto)
      // Reloj de pared y no `tr.ms`: si una frase larga tiene ocupado a Marian,
      // la siguiente espera su turno, y esa espera la sufre el usuario aunque
      // el modelo no la cuente como suya.
      const msTraducir = Date.now() - t0
      const frase = {
        it: texto, es: tr.es,
        ms: msTranscribir + msTraducir,   // el retardo es la cadena, no una pierna
        msTranscribir, msTraducir,
        // `forzado` dice que el turno lo cortamos nosotros por largo, así que
        // esta frase puede estar partida. Queda en el archivo para poder
        // contar en la próxima reunión real cuántas se parten de verdad.
        forzado: Boolean(forzado),
      }
      sesion.frases++
      // §0.3 — al disco ANTES de pintar: si la app muere en el repintado, la
      // frase ya está a salvo.
      autosave.escribir(frase)
      aRenderer('app:frase', frase)

      // Y después de pintar, nunca antes: el triaje y el LLM no pueden
      // retrasar la burbuja, que es lo que el usuario está leyendo.
      // `considerar` no se espera a propósito —dentro decide si merece la
      // llamada y emite por su cuenta—, así que aquí solo se recoge el fallo.
      sesion.motor?.considerar(texto, tr.es)
        .catch(e => console.error('[preguntas]', e.message))
      sesion.resumen?.registrar(texto, tr.es)
    } catch (err) {
      aRenderer('app:estado', { clase: 'aviso', texto: `no se pudo traducir: ${err.message}` })
    }
  })

  transcriptor.on('estado', e => {
    const mapa = {
      conectando: ['aviso', 'Conectando'],
      escuchando: ['vivo', 'Escuchando'],
      reconectando: ['aviso', 'Reconectando'],
      'esperando-cupo': ['aviso', 'Esperando turno de conexión'],
      'sin-conexion': ['mal', 'Sin conexión'],
      parado: ['', 'Detenido'],
    }
    const [clase, texto] = mapa[e] || ['', e]
    aRenderer('app:estado', { clase, texto })
  })

  transcriptor.on('error', err =>
    aRenderer('app:estado', { clase: 'aviso', texto: err.message }))

  await transcriptor.start()
  return { ok: true }
}

async function pararSesion (motivo = 'el usuario paró') {
  if (!sesion) return { ok: true }
  const s = sesion
  sesion = null
  try {
    await s.transcriptor.stop()          // manda Terminate y espera el acuse
    s.autosave.cerrar()
    db.endSession(s.idSesion, {
      durationSeconds: Math.round((Date.now() - s.inicio) / 1000),
      lineCount: s.frases,
    })
    db.vaciar()
  } catch (err) {
    console.error('[sesión] al cerrar:', err.message)
  }
  return {
    ok: true, motivo,
    frases: s.frases,
    costeUsd: s.transcriptor.costeAproximadoUsd(0.45),
    stats: s.transcriptor.stats,
  }
}

// ── IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('app:empezar', (_e, datos) => empezarSesion(datos))
ipcMain.handle('app:parar', () => pararSesion())

/** El audio llega en bloques de 100 ms desde el renderer. */
ipcMain.on('app:audio', (_e, muestras) => {
  sesion?.transcriptor.alimentar(muestras)
})

/**
 * El botón «Otra» de una tarjeta de pregunta.
 *
 * Al pulsarlo el renderer ya ha puesto «Preparando…», así que **siempre tiene
 * que llegar algo de vuelta**. Cuando no hay motor —sin clave, o la reunión ya
 * terminó— se contesta por este mismo canal en vez de dejar la tarjeta colgada;
 * cuando sí lo hay, el propio motor emite la respuesta o el fallo.
 */
ipcMain.handle('app:otraRespuesta', (_e, id) => {
  if (!sesion?.motor) {
    aRenderer('app:respuesta', { id, texto: null, error: 'no hay reunión en marcha' })
    return { ok: false }
  }
  return { ok: sesion.motor.reintentar(id) }
})

ipcMain.handle('app:guardarClaves', (_e, claves) => {
  try { return { ok: true, guardadas: guardarClaves(claves) } }
  catch (err) { return { ok: false, motivo: err.message } }
})

/** Dice CUÁLES hay, nunca su valor. */
ipcMain.handle('app:estadoClaves', () => {
  const c = leerClaves()
  return { stt: !!c.stt, llm: !!c.llm, cifradoDisponible: safeStorage.isEncryptionAvailable() }
})

/**
 * La comprobación de la pantalla de preparación.
 *
 * Mide lo que decide si la app sirve en ESTE equipo, y nada más. No hay banco
 * de CPU ni veredicto de hardware: en la versión de nube el equipo sólo tiene
 * que capturar audio y tener red, así que un veredicto sobre su procesador
 * sería una cifra que no decide nada — y ya nos costó dos informes equivocados.
 *
 * El audio lo comprueba el renderer, que es donde vive esa API.
 */
ipcMain.handle('app:comprobar', async (_e, ctx) => {
  const r = {}

  // ── Protección de pantalla ──
  // `setContentProtection` necesita Windows 10 build 19041 o superior. En otros
  // sistemas se dice que no aplica, en vez de dar un falso verde.
  r.pantalla = process.platform === 'win32'
    ? { ok: true, valor: 'activa' }
    : { aviso: true, valor: 'solo Windows' }

  const claves = leerClaves()
  if (!claves.stt) {
    r.red = { mal: true, valor: 'falta la clave' }
    r.extremo = { mal: true, valor: 'falta la clave' }
    return r
  }

  // ── Red y cadena completa, con el audio de prueba ──
  // Se mide de punta a punta —oír, transcribir, traducir— porque es el número
  // que el usuario va a sentir. Medir una pieza sola no dice nada útil.
  try {
    const wav = fs.readFileSync(rutaFixture())
    const pcm = wav.subarray(44)
    const muestras = new Float32Array(pcm.length / 2)
    for (let i = 0; i < muestras.length; i++) muestras[i] = pcm.readInt16LE(i * 2) / 32768

    const glosario = (ctx?.glosario || '').split(/[,\n·;]+/).map(x => x.trim()).filter(Boolean)
    const t = new AssemblyLiveTranscriber({ apiKey: claves.stt, idioma: 'it', glosario })

    const tConexion = Date.now()
    await t.start()
    r.red = { ok: true, valor: `${Date.now() - tConexion} ms` }

    await traductor.cargar()

    // Las dos piernas salen de la misma fuente que en la reunión de verdad:
    // el transcriptor sella lo que costó oír y el traductor lo que costó
    // traducir. Antes se cronometraba aquí desde que se acababa de mandar el
    // audio, y si la frase llegaba antes de esa marca la comprobación acababa
    // diciendo «sin traducción» con la cadena funcionando.
    let italiano = null, msExtremo = null
    t.once('frase', async ({ texto, msTranscribir }) => {
      italiano = texto
      const tr = await traductor.traducir(texto)
      msExtremo = msTranscribir + tr.ms
    })

    const POR_BLOQUE = 1600
    for (let i = 0; i < muestras.length; i += POR_BLOQUE) {
      t.alimentar(muestras.subarray(i, i + POR_BLOQUE))
      await new Promise(x => setTimeout(x, 100))
    }

    for (let i = 0; i < 40 && msExtremo == null; i++) await new Promise(x => setTimeout(x, 100))
    await t.stop()

    r.extremo = msExtremo != null
      ? { ok: msExtremo < 2000, aviso: msExtremo >= 2000, valor: `${msExtremo} ms` }
      : { mal: true, valor: italiano ? 'sin traducción' : 'sin respuesta' }
    r.coste = { valor: `$${t.costeAproximadoUsd(0.45)}` }
  } catch (err) {
    r.red = r.red || { mal: true, valor: 'falló' }
    r.extremo = { mal: true, valor: err.message.slice(0, 60) }
  }
  return r
})

/** El audio de prueba, tanto en desarrollo como dentro del paquete. */
function rutaFixture () {
  const candidatos = [
    path.join(process.resourcesPath || '', 'node-backend', 'test', 'fixtures', 'italiano.wav'),
    path.join(__dirname, '..', '..', 'node-backend', 'test', 'fixtures', 'italiano.wav'),
  ]
  for (const c of candidatos) if (c && fs.existsSync(c)) return c
  throw new Error('no se encuentra el audio de prueba')
}

ipcMain.handle('app:listarPerfiles', () => contexto.listarPerfiles())
ipcMain.handle('app:guardarPerfil', (_e, p) => contexto.crearPerfil(p))
ipcMain.handle('app:listarContextos', () => contexto.listarContextos())
ipcMain.handle('app:guardarContexto', (_e, c) => contexto.crearContexto(c))

ipcMain.handle('app:exportarSesion', async () => {
  const r = await dialog.showSaveDialog(ventana, {
    title: 'Guardar la transcripción',
    defaultPath: `reunion-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Texto', extensions: ['txt'] }],
  })
  if (r.canceled || !r.filePath) return { ok: false }
  return { ok: true, ruta: r.filePath }
})

ipcMain.handle('app:abrirCarpeta', (_e, ruta) => shell.showItemInFolder(ruta))

// ── Arranque y cierre ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  await db.init()
  crearVentana()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana()
  })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// Última red: si el proceso se va por cualquier vía, la sesión se cierra.
// `assemblyLive` ya registra sus propias salidas, pero esto cubre el caso de
// que Electron termine sin pasar por ahí.
app.on('before-quit', ev => {
  if (!sesion) return
  ev.preventDefault()
  pararSesion('la aplicación se cerró').finally(() => app.exit(0))
})

module.exports = { _internos: { guardarClaves, leerClaves, empezarSesion, pararSesion } }
