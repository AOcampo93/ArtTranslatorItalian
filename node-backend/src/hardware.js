/**
 * hardware.js
 * Perfil de la máquina donde corre la app.
 *
 * Sirve para dos cosas distintas, y conviene no confundirlas:
 *
 *  - **Explicar.** Decirle al usuario "Intel Core i9, 32 GB" para que reconozca
 *    su equipo, y poder depurar a distancia con el informe que devuelve.
 *  - **NO predecir.** El nombre de la CPU no determina el rendimiento: no
 *    contiene el límite de potencia, el canal de memoria, la topología híbrida,
 *    el estado térmico ni —lo que más pesa— la carga competidora, que en este
 *    caso es siempre una videollamada. Para decidir se **mide** (ver F007).
 *
 * Tres trampas que este módulo evita:
 *
 *  - **`wmic` está deprecado** y ya no viene por defecto en builds recientes de
 *    Windows 11. Se usa PowerShell.
 *  - **Distinguir P-cores de E-cores no se puede** desde Node sin un addon
 *    nativo (`GetSystemCpuSetInformation`). Es justo el dato que más querríamos
 *    y no está: se declara como desconocido en vez de inventarlo.
 *  - **Ninguna consulta puede colgar la app.** PowerShell tarda 300-800 ms y
 *    puede estar restringido por política corporativa, así que todo lleva
 *    timeout y degrada en silencio.
 */

'use strict'

const os = require('os')
const { execFile } = require('child_process')

const ES_WINDOWS = process.platform === 'win32'
const ES_MAC = process.platform === 'darwin'

/** Ejecuta un comando con timeout. Nunca lanza: devuelve null si falla. */
function correr (cmd, args, ms = 2500) {
  return new Promise(resolve => {
    let hecho = false
    const fin = (v) => { if (!hecho) { hecho = true; resolve(v) } }
    try {
      const p = execFile(cmd, args, { timeout: ms, windowsHide: true },
        (err, stdout) => fin(err ? null : String(stdout).trim()))
      p.on('error', () => fin(null))
    } catch { fin(null) }
    setTimeout(() => fin(null), ms + 250)
  })
}

/** Núcleos físicos. Ojo: en CPU híbrida esto es P + E, no distingue. */
async function nucleosFisicos () {
  if (ES_MAC) {
    const s = await correr('sysctl', ['-n', 'hw.physicalcpu'])
    const n = parseInt(s, 10)
    return Number.isFinite(n) ? n : null
  }
  if (ES_WINDOWS) {
    // PowerShell y no wmic: wmic está deprecado y puede no existir.
    const s = await correr('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'], 4000)
    const n = parseInt(s, 10)
    return Number.isFinite(n) ? n : null
  }
  const s = await correr('nproc', ['--all'])
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * ¿Es una CPU de topología híbrida (P-cores + E-cores)?
 *
 * Se deduce del nombre porque no hay forma de leerlo: Intel desde la 12ª
 * generación y Apple Silicon la tienen. Importa para elegir hilos — usar todos
 * los núcleos en una híbrida rinde PEOR que usar solo los rápidos.
 */
function esHibrida (modelo) {
  // Se quitan los marcadores de marca antes de comparar: el string real de
  // Intel es "Intel(R) Core(TM) Ultra 7 155H" y un patrón ingenuo no casa.
  const limpio = (modelo || '').replace(/\((?:r|tm|c)\)/gi, ' ').replace(/\s+/g, ' ')
  return /\b1[2-9]th\b|core\s*ultra|apple\s+m\d/i.test(limpio)
}

/** GPU. Con NVIDIA, `nvidia-smi` es la mejor fuente y la única con VRAM fiable. */
async function gpu () {
  const nv = await correr('nvidia-smi',
    ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], 3000)
  if (nv) {
    const [nombre, vram, driver] = nv.split('\n')[0].split(',').map(x => x.trim())
    return { nombre, vram, driver, fuente: 'nvidia-smi' }
  }

  if (ES_WINDOWS) {
    // AdapterRAM es un uint32 y miente por encima de 4 GB, así que ni lo pedimos.
    const s = await correr('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name'], 4000)
    return s ? { nombre: s.split('\n')[0].trim(), vram: null, driver: null, fuente: 'Win32_VideoController' } : null
  }
  if (ES_MAC) {
    const s = await correr('sh', ['-c',
      "system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2; exit}'"], 5000)
    return s ? { nombre: s.trim(), vram: null, driver: null, fuente: 'system_profiler' } : null
  }
  return null
}

/**
 * ¿A batería o enchufado? En batería Windows baja el límite de frecuencia y el
 * mismo modelo puede tardar el doble, así que un veredicto medido enchufado no
 * vale a batería.
 */
async function energia () {
  if (ES_MAC) {
    const s = await correr('pmset', ['-g', 'batt'], 2000)
    if (!s) return { fuente: 'desconocida', aBateria: null }
    return { fuente: /AC Power/i.test(s) ? 'corriente' : 'batería', aBateria: !/AC Power/i.test(s) }
  }
  if (ES_WINDOWS) {
    // BatteryStatus 2 = conectado a corriente. Sin batería, no hay objeto.
    const s = await correr('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus'], 4000)
    if (s === null || s === '') return { fuente: 'corriente', aBateria: false }  // sobremesa
    const n = parseInt(s, 10)
    return { fuente: n === 2 ? 'corriente' : 'batería', aBateria: n !== 2 }
  }
  return { fuente: 'desconocida', aBateria: null }
}

/**
 * Perfila la máquina. No lanza nunca: lo que no se pueda leer viene como null.
 * @returns {Promise<object>} serializable a JSON
 */
async function perfilar () {
  const cpus = os.cpus()
  const modelo = cpus[0]?.model?.trim() || 'desconocido'
  const logicos = cpus.length

  const [fisicos, tarjeta, alimentacion] = await Promise.all([
    nucleosFisicos(), gpu(), energia(),
  ])

  const hibrida = esHibrida(modelo)

  return {
    generadoEn: new Date().toISOString(),
    so: {
      plataforma: process.platform,
      version: os.release(),
      arquitectura: process.arch,
    },
    cpu: {
      modelo,
      nucleosLogicos: logicos,
      nucleosFisicos: fisicos,
      hibrida,
      // Se declara explícitamente que no se puede saber, en vez de estimarlo.
      pCores: hibrida ? null : fisicos,
      notaPCores: hibrida
        ? 'topología híbrida: distinguir P de E requiere un addon nativo, no se puede leer desde Node'
        : null,
    },
    memoria: {
      totalGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
      // os.freemem() engaña en Windows: ignora la memoria en standby.
      libreGB: +(os.freemem() / 1024 ** 3).toFixed(1),
      notaLibre: 'os.freemem() infravalora la memoria realmente disponible en Windows',
    },
    gpu: tarjeta,
    energia: alimentacion,
    node: process.versions.node,
  }
}

/** Resumen de una línea, para enseñárselo al usuario. */
function resumir (p) {
  const partes = [
    p.cpu.modelo,
    `${p.cpu.nucleosFisicos || p.cpu.nucleosLogicos} núcleos`,
    `${p.memoria.totalGB} GB`,
  ]
  if (p.gpu?.nombre) partes.push(p.gpu.nombre)
  if (p.energia?.aBateria) partes.push('a batería')
  return partes.join(' · ')
}

module.exports = { perfilar, resumir }
module.exports._internos = { esHibrida, correr }
