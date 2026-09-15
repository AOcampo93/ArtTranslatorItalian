/**
 * preload.js — Puente entre el renderer y el proceso principal.
 * Superficie mínima a propósito: esta app solo mide.
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('diag', {
  plataforma:    ()       => ipcRenderer.invoke('diagnostico:plataforma'),
  backend:       ()       => ipcRenderer.invoke('diagnostico:backend'),
  informe:       (datos)  => ipcRenderer.invoke('diagnostico:informe', datos),
  guardar:       (texto)  => ipcRenderer.invoke('diagnostico:guardar', texto),
  abrirCarpeta:  (ruta)   => ipcRenderer.invoke('diagnostico:abrirCarpeta', ruta),
})
