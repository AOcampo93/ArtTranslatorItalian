/**
 * Pruebas del pipeline completo.
 *
 * La diferencia con las otras pruebas: aquí el audio **llega a trozos**, como
 * en una reunión real, en vez de entregarse como archivo completo. Es lo único
 * que ejercita la decisión difícil, que es cuándo cortar.
 */

'use strict'

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { Pipeline, SAMPLE_RATE, _internos } = require('../src/pipeline')
const { Transcriber } = require('../src/transcriber')
const translator = require('../src/translator')

const RAIZ = path.join(__dirname, '..', '..')
const BINARIO = path.join(RAIZ, 'bin', 'whisper-server')
const MODELO = path.join(RAIZ, 'models', 'ggml-small.bin')
const WAV = path.join(__dirname, 'fixtures', 'italiano.wav')
const HAY_ENTORNO = [BINARIO, MODELO, WAV].every(p => fs.existsSync(p))

/** Lee el WAV de prueba y devuelve las muestras en Float32 normalizado. */
function muestrasDelWav (ruta) {
  const buf = fs.readFileSync(ruta)
  // Buscamos el chunk 'data' en vez de asumir cabecera de 44 bytes: los WAV
  // reales traen chunks extra (LIST, fact) y asumir 44 mete ruido al principio.
  let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      const n = Math.floor(size / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768
      return out
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('no se encontró el chunk data en el WAV')
}

/** Añade silencio al final para que el VAD cierre la última frase. */
function conSilencio (muestras, ms) {
  const extra = new Float32Array(Math.floor(SAMPLE_RATE * ms / 1000))
  const out = new Float32Array(muestras.length + extra.length)
  out.set(muestras, 0)
  return out
}

describe('utilidades sin dependencias', () => {
  test('rms distingue silencio de voz', () => {
    const silencio = new Float32Array(1000)
    const voz = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 3) * 0.5)
    assert.ok(_internos.rms(silencio) < 0.001)
    assert.ok(_internos.rms(voz) > 0.1)
  })

  test('el WAV generado tiene cabecera válida de 16 kHz mono', () => {
    const wav = _internos.aWav(new Float32Array(1600))
    assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF')
    assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE')
    assert.strictEqual(wav.readUInt32LE(24), SAMPLE_RATE, 'sample rate')
    assert.strictEqual(wav.readUInt16LE(22), 1, 'mono')
    assert.strictEqual(wav.readUInt16LE(34), 16, 'PCM16')
  })
})

describe('filtro de alucinaciones', () => {
  // Este repertorio es el que Whisper produce en italiano sobre silencio. Sin
  // este filtro, el usuario leería créditos de subtítulos como si su
  // interlocutor los hubiera dicho.
  const BASURA = [
    'Sottotitoli e revisione a cura di QTSS',
    'Sottotitoli creati dalla comunità Amara.org',
    'www.amara.org',
    'Grazie per aver guardato il video!',
    'Iscrivetevi al canale',
    '.',
  ]
  for (const b of BASURA) {
    test(`descarta: "${b.slice(0, 40)}"`, () => {
      assert.strictEqual(_internos.esBasura(b), true)
    })
  }

  test('descarta bucles de repetición', () => {
    assert.strictEqual(_internos.esBasura(Array(5).fill('il cliente ha').join(' ')), true)
  })

  test('NO descarta habla normal', () => {
    const buena = 'Il cliente ha chiesto di anticipare la consegna alla prossima settimana.'
    assert.strictEqual(_internos.esBasura(buena), false)
  })
})

describe('segmentación por silencio (sin modelos)', () => {
  // Dobles de prueba: aquí solo nos interesa DÓNDE corta, no qué transcribe.
  const fakeTranscriber = { transcribir: async () => ({ texto: 'frase italiana de prueba', ms: 1 }) }
  const fakeTranslator = { traducir: async () => ({ es: 'frase española de prueba', ms: 1 }) }

  function bloqueVoz (ms) {
    const n = Math.floor(SAMPLE_RATE * ms / 1000)
    return Float32Array.from({ length: n }, (_, i) => Math.sin(i / 4) * 0.4)
  }
  function bloqueSilencio (ms) {
    return new Float32Array(Math.floor(SAMPLE_RATE * ms / 1000))
  }

  test('una pausa larga separa dos frases', async () => {
    const p = new Pipeline({ transcriber: fakeTranscriber, translator: fakeTranslator })
    const frases = []
    p.on('frase', f => frases.push(f))
    p.start()

    p.alimentar(bloqueVoz(900))
    p.alimentar(bloqueSilencio(800))   // supera SILENCIO_CIERRE_MS -> corta
    p.alimentar(bloqueVoz(900))
    await p.stop()

    assert.strictEqual(frases.length, 2, `esperaba 2 frases, salieron ${frases.length}`)
  })

  test('una pausa corta NO parte la frase', async () => {
    const p = new Pipeline({ transcriber: fakeTranscriber, translator: fakeTranslator })
    const frases = []
    p.on('frase', f => frases.push(f))
    p.start()

    p.alimentar(bloqueVoz(700))
    p.alimentar(bloqueSilencio(200))   // por debajo del umbral de cierre
    p.alimentar(bloqueVoz(700))
    await p.stop()

    assert.strictEqual(frases.length, 1, `esperaba 1 frase, salieron ${frases.length}`)
  })

  test('el silencio sin voz previa no genera nada', async () => {
    const p = new Pipeline({ transcriber: fakeTranscriber, translator: fakeTranslator })
    const frases = []
    p.on('frase', f => frases.push(f))
    p.start()
    p.alimentar(bloqueSilencio(3000))
    await p.stop()
    assert.strictEqual(frases.length, 0, 'no debe decodificar silencio')
  })

  test('el watchdog NO dispara sobre silencio', async () => {
    // El fallo que esto previene: forzar un decode cuando no hay energía
    // produce una alucinación que el usuario lee como frase real.
    const p = new Pipeline(
      { transcriber: fakeTranscriber, translator: fakeTranslator },
      { watchdogMs: 50 }
    )
    const frases = []
    p.on('frase', f => frases.push(f))
    p.start()

    for (let i = 0; i < 6; i++) {
      p.alimentar(bloqueSilencio(200))
      await new Promise(r => setTimeout(r, 20))
    }
    await p.stop()
    assert.strictEqual(frases.length, 0, 'el watchdog disparó sobre silencio')
  })

  test('descarta la alucinación en vez de emitirla', async () => {
    const alucinado = { transcribir: async () => ({ texto: 'Sottotitoli e revisione a cura di QTSS', ms: 1 }) }
    const p = new Pipeline({ transcriber: alucinado, translator: fakeTranslator })
    const frases = []
    const descartes = []
    p.on('frase', f => frases.push(f))
    p.on('descartada', d => descartes.push(d))
    p.start()
    p.alimentar(bloqueVoz(900))
    p.alimentar(bloqueSilencio(800))
    await p.stop()

    assert.strictEqual(frases.length, 0, 'no debe emitir la alucinación')
    assert.strictEqual(descartes.length, 1, 'debe registrar el descarte')
  })
})

describe('end-to-end con audio real', { skip: HAY_ENTORNO ? false : 'falta binario, modelo o audio' }, () => {
  let tr, p

  before(async () => {
    tr = new Transcriber({ binario: BINARIO, modelo: MODELO })
    await tr.start()
    await translator.cargar()
  }, { timeout: 180000 })

  after(() => { if (tr) tr.stop() })

  test('de audio italiano a español, alimentado a trozos', async () => {
    p = new Pipeline({ transcriber: tr, translator })
    const frases = []
    p.on('frase', f => frases.push(f))
    p.on('error', e => assert.fail(`el pipeline falló: ${e.message}`))
    p.start()

    // Alimentamos en trozos de 100 ms, como haría la captura real.
    const muestras = conSilencio(muestrasDelWav(WAV), 900)
    const trozo = Math.floor(SAMPLE_RATE * 0.1)
    for (let i = 0; i < muestras.length; i += trozo) {
      p.alimentar(muestras.subarray(i, Math.min(i + trozo, muestras.length)))
    }
    await p.stop()

    assert.ok(frases.length >= 1, 'no salió ninguna frase')

    const it = frases.map(f => f.it).join(' ')
    const es = frases.map(f => f.es).join(' ')
    assert.match(it, /buongiorno/i, `italiano inesperado: "${it}"`)
    assert.match(es, /d[ií]as|reuni[óo]n/i, `español inesperado: "${es}"`)

    console.log(`\n[end-to-end] ${frases.length} frase(s)`)
    for (const f of frases) {
      console.log(`  ${f.segundosAudio}s audio · whisper ${f.msWhisper}ms · marian ${f.msMarian}ms · total ${f.msTotal}ms`)
      console.log(`    IT: ${f.it}`)
      console.log(`    ES: ${f.es}`)
    }
  }, { timeout: 180000 })
})
