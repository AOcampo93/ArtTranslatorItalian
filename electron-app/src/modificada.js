/**
 * modificada.js — lo ÚNICO que corre cuando `node-backend/src` o `shared` no son los del
 * paquete (F054, ronda 2; ver `integridad.js`).
 *
 * `mainApp.js` llama aquí en lugar de cargar el backend y deja de ejecutarse: no se registra
 * ningún otro canal, no se abre la base, no hay forma de empezar una reunión. Se abre una
 * ventana con la misma `app.html` y el mismo `preload`, y la pantalla de licencia dice
 * «Esta copia está modificada; descárgala de nuevo». Sin botón de reintentar: los archivos
 * no cambian por volver a mirarlos, hay que volver a descargar el paquete.
 *
 * Autocontenido: usa `licencia.js` solo para los textos, y recibe de Electron lo que necesita.
 */

'use strict'

const path = require('path')
const { vistaDe } = require('./licencia')

/**
 * @param {object} o
 * @param {object} o.app
 * @param {Function} o.BrowserWindow
 * @param {{ handle: Function }} o.ipcMain
 * @param {string} o.motivo   qué archivo falló: va al registro, no a la pantalla
 */
function abrirVentanaModificada ({ app, BrowserWindow, ipcMain, motivo }) {
  // Solo el nombre del archivo y la causa: nada del contenido.
  console.error('[integridad] el backend no es el del paquete:', motivo)

  // Los dos únicos canales que la interfaz usa para la licencia, con la misma respuesta siempre.
  const vista = vistaDe({ estado: 'modificada' })
  ipcMain.handle('app:licencia', () => vista)
  ipcMain.handle('app:licenciaReintentar', () => vista)

  app.whenReady().then(() => {
    const ventana = new BrowserWindow({
      width: 440,
      height: 640,
      backgroundColor: '#0B0F14',
      title: 'ArtTranslatorV2',
      webPreferences: {
        preload: path.join(__dirname, 'preloadApp.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    ventana.loadFile(path.join(__dirname, 'renderer', 'app.html'))
  })

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}

module.exports = { abrirVentanaModificada }
