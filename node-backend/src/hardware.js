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

/**
 * Ejecuta un comando con timeout y **dice por qué falló**.
 *
 * El motivo importa. Antes esto devolvía `null` igual si el comando no existía,
 * si expiró o si devolvió error, y eso dejó un informe imposible de interpretar:
 * en el HP Pavilion los núcleos físicos salieron `null` y no había forma de
 * saber si PowerShell no estaba, estaba restringido por política, o simplemente
 * no llegó a tiempo. Tres causas con tres arreglos distintos.
 *
 * @returns {Promise<{ok: boolean, salida: string|null, motivo: string}>}
 */
function ejecutar (cmd, args, ms = 2500) {
  return new Promise(resolve => {
    let hecho = false
    const fin = (r) => { if (!hecho) { hecho = true; resolve(r) } }
    try {
      const p = execFile(cmd, args, { timeout: ms, windowsHide: true }, (err, stdout) => {
        if (!err) return fin({ ok: true, salida: String(stdout).trim(), motivo: 'ok' })
        // `killed` con SIGTERM es lo que pone execFile al agotar su propio timeout.
        const motivo = err.code === 'ENOENT' ? 'no-existe'
          : (err.killed || err.signal) ? 'expiró'
          : 'falló'
        fin({ ok: false, salida: null, motivo })
      })
      p.on('error', e => fin({
        ok: false, salida: null, motivo: e.code === 'ENOENT' ? 'no-existe' : 'falló',
      }))
    } catch { fin({ ok: false, salida: null, motivo: 'falló' }) }
    // Red de seguridad por si execFile no llega a llamar al callback.
    setTimeout(() => fin({ ok: false, salida: null, motivo: 'expiró' }), ms + 250)
  })
}

/** La forma corta, para quien solo quiere la salida. */
async function correr (cmd, args, ms = 2500) {
  return (await ejecutar(cmd, args, ms)).salida
}

/**
 * Las tres consultas de Windows en UNA sola invocación de PowerShell.
 *
 * Antes eran tres, lanzadas a la vez con `Promise.all`, cada una con 4 s de
 * plazo: núcleos, GPU y energía. Arrancar PowerShell cuesta cientos de
 * milisegundos, y **tres arranques simultáneos en un portátil de 15 W compiten
 * entre ellos**, de modo que las tres pueden agotar su plazo a la vez. En el
 * informe del HP Pavilion los núcleos físicos salieron `null` en una ejecución
 * y 4 en otra del MISMO equipo. Un proceso en lugar de tres elimina esa
 * competencia.  [por medir: si era esta la causa, lo dirá el próximo informe]
 *
 * El plazo es holgado a propósito. Esto corre una vez, mientras el usuario
 * configura su perfil, y el coste de quedarse sin el dato es peor que esperar:
 * de los núcleos físicos dependía el número de hilos.
 *
 * Devuelve `baterias` como CUENTA, no como presencia. Es la diferencia entre
 * "este equipo no tiene batería, es de sobremesa" —que es una medida— y "la
 * consulta falló" —que no lo es—. Antes ambas daban el mismo resultado y la app
 * informaba "corriente" cuando en realidad no lo sabía.
 */
const PS_CONSULTA = [
  '$ErrorActionPreference=\'SilentlyContinue\';',
  '$p=Get-CimInstance Win32_Processor;',
  '$b=@(Get-CimInstance Win32_Battery);',
  '[pscustomobject]@{',
  'nucleos=($p|Measure-Object -Property NumberOfCores -Sum).Sum;',
  'logicos=($p|Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum;',
  'gpu=(Get-CimInstance Win32_VideoController|Select-Object -First 1).Name;',
  'baterias=$b.Count;',
  'estadoBateria=$(if($b.Count -gt 0){[int]$b[0].BatteryStatus}else{$null})',
  '}|ConvertTo-Json -Compress',
].join('')

async function consultarWindows () {
  const r = await ejecutar('powershell',
    ['-NoProfile', '-NonInteractive', '-Command', PS_CONSULTA], 9000)
  if (!r.ok || !r.salida) return { ok: false, motivo: r.motivo, datos: null }
  try {
    return { ok: true, motivo: 'ok', datos: JSON.parse(r.salida) }
  } catch {
    // PowerShell respondió algo que no era JSON: casi siempre un aviso de
    // política de ejecución. Se distingue de un timeout a propósito.
    return { ok: false, motivo: 'respuesta-ilegible', datos: null }
  }
}

/** Núcleos físicos. Ojo: en CPU híbrida esto es P + E, no distingue. */
async function nucleosFisicos (win) {
  if (ES_WINDOWS) {
    const n = parseInt(win?.datos?.nucleos, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  if (ES_MAC) {
    const s = await correr('sysctl', ['-n', 'hw.physicalcpu'])
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
async function gpu (win) {
  const nv = await correr('nvidia-smi',
    ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], 3000)
  if (nv) {
    const [nombre, vram, driver] = nv.split('\n')[0].split(',').map(x => x.trim())
    return { nombre, vram, driver, fuente: 'nvidia-smi' }
  }

  if (ES_WINDOWS) {
    // AdapterRAM es un uint32 y miente por encima de 4 GB, así que ni lo pedimos.
    // El nombre viene de la consulta única, no de un PowerShell propio.
    const n = win?.datos?.gpu
    return n ? { nombre: String(n).trim(), vram: null, driver: null, fuente: 'Win32_VideoController' } : null
  }
  if (ES_MAC) {
    const s = await correr('sh', ['-c',
      "system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2; exit}'"], 5000)
    return s ? { nombre: s.trim(), vram: null, driver: null, fuente: 'system_profiler' } : null
  }
  return null
}

/**
 * Interpreta la consulta de energía de Windows. Función pura y separada porque
 * es la decisión que estaba mal, y enterrada tras un `if (process.platform)` no
 * se podía probar desde macOS.
 *
 * El fallo que corrige: `null` significaba a la vez "este equipo no tiene
 * batería" y "la consulta no llegó", y la app respondía **"corriente"** en los
 * dos casos. En un portátil cuya consulta expira, eso es afirmar que está
 * enchufado sin saberlo — y a batería Windows recorta la frecuencia, así que
 * invalida en silencio cualquier veredicto de rendimiento.
 *
 * Ahora se cuentan las baterías: cero es una medida ("es de sobremesa"), y que
 * la consulta falle es otra cosa ("no lo sé").
 */
function interpretarEnergiaWindows (win) {
  if (!win?.ok) {
    return { fuente: 'desconocida', aBateria: null, motivo: win?.motivo || 'no-disponible' }
  }
  if (win.datos?.baterias === 0) {
    return { fuente: 'corriente', aBateria: false, nota: 'sin batería: sobremesa' }
  }
  // BatteryStatus 2 = conectado a corriente.
  const n = parseInt(win.datos?.estadoBateria, 10)
  if (!Number.isFinite(n)) {
    return { fuente: 'desconocida', aBateria: null, motivo: 'estado-ilegible' }
  }
  return { fuente: n === 2 ? 'corriente' : 'batería', aBateria: n !== 2 }
}

/**
 * ¿A batería o enchufado? En batería Windows baja el límite de frecuencia y el
 * mismo modelo puede tardar el doble, así que un veredicto medido enchufado no
 * vale a batería.
 */
async function energia (win) {
  if (ES_MAC) {
    const s = await correr('pmset', ['-g', 'batt'], 2000)
    if (!s) return { fuente: 'desconocida', aBateria: null }
    return { fuente: /AC Power/i.test(s) ? 'corriente' : 'batería', aBateria: !/AC Power/i.test(s) }
  }
  if (ES_WINDOWS) return interpretarEnergiaWindows(win)
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

  // En Windows, UNA consulta de PowerShell para los tres datos. nvidia-smi va
  // aparte porque no es PowerShell y es la única fuente fiable de VRAM.
  const win = ES_WINDOWS ? await consultarWindows() : null
  const [fisicos, tarjeta, alimentacion] = await Promise.all([
    nucleosFisicos(win), gpu(win), energia(win),
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
    // Qué no se pudo leer y por qué. Sin esto, un `null` en el informe es un
    // misterio: no se sabe si el comando no existe, si la política de la
    // empresa lo bloquea o si no llegó a tiempo, y cada causa se arregla
    // distinto.
    lecturas: {
      consultaWindows: win ? win.motivo : 'no-aplica',
      nucleosFisicos: fisicos === null ? (win?.motivo || 'no-disponible') : 'ok',
      energia: alimentacion.fuente === 'desconocida'
        ? (alimentacion.motivo || 'no-disponible') : 'ok',
    },
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
module.exports._internos = {
  esHibrida, correr, ejecutar, interpretarEnergiaWindows, PS_CONSULTA,
}
