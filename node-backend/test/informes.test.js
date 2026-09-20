/**
 * Pruebas del cliente de subida de informes (F039b).
 *
 * Las tres pruebas del criterio de aceptación, contra el receptor REAL
 * (`vps/servidor.js`, F039a) en un puerto efímero — no un servidor de mentira:
 * lo que hay que probar es que las cabeceras y el cuerpo que manda
 * `ColaDeInformes` son los que el contrato de subida pactado exige, y eso solo
 * lo confirma el propio receptor aceptándolos o rechazándolos.
 *
 * Política del 20-09-2026: una prueba por criterio, sin baterías.
 */

'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { crearServidor } = require('../../vps/servidor')
const { ColaDeInformes } = require('../src/informes')

const TOKEN = 'token-de-prueba-suficientemente-largo'

function dirTemporal () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'informes-test-'))
}

/** Arranca el receptor real en un puerto efímero y devuelve su URL de subida. */
function arrancarReceptor (directorioBase) {
  return new Promise((resolve) => {
    const servidor = crearServidor({ token: TOKEN, directorioBase })
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address()
      resolve({ servidor, url: `http://127.0.0.1:${port}/informes` })
    })
  })
}

test('sube el .jsonl y llega al VPS con las cabeceras del contrato', async () => {
  const dirVps = dirTemporal()
  const dirApp = dirTemporal()
  const { servidor, url } = await arrancarReceptor(dirVps)
  try {
    const rutaJsonl = path.join(dirApp, 'sesion-20260920-101500-3.jsonl')
    fs.writeFileSync(rutaJsonl, JSON.stringify({ tipo: 'cabecera', id: 3 }) + '\n')

    const cola = new ColaDeInformes({ directorioDatos: dirApp, token: TOKEN, url })
    cola.encolar(rutaJsonl, { maquina: 'pc-arturo', version: '0.5.0', reunion: '20260920-101500-3' })
    await cola.enviarPendientes()

    const dia = new Date().toISOString().slice(0, 10)
    const archivos = fs.readdirSync(path.join(dirVps, dia))
    assert.strictEqual(archivos.length, 1)
    assert.match(archivos[0], /^pc-arturo-\d{6}-0\.5\.0-20260920-101500-3\.jsonl$/)
    const contenido = fs.readFileSync(path.join(dirVps, dia, archivos[0]), 'utf8')
    assert.match(contenido, /"tipo":"cabecera"/)
  } finally {
    servidor.close()
  }
})

test('sin red, el informe queda en cola y se reenvía en el siguiente enviarPendientes()', async () => {
  const dirApp = dirTemporal()
  const dirVps = dirTemporal()
  const rutaJsonl = path.join(dirApp, 'sesion-20260920-111500-4.jsonl')
  fs.writeFileSync(rutaJsonl, JSON.stringify({ tipo: 'cabecera', id: 4 }) + '\n')

  // Puerto elegido a mano y SIN nada escuchando ahí: la primera llamada tiene
  // que fallar por "sin red", no por un 404 o un timeout largo de un puerto
  // real ocupado por otra cosa.
  const puertoLibre = await new Promise((resolve) => {
    const s = require('net').createServer()
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
  const url = `http://127.0.0.1:${puertoLibre}/informes`

  const cola = new ColaDeInformes({ directorioDatos: dirApp, token: TOKEN, url })
  cola.encolar(rutaJsonl, { maquina: 'pc-arturo', version: '0.5.0', reunion: '20260920-111500-4' })

  await cola.enviarPendientes() // nadie escucha: falla, y no debe lanzar
  const colaTrasFallo = JSON.parse(fs.readFileSync(path.join(dirApp, 'cola-informes.json'), 'utf8'))
  assert.strictEqual(colaTrasFallo.length, 1, 'el pendiente sigue en la cola tras el fallo de red')

  // Ahora sí levanta el receptor, en el MISMO puerto que ya estaba en la cola.
  const servidor = crearServidor({ token: TOKEN, directorioBase: dirVps })
  await new Promise((resolve) => servidor.listen(puertoLibre, '127.0.0.1', resolve))
  try {
    await cola.enviarPendientes()
    const colaTrasReintento = JSON.parse(fs.readFileSync(path.join(dirApp, 'cola-informes.json'), 'utf8'))
    assert.strictEqual(colaTrasReintento.length, 0, 'el reintento la subió y la sacó de la cola')

    const dia = new Date().toISOString().slice(0, 10)
    assert.strictEqual(fs.readdirSync(path.join(dirVps, dia)).length, 1)
  } finally {
    servidor.close()
  }
})

test('en modo "metricas" no se manda ningún texto de italiano ni de español', async () => {
  const dirVps = dirTemporal()
  const dirApp = dirTemporal()
  const { servidor, url } = await arrancarReceptor(dirVps)
  try {
    const rutaJsonl = path.join(dirApp, 'sesion-20260920-121500-5.jsonl')
    // Cabecera (se conserva) + una frase con texto reconocible que NO debe cruzar.
    fs.writeFileSync(rutaJsonl,
      JSON.stringify({ tipo: 'cabecera', id: 5 }) + '\n' +
      JSON.stringify({ it: 'ciao come stai', es: 'hola cómo estás', ms: 812, forzado: true }) + '\n')

    const cola = new ColaDeInformes({
      directorioDatos: dirApp, token: TOKEN, url, obtenerModo: () => 'metricas',
    })
    cola.encolar(rutaJsonl, { maquina: 'pc-arturo', version: '0.5.0', reunion: '20260920-121500-5' })
    await cola.enviarPendientes()

    const dia = new Date().toISOString().slice(0, 10)
    const archivos = fs.readdirSync(path.join(dirVps, dia))
    const contenido = fs.readFileSync(path.join(dirVps, dia, archivos[0]), 'utf8')
    assert.ok(!contenido.includes('ciao'), 'no debe llevar el italiano')
    assert.ok(!contenido.includes('hola'), 'no debe llevar el español')
    assert.ok(!contenido.includes('"it"') && !contenido.includes('"es"'), 'no debe llevar ni el campo it ni el campo es')
    assert.match(contenido, /"itLen":14/)
    assert.match(contenido, /"esLen":15/)
    assert.match(contenido, /"ms":812/)
    assert.match(contenido, /"forzado":true/)
  } finally {
    servidor.close()
  }
})

test('una reunión grabada en modo "no" no sube nunca, ni aunque el ajuste cambie después a "completo"', async () => {
  // Corrección F039b tras revisión: el consentimiento que vale es el que
  // había AL GRABAR, no el del día que se reintenta el envío.
  const dirVps = dirTemporal()
  const dirApp = dirTemporal()
  const { servidor, url } = await arrancarReceptor(dirVps)
  try {
    const rutaJsonl = path.join(dirApp, 'sesion-20260920-131500-6.jsonl')
    fs.writeFileSync(rutaJsonl,
      JSON.stringify({ tipo: 'cabecera', id: 6 }) + '\n' +
      JSON.stringify({ it: 'ciao', es: 'hola', ms: 100 }) + '\n')

    let modo = 'no'
    const cola = new ColaDeInformes({
      directorioDatos: dirApp, token: TOKEN, url, obtenerModo: () => modo,
    })
    cola.encolar(rutaJsonl, { maquina: 'pc-arturo', version: '0.5.0', reunion: '20260920-131500-6' })

    // Semanas después, el usuario cambia el ajuste para otra reunión.
    modo = 'completo'
    await cola.enviarPendientes()

    const colaTrasIntento = JSON.parse(fs.readFileSync(path.join(dirApp, 'cola-informes.json'), 'utf8'))
    assert.strictEqual(colaTrasIntento.length, 0, 'el pendiente grabado en modo "no" se descarta, no se reintenta')
    const dia = new Date().toISOString().slice(0, 10)
    assert.ok(!fs.existsSync(path.join(dirVps, dia)), 'no debe haber llegado nada al VPS')
  } finally {
    servidor.close()
  }
})
