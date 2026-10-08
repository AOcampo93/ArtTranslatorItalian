#!/usr/bin/env node
/**
 * manifiesto-backend.js — escribe `electron-app/src/manifiesto-backend.json` con el SHA-256 de cada
 * archivo de `node-backend/src` y de `shared` (F054, ronda 2; ver `electron-app/src/integridad.js`).
 *
 * El paquete de Windows lleva esas dos carpetas FUERA de `app.asar`, en texto plano; el manifiesto va
 * DENTRO, y la app lo compara al arrancar antes de cargar nada de ellas. Por eso este guion se corre
 * en la construcción (F055), DESPUÉS de tocar cualquier archivo de esas carpetas y ANTES de
 * `electron-builder`: un manifiesto viejo bloquearía a todos los clientes con «Esta copia está
 * modificada». El archivo generado NO se versiona (`.gitignore`); este guion sí.
 *
 * Uso:
 *   node herramientas/manifiesto-backend.js [--raiz <carpeta>] [--salida <archivo>]
 *
 * `--raiz` es la carpeta que contiene `node-backend/` y `shared/` (por defecto, la del repositorio).
 * Las pruebas lo usan sobre un paquete de mentira y pasan siempre las dos opciones; sin `--salida`
 * se escribe en `electron-app/src/` del repositorio.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { calcularManifiesto } = require('../electron-app/src/integridad')

const argumento = (nombre, porDefecto) => {
  const i = process.argv.indexOf(nombre)
  if (i === -1) return porDefecto
  if (!process.argv[i + 1]) throw new Error(`${nombre} necesita un valor`)
  return path.resolve(process.argv[i + 1])
}

try {
  const raiz = argumento('--raiz', path.join(__dirname, '..'))
  const salida = argumento('--salida', path.join(__dirname, '..', 'electron-app', 'src', 'manifiesto-backend.json'))
  const manifiesto = calcularManifiesto(raiz)
  const raros = Object.entries(manifiesto.archivos).filter(([, hash]) => hash === null).map(([ruta]) => ruta)
  if (raros.length) throw new Error(`no son archivos normales (enlaces, etc.): ${raros.join(', ')}`)
  fs.writeFileSync(salida, `${JSON.stringify(manifiesto, null, 2)}\n`)
  console.log(`Manifiesto escrito en ${salida}: ${Object.keys(manifiesto.archivos).length} archivos.`)
} catch (error) {
  console.error(`error: ${error.message}`)
  process.exitCode = 1
}
