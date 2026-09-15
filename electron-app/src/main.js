/**
 * main.js — Proceso principal de la herramienta de diagnóstico.
 *
 * Esta app NO traduce ni graba nada: solo mide el equipo del cliente y escribe
 * un informe que él devuelve. Se le manda **antes** de construir el producto,
 * porque hay tres cosas que solo se pueden saber en su máquina: si el loopback
 * capta su videollamada, si existe Mezcla estéreo, y si Whisper aguanta con una
 * reunión en marcha.
 *
 * Dos invariantes de PLAN.md §0 que aplican ya aquí:
 *
 *  - **§0.1 `setContentProtection`.** Aunque esta app no muestre respuestas
 *    sugeridas, se pone desde el primer prototipo: es una línea, y la costumbre
 *    de ponerla es lo que evita olvidarla en la app de verdad, donde su ausencia
 *    significa que al compartir pantalla la sala entera lee lo que le soplamos
 *    al usuario.
 *  - **§0.2 nada escucha en `0.0.0.0`.** Aquí no se abre ningún puerto, y es
 *    deliberado: el diálogo del Firewall en el primer arranque es justo lo que
 *    haría que el cliente cancelara y se quedara con una app rota sin saber
 *    por qué.
 */

'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

let ventana = null

function crearVentana () {
  ventana = new BrowserWindow({
    width: 720,
    height: 760,
    backgroundColor: '#0B0F14',
    title: 'Diagnóstico — Traductor Italiano',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Invisible para cualquier capturador de pantalla. Ver §0.1.
  ventana.setContentProtection(true)

  // ── Captura de audio del sistema ────────────────────────────────────────
  // `audio: 'loopback'` es solo-Windows y es lo que permite captar el audio
  // sin pedirle nada al usuario.
  //
  // IMPORTANTE: se usa 'loopback' a secas y NO 'loopbackWithMute' ni
  // restrictOwnAudio. La comprobación consiste en que la app reproduzca un tono
  // y se oiga a sí misma; si se excluyera el audio del propio proceso, el test
  // fallaría precisamente cuando todo funciona bien. Es un error fácil de
  // cometer y muy difícil de diagnosticar después.
  ventana.webContents.session.setDisplayMediaRequestHandler((peticion, callback) => {
    callback({ video: peticion.frame, audio: 'loopback' })
  }, { useSystemPicker: false })

  ventana.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

/**
 * Modo automático (`DIAG_AUTO=1`): ejecuta el diagnóstico, escribe el informe
 * y sale, sin que nadie toque nada.
 *
 * No es andamiaje de pruebas: es la salida de emergencia si la interfaz falla
 * en el equipo del cliente. Se le dice que ejecute el .exe desde la terminal
 * con esa variable y sigue habiendo informe.
 */
async function modoAutomatico () {
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) { console.error('[diag] no hay ventana'); return app.exit(1) }
  try {
    await w.webContents.executeJavaScript('ejecutar()')
    const texto = await w.webContents.executeJavaScript('informe')
    const r = await guardarInforme(texto)
    console.log('\n' + texto)
    console.log(r.ok ? `[diag] informe guardado en ${r.ruta}` : `[diag] no se pudo guardar: ${r.motivo}`)
    app.exit(0)
  } catch (err) {
    console.error('[diag] falló:', err.message)
    app.exit(1)
  }
}

app.whenReady().then(() => {
  crearVentana()
  if (process.env.DIAG_AUTO === '1') {
    ventana.webContents.once('did-finish-load', () => setTimeout(modoAutomatico, 300))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana()
  })
})

app.on('window-all-closed', () => app.quit())

// ── IPC ───────────────────────────────────────────────────────────────────

/**
 * Corre lo que vive en el backend: perfil de hardware, transcripción y
 * traducción. El renderer se encarga solo del audio, porque `getDisplayMedia`
 * es una API suya.
 */
ipcMain.handle('diagnostico:backend', async () => {
  const raiz = path.join(__dirname, '..', '..')
  const backend = path.join(raiz, 'node-backend', 'src')

  const { perfilar } = require(path.join(backend, 'hardware'))
  const perfil = await perfilar()

  const salida = { perfil, transcripcion: null, traduccion: null, admision: null }

  const binario = path.join(raiz, 'bin', process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server')
  const modelo = path.join(raiz, 'models', 'ggml-small.bin')
  const wav = path.join(raiz, 'node-backend', 'test', 'fixtures', 'italiano.wav')

  const faltan = [binario, modelo, wav].filter(p => !fs.existsSync(p))
  if (faltan.length) {
    salida.motivoOmision = 'faltan componentes: ' + faltan.map(p => path.basename(p)).join(', ')
    return salida
  }

  const { Transcriber } = require(path.join(backend, 'transcriber'))
  const translator = require(path.join(backend, 'translator'))
  const admision = require(path.join(backend, 'admissionTest'))

  const tr = new Transcriber({ binario, modelo })
  try {
    await tr.start()
    await translator.cargar()
    salida.transcripcion = { ok: true, hilos: tr.hilos }
    salida.traduccion = { ok: true }
    salida.admision = await admision.ejecutar(
      { transcriber: tr, translator, wavItaliano: fs.readFileSync(wav), perfil },
      { rondas: 3 }
    )
  } catch (err) {
    salida.error = err.message
  } finally {
    tr.stop()
  }
  return salida
})

/** Guarda el informe donde el cliente lo pueda encontrar y devolver. */
async function guardarInforme (texto) {
  const nombre = `diagnostico-${new Date().toISOString().slice(0, 10)}.txt`
  const destino = path.join(app.getPath('desktop') || os.homedir(), nombre)
  try {
    fs.writeFileSync(destino, texto, 'utf8')
    return { ok: true, ruta: destino }
  } catch (err) {
    // El Controlled Folder Access de Defender puede bloquear el Escritorio.
    // Si pasa, se pregunta en vez de fallar en silencio.
    const r = await dialog.showSaveDialog(ventana, { defaultPath: nombre })
    if (r.canceled) return { ok: false, motivo: err.message }
    fs.writeFileSync(r.filePath, texto, 'utf8')
    return { ok: true, ruta: r.filePath }
  }
}

ipcMain.handle('diagnostico:guardar', (_e, texto) => guardarInforme(texto))

/**
 * El informe se construye en el proceso principal, no en el renderer: allí no
 * hay `require` con contextIsolation y por tanto no se podría probar. Este
 * texto es lo único que veremos de los equipos del cliente, así que tiene que
 * estar bajo prueba.
 */
ipcMain.handle('diagnostico:informe', (_e, datos) => {
  const reporte = require(path.join(__dirname, '..', '..', 'node-backend', 'src', 'reporte'))
  return {
    texto: reporte.construir(datos),
    bien: reporte.veredictoGlobal(datos),
  }
})

ipcMain.handle('diagnostico:abrirCarpeta', (_e, ruta) => shell.showItemInFolder(ruta))

ipcMain.handle('diagnostico:plataforma', () => ({
  plataforma: process.platform,
  electron: process.versions.electron,
  // El loopback es solo-Windows: en macOS el test de audio no concluye nada.
  loopbackSoportado: process.platform === 'win32',
}))
