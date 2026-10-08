/**
 * Pruebas de las licencias del servidor (F053).
 *
 * Mismo criterio que `servidor.test.js`: el servidor real en un puerto
 * efímero, un directorio temporal por prueba y claves generadas aquí, nunca
 * las de producción. La administración se ejercita con la herramienta de
 * verdad (`licencias-cli.js`, en un proceso aparte), que es como se usa.
 *
 * Una prueba por criterio de aceptación, más las que protegen lo que cuesta
 * dinero o deja todo caído: la concurrencia del tope, la validación, el freno,
 * el candado huérfano, la clave que se imprime y los archivos de despliegue.
 */

'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync, spawnSync } = require('child_process')

const { crearServidor, _internos } = require('../servidor')
const { cargarClavePrivada, MS_DIA } = require('../licencias')

const CLI = path.join(__dirname, '..', 'licencias-cli.js')
const RUTA = '/informes/licencias/activar' // la que ve Traefik; el servidor también acepta la que llega sin prefijo
const TOKEN = 'token-de-prueba-no-es-un-secreto-real'
const CONTACTO_SERVIDOR = 'soporte-servidor@ejemplo.test'
const CONTACTO_LICENCIA = 'soporte-cliente@ejemplo.test'

// La ruta registra cada activación con console.log: aquí se recoge en vez de
// imprimirse, y una prueba comprueba que ahí no sale nada que no deba.
const lineasDeLog = []
console.log = (...args) => { lineasDeLog.push(args.join(' ')) }
console.error = (...args) => { lineasDeLog.push(args.join(' ')) }

function sha (texto) {
  return crypto.createHash('sha256').update(texto).digest('hex')
}

/** Un equipo ficticio: nombre, versión y las dos huellas que calcularía la app. Cada uno viene de una IP distinta, como en la vida real. */
function equipo (n) {
  return {
    equipo: `PC-${n}`,
    version: '1.0.0',
    ip: `10.9.0.${n}`,
    huellas: { maquina: sha(`maquina-${n}`), placa: sha(`placa-${n}`) }
  }
}

function paresDeClaves () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return {
    publica: publicKey,
    // Como llega de un .env: una línea, los saltos escritos como \n y entre comillas. El peor caso de LICENCIAS_CLAVE_PRIVADA.
    privadaEnv: `"${pem.trim().replace(/\n/g, '\\n')}"`,
    privadaBase64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
}

function cli (directorio, ...args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, LICENCIAS_DIRECTORIO: directorio },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function peticion ({ puerto, metodo = 'POST', ruta, cabeceras = {}, cuerpo = '' }) {
  const buf = Buffer.from(cuerpo)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: puerto, path: ruta, method: metodo, headers: { 'Content-Length': String(buf.length), ...cabeceras } },
      (res) => {
        const trozos = []
        res.on('data', (t) => trozos.push(t))
        res.on('end', () => {
          const texto = Buffer.concat(trozos).toString('utf8')
          let json = null
          try { json = JSON.parse(texto) } catch { /* no era JSON: la prueba mira `cuerpo` */ }
          resolve({ status: res.statusCode, cuerpo: texto, cabeceras: res.headers, json })
        })
      }
    )
    req.on('error', reject)
    req.end(buf)
  })
}

/**
 * Servidor real con una licencia ya creada por la herramienta. `maximo` es su
 * tope de equipos; `clavePrivada` pisa la del par generado (para probar el
 * servidor sin clave o con una inservible).
 */
async function arrancar ({ maximo = 6, clavePrivada } = {}) {
  const dirInformes = fs.mkdtempSync(path.join(os.tmpdir(), 'informes-lic-'))
  const dirLicencias = fs.mkdtempSync(path.join(os.tmpdir(), 'licencias-test-'))
  const claves = paresDeClaves()
  const licencia = cli(dirLicencias, 'crear', 'Cliente de prueba', String(maximo), CONTACTO_LICENCIA).trim()
  const servidor = crearServidor({
    token: TOKEN,
    directorioBase: dirInformes,
    licencias: {
      clavePrivada: clavePrivada === undefined ? claves.privadaEnv : clavePrivada,
      directorio: dirLicencias,
      contacto: CONTACTO_SERVIDOR
    }
  })
  await new Promise((resolve, reject) => {
    servidor.on('error', reject)
    servidor.listen(0, '127.0.0.1', resolve)
  })
  return { servidor, puerto: servidor.address().port, dirInformes, dirLicencias, licencia, ...claves }
}

function cerrar (s) {
  return new Promise((resolve) => {
    s.servidor.close(() => {
      fs.rmSync(s.dirInformes, { recursive: true, force: true })
      fs.rmSync(s.dirLicencias, { recursive: true, force: true })
      resolve()
    })
  })
}

function activar (s, e, { licencia = s.licencia, ruta = RUTA } = {}) {
  return peticion({
    puerto: s.puerto,
    ruta,
    cabeceras: { 'Content-Type': 'application/json', 'X-Forwarded-For': e.ip || '10.9.0.1' },
    cuerpo: JSON.stringify({ licencia, huellas: e.huellas, equipo: e.equipo, version: e.version })
  })
}

function almacenDe (s) {
  return JSON.parse(fs.readFileSync(path.join(s.dirLicencias, 'licencias.json'), 'utf8')).licencias[s.licencia]
}

// ---------------------------------------------------------------------------
// Criterios de aceptación de F053
// ---------------------------------------------------------------------------

test('F053 tope 6: seis equipos reciben permiso, el 7.º recibe 403 tope y el 1.º vuelve a entrar sin gastar plaza', async () => {
  const s = await arrancar({ maximo: 6 })
  try {
    for (let n = 1; n <= 6; n++) {
      const r = await activar(s, equipo(n))
      assert.strictEqual(r.status, 200, `el equipo ${n} debía recibir permiso`)
      assert.ok(r.json.permiso && r.json.firma)
      assert.strictEqual(r.cabeceras['cache-control'], 'no-store')
    }

    const septimo = await activar(s, equipo(7))
    assert.strictEqual(septimo.status, 403)
    assert.deepStrictEqual(septimo.json, { motivo: 'tope', usados: 6, maximo: 6, contacto: CONTACTO_LICENCIA })
    assert.strictEqual(septimo.cabeceras['cache-control'], 'no-store')

    // El 1.º, esta vez por la ruta sin prefijo (Traefik puede entregarla de las dos formas).
    const primero = await activar(s, equipo(1), { ruta: '/licencias/activar' })
    assert.strictEqual(primero.status, 200)
    assert.strictEqual(almacenDe(s).equipos.length, 6, 'volver a entrar no gasta plaza')
    assert.strictEqual((await activar(s, equipo(7))).json.usados, 6, 'y el 7.º sigue sin caber')

    // La clave privada, la licencia entera y las huellas no salen en ningún log; 8 hex de la licencia sí, para reconocerla.
    const todo = lineasDeLog.join('\n')
    assert.ok(lineasDeLog.length > 0, 'la ruta registra cada activación')
    assert.ok(!todo.includes(s.privadaBase64) && !todo.includes('PRIVATE KEY'), 'la clave privada no puede salir en un log')
    assert.ok(!todo.includes(s.licencia) && !todo.includes(equipo(1).huellas.maquina), 'ni la licencia entera ni las huellas')
    assert.ok(todo.includes(s.licencia.slice(0, 8)))
  } finally {
    await cerrar(s)
  }
})

test('F053 ocho activaciones simultáneas con tope 6: seis permisos, dos topes y ninguna escritura perdida', async () => {
  const s = await arrancar({ maximo: 6 })
  try {
    const respuestas = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((n) => activar(s, equipo(n))))
    assert.strictEqual(respuestas.filter((r) => r.status === 200).length, 6)
    assert.strictEqual(respuestas.filter((r) => r.status === 403 && r.json.motivo === 'tope').length, 2)

    const lic = almacenDe(s)
    assert.strictEqual(lic.equipos.length, 6, 'ni una plaza de más ni una registrada que se perdiera')
    assert.strictEqual(lic.activaciones.length, 8, 'las ocho quedan en el registro, gasten plaza o no')
    assert.strictEqual(lic.activacionesTotal, 8)
  } finally {
    await cerrar(s)
  }
})

test('F053 la misma placa con otra máquina es el mismo equipo (Windows reinstalado) y no gasta plaza', async () => {
  const s = await arrancar({ maximo: 1 })
  try {
    const original = { equipo: 'PC-A', version: '1.0.0', ip: '10.9.1.1', huellas: { maquina: sha('maquina-vieja'), placa: sha('placa-unica') } }
    const reinstalado = { ...original, version: '1.0.1', huellas: { maquina: sha('maquina-nueva'), placa: original.huellas.placa } }
    assert.strictEqual((await activar(s, original)).status, 200)
    // Con tope 1, si esto fuera un equipo nuevo sería 403.
    assert.strictEqual((await activar(s, reinstalado)).status, 200)
    assert.strictEqual(almacenDe(s).equipos[0].version, '1.0.1', 'se actualiza la versión')

    // La huella nueva quedó guardada: sin placa, la máquina nueva ya se reconoce sola.
    const sinPlaca = { ...reinstalado, huellas: { maquina: reinstalado.huellas.maquina, placa: null } }
    assert.strictEqual((await activar(s, sinPlaca)).status, 200)

    // Un equipo de verdad distinto (ninguna huella en común) sigue sin caber.
    const otro = await activar(s, equipo(2))
    assert.strictEqual(otro.status, 403)
    assert.strictEqual(otro.json.usados, 1)
  } finally {
    await cerrar(s)
  }
})

test('F053 un MachineGuid copiado o una petición retocada no dan plaza gratis; Windows reinstalado y placa null siguen entrando', async () => {
  const s = await arrancar({ maximo: 2 })
  try {
    const pc = (n, maquina, placa) => ({
      equipo: `PC-${n}`,
      version: '1.0.0',
      ip: `10.9.3.${n}`,
      huellas: { maquina: sha(maquina), placa: placa === null ? null : sha(placa) }
    })
    // Dos plazas, las dos gastadas: la PC 1 con sus dos huellas y la PC 2 con placa null (una placa barata).
    assert.strictEqual((await activar(s, pc(1, 'M1', 'P1'))).status, 200)
    assert.strictEqual((await activar(s, pc(2, 'M2', null))).status, 200)

    // Caso 1 de la revisión: una PC nueva copia el MachineGuid de la 1 con regedit. Su placa lo contradice.
    const copiado = await activar(s, pc(7, 'M1', 'P7'))
    assert.strictEqual(copiado.status, 403)
    assert.strictEqual(copiado.json.usados, 2)
    assert.strictEqual((await activar(s, pc(7, 'M7', 'P7'))).status, 403, 'y no se quedó con nada: su identidad verdadera tampoco entra')

    // Caso 2: una petición retocada con la placa de la 1 pasa, porque misma placa es misma computadora (igual que un Windows reinstalado)...
    assert.strictEqual((await activar(s, pc(8, 'M8', 'P1'))).status, 200)
    // ...pero la app sin tocar de la PC 8, con su placa de verdad, es otra computadora.
    assert.strictEqual((await activar(s, pc(8, 'M8', 'P8'))).status, 403)

    // La placa null sigue funcionando por máquina, en los dos sentidos.
    assert.strictEqual((await activar(s, pc(2, 'M2', null))).status, 200, 'sin placa, se reconoce por la máquina')
    assert.strictEqual((await activar(s, pc(1, 'M1', null))).status, 200, 'si esta vez no se pudo leer la placa, no hay contradicción')
    assert.strictEqual((await activar(s, pc(2, 'M2', 'P2'))).status, 200, 'y un equipo sin placa aprende la que por fin trae')
    assert.deepStrictEqual(almacenDe(s).equipos[1].placas, [sha('P2')])
    assert.strictEqual(almacenDe(s).equipos.length, 2, 'ninguna de las peticiones aceptadas gastó una tercera plaza')
  } finally {
    await cerrar(s)
  }
})

test('F053 licencia inexistente y revocada dan exactamente la misma respuesta', async () => {
  const s = await arrancar()
  try {
    assert.strictEqual((await activar(s, equipo(1))).status, 200, 'antes de revocar, entra')
    cli(s.dirLicencias, 'revocar', s.licencia)

    const revocada = await activar(s, equipo(2))
    const inexistente = await activar(s, equipo(2), { licencia: 'f'.repeat(32) })
    assert.strictEqual(revocada.status, 403)
    assert.strictEqual(inexistente.status, 403)
    assert.strictEqual(inexistente.cuerpo, revocada.cuerpo, 'byte a byte, o delata cuáles existen')
    // El contacto es el del servidor: el de la licencia solo lo ve quien la tiene en regla.
    assert.deepStrictEqual(revocada.json, { motivo: 'denegada', contacto: CONTACTO_SERVIDOR })
    for (const cabecera of ['content-type', 'content-length', 'cache-control']) {
      assert.strictEqual(inexistente.cabeceras[cabecera], revocada.cabeceras[cabecera], cabecera)
    }

    // Y un equipo que ya estaba activado tampoco renueva con la licencia revocada.
    assert.strictEqual((await activar(s, equipo(1))).status, 403)
  } finally {
    await cerrar(s)
  }
})

test('F053 el permiso verifica con la clave pública y deja de verificar si cambia un byte', async () => {
  const s = await arrancar()
  try {
    const e = equipo(1)
    const { json } = await activar(s, e)
    assert.match(json.permiso, /^[A-Za-z0-9_-]+$/, 'base64url')
    const bytes = Buffer.from(json.permiso, 'base64url')
    const firma = Buffer.from(json.firma, 'base64url')

    assert.ok(crypto.verify(null, bytes, s.publica, firma), 'el permiso verifica con la pública')

    const carga = JSON.parse(bytes.toString('utf8'))
    assert.deepStrictEqual(Object.keys(carga), ['licencia', 'huellas', 'emitido', 'caduca'])
    assert.strictEqual(carga.licencia, s.licencia)
    assert.deepStrictEqual(carga.huellas, e.huellas)
    assert.ok(Math.abs(carga.emitido - Date.now()) < 10_000)
    assert.strictEqual(carga.caduca - carga.emitido, 14 * MS_DIA, '14 días por defecto')

    const permisoAlterado = Buffer.from(bytes)
    permisoAlterado[permisoAlterado.length - 3] ^= 1 // un solo bit de un solo byte
    assert.ok(!crypto.verify(null, permisoAlterado, s.publica, firma), 'cambiar un byte del permiso lo invalida')
    const firmaAlterada = Buffer.from(firma)
    firmaAlterada[0] ^= 1
    assert.ok(!crypto.verify(null, bytes, s.publica, firmaAlterada), 'y cambiar un byte de la firma también')
    assert.ok(!crypto.verify(null, bytes, paresDeClaves().publica, firma), 'ni verifica con la pública de otra clave')
  } finally {
    await cerrar(s)
  }
})

test('F053 liberar libera la plaza y el siguiente equipo entra', async () => {
  const s = await arrancar({ maximo: 1 })
  try {
    const primero = equipo(1)
    const segundo = equipo(2)
    assert.strictEqual((await activar(s, primero)).status, 200)
    assert.strictEqual((await activar(s, segundo)).status, 403)

    const listado = cli(s.dirLicencias, 'listar')
    for (const esperado of [s.licencia, 'PC-1', 'v1.0.0', 'equipos 1/1', 'activaciones 2', 'máquinas 1 (última ' + primero.huellas.maquina.slice(0, 12), 'placas 1 (última ' + primero.huellas.placa.slice(0, 12)]) {
      assert.ok(listado.includes(esperado), `«listar» debe mostrar ${esperado}`)
    }

    cli(s.dirLicencias, 'liberar', s.licencia, primero.huellas.maquina.slice(0, 12))
    assert.strictEqual((await activar(s, segundo)).status, 200, 'la plaza liberada la ocupa el siguiente')
    assert.strictEqual((await activar(s, primero)).status, 403, 'y el liberado ya no cabe')
  } finally {
    await cerrar(s)
  }
})

test('F053 sin LICENCIAS_CLAVE_PRIVADA (o con una inservible) la ruta da 503 y la subida de informes sigue funcionando', async () => {
  for (const clavePrivada of ['', 'esto no es una clave']) {
    const s = await arrancar({ clavePrivada })
    try {
      const r = await activar(s, equipo(1))
      assert.strictEqual(r.status, 503, `clave «${clavePrivada}»`)
      assert.strictEqual(r.cabeceras['cache-control'], 'no-store')

      const subida = await peticion({
        puerto: s.puerto,
        ruta: '/informes',
        cabeceras: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/x-ndjson', 'X-Maquina': 'pc-prueba', 'X-Version': '1.0.0', 'X-Reunion': 'sin-clave' },
        cuerpo: '{}'
      })
      assert.strictEqual(subida.status, 201)
    } finally {
      await cerrar(s)
    }
  }
})

// ---------------------------------------------------------------------------
// Lo que no es un criterio de aceptación pero deja el servicio abierto o caído
// ---------------------------------------------------------------------------

test('F053 validación: método, tipo, tamaño y campos fuera de su alfabeto se rechazan sin tocar el almacén', async () => {
  const s = await arrancar()
  try {
    const base = { licencia: s.licencia, huellas: { maquina: sha('m'), placa: sha('p') }, equipo: 'PC-1', version: '1.0.0' }
    let n = 0
    const enviar = (cuerpo, cabeceras = {}) => peticion({
      puerto: s.puerto,
      ruta: RUTA,
      cabeceras: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.2.${++n}`, ...cabeceras },
      cuerpo: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)
    })

    assert.strictEqual((await peticion({ puerto: s.puerto, metodo: 'GET', ruta: RUTA })).status, 405)
    assert.strictEqual((await enviar(base, { 'Content-Type': 'text/plain' })).status, 415)
    assert.strictEqual((await enviar('{esto no es json')).status, 400)
    assert.strictEqual((await enviar('x'.repeat(_internos.TOPE_ACTIVACION_BYTES + 1))).status, 413)

    const casos = [
      ['licencia', { ...base, licencia: 'A'.repeat(32) }], // mayúsculas: no es el alfabeto
      ['licencia', { ...base, licencia: '../'.repeat(11) }],
      ['huellas.maquina', { ...base, huellas: { maquina: 'abc', placa: null } }],
      ['huellas.placa', { ...base, huellas: { maquina: sha('m'), placa: 'zz' } }],
      ['equipo', { ...base, equipo: 'PC con espacio' }],
      ['equipo', { ...base, equipo: '..' }],
      ['version', { ...base, version: 'latest' }]
    ]
    for (const [campo, cuerpo] of casos) {
      const r = await enviar(cuerpo)
      assert.strictEqual(r.status, 400, campo)
      assert.strictEqual(r.json.campo, campo)
    }
    assert.strictEqual(almacenDe(s).activaciones.length, 0, 'nada de lo rechazado llegó al almacén')
  } finally {
    await cerrar(s)
  }
})

test('F053 freno por IP real: la activación 11 en un minuto recibe 429 y otra IP no lo nota', async () => {
  const s = await arrancar()
  try {
    // Cuerpos vacíos: dan 400 y no gastan nada del almacén, pero cuentan para el freno.
    const vacia = (ip) => peticion({ puerto: s.puerto, ruta: RUTA, cabeceras: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, cuerpo: '{}' })
    for (let i = 0; i < _internos.MAX_ACTIVACIONES_MIN; i++) {
      assert.strictEqual((await vacia('9.9.9.1')).status, 400, `la ${i + 1}.ª pasa`)
    }
    assert.strictEqual((await vacia('9.9.9.1')).status, 429)
    assert.strictEqual((await vacia('9.9.9.2')).status, 400, 'el cupo es por IP real, no por el socket')
  } finally {
    await cerrar(s)
  }
})

test('F053 un candado huérfano (el proceso murió con él) no bloquea las activaciones para siempre', async () => {
  const s = await arrancar()
  try {
    const candado = path.join(s.dirLicencias, 'licencias.lock')
    fs.writeFileSync(candado, '')
    const hace = new Date(Date.now() - 60_000)
    fs.utimesSync(candado, hace, hace)

    assert.strictEqual((await activar(s, equipo(1))).status, 200)
    assert.ok(!fs.existsSync(candado), 'el candado se suelta al terminar')
  } finally {
    await cerrar(s)
  }
})

test('F053 claves: la privada va a un archivo 600, stdout lleva SOLO la pública y no se pisa una clave existente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claves-test-'))
  try {
    const archivo = path.join(dir, 'privada.pem')
    const r = spawnSync(process.execPath, [CLI, 'claves', archivo], { encoding: 'utf8' })
    assert.strictEqual(r.status, 0, r.stderr)
    assert.match(r.stdout, /^-----BEGIN PUBLIC KEY-----/)
    assert.ok(!r.stdout.includes('PRIVATE') && !r.stderr.includes('PRIVATE'), 'la privada no se imprime en ningún flujo')
    assert.strictEqual(fs.statSync(archivo).mode & 0o777, 0o600)

    // El par es coherente, y el archivo se carga como lo hará el servidor desde el .env (una línea con \n literales).
    const pem = fs.readFileSync(archivo, 'utf8')
    const privada = cargarClavePrivada(pem.trim().split('\n').join('\\n'))
    const firma = crypto.sign(null, Buffer.from('permiso'), privada)
    assert.ok(crypto.verify(null, Buffer.from('permiso'), crypto.createPublicKey(r.stdout), firma))

    const otra = spawnSync(process.execPath, [CLI, 'claves', archivo], { encoding: 'utf8' })
    assert.strictEqual(otra.status, 1)
    assert.strictEqual(otra.stdout, '')
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), pem, 'la clave existente queda intacta')

    // Sin archivo se niega y no escribe nada: con un nombre por defecto, la privada caía en el directorio actual.
    const sinArchivo = spawnSync(process.execPath, [CLI, 'claves'], { encoding: 'utf8', cwd: dir })
    assert.strictEqual(sinArchivo.status, 1)
    assert.strictEqual(sinArchivo.stdout, '')
    assert.deepStrictEqual(fs.readdirSync(dir), ['privada.pem'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F053 despliegue: rsync --delete no toca licencias/, compose la monta y la imagen lleva todo lo que se requiere', () => {
  const leer = (nombre) => fs.readFileSync(path.join(__dirname, '..', nombre), 'utf8')

  // Sin este --exclude, cada despliegue borraría el registro de licencias del VPS.
  assert.match(leer('desplegar.sh'), /--exclude 'licencias\/'/)
  assert.match(leer('desplegar.sh'), /--exclude '\*\.pem'/) // rsync no mira el .gitignore
  assert.match(leer('docker-compose.yml'), /- \.\/licencias:\/datos\/licencias/)

  // Un archivo que el servidor requiere y la imagen no copia lo deja en un bucle de caídas, y se lleva la subida de informes.
  const copiados = leer('Dockerfile').match(/^COPY (.+) \.\/$/m)[1].split(/\s+/)
  const necesarios = new Set(['servidor.js', 'licencias-cli.js'])
  for (const archivo of ['servidor.js', 'licencias.js', 'licencias-cli.js']) {
    for (const m of leer(archivo).matchAll(/require\('\.\/([\w-]+)(?:\.js)?'\)/g)) necesarios.add(`${m[1]}.js`)
  }
  for (const archivo of necesarios) assert.ok(copiados.includes(archivo), `el Dockerfile no copia ${archivo}`)
})
