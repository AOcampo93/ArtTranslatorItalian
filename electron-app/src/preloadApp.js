/**
 * preloadApp.js — Puente entre la interfaz y el proceso principal.
 *
 * Superficie mínima y explícita. No se expone `ipcRenderer` entero ni nada que
 * permita al renderer pedir rutas arbitrarias: si alguna vez entra contenido
 * ajeno en esa ventana —y en esta app entra texto que viene de una reunión y
 * de un LLM—, lo único que puede tocar es esta lista.
 *
 * **Las claves viajan en un solo sentido.** Se pueden guardar desde aquí, pero
 * no hay forma de leerlas: van cifradas con `safeStorage` y el renderer nunca
 * las ve. Así, ni un fallo de la interfaz ni un texto malicioso pueden
 * sacárselas al usuario.
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/** Envuelve un canal de eventos para que el renderer no vea el objeto de IPC. */
const escuchar = (canal, fn) => {
  ipcRenderer.on(canal, (_evento, datos) => fn(datos))
}

contextBridge.exposeInMainWorld('app', {
  // ── Ciclo de la reunión ───────────────────────────────────────────
  empezar: datos => ipcRenderer.invoke('app:empezar', datos),
  parar: () => ipcRenderer.invoke('app:parar'),

  /**
   * Bloques de audio de 100 ms, 16 kHz mono. Va por `send` y no por `invoke`
   * porque son diez por segundo durante toda la reunión y no necesitan
   * respuesta: esperar un acuse en cada bloque añadiría retardo sin ganar nada.
   */
  audio: muestras => ipcRenderer.send('app:audio', muestras),

  /** Comprueba audio, red y protección de pantalla. Devuelve un paso por clave. */
  comprobar: contexto => ipcRenderer.invoke('app:comprobar', contexto),

  /** Pide otra redacción para una pregunta ya detectada. */
  otraRespuesta: id => ipcRenderer.invoke('app:otraRespuesta', id),

  /**
   * Convierte una burbuja en pregunta (F033): el botón «→ Pregunta» salta el
   * detector porque el usuario ya decidió que esa frase lo era.
   */
  preguntar: (it, es) => ipcRenderer.invoke('app:preguntar', { it, es }),

  // ── Perfiles y contextos ──────────────────────────────────────────
  listarPerfiles: () => ipcRenderer.invoke('app:listarPerfiles'),
  guardarPerfil: p => ipcRenderer.invoke('app:guardarPerfil', p),
  listarContextos: () => ipcRenderer.invoke('app:listarContextos'),
  guardarContexto: c => ipcRenderer.invoke('app:guardarContexto', c),

  // ── Claves: entran, no salen ──────────────────────────────────────
  guardarClaves: claves => ipcRenderer.invoke('app:guardarClaves', claves),
  /** Sólo dice CUÁLES hay, nunca su valor. */
  estadoClaves: () => ipcRenderer.invoke('app:estadoClaves'),

  // ── Al cerrar la reunión ──────────────────────────────────────────
  exportarSesion: formato => ipcRenderer.invoke('app:exportarSesion', formato),

  // ── Eventos que llegan del proceso principal ──────────────────────
  alParcial: fn => escuchar('app:parcial', fn),
  alFrase: fn => escuchar('app:frase', fn),
  /**
   * La burbuja provisional que acaba de dejar de serlo, o que ha crecido
   * (F037). Llega con el `idProvisional` de la burbuja a la que sustituye: la
   * traducción entera es nueva, así que la interfaz reemplaza, no pega.
   */
  alReemplazo: fn => escuchar('app:frase:reemplazo', fn),
  alPregunta: fn => escuchar('app:pregunta', fn),
  alRespuesta: fn => escuchar('app:respuesta', fn),
  /** Por qué el panel de preguntas no va a dar respuestas (p. ej. falta la clave). */
  alAvisoPreguntas: fn => escuchar('app:avisoPreguntas', fn),
  alContexto: fn => escuchar('app:contexto', fn),
  alEstado: fn => escuchar('app:estado', fn),
})
