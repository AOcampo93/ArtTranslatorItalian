/**
 * Pruebas del test de admisión.
 *
 * Lo importante que se verifica aquí no es el número medido —depende de la
 * máquina— sino **el criterio**: que los umbrales dictaminen lo que deben, que
 * la consecuencia salga en segundos y no en un porcentaje, y que el informe
 * declare las condiciones en vez de callarlas.
 */

'use strict'

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const admision = require('../src/admissionTest')
const { ejecutar, informe, _internos, UMBRAL_COMODO_MS, UMBRAL_JUSTO_MS } = admision
const { Transcriber } = require('../src/transcriber')
const translator = require('../src/translator')
const { perfilar } = require('../src/hardware')

const RAIZ = path.join(__dirname, '..', '..')
const BINARIO = path.join(RAIZ, 'bin', 'whisper-server')
const MODELO = path.join(RAIZ, 'models', 'ggml-small.bin')
const WAV = path.join(__dirname, 'fixtures', 'italiano.wav')
const HAY_ENTORNO = [BINARIO, MODELO, WAV].every(p => fs.existsSync(p))

describe('percentiles', () => {
  test('p50 y p95 sobre una serie conocida', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    assert.strictEqual(_internos.percentil(v, 50), 50)
    assert.strictEqual(_internos.percentil(v, 95), 100)
  })

  test('un solo valor no revienta', () => {
    assert.strictEqual(_internos.percentil([42], 95), 42)
  })

  test('una serie vacía devuelve null', () => {
    assert.strictEqual(_internos.percentil([], 50), null)
  })

  test('el p95 no es la media: los picos importan', () => {
    // Si se reportara la media, un pico de 5 s quedaría escondido tras nueve
    // medidas buenas. En una reunión ese pico es una frase perdida.
    const v = [100, 100, 100, 100, 100, 100, 100, 100, 100, 5000]
    const media = v.reduce((a, b) => a + b) / v.length
    assert.ok(_internos.percentil(v, 95) > media, 'el p95 debe destapar el pico')
  })
})

describe('criterio del veredicto', () => {
  test('la consecuencia se expresa en segundos, nunca en porcentaje', () => {
    for (const v of ['sobrado', 'justo', 'no-llega']) {
      const f = _internos.frase(v, 1200)
      assert.match(f, /segundos?/, `"${f}" no habla de segundos`)
      assert.doesNotMatch(f, /%|por ciento/, `"${f}" usa un porcentaje`)
    }
  })

  test('solo el veredicto bueno se queda sin acción', () => {
    assert.strictEqual(_internos.accion('sobrado'), null)
    assert.match(_internos.accion('justo'), /navegador/)
    assert.match(_internos.accion('no-llega'), /nube/)
  })

  test('"no llega" dice el coste de la alternativa', () => {
    // Paga el cliente: activar la nube sin decir cuánto cuesta destruye la
    // confianza en la primera factura.
    assert.match(_internos.accion('no-llega'), /USD|coste/i)
  })

  test('los umbrales están ordenados', () => {
    assert.ok(UMBRAL_COMODO_MS < UMBRAL_JUSTO_MS)
  })
})

describe('lectura de WAV', () => {
  test('encuentra el chunk data sin asumir cabecera de 44 bytes', { skip: !HAY_ENTORNO }, () => {
    // Asumir 44 mete los chunks LIST o fact como si fueran audio, y eso es
    // ruido al principio de cada transcripción.
    const m = _internos.muestrasDeWav(fs.readFileSync(WAV))
    assert.ok(m.length > 16000, `solo ${m.length} muestras`)
    assert.ok(m instanceof Float32Array)
    const max = Math.max(...Array.from(m.subarray(0, 48000)).map(Math.abs))
    assert.ok(max <= 1, 'las muestras deben estar normalizadas')
  })

  test('un buffer sin chunk data lanza con mensaje claro', () => {
    const falso = Buffer.alloc(64)
    falso.write('RIFF', 0); falso.write('WAVE', 8)
    assert.throws(() => _internos.muestrasDeWav(falso), /chunk data/)
  })
})

describe('ejecución real', { skip: HAY_ENTORNO ? false : 'falta binario, modelo o audio' }, () => {
  let tr, resultado, perfil

  before(async () => {
    tr = new Transcriber({ binario: BINARIO, modelo: MODELO })
    await tr.start()
    await translator.cargar()
    perfil = await perfilar()
    resultado = await ejecutar({
      transcriber: tr,
      translator,
      wavItaliano: fs.readFileSync(WAV),
      perfil,
    }, { rondas: 3 })
  }, { timeout: 300000 })

  after(() => { if (tr) tr.stop() })

  test('produce un veredicto válido', () => {
    assert.strictEqual(resultado.ok, true, resultado.motivo)
    assert.ok(['sobrado', 'justo', 'no-llega'].includes(resultado.veredicto))
  })

  test('reporta p95 y no solo la media', () => {
    for (const etapa of ['whisper', 'marian', 'total']) {
      assert.strictEqual(typeof resultado.medidas[etapa].p50, 'number')
      assert.strictEqual(typeof resultado.medidas[etapa].p95, 'number')
      assert.ok(resultado.medidas[etapa].p95 >= resultado.medidas[etapa].p50)
    }
  })

  test('el veredicto concuerda con la latencia medida', () => {
    const ms = resultado.latenciaFraseMs
    const esperado = ms <= UMBRAL_COMODO_MS ? 'sobrado' : ms <= UMBRAL_JUSTO_MS ? 'justo' : 'no-llega'
    assert.strictEqual(resultado.veredicto, esperado)
  })

  test('declara las condiciones en vez de callarlas', () => {
    const c = resultado.condiciones
    assert.ok(c.fecha)
    assert.strictEqual(typeof c.duracionPruebaS, 'number')
    assert.strictEqual(typeof c.sostenida, 'boolean')
    assert.ok(c.hilosWhisper > 0, 'debe registrar los hilos usados')
    // Una prueba de 3 rondas es corta: tiene que avisar de que no ve el
    // throttling térmico, en vez de dar el número como si fuera definitivo.
    assert.strictEqual(c.sostenida, false)
    assert.match(c.avisoSostenida, /temperatura/)
  })

  test('el informe no enseña la memoria libre, que es un dato que engaña', () => {
    // os.freemem() infravalora mucho la disponible real en Windows. Un
    // "0,1 GB libres" en el informe alarmaría al cliente sin motivo.
    const txt = informe(resultado, perfil)
    assert.doesNotMatch(txt, /GB libres/, 'no debe mostrar la memoria libre')
    assert.match(txt, /GB de memoria/, 'sí debe mostrar la total, que es fiable')
  })

  test('el informe es legible y trae lo esencial', () => {
    const txt = informe(resultado, perfil)
    assert.match(txt, /TEST DE ADMISIÓN/)
    assert.match(txt, /segundos/)
    assert.match(txt, /p95/)
    assert.match(txt, /CONDICIONES/)
    console.log('\n' + txt)
  })
})
