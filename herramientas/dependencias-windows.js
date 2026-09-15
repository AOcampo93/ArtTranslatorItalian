/**
 * dependencias-windows.js
 * Lee la tabla de importaciones de los binarios de Windows y dice qué DLL
 * faltan en la carpeta.
 *
 * Existe por un fallo concreto y ya pagado: el paquete se envió a la máquina
 * virtual, la lista de verificación salió toda en verde, y `whisper-server.exe`
 * murió con `0xC0000135` (STATUS_DLL_NOT_FOUND). La comprobación de entonces
 * miraba que `vc_redist.x64.exe` estuviera **incluido** en el paquete — pero
 * incluir un instalador no instala nada. Nadie lo ejecutó, y no había forma de
 * notarlo sin un Windows limpio delante.
 *
 * Esto no supone nada: abre el PE, recorre el directorio de importación y
 * compara contra los archivos que hay al lado. Si algo falta, se sabe en
 * macOS, antes de enviar.
 *
 * Lo que NO comprueba: que la DLL presente sea de la arquitectura correcta o
 * exporte los símbolos que se le piden. Para eso haría falta resolver cada
 * import por nombre, y no se ha necesitado todavía.
 */

'use strict'

const fs = require('fs')
const path = require('path')

/**
 * DLL que Windows siempre resuelve por su cuenta desde el sistema.
 *
 * `api-ms-win-*` y `ext-ms-win-*` son los *API sets*: no son archivos reales,
 * sino nombres que el cargador redirige a la DLL que toque en esa versión de
 * Windows. Buscarlos en la carpeta daría un falso negativo garantizado.
 */
const DEL_SISTEMA = [
  /^api-ms-win-/i, /^ext-ms-win-/i,
  /^(kernel32|kernelbase|user32|advapi32|gdi32|shell32|shlwapi|ole32|oleaut32)\.dll$/i,
  /^(ws2_32|mswsock|iphlpapi|dnsapi|winmm|version|psapi|ntdll|rpcrt4)\.dll$/i,
  /^(crypt32|bcrypt|ncrypt|secur32|userenv|setupapi|cfgmgr32|powrprof)\.dll$/i,
  /^(dbghelp|normaliz|imm32|comdlg32|comctl32|uxtheme|dwmapi|winhttp)\.dll$/i,
]

const esDelSistema = n => DEL_SISTEMA.some(re => re.test(n))

/** Traduce una RVA a desplazamiento dentro del archivo, vía tabla de secciones. */
function aDesplazamiento (secciones, rva) {
  for (const s of secciones) {
    if (rva >= s.va && rva < s.va + Math.max(s.tamVirtual, s.tamCrudo)) {
      return s.crudo + (rva - s.va)
    }
  }
  return null
}

/**
 * Devuelve los nombres de DLL que importa un PE.
 * @param {string} archivo
 * @returns {string[]}
 */
function importaciones (archivo) {
  const d = fs.readFileSync(archivo)
  if (d.length < 0x40 || d.readUInt16LE(0) !== 0x5A4D) {
    throw new Error(`${path.basename(archivo)} no es un ejecutable de Windows`)
  }
  const pe = d.readUInt32LE(0x3C)
  if (d.toString('latin1', pe, pe + 4) !== 'PE\0\0') {
    throw new Error(`${path.basename(archivo)}: cabecera PE inválida`)
  }

  const nSecciones = d.readUInt16LE(pe + 6)
  const tamOpcional = d.readUInt16LE(pe + 20)
  const esPE32Plus = d.readUInt16LE(pe + 24) === 0x20B

  // El directorio de datos empieza tras la cabecera opcional; la entrada 1 es
  // la tabla de importación. PE32+ mete 16 bytes más antes de llegar ahí.
  const dirDatos = pe + 24 + (esPE32Plus ? 112 : 96)
  const rvaImport = d.readUInt32LE(dirDatos + 8)
  if (!rvaImport) return []

  const secciones = []
  const baseSecciones = pe + 24 + tamOpcional
  for (let i = 0; i < nSecciones; i++) {
    const o = baseSecciones + i * 40
    secciones.push({
      tamVirtual: d.readUInt32LE(o + 8),
      va: d.readUInt32LE(o + 12),
      tamCrudo: d.readUInt32LE(o + 16),
      crudo: d.readUInt32LE(o + 20),
    })
  }

  const nombres = []
  let o = aDesplazamiento(secciones, rvaImport)
  if (o === null) return []
  // Cada descriptor son 20 bytes; el array termina en uno todo a ceros.
  for (; o + 20 <= d.length; o += 20) {
    let vacio = true
    for (let i = 0; i < 20; i++) if (d[o + i] !== 0) { vacio = false; break }
    if (vacio) break

    const on = aDesplazamiento(secciones, d.readUInt32LE(o + 12))
    if (on === null || on >= d.length) continue
    let fin = on
    while (fin < d.length && d[fin] !== 0) fin++
    nombres.push(d.toString('latin1', on, fin))
  }
  return nombres
}

/**
 * Revisa una carpeta entera y devuelve qué falta.
 *
 * @param {string} carpeta
 * @returns {{ archivos: Array, faltan: string[], completo: boolean }}
 */
function revisarCarpeta (carpeta) {
  const entradas = fs.readdirSync(carpeta)
  // Windows no distingue mayúsculas en nombres de DLL; macOS a veces tampoco,
  // pero Linux sí. Se normaliza para que el resultado sea el mismo en los tres.
  const presentes = new Set(entradas.map(n => n.toLowerCase()))

  const binarios = entradas
    .filter(n => /\.(exe|dll)$/i.test(n))
    .sort()

  const archivos = []
  const faltan = new Set()

  for (const n of binarios) {
    const deps = importaciones(path.join(carpeta, n))
      .filter(x => !esDelSistema(x))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

    const ausentes = deps.filter(x => !presentes.has(x.toLowerCase()))
    ausentes.forEach(x => faltan.add(x))
    archivos.push({ nombre: n, dependencias: deps, ausentes })
  }

  return { archivos, faltan: [...faltan].sort(), completo: faltan.size === 0 }
}

/** Informe legible, para el script de verificación. */
function informe (carpeta) {
  const r = revisarCarpeta(carpeta)
  const lineas = [`Dependencias de ${carpeta}`, '']
  for (const a of r.archivos) {
    if (!a.dependencias.length) continue
    lineas.push(`  ${a.nombre}`)
    for (const d of a.dependencias) {
      const falta = a.ausentes.includes(d)
      lineas.push(`     ${falta ? '✗' : '✓'} ${d}`)
    }
  }
  lineas.push('')
  lineas.push(r.completo
    ? '  Cerrado: no falta ninguna DLL.'
    : `  FALTAN ${r.faltan.length}: ${r.faltan.join(', ')}`)
  return { texto: lineas.join('\n'), ...r }
}

module.exports = { importaciones, revisarCarpeta, informe, esDelSistema }

if (require.main === module) {
  const carpeta = process.argv[2]
  if (!carpeta) {
    console.error('uso: node herramientas/dependencias-windows.js <carpeta>')
    process.exit(2)
  }
  const r = informe(carpeta)
  console.log(r.texto)
  process.exit(r.completo ? 0 : 1)
}
