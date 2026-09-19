'use strict'

/**
 * Receptor de informes de reuniones (F039a).
 *
 * Recibe por HTTPS (el TLS lo termina Traefik delante de este contenedor) el
 * `.jsonl` de cada reunión y lo escribe en disco. No hay listado ni descarga
 * por HTTP a propósito: los informes contienen texto de reuniones reales y
 * la única vía de lectura es `ssh` (ver `descargar.sh`), nunca una URL.
 *
 * Deliberadamente sin dependencias: es un servicio de una sola ruta, no un
 * framework — el espíritu del límite original de ~150 líneas, no la cifra
 * literal (la ronda 2 de revisión añadió el freno por IP real detrás de
 * proxy y el try/catch de la escritura, y con eso ya no cabe en 150). Todo
 * lo que necesita ya está en `http`, `fs`, `path` y `crypto`.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const TOPE_BYTES = 20 * 1024 * 1024 // 20 MiB — tope del contrato de subida
const MAX_SUBIDAS_MIN = 30 // subidas por IP y minuto
const VENTANA_MS = 60 * 1000
// X-Maquina, X-Version y X-Reunion se usan tal cual para construir un nombre
// de archivo: el alfabeto cerrado es lo que evita que una cabecera se
// convierta en una ruta. `..` se rechaza aparte, aunque el propio alfabeto ya
// deja fuera la barra que haría falta para que sirviera de algo.
const PATRON_CABECERA = /^[A-Za-z0-9._-]{1,64}$/
const CONTENT_TYPE_ESPERADO = 'application/x-ndjson'
const DIRECTORIO_POR_DEFECTO = '/datos/informes'

function pad2 (n) {
  return String(n).padStart(2, '0')
}

/** Puro: separa la fecha (para el directorio) de la hora (para el nombre). Usa UTC porque el contenedor no tiene por qué compartir zona horaria con quien lea el informe. */
function partesFecha (fecha = new Date()) {
  return {
    dia: `${fecha.getUTCFullYear()}-${pad2(fecha.getUTCMonth() + 1)}-${pad2(fecha.getUTCDate())}`,
    hora: `${pad2(fecha.getUTCHours())}${pad2(fecha.getUTCMinutes())}${pad2(fecha.getUTCSeconds())}`
  }
}

/** Puro: null si la cabecera no es segura para ir dentro de un nombre de archivo. */
function saneaCabecera (valor) {
  if (typeof valor !== 'string' || valor.length === 0) return null
  if (valor.includes('..')) return null
  return PATRON_CABECERA.test(valor) ? valor : null
}

/**
 * Comparación en tiempo constante que no depende de que `a` y `b` tengan la
 * misma longitud (si no, `timingSafeEqual` lanza). Se compara el HMAC de cada
 * valor con una clave fija de este proceso, así el resultado siempre tiene el
 * mismo tamaño y no hay atajo por longitud.
 */
const CLAVE_COMPARACION = crypto.randomBytes(32)
function comparaConstante (a, b) {
  const ha = crypto.createHmac('sha256', CLAVE_COMPARACION).update(String(a)).digest()
  const hb = crypto.createHmac('sha256', CLAVE_COMPARACION).update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/**
 * Puro: es `true` si el par TCP directo solo pudo llegar desde dentro de la
 * red interna de Docker (o `localhost`, en pruebas). `docker-compose.yml` no
 * publica `ports:`, así que en producción el único que conecta directo con
 * este contenedor es Traefik (u otro contenedor de la red `coolify`) — nunca
 * Internet. Solo en ese caso vale la pena mirar `X-Forwarded-For`: si el par
 * directo fuera una IP pública cualquiera, esa cabecera podría ser inventada
 * por quien sea, y confiar en ella convertiría el límite de tasa en
 * decorativo (motivo de rechazo de la ronda 1).
 */
function esIpConfiable (ip) {
  const limpia = String(ip).replace(/^::ffff:/, '')
  return (
    limpia === '127.0.0.1' ||
    limpia === '::1' ||
    /^10\./.test(limpia) ||
    /^192\.168\./.test(limpia) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(limpia)
  )
}

/**
 * Decide qué IP usar como clave del límite de subidas. Con el par directo
 * confiable (ver `esIpConfiable`), se usa el último tramo de
 * `X-Forwarded-For` — el que añade el proxy más cercano (Traefik), que es la
 * IP real del cliente — para que dos máquinas detrás del mismo proxy no
 * compartan cupo. Si no hay cabecera, o el par directo no es confiable, se
 * usa la IP del socket tal cual.
 */
function ipCliente (req) {
  const directa = req.socket.remoteAddress || 'desconocida'
  if (!esIpConfiable(directa)) return directa
  const cabecera = req.headers['x-forwarded-for']
  if (!cabecera) return directa
  const tramos = String(cabecera).split(',').map((s) => s.trim()).filter(Boolean)
  return tramos.length ? tramos[tramos.length - 1] : directa
}

/**
 * Puro: decide si `ip` puede subir ahora, mutando `mapa` (ip -> {n, inicio}).
 * Ventana fija de un minuto: se reinicia sola, sin temporizador aparte.
 */
function permiteSubida (mapa, ip, ahora = Date.now()) {
  const entrada = mapa.get(ip)
  if (!entrada || ahora - entrada.inicio >= VENTANA_MS) {
    mapa.set(ip, { n: 1, inicio: ahora })
    return true
  }
  entrada.n += 1
  return entrada.n <= MAX_SUBIDAS_MIN
}

function responde (res, status, cuerpo, tipo = 'application/json') {
  if (res.headersSent) return
  if (tipo === 'application/json') {
    const datos = JSON.stringify(cuerpo)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(datos) })
    res.end(datos)
  } else {
    res.writeHead(status, { 'Content-Type': tipo })
    res.end(String(cuerpo))
  }
}

function manejarSalud (req, res) {
  if (req.method !== 'GET') return responde(res, 405, { error: 'metodo_no_permitido' })
  responde(res, 200, 'ok', 'text/plain; charset=utf-8')
}

function manejarInforme (req, res, { token, directorioBase, contadores }) {
  if (req.method !== 'POST') return responde(res, 405, { error: 'metodo_no_permitido' })

  const autorizacion = String(req.headers.authorization || '')
  const [esquema, credencial] = autorizacion.split(' ')
  if (esquema !== 'Bearer' || !credencial || !comparaConstante(credencial, token)) {
    return responde(res, 401, { error: 'token_invalido' })
  }

  // El límite de tasa se cobra DESPUÉS de autenticar, no antes: si se cobrara
  // antes, cualquiera en Internet mandando peticiones con un token inválido
  // agotaría el cupo de la máquina legítima sin necesidad de saber el token
  // (motivo de rechazo de la ronda 1, reproducido con 30 intentos fallidos
  // seguidos de una subida legítima que recibía 429).
  const ip = ipCliente(req)
  if (!permiteSubida(contadores, ip)) {
    return responde(res, 429, { error: 'demasiadas_subidas' })
  }

  const tipo = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (tipo !== CONTENT_TYPE_ESPERADO) {
    return responde(res, 415, { error: 'content_type_invalido' })
  }

  const maquina = saneaCabecera(req.headers['x-maquina'])
  const version = saneaCabecera(req.headers['x-version'])
  const reunion = saneaCabecera(req.headers['x-reunion'])
  if (!maquina || !version || !reunion) {
    return responde(res, 400, { error: 'cabecera_invalida' })
  }

  // El tamaño se decide por `Content-Length` si el cliente lo manda, y si no
  // (o miente) por el total real que va llegando. En los dos casos se corta
  // con 413 **al terminar de leer**, nunca a mitad de conexión: cerrar el
  // socket de golpe mientras el cliente todavía está escribiendo el cuerpo
  // dispara ECONNRESET/EPIPE en su lado, que es ruido indistinguible de un
  // fallo real. Lo que promete el contrato — «nunca los >20 MB enteros en
  // memoria» — se cumple igual: en cuanto se excede, se deja de empujar a
  // `trozos` y se sigue drenando el socket sin guardar nada más.
  const longitudDeclarada = Number(req.headers['content-length'])
  let excedido = Number.isFinite(longitudDeclarada) && longitudDeclarada > TOPE_BYTES

  const trozos = []
  let total = 0

  req.on('data', (trozo) => {
    total += trozo.length
    if (excedido || total > TOPE_BYTES) {
      excedido = true
      return
    }
    trozos.push(trozo)
  })

  req.on('error', () => {
    // El cliente cortó a medias (red caída en el equipo del usuario). No hay
    // nada que guardar ni que responder: el socket ya no está.
  })

  req.on('end', () => {
    if (excedido) {
      return responde(res, 413, { error: 'cuerpo_demasiado_grande' })
    }
    const cuerpo = Buffer.concat(trozos)
    const ahora = new Date()
    const { dia, hora } = partesFecha(ahora)
    const dirDia = path.join(directorioBase, dia)
    const nombre = `${maquina}-${hora}-${version}-${reunion}.jsonl`
    const destino = path.join(dirDia, nombre)

    // Sin try/catch, un EACCES/ENOSPC/EDQUOT real (p. ej. el bind mount del
    // VPS con el dueño equivocado) salía como excepción no capturada y tiraba
    // el proceso entero — con `restart: unless-stopped` eso es un bucle de
    // caídas invisible, no un 500 (motivo de rechazo de la ronda 1,
    // reproducido con el directorio base sin permiso de escritura).
    try {
      fs.mkdirSync(dirDia, { recursive: true })
      const temporal = path.join(dirDia, `.tmp-${crypto.randomUUID()}`)
      fs.writeFileSync(temporal, cuerpo)
      fs.renameSync(temporal, destino) // atómico: nunca hay un .jsonl a medio escribir con su nombre final
    } catch (error) {
      // El código del error sí va al log (para depurar); la ruta completa y
      // el mensaje de Node no van en la respuesta, que se queda genérica.
      console.error(`${ahora.toISOString()} fallo_escritura codigo=${error.code || 'desconocido'}`)
      return responde(res, 500, { error: 'fallo_al_guardar' })
    }

    // Procedencia [verificado]: nunca el cuerpo ni el token, solo lo que hace falta para auditar cuánto sube cada máquina.
    console.log(`${ahora.toISOString()} ip=${ip} maquina=${maquina} version=${version} bytes=${cuerpo.length}`)

    responde(res, 201, { id: nombre })
  })
}

/**
 * Fábrica: no arranca a escuchar por sí sola (lo hace quien la llama, con el
 * puerto que le toque — efímero en tests, `PUERTO` en producción). Cada
 * servidor tiene su propio mapa de límite de subidas: dos servidores de test
 * en el mismo proceso no se contaminan entre sí.
 */
function crearServidor ({ token, directorioBase = DIRECTORIO_POR_DEFECTO } = {}) {
  if (!token) {
    throw new Error('INFORMES_TOKEN vacío: el receptor se niega a arrancar sin él')
  }

  if (token === 'cámbiame' || token.length < 16) {
    // El token de `.env.ejemplo` es literalmente "cámbiame"; si alguien
    // despliega antes de editarlo, mejor negarse a arrancar que exponer un
    // receptor con un token adivinable a la primera. 16 es un mínimo bajo
    // a propósito (no valida "buena" aleatoriedad, solo descarta lo trivial).
    throw new Error('INFORMES_TOKEN parece de ejemplo o demasiado corto: pon uno largo y aleatorio')
  }

  const contadores = new Map()
  const limpieza = setInterval(() => {
    const ahora = Date.now()
    for (const [ip, entrada] of contadores) {
      if (ahora - entrada.inicio >= VENTANA_MS) contadores.delete(ip)
    }
  }, VENTANA_MS * 5)
  limpieza.unref() // no debe mantener vivo el proceso, ni colgar `node --test`

  const servidor = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch {
      return responde(res, 400, { error: 'url_invalida' })
    }

    if (url.pathname === '/salud') return manejarSalud(req, res)
    if (url.pathname === '/informes') return manejarInforme(req, res, { token, directorioBase, contadores })
    return responde(res, 404, { error: 'no_encontrado' })
  })

  servidor.on('close', () => clearInterval(limpieza))
  return servidor
}

if (require.main === module) {
  const token = process.env.INFORMES_TOKEN
  if (!token) {
    console.error('INFORMES_TOKEN no está definido: el receptor no arranca sin él.')
    process.exit(1)
  }
  const puerto = Number(process.env.PUERTO) || 3000
  const servidor = crearServidor({ token })
  servidor.listen(puerto, '0.0.0.0', () => {
    console.log(`Receptor de informes escuchando en 0.0.0.0:${puerto}`)
  })
}

module.exports = {
  crearServidor,
  _internos: {
    saneaCabecera,
    comparaConstante,
    partesFecha,
    permiteSubida,
    esIpConfiable,
    ipCliente,
    TOPE_BYTES,
    MAX_SUBIDAS_MIN,
    VENTANA_MS,
    PATRON_CABECERA,
    CONTENT_TYPE_ESPERADO
  }
}
