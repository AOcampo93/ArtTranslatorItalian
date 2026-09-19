/**
 * Pruebas del receptor de informes (F039a).
 *
 * Todo corre en local: puerto efímero (`listen(0)`) y un directorio temporal
 * por prueba, sin tocar `/datos/informes` ni la red. Cada bloque prueba un
 * criterio del contrato con una llamada HTTP real (nivel 2 — es una interfaz
 * real, no un mock) más, cuando el criterio nace de una función pura, una
 * prueba unitaria directa sobre `_internos` (nivel 1).
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { crearServidor, _internos } = require('../servidor')
const { saneaCabecera, permiteSubida, esIpConfiable, ipCliente, partesFecha, TOPE_BYTES, MAX_SUBIDAS_MIN } = _internos

const TOKEN = 'token-de-prueba-no-es-un-secreto-real'

function cabecerasValidas (extra = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/x-ndjson',
    'X-Maquina': 'pc-arturo',
    'X-Version': '0.5.0',
    'X-Reunion': '20260919-1200-abcd',
    ...extra
  }
}

/** Arranca un servidor real en un puerto efímero, con un directorio temporal como base. */
function arrancar (opciones = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'informes-test-'))
  const servidor = crearServidor({ token: TOKEN, directorioBase: dir, ...opciones })
  return new Promise((resolve, reject) => {
    servidor.on('error', reject)
    servidor.listen(0, '127.0.0.1', () => {
      resolve({ servidor, dir, puerto: servidor.address().port })
    })
  })
}

function cerrar (servidor) {
  return new Promise((resolve) => servidor.close(resolve))
}

/**
 * Una petición HTTP real contra el servidor de prueba. Content-Length se
 * calcula solo, salvo que la prueba lo pise a propósito.
 *
 * Cuando el servidor corta con 413 antes (o en medio) de recibir un cuerpo
 * de más de 20 MB, cierra la conexión mientras el cliente todavía puede
 * estar escribiendo los últimos MB del cuerpo — eso es un `EPIPE`/`ECONNRESET`
 * normal en el socket, no un fallo de la petición: la respuesta ya llegó. Por
 * eso el `error` del request solo cuenta si todavía no se resolvió la
 * promesa con una respuesta.
 */
function peticion ({ puerto, metodo = 'POST', ruta = '/informes', cabeceras = {}, cuerpo = Buffer.alloc(0) }) {
  const buf = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo)
  const cabecerasFinal = { 'Content-Length': String(buf.length), ...cabeceras }
  return new Promise((resolve, reject) => {
    let asentado = false
    const req = http.request(
      { hostname: '127.0.0.1', port: puerto, path: ruta, method: metodo, headers: cabecerasFinal },
      (res) => {
        const trozos = []
        res.on('data', (t) => trozos.push(t))
        res.on('end', () => {
          asentado = true
          resolve({ status: res.statusCode, cuerpo: Buffer.concat(trozos).toString('utf8') })
        })
      }
    )
    req.on('error', (err) => { if (!asentado) reject(err) })
    req.end(buf)
  })
}

// ---------------------------------------------------------------------------
// Nivel 1: funciones puras de `_internos`
// ---------------------------------------------------------------------------

describe('saneaCabecera (puro)', () => {
  test('acepta el alfabeto cerrado [A-Za-z0-9._-]', () => {
    assert.strictEqual(saneaCabecera('pc-arturo_01.v2'), 'pc-arturo_01.v2')
  })

  test('rechaza barra, traversal, vacío y no-string — camino de error', () => {
    // Mutación que esto caza: quitar la comprobación de `..` o el patrón del
    // alfabeto en `saneaCabecera` hace que '../x' pase como válido, y esta
    // prueba (y la de integración de más abajo) caen.
    assert.strictEqual(saneaCabecera('../x'), null)
    assert.strictEqual(saneaCabecera('..'), null)
    assert.strictEqual(saneaCabecera('a/b'), null)
    assert.strictEqual(saneaCabecera(''), null)
    assert.strictEqual(saneaCabecera(undefined), null)
    assert.strictEqual(saneaCabecera('a'.repeat(65)), null) // máx 64
  })
})

describe('partesFecha (puro)', () => {
  test('separa día (para el directorio) y HHMMSS (para el nombre) en UTC', () => {
    const { dia, hora } = partesFecha(new Date('2026-09-19T08:05:07Z'))
    assert.strictEqual(dia, '2026-09-19')
    assert.strictEqual(hora, '080507')
  })
})

describe('permiteSubida (puro)', () => {
  test('deja pasar la 30ª subida y corta la 31ª — las dos orillas, no solo una', () => {
    // Ronda 1: esta prueba solo afirmaba `resultados[30] === false` y una
    // mutación (`n <= MAX_SUBIDAS_MIN` -> `n < MAX_SUBIDAS_MIN`, que adelanta
    // el corte a la 30ª) dejaba 18/18 verdes. Ahora se afirman las dos orillas.
    const mapa = new Map()
    const ahora = Date.now()
    const resultados = []
    for (let i = 0; i < 31; i++) {
      resultados.push(permiteSubida(mapa, '1.2.3.4', ahora + i)) // dentro de la misma ventana de 60 s
    }
    assert.strictEqual(resultados[29], true) // la 30ª — la orilla que faltaba
    assert.strictEqual(resultados[30], false) // la 31ª
    // Mutación que esto caza: cambiar `n <= MAX_SUBIDAS_MIN` por `n < MAX_SUBIDAS_MIN`
    // hace que `resultados[29]` sea `false` (corta un turno antes de tiempo);
    // olvidar incrementar `n` deja pasar la 31ª (`resultados[30]` sería `true`).
  })

  test('una IP distinta no gasta el cupo de otra', () => {
    const mapa = new Map()
    const ahora = Date.now()
    for (let i = 0; i < 30; i++) permiteSubida(mapa, '1.2.3.4', ahora)
    assert.strictEqual(permiteSubida(mapa, '5.6.7.8', ahora), true)
  })

  test('la ventana se reinicia sola pasado el minuto', () => {
    const mapa = new Map()
    const t0 = Date.now()
    for (let i = 0; i < 30; i++) permiteSubida(mapa, '1.2.3.4', t0)
    assert.strictEqual(permiteSubida(mapa, '1.2.3.4', t0 + 61_000), true)
  })
})

describe('esIpConfiable / ipCliente (puro)', () => {
  test('confía en loopback y en los rangos privados que usa Docker', () => {
    assert.strictEqual(esIpConfiable('127.0.0.1'), true)
    assert.strictEqual(esIpConfiable('::1'), true)
    assert.strictEqual(esIpConfiable('::ffff:172.20.0.5'), true)
    assert.strictEqual(esIpConfiable('172.20.0.5'), true)
    assert.strictEqual(esIpConfiable('10.0.0.5'), true)
    assert.strictEqual(esIpConfiable('192.168.1.5'), true)
  })

  test('no confía en una IP pública cualquiera', () => {
    assert.strictEqual(esIpConfiable('8.8.8.8'), false)
    assert.strictEqual(esIpConfiable('200.1.2.3'), false)
  })

  test('ipCliente usa el último tramo de X-Forwarded-For solo si el par directo es confiable', () => {
    const confiable = { socket: { remoteAddress: '172.20.0.2' }, headers: { 'x-forwarded-for': '9.9.9.1, 172.20.0.1' } }
    assert.strictEqual(ipCliente(confiable), '172.20.0.1')

    const noConfiable = { socket: { remoteAddress: '8.8.8.8' }, headers: { 'x-forwarded-for': '9.9.9.1' } }
    assert.strictEqual(ipCliente(noConfiable), '8.8.8.8') // no se fía de la cabecera: podría inventarla cualquiera

    const sinCabecera = { socket: { remoteAddress: '172.20.0.2' }, headers: {} }
    assert.strictEqual(ipCliente(sinCabecera), '172.20.0.2')
  })
})

test('crearServidor se niega a arrancar sin INFORMES_TOKEN', () => {
  assert.throws(() => crearServidor({ directorioBase: '/tmp/no-se-usa' }), /INFORMES_TOKEN/)
})

test('crearServidor se niega a arrancar con el token de ejemplo o uno demasiado corto', () => {
  assert.throws(() => crearServidor({ token: 'cámbiame', directorioBase: '/tmp/no-se-usa' }), /ejemplo|corto/)
  assert.throws(() => crearServidor({ token: 'corto', directorioBase: '/tmp/no-se-usa' }), /ejemplo|corto/)
})

// ---------------------------------------------------------------------------
// Nivel 2: la interfaz real, por HTTP
// ---------------------------------------------------------------------------

test('201: guarda el .jsonl con nombre AAAA-MM-DD/maquina-HHMMSS-version-reunion.jsonl', async () => {
  const { servidor, dir, puerto } = await arrancar()
  try {
    const cuerpo = Buffer.from('{"frase":"ciao"}\n{"frase":"come stai"}\n')
    const resp = await peticion({ puerto, cabeceras: cabecerasValidas(), cuerpo })
    assert.strictEqual(resp.status, 201)
    const { id } = JSON.parse(resp.cuerpo)
    assert.match(id, /^pc-arturo-\d{6}-0\.5\.0-20260919-1200-abcd\.jsonl$/)

    const dias = fs.readdirSync(dir)
    assert.strictEqual(dias.length, 1)
    assert.match(dias[0], /^\d{4}-\d{2}-\d{2}$/)
    const archivo = path.join(dir, dias[0], id)
    assert.ok(fs.existsSync(archivo), `esperaba encontrar ${archivo}`)
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), cuerpo.toString('utf8'))
  } finally {
    await cerrar(servidor)
  }
})

test('401: sin token y con token incorrecto', async () => {
  const { servidor, puerto } = await arrancar()
  try {
    const { Authorization, ...sinAuth } = cabecerasValidas()
    const sinToken = await peticion({ puerto, cabeceras: sinAuth, cuerpo: Buffer.from('{}') })
    assert.strictEqual(sinToken.status, 401)

    const tokenMalo = await peticion({ puerto, cabeceras: cabecerasValidas({ Authorization: 'Bearer lo-que-sea' }), cuerpo: Buffer.from('{}') })
    assert.strictEqual(tokenMalo.status, 401)
  } finally {
    await cerrar(servidor)
  }
})

test('413: un cuerpo de 20 MB + 1 se rechaza sin llegar a guardarse', async () => {
  const { servidor, dir, puerto } = await arrancar()
  try {
    const grande = Buffer.alloc(TOPE_BYTES + 1, 97) // 'a' repetido — el contenido no importa, el tamaño sí
    const resp = await peticion({ puerto, cabeceras: cabecerasValidas(), cuerpo: grande })
    assert.strictEqual(resp.status, 413)
    assert.deepStrictEqual(fs.readdirSync(dir), []) // nada se escribió: no hay ni el directorio del día
  } finally {
    await cerrar(servidor)
  }
})

test('el tope exacto (20 MB) sí se acepta — el corte es en tope+1, no en tope', async () => {
  const { servidor, puerto } = await arrancar()
  try {
    const exacto = Buffer.alloc(TOPE_BYTES, 98)
    const resp = await peticion({ puerto, cabeceras: cabecerasValidas({ 'X-Reunion': 'tope-exacto' }), cuerpo: exacto })
    assert.strictEqual(resp.status, 201)
  } finally {
    await cerrar(servidor)
  }
})

test('415: content-type distinto de application/x-ndjson', async () => {
  const { servidor, puerto } = await arrancar()
  try {
    const resp = await peticion({ puerto, cabeceras: cabecerasValidas({ 'Content-Type': 'application/json' }), cuerpo: Buffer.from('{}') })
    assert.strictEqual(resp.status, 415)
  } finally {
    await cerrar(servidor)
  }
})

test('400: X-Maquina con intento de traversal se rechaza (no llega a tocar disco fuera de sitio)', async () => {
  const { servidor, dir, puerto } = await arrancar()
  try {
    const resp = await peticion({ puerto, cabeceras: cabecerasValidas({ 'X-Maquina': '../x' }), cuerpo: Buffer.from('{}') })
    assert.strictEqual(resp.status, 400)
    assert.deepStrictEqual(fs.readdirSync(dir), [])
    // Comprueba también que no se escapó del directorio base.
    assert.ok(!fs.existsSync(path.join(dir, '..', 'x')))
  } finally {
    await cerrar(servidor)
  }
})

test('405: GET /informes no está permitido', async () => {
  const { servidor, puerto } = await arrancar()
  try {
    const resp = await peticion({ puerto, metodo: 'GET', ruta: '/informes' })
    assert.strictEqual(resp.status, 405)
  } finally {
    await cerrar(servidor)
  }
})

test('404: una ruta que cuelga de /informes no existe como recurso', async () => {
  const { servidor, puerto } = await arrancar()
  try {
    const resp = await peticion({ puerto, metodo: 'GET', ruta: '/informes/lo-que-sea' })
    assert.strictEqual(resp.status, 404)
  } finally {
    await cerrar(servidor)
  }
})

test('429: la subida 30 se acepta y la 31, en el mismo minuto y la misma IP, se corta', async () => {
  // Ronda 1: solo se afirmaba la 31ª. Con eso, adelantar el corte a la 30ª
  // (mutación `n <= MAX_SUBIDAS_MIN` -> `n < MAX_SUBIDAS_MIN`) dejaba 18/18
  // verdes igual. Ahora se afirman las dos orillas también a nivel HTTP.
  const { servidor, puerto } = await arrancar()
  try {
    let trigesima, ultimo
    for (let i = 0; i < 31; i++) {
      const resp = await peticion({ puerto, cabeceras: cabecerasValidas({ 'X-Reunion': `r${i}` }), cuerpo: Buffer.from('{}') })
      if (i === 29) trigesima = resp
      ultimo = resp
    }
    assert.strictEqual(trigesima.status, 201) // la 30ª — la orilla que faltaba
    assert.strictEqual(ultimo.status, 429)
  } finally {
    await cerrar(servidor)
  }
})

test('429: el cupo es por IP real (X-Forwarded-For) tras un proxy de confianza, no por el socket TCP', async () => {
  // El par TCP de las pruebas es 127.0.0.1 (confiable), así que dos
  // peticiones que declaran X-Forwarded-For distinto deben tratarse como dos
  // máquinas distintas aunque compartan el mismo socket físico de pruebas —
  // así es como se comportaría el servicio real detrás de Traefik.
  const { servidor, puerto } = await arrancar()
  try {
    for (let i = 0; i < 30; i++) {
      const resp = await peticion({ puerto, cabeceras: cabecerasValidas({ 'X-Reunion': `a${i}`, 'X-Forwarded-For': '9.9.9.1' }), cuerpo: Buffer.from('{}') })
      assert.strictEqual(resp.status, 201)
    }
    const agotada = await peticion({ puerto, cabeceras: cabecerasValidas({ 'X-Reunion': 'a30', 'X-Forwarded-For': '9.9.9.1' }), cuerpo: Buffer.from('{}') })
    assert.strictEqual(agotada.status, 429)

    const otraMaquina = await peticion({ puerto, cabeceras: cabecerasValidas({ 'X-Reunion': 'b0', 'X-Forwarded-For': '9.9.9.2' }), cuerpo: Buffer.from('{}') })
    assert.strictEqual(otraMaquina.status, 201)
    // Mutación que esto caza: volver a `req.socket.remoteAddress` sin mirar
    // X-Forwarded-For hace que la máquina B también reciba 429 (comparte
    // cupo con la A por venir del mismo socket físico de las pruebas).
  } finally {
    await cerrar(servidor)
  }
})

test('429: los intentos con token inválido no gastan el cupo de la subida legítima', async () => {
  const { servidor, puerto } = await arrancar()
  try {
    for (let i = 0; i < 30; i++) {
      const resp = await peticion({ puerto, cabeceras: cabecerasValidas({ Authorization: 'Bearer lo-que-sea', 'X-Forwarded-For': '9.9.9.9' }), cuerpo: Buffer.from('{}') })
      assert.strictEqual(resp.status, 401)
    }
    const legitima = await peticion({ puerto, cabeceras: cabecerasValidas({ 'X-Forwarded-For': '9.9.9.9', 'X-Reunion': 'legitima' }), cuerpo: Buffer.from('{}') })
    assert.strictEqual(legitima.status, 201)
    // Mutación que esto caza: aplicar `permiteSubida` ANTES de comprobar el
    // token hace que la subida legítima reciba 429 (el cupo ya se gastó con
    // los 30 intentos con token inválido).
  } finally {
    await cerrar(servidor)
  }
})

test('GET /salud responde 200 "ok" en texto plano', async () => {
  const { servidor, puerto } = await arrancar()
  try {
    const resp = await peticion({ puerto, metodo: 'GET', ruta: '/salud' })
    assert.strictEqual(resp.status, 200)
    assert.strictEqual(resp.cuerpo, 'ok')
  } finally {
    await cerrar(servidor)
  }
})

test('500: un fallo real de escritura no tira el proceso, y /salud sigue viva después', async (t) => {
  if (process.getuid && process.getuid() === 0) {
    // Root ignora los permisos de archivo: el EACCES que esta prueba
    // necesita provocar no ocurriría, así que la prueba no sería real.
    t.skip('correría como root: los permisos de disco no bloquean a root')
    return
  }
  const { servidor, dir, puerto } = await arrancar()
  try {
    fs.chmodSync(dir, 0o555) // sin permiso de escritura: fuerza el EACCES real que, sin try/catch, tiraba el proceso
    const resp = await peticion({ puerto, cabeceras: cabecerasValidas({ 'X-Reunion': 'sin-permiso' }), cuerpo: Buffer.from('{}') })
    assert.strictEqual(resp.status, 500)

    const salud = await peticion({ puerto, metodo: 'GET', ruta: '/salud' })
    assert.strictEqual(salud.status, 200)
    // Mutación que esto caza: quitar el try/catch alrededor de
    // mkdirSync/writeFileSync/renameSync hace que la excepción no capturada
    // tire el proceso — esta prueba (y cualquiera después) deja de correr.
  } finally {
    fs.chmodSync(dir, 0o755)
    await cerrar(servidor)
  }
})

test('el log de cada subida no lleva el token ni el cuerpo', async () => {
  const { servidor, puerto } = await arrancar()
  const original = console.log
  const lineas = []
  console.log = (...args) => { lineas.push(args.join(' ')) }
  try {
    const cuerpo = Buffer.from('{"secreto-de-la-reunion":"esto no debe salir en el log"}\n')
    const resp = await peticion({ puerto, cabeceras: cabecerasValidas({ 'X-Reunion': 'log-limpio' }), cuerpo })
    assert.strictEqual(resp.status, 201)
    assert.strictEqual(lineas.length, 1)
    assert.ok(!lineas[0].includes(TOKEN), 'el log no debe contener el token')
    assert.ok(!lineas[0].includes('secreto-de-la-reunion'), 'el log no debe contener el cuerpo')
    // Mutación que esto caza: interpolar `req.headers.authorization` o
    // `cuerpo` en la línea de log tumba esta prueba.
  } finally {
    console.log = original
    await cerrar(servidor)
  }
})

test('dos servidores en el mismo proceso no comparten cupo de subidas (cada uno su Map)', async () => {
  const a = await arrancar()
  const b = await arrancar()
  try {
    for (let i = 0; i < 30; i++) {
      await peticion({ puerto: a.puerto, cabeceras: cabecerasValidas({ 'X-Reunion': `a${i}` }), cuerpo: Buffer.from('{}') })
    }
    const resp = await peticion({ puerto: b.puerto, cabeceras: cabecerasValidas({ 'X-Reunion': 'b0' }), cuerpo: Buffer.from('{}') })
    assert.strictEqual(resp.status, 201)
  } finally {
    await cerrar(a.servidor)
    await cerrar(b.servidor)
  }
})
