#!/usr/bin/env node
'use strict'

/**
 * Administración de licencias (F053), contra el mismo almacén que usa el
 * servidor (`licencias.js`). En el VPS se corre con `./licencias.sh <comando>`,
 * que lo ejecuta dentro del contenedor por ssh; `claves` es la excepción y se
 * corre en local (ver abajo). Sin dependencias.
 *
 * Cada cambio va dentro del mismo candado que las activaciones: sin él, una
 * activación que cae entre la lectura y la escritura de esta herramienta
 * desharía en silencio un `revocar` o un `liberar`.
 */

const fs = require('fs')
const crypto = require('crypto')
const {
  PATRON_LICENCIA,
  MAXIMO_POR_DEFECTO,
  directorioLicencias,
  leerAlmacen,
  escribirAlmacen,
  conCandado,
  huellaClavePublica
} = require('./licencias')

const MAXIMO_ADMIN = 1000 // tope de cordura para `tope`: un 6000 por un descuido del dedo no es un tope
const LARGO_PREFIJO_MOSTRADO = 12
const LARGO_PREFIJO_MINIMO = 6

const USO = `Uso: licencias.sh <comando> [argumentos]

  crear <cliente> [maximo] [contacto]   crea una licencia (maximo, 6 por defecto) e imprime su id
  listar                                licencias, con sus equipos y el número de activaciones
  liberar <licencia> <prefijo-huella>   libera la plaza de un equipo (el prefijo lo da «listar»)
  revocar <licencia>                    la licencia deja de activar equipos
  tope <licencia> <n>                   cambia el máximo de equipos
  claves <archivo>                      genera el par Ed25519; se corre EN LOCAL, no en el VPS:
                                        node licencias-cli.js claves <archivo-fuera-del-repo>
`

/** Error esperado (uso incorrecto, licencia que no existe): se cuenta en una línea y sale con 1. */
class ErrorDeUso extends Error {}

/** Texto libre del administrador a una línea: sin caracteres de control (llegan a su terminal en `listar`) y con tope. */
function limpiaTexto (valor, maximo) {
  return String(valor === undefined ? '' : valor).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximo)
}

function enteroEnRango (valor, minimo, maximo, nombre) {
  const n = Number(valor)
  if (!/^\d+$/.test(String(valor)) || !Number.isInteger(n) || n < minimo || n > maximo) {
    throw new ErrorDeUso(`${nombre} tiene que ser un entero de ${minimo} a ${maximo}`)
  }
  return n
}

function exigeLicencia (valor) {
  if (!PATRON_LICENCIA.test(String(valor))) {
    throw new ErrorDeUso('la licencia son 32 caracteres hexadecimales en minúscula (la que imprime «crear» o muestra «listar»)')
  }
  return String(valor)
}

function licenciaOError (almacen, id) {
  if (!Object.hasOwn(almacen.licencias, id)) throw new ErrorDeUso(`no existe la licencia ${id}`)
  return almacen.licencias[id]
}

function crear (directorio, [cliente, maximo, contacto]) {
  const nombre = limpiaTexto(cliente, 100)
  if (!nombre) throw new ErrorDeUso('falta el nombre del cliente: crear <cliente> [maximo] [contacto]')
  const tope = maximo === undefined ? MAXIMO_POR_DEFECTO : enteroEnRango(maximo, 1, MAXIMO_ADMIN, 'maximo')
  const id = crypto.randomBytes(16).toString('hex') // 128 bits: no se adivina
  conCandado(directorio, () => {
    const almacen = leerAlmacen(directorio)
    almacen.licencias[id] = {
      cliente: nombre,
      maximo: tope,
      contacto: limpiaTexto(contacto, 300) || null, // si falta, la respuesta de tope usa LICENCIAS_CONTACTO
      creada: new Date().toISOString(),
      revocada: null,
      activacionesTotal: 0,
      equipos: [],
      activaciones: []
    }
    escribirAlmacen(directorio, almacen)
  })
  console.error(`Licencia creada para ${nombre}: hasta ${tope} equipos.`)
  console.log(id) // solo el id en stdout: `ID=$(licencias.sh crear "Cliente")`
}

function listar (directorio) {
  const almacen = leerAlmacen(directorio)
  const ids = Object.keys(almacen.licencias)
  if (ids.length === 0) {
    console.log('No hay licencias.')
    return
  }
  // Cuántas huellas ha acumulado cada equipo y la última: una cuenta que sube sin motivo es una computadora que se está pegando a otra.
  const resumen = (huellas) => `${huellas.length} (última ${huellas.length ? huellas[huellas.length - 1].slice(0, LARGO_PREFIJO_MOSTRADO) : '-'})`
  for (const id of ids) {
    const lic = almacen.licencias[id]
    const estado = lic.revocada ? `  REVOCADA ${lic.revocada}` : ''
    console.log(`${id}  ${JSON.stringify(lic.cliente)}  equipos ${lic.equipos.length}/${lic.maximo}  activaciones ${lic.activacionesTotal || 0}${estado}`)
    if (lic.contacto) console.log(`  contacto: ${JSON.stringify(lic.contacto)}`)
    for (const e of lic.equipos) {
      console.log(`  - ${e.nombre}  v${e.version}  primera ${e.primera}  última ${e.ultima}  máquinas ${resumen(e.maquinas)}  placas ${resumen(e.placas)}`)
    }
  }
}

function liberar (directorio, [licencia, prefijo]) {
  const id = exigeLicencia(licencia)
  const buscado = String(prefijo || '').toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${LARGO_PREFIJO_MINIMO},64}$`).test(buscado)) {
    throw new ErrorDeUso(`el prefijo son de ${LARGO_PREFIJO_MINIMO} a 64 caracteres hexadecimales de una huella (los que muestra «listar»)`)
  }
  const liberado = conCandado(directorio, () => {
    const almacen = leerAlmacen(directorio)
    const lic = licenciaOError(almacen, id)
    const coincidentes = lic.equipos.filter((e) => e.maquinas.concat(e.placas).some((huella) => huella.startsWith(buscado)))
    if (coincidentes.length === 0) throw new ErrorDeUso(`ningún equipo de esa licencia tiene una huella que empiece por ${buscado}`)
    if (coincidentes.length > 1) {
      throw new ErrorDeUso(`${buscado} coincide con ${coincidentes.length} equipos (${coincidentes.map((e) => e.nombre).join(', ')}): usa un prefijo más largo`)
    }
    lic.equipos = lic.equipos.filter((e) => e !== coincidentes[0])
    escribirAlmacen(directorio, almacen)
    return { nombre: coincidentes[0].nombre, usados: lic.equipos.length, maximo: lic.maximo }
  })
  console.log(`Plaza liberada: ${liberado.nombre}. Equipos ${liberado.usados}/${liberado.maximo}.`)
}

function revocar (directorio, [licencia]) {
  const id = exigeLicencia(licencia)
  const resultado = conCandado(directorio, () => {
    const almacen = leerAlmacen(directorio)
    const lic = licenciaOError(almacen, id)
    if (lic.revocada) return { cliente: lic.cliente, yaEstaba: true }
    lic.revocada = new Date().toISOString()
    escribirAlmacen(directorio, almacen)
    return { cliente: lic.cliente, yaEstaba: false }
  })
  console.log(resultado.yaEstaba
    ? `La licencia de ${resultado.cliente} ya estaba revocada.`
    : `Licencia de ${resultado.cliente} revocada: no activa equipos nuevos y los permisos ya emitidos caducan solos.`)
}

function tope (directorio, [licencia, n]) {
  const id = exigeLicencia(licencia)
  const maximo = enteroEnRango(n, 1, MAXIMO_ADMIN, 'n')
  const resultado = conCandado(directorio, () => {
    const almacen = leerAlmacen(directorio)
    const lic = licenciaOError(almacen, id)
    lic.maximo = maximo
    escribirAlmacen(directorio, almacen)
    return { cliente: lic.cliente, usados: lic.equipos.length }
  })
  console.log(`Tope de ${resultado.cliente}: ${maximo} equipos (usados ${resultado.usados}).`)
  if (maximo < resultado.usados) console.error(`Aviso: hay más equipos de los que caben; ninguno nuevo entra hasta liberar ${resultado.usados - maximo}.`)
}

/**
 * Par Ed25519 para firmar permisos. La privada se escribe en un archivo con
 * permisos 600 y NO se imprime; stdout lleva solo la pública, lista para
 * incrustar en la app. No pisa un archivo que ya exista: perder la privada que
 * firma los permisos deja a todos los equipos sin renovar. El archivo es
 * obligatorio: con un nombre por defecto, la privada caía en el directorio
 * actual, y si era `vps/` el despliegue la habría subido al servidor.
 */
function claves ([archivo]) {
  if (!archivo) throw new ErrorDeUso('claves necesita el archivo donde dejar la privada, fuera del repo: claves <archivo>')
  const destino = archivo
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  try {
    fs.writeFileSync(destino, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') throw new ErrorDeUso(`${destino} ya existe: no lo piso, sería perder la clave que firma los permisos`)
    throw error
  }
  fs.chmodSync(destino, 0o600) // el modo de creación pasa por el umask; esto lo deja exacto
  console.error(`Clave privada escrita en ${destino} (permisos 600). Huella de la pública: ${huellaClavePublica(privateKey)}`)
  process.stdout.write(publicKey.export({ type: 'spki', format: 'pem' }))
}

function ejecutar (argv) {
  const [comando, ...argumentos] = argv
  const directorio = directorioLicencias()
  try {
    switch (comando) {
      case 'crear': crear(directorio, argumentos); break
      case 'listar': listar(directorio); break
      case 'liberar': liberar(directorio, argumentos); break
      case 'revocar': revocar(directorio, argumentos); break
      case 'tope': tope(directorio, argumentos); break
      case 'claves': claves(argumentos); break
      default:
        console.error(USO)
        return 2
    }
    return 0
  } catch (error) {
    console.error(error instanceof ErrorDeUso ? `error: ${error.message}` : `error: ${error.code || error.message} (almacén ${directorio})`)
    return 1
  }
}

if (require.main === module) {
  // `exitCode` y no `process.exit()`: así stdout termina de vaciarse por una tubería (ssh) antes de salir.
  process.exitCode = ejecutar(process.argv.slice(2))
}
