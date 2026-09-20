'use strict'

/**
 * Receptor de informes de reuniones (F039a) + vista privada y despliegue
 * bajo `https://arturoocampo.com/informes` (F039c).
 *
 * Recibe por HTTPS (el TLS lo termina Traefik delante de este contenedor) el
 * `.jsonl` de cada reunión y lo escribe en disco. Coolify sirve esta app bajo
 * una ruta de un dominio compartido; según cómo quede el router de Traefik,
 * la petición puede llegar con el prefijo `/informes` intacto o ya quitado
 * — `quitaPrefijo` normaliza los dos casos a la misma ruta interna, así que
 * el resto del código no distingue uno de otro (criterio F039c: "POST con y
 * sin prefijo llega al mismo manejador").
 *
 * F039c añade una vista privada de solo lectura (listar y descargar por HTTP
 * Basic) porque revisar los informes por `ssh`/`rsync` a mano no escala con
 * el volumen de reuniones. Sigue sin haber framework ni dependencias: es más
 * ruta que antes, pero la misma lógica simple (auth, saneado de ruta, límite
 * de tasa) que ya tenía la subida. Todo lo que necesita ya está en `http`,
 * `fs`, `path` y `crypto`.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const TOPE_BYTES = 20 * 1024 * 1024 // 20 MiB — tope del contrato de subida
const MAX_SUBIDAS_MIN = 30 // subidas por IP y minuto
const MAX_FALLOS_AUTH_MIN = 10 // fallos de HTTP Basic por IP y minuto, antes de 429 (vista privada)
const VENTANA_MS = 60 * 1000
const PREFIJO = '/informes'
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
 * Puro: quita el prefijo `/informes` de la ruta si está, dejando siempre una
 * ruta que empieza por `/`. Existe porque Coolify sirve esta app bajo una
 * ruta de un dominio compartido y, según quede montado el router de Traefik,
 * la petición puede llegar como `/informes/...` o ya sin ese trozo — el
 * resto del código solo conoce la ruta normalizada, nunca cuál de las dos
 * formas usó quien llamó.
 */
function quitaPrefijo (pathname) {
  if (pathname === PREFIJO) return '/'
  if (pathname.startsWith(PREFIJO + '/')) return pathname.slice(PREFIJO.length)
  return pathname
}

/**
 * Comparación en tiempo constante que no depende de que `a` y `b` tengan la
 * misma longitud (si no, `timingSafeEqual` lanza). Se compara el HMAC de cada
 * valor con una clave fija de este proceso, así el resultado siempre tiene el
 * mismo tamaño y no hay atajo por longitud. La usan tanto el token de subida
 * como el usuario/clave de la vista privada.
 */
const CLAVE_COMPARACION = crypto.randomBytes(32)
function comparaConstante (a, b) {
  const ha = crypto.createHmac('sha256', CLAVE_COMPARACION).update(String(a)).digest()
  const hb = crypto.createHmac('sha256', CLAVE_COMPARACION).update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/**
 * Puro: separa las credenciales de una cabecera `Authorization: Basic ...`.
 * `null` si falta, no es `Basic` o el base64 no trae un `:`.
 */
function credencialesBasic (cabecera) {
  const valor = String(cabecera || '')
  if (!valor.startsWith('Basic ')) return null
  let decodificado
  try {
    decodificado = Buffer.from(valor.slice(6), 'base64').toString('utf8')
  } catch {
    return null
  }
  const separador = decodificado.indexOf(':')
  if (separador === -1) return null
  return { usuario: decodificado.slice(0, separador), clave: decodificado.slice(separador + 1) }
}

/** Puro: bytes legibles para la vista ("1.2 MB"), sin depender de ninguna librería. */
function formateaTamano (bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Puro: escapa texto para insertarlo en HTML — defensivo, aunque los nombres ya pasaron `saneaCabecera` al subir. */
function escapaHtml (valor) {
  return String(valor).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
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

/**
 * Puro: cuántos fallos de HTTP Basic lleva `ip` en la ventana actual (0 si no
 * hay ninguno o la ventana ya caducó). Se consulta ANTES de comprobar las
 * credenciales, así una IP ya bloqueada recibe 429 sin que la petición
 * llegue a decidir si el usuario/clave son correctos.
 */
function fallosAuthRecientes (mapa, ip, ahora = Date.now()) {
  const entrada = mapa.get(ip)
  if (!entrada || ahora - entrada.inicio >= VENTANA_MS) return 0
  return entrada.n
}

/** Muta `mapa`: registra un fallo de HTTP Basic de `ip`. Solo se llama cuando la autenticación falla; un éxito no cuenta. */
function registraFalloAuth (mapa, ip, ahora = Date.now()) {
  const entrada = mapa.get(ip)
  if (!entrada || ahora - entrada.inicio >= VENTANA_MS) {
    mapa.set(ip, { n: 1, inicio: ahora })
  } else {
    entrada.n += 1
  }
}

/**
 * Lee `directorioBase` y arma la estructura de la vista: una entrada por
 * fecha (más reciente primero), con sus archivos `.jsonl` (nombre, tamaño,
 * hora de escritura). Nunca lanza: un directorio que no existe o no se
 * puede leer da lista vacía, no un 500 — la vista tiene que sobrevivir a un
 * `/datos/informes` recién creado y todavía sin nada dentro.
 */
function listaInformes (directorioBase) {
  let fechas = []
  try {
    fechas = fs.readdirSync(directorioBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse()
  } catch {
    fechas = []
  }
  return fechas.map((fecha) => {
    const dirDia = path.join(directorioBase, fecha)
    let archivos = []
    try {
      archivos = fs.readdirSync(dirDia)
        .filter((nombre) => nombre.endsWith('.jsonl'))
        .map((nombre) => {
          const info = fs.statSync(path.join(dirDia, nombre))
          return { nombre, bytes: info.size, hora: info.mtime.toISOString().slice(11, 19) }
        })
        .sort((a, b) => a.nombre.localeCompare(b.nombre))
    } catch {
      archivos = []
    }
    return { fecha, archivos }
  })
}

/**
 * Puro: la ruta absoluta de un informe si `fecha`/`archivo` son seguros, o
 * `null` si no. Tres capas, ninguna de sobra: la fecha tiene que tener forma
 * de fecha, el nombre de archivo no puede llevar separador de ruta ni `..`
 * (así una `X-Maquina` o `X-Reunion` con esos caracteres —ya imposibles al
 * subir por `saneaCabecera`— tampoco colarían aquí si algún día cambia esa
 * regla), y por último se resuelve la ruta final y se comprueba que sigue
 * dentro de `directorioBase` — la red que no depende de haber acertado las
 * dos anteriores.
 */
function rutaSegura (directorioBase, fecha, archivo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null
  if (!archivo.endsWith('.jsonl')) return null
  if (archivo.includes('..') || archivo.includes('/') || archivo.includes('\\')) return null
  const base = path.resolve(directorioBase)
  const destino = path.resolve(base, fecha, archivo)
  if (!destino.startsWith(base + path.sep)) return null
  return destino
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
 * Comprueba HTTP Basic contra `usuarioVista`/`claveVista` y aplica el freno
 * de fallos. Responde ella misma (429 o 401 con `WWW-Authenticate`) y
 * devuelve `false` cuando no deja pasar; el llamador solo sigue si devuelve
 * `true`. `Cache-Control: no-store` va en las dos vías, autorizada o no:
 * nada de lo que sirve la vista debe quedar en una caché intermedia.
 */
function autorizaVista (req, res, { usuarioVista, claveVista, contadoresFallosAuth }) {
  res.setHeader('Cache-Control', 'no-store')
  const ip = ipCliente(req)

  if (fallosAuthRecientes(contadoresFallosAuth, ip) >= MAX_FALLOS_AUTH_MIN) {
    responde(res, 429, { error: 'demasiados_intentos' })
    return false
  }

  const credenciales = credencialesBasic(req.headers.authorization)
  // Las dos comparaciones se hacen siempre, aunque la primera ya haya
  // fallado: con `&&` de cortocircuito, un usuario correcto y una clave
  // incorrecta tardarían un HMAC más que un usuario ya incorrecto, una
  // diferencia de tiempo diminuta pero evitable sin coste.
  const usuarioOk = credenciales ? comparaConstante(credenciales.usuario, usuarioVista) : false
  const claveOk = credenciales ? comparaConstante(credenciales.clave, claveVista) : false
  if (!usuarioOk || !claveOk) {
    registraFalloAuth(contadoresFallosAuth, ip)
    res.setHeader('WWW-Authenticate', 'Basic realm="Informes ArtTranslator"')
    responde(res, 401, { error: 'credenciales_invalidas' })
    return false
  }
  return true
}

/** Página HTML sencilla en castellano: una fecha por bloque, con sus archivos y enlace de descarga. */
function paginaListado (grupos) {
  const bloques = grupos.length === 0
    ? '<p>Todavía no hay informes.</p>'
    : grupos.map(({ fecha, archivos }) => {
      const filas = archivos.length === 0
        ? '<li>(sin archivos)</li>'
        : archivos.map((a) => {
          const href = `${PREFIJO}/${encodeURIComponent(fecha)}/${encodeURIComponent(a.nombre)}`
          return `<li><a href="${href}">${escapaHtml(a.nombre)}</a> — ${formateaTamano(a.bytes)} — ${a.hora}</li>`
        }).join('\n')
      return `<h2>${escapaHtml(fecha)}</h2>\n<ul>\n${filas}\n</ul>`
    }).join('\n')

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>Informes de reuniones</title></head>
<body>
<h1>Informes de reuniones</h1>
${bloques}
</body>
</html>`
}

function manejarVistaListado (req, res, ctx) {
  if (!autorizaVista(req, res, ctx)) return
  responde(res, 200, paginaListado(listaInformes(ctx.directorioBase)), 'text/html; charset=utf-8')
}

function manejarDescarga (req, res, ctx) {
  if (!autorizaVista(req, res, ctx)) return

  let fecha, archivo
  try {
    fecha = decodeURIComponent(ctx.fecha)
    archivo = decodeURIComponent(ctx.archivo)
  } catch {
    return responde(res, 400, { error: 'ruta_invalida' })
  }

  const destino = rutaSegura(ctx.directorioBase, fecha, archivo)
  if (!destino) return responde(res, 400, { error: 'ruta_invalida' })

  fs.stat(destino, (error, info) => {
    if (error || !info.isFile()) return responde(res, 404, { error: 'no_encontrado' })
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${archivo.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store'
    })
    fs.createReadStream(destino).pipe(res)
  })
}

/**
 * Fábrica: no arranca a escuchar por sí sola (lo hace quien la llama, con el
 * puerto que le toque — efímero en tests, `PUERTO` en producción). Cada
 * servidor tiene su propio mapa de límite de subidas: dos servidores de test
 * en el mismo proceso no se contaminan entre sí.
 */
function crearServidor ({ token, directorioBase = DIRECTORIO_POR_DEFECTO, usuarioVista = '', claveVista = '' } = {}) {
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

  // Sin INFORMES_USUARIO o INFORMES_CLAVE (o los dos), la vista privada no
  // existe: ni una ruta de más responde con ella, para que "no configurada"
  // y "no encontrada" sean indistinguibles desde fuera (criterio F039c).
  const vistaActiva = Boolean(usuarioVista) && Boolean(claveVista)

  const contadores = new Map()
  const contadoresFallosAuth = new Map()
  const limpieza = setInterval(() => {
    const ahora = Date.now()
    for (const mapa of [contadores, contadoresFallosAuth]) {
      for (const [ip, entrada] of mapa) {
        if (ahora - entrada.inicio >= VENTANA_MS) mapa.delete(ip)
      }
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

    // Normalizado una sola vez: de aquí para abajo nadie mira si la
    // petición traía `/informes` delante o no.
    const ruta = quitaPrefijo(url.pathname)
    const ctxVista = { directorioBase, usuarioVista, claveVista, contadoresFallosAuth }

    if (ruta === '/salud') return manejarSalud(req, res)

    if (ruta === '/') {
      if (req.method === 'POST') return manejarInforme(req, res, { token, directorioBase, contadores })
      if (req.method === 'GET') {
        if (!vistaActiva) return responde(res, 404, { error: 'no_encontrado' })
        return manejarVistaListado(req, res, ctxVista)
      }
      return responde(res, 405, { error: 'metodo_no_permitido' })
    }

    const partes = ruta.split('/').filter(Boolean)
    if (partes.length === 2) {
      if (!vistaActiva) return responde(res, 404, { error: 'no_encontrado' })
      if (req.method !== 'GET') return responde(res, 405, { error: 'metodo_no_permitido' })
      return manejarDescarga(req, res, { ...ctxVista, fecha: partes[0], archivo: partes[1] })
    }

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
  const servidor = crearServidor({
    token,
    usuarioVista: process.env.INFORMES_USUARIO || '',
    claveVista: process.env.INFORMES_CLAVE || ''
  })
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
