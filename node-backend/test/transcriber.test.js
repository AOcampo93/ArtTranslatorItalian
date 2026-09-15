/**
 * Pruebas del transcriptor italiano.
 *
 * Lo que de verdad importa comprobar aquí no es que transcriba —eso lo hace
 * whisper— sino los tres invariantes de PLAN.md §0 que el proyecto base
 * incumplía: que el modelo NO se recargue en cada petición, que no escuche en
 * 0.0.0.0, y que el hijo no quede huérfano.
 *
 * El audio de prueba se genera con la voz italiana de macOS (ver
 * `fixtures/README.md`), así que es reproducible y no depende de una descarga.
 */

'use strict'

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Transcriber, _internos } = require('../src/transcriber')

const RAIZ = path.join(__dirname, '..', '..')
const BINARIO = path.join(RAIZ, 'bin', 'whisper-server')
const MODELO = path.join(RAIZ, 'models', 'ggml-small.bin')
const WAV = path.join(__dirname, 'fixtures', 'italiano.wav')

const HAY_ENTORNO = fs.existsSync(BINARIO) && fs.existsSync(MODELO) && fs.existsSync(WAV)

describe('limpieza de artefactos de whisper', () => {
  test('quita [BLANK_AUDIO] y el sonido ambiente', () => {
    const sucio = '[BLANK_AUDIO] Buongiorno (musica di sottofondo) a tutti.'
    assert.strictEqual(_internos.limpiar(sucio), 'Buongiorno a tutti.')
  })

  test('colapsa los espacios sobrantes', () => {
    assert.strictEqual(_internos.limpiar('  ciao    a   tutti '), 'ciao a tutti')
  })
})

describe('códigos de salida de Windows', () => {
  // Medido en una VM real: sin el runtime de MSVC, whisper-server muere con
  // 0xC0000135 antes de imprimir nada. Un número suelto no le dice al usuario
  // qué hacer; el mensaje sí.
  test('0xC0000135 se traduce a "falta una DLL" con su arreglo', () => {
    const m = _internos.explicarCodigo(3221225781)
    assert.match(m, /falta una DLL/i)
    assert.match(m, /C0000135/, 'debe mostrar el código en hexadecimal')
    // Ya no dice "ejecuta vc_redist": las cuatro DLL del runtime viajan junto
    // al binario, así que ese consejo mandaría al usuario a un archivo que no
    // existe. El arreglo tiene que ser accionable HOY.
    assert.doesNotMatch(m, /vc_redist/i, 'el redistribuible ya no viaja en el paquete')
    assert.match(m, /dependencias-windows/, 'debe decir cómo comprobarlo')
  })

  test('un código desconocido no se inventa una causa', () => {
    const m = _internos.explicarCodigo(42)
    assert.match(m, /terminó con código 42/)
    assert.doesNotMatch(m, /vc_redist/)
  })

  test('los códigos conocidos traen causa y arreglo', () => {
    for (const [code, info] of Object.entries(_internos.CODIGOS_WINDOWS)) {
      assert.ok(info.causa, `${code} sin causa`)
      assert.ok(info.arreglo, `${code} sin arreglo accionable`)
    }
  })

  test('cada clave coincide con el hexadecimal de su comentario', () => {
    // Esta es la prueba que faltaba. La anterior solo comprobaba que los textos
    // no estuvieran vacíos, y con eso pasó inadvertido que 3221225595 estaba
    // etiquetado 0xC0000139 cuando es 0xC000007B — y que el 0xC0000139 de
    // verdad (3221225785) no estaba en la tabla, así que ese fallo nunca se
    // habría traducido.
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'src', 'transcriber.js'), 'utf8')
    const vistos = []
    for (const m of fuente.matchAll(/^\s*(\d{7,10}): \{\s*\/\/ (0x[0-9A-F]{8})/gm)) {
      const [, clave, hex] = m
      const esperado = '0x' + (Number(clave) >>> 0).toString(16).toUpperCase().padStart(8, '0')
      assert.strictEqual(hex, esperado, `${clave} está etiquetado ${hex} y es ${esperado}`)
      vistos.push(clave)
    }
    assert.strictEqual(vistos.length, Object.keys(_internos.CODIGOS_WINDOWS).length,
      'cada entrada de la tabla debe llevar su hexadecimal en el comentario')
  })

  test('están los dos códigos de DLL que de verdad se distinguen', () => {
    // 0xC0000135 = no se encontró la DLL. 0xC0000139 = está, pero le falta el
    // símbolo. Son causas distintas y arreglos distintos, y el segundo faltaba.
    assert.ok(_internos.CODIGOS_WINDOWS[3221225781], 'falta 0xC0000135')
    assert.ok(_internos.CODIGOS_WINDOWS[3221225785], 'falta 0xC0000139')
  })
})

describe('elección de hilos', () => {
  test('nunca devuelve menos de 2 ni más que los núcleos lógicos', () => {
    const n = Transcriber.hilosRecomendados()
    assert.ok(n >= 2, `devolvió ${n}`)
    assert.ok(n <= require('os').cpus().length, `devolvió ${n}`)
  })

  test('NUNCA pide más hilos que núcleos disponibles', () => {
    // Esto sustituye a una prueba que exigía no pasarse de los núcleos FÍSICOS,
    // justificándolo con una degradación "de hasta 2x" que nadie había medido.
    // Lo medido es otra cosa, y más grave: el límite que importa son los
    // núcleos DISPONIBLES, y pasarse de ahí no degrada un 2x sino que se cae
    // por un precipicio — 12 hilos sobre 10 núcleos dieron 73.652 ms frente a
    // 909 ms con 8, o sea 81 veces más. La causa está en ggml: la barrera entre
    // hilos es espera activa, así que un hilo que espera quema un núcleo.
    for (const logicos of [1, 2, 3, 4, 6, 8, 10, 16, 32]) {
      const n = Transcriber.hilosRecomendados({ logicos })
      assert.ok(n <= logicos, `con ${logicos} disponibles pidió ${n} hilos`)
      assert.ok(n >= 1, `con ${logicos} disponibles pidió ${n}`)
    }
  })

  test('reserva núcleos para la videollamada', () => {
    // El óptimo medido se mueve con la carga: en reposo ganó 8 hilos (909 ms),
    // con 4 de 10 núcleos ocupados ganó 6 (1.500 ms) y 8 pasó a ser 1,4x peor.
    // La app nunca corre en reposo, así que la regla reserva núcleos.
    for (const logicos of [8, 10, 16, 32]) {
      const n = Transcriber.hilosRecomendados({ logicos })
      assert.ok(n <= logicos - 2,
        `con ${logicos} disponibles pidió ${n}: no deja sitio a la videollamada`)
    }
  })

  test('el óptimo medido en el M5 con carga es lo que devuelve', () => {
    // Anclado a la medición concreta: 10 núcleos, 4 ocupados, mejor 6 hilos.
    assert.strictEqual(Transcriber.hilosRecomendados({ logicos: 10 }), 6)
  })

  test('una firma equivocada no puede colar un número peligroso', () => {
    // La versión anterior recibía `nucleosFisicos` posicional. Si alguien
    // llamara con la costumbre vieja, con firma de objeto cae al valor por
    // defecto en vez de tomar 4 como si fueran los lógicos y devolver 2.
    const conObjeto = Transcriber.hilosRecomendados({ logicos: 8 })
    assert.strictEqual(conObjeto, 4)
    assert.strictEqual(Transcriber.hilosRecomendados(8), Transcriber.hilosRecomendados())
  })

  test('WHISPER_HILOS anula la heurística', () => {
    // Necesario en máquina virtual: la heurística está calibrada sobre los
    // núcleos lógicos de una CPU híbrida real y con pocos vCPU se queda corta.
    const previo = process.env.WHISPER_HILOS
    try {
      process.env.WHISPER_HILOS = '6'
      assert.strictEqual(Transcriber.hilosRecomendados(), 6)
      process.env.WHISPER_HILOS = 'nada'
      assert.ok(Transcriber.hilosRecomendados() >= 2, 'un valor inválido cae a la heurística')
    } finally {
      if (previo === undefined) delete process.env.WHISPER_HILOS
      else process.env.WHISPER_HILOS = previo
    }
  })

  test('en CPU híbrida no usa todos los núcleos', () => {
    // El fallo que esto previene: en un i9-13900HX (8 P + 16 E) usar 22 hilos
    // rinde PEOR que usar 8, porque los P-cores esperan a los E-cores.
    const n = Transcriber.hilosRecomendados()
    const nombre = (require('os').cpus()[0]?.model || '').toLowerCase()
    if (/12th|13th|14th|15th|core ultra|apple m/.test(nombre)) {
      assert.ok(n <= 8, `CPU híbrida detectada pero devolvió ${n} hilos`)
    }
  })
})

describe('rechazo de modelos solo-inglés', () => {
  test('no arranca con un modelo .en', async () => {
    const t = new Transcriber({ binario: BINARIO, modelo: '/tmp/ggml-small.en.bin' })
    await assert.rejects(() => t.start(), /solo-inglés|no encontrado/)
  })
})

describe('puerto efímero en loopback', () => {
  test('el puerto pedido es alto y utilizable', async () => {
    const p = await _internos.puertoLibre()
    assert.ok(p > 1024, `puerto ${p} demasiado bajo`)
    assert.ok(p < 65536)
  })
})

describe('transcripción real', { skip: HAY_ENTORNO ? false : 'falta binario, modelo o audio' }, () => {
  let tr

  before(async () => {
    tr = new Transcriber({ binario: BINARIO, modelo: MODELO })
    await tr.start()
  }, { timeout: 120000 })

  after(() => { if (tr) tr.stop() })

  test('transcribe italiano reconocible', async () => {
    const wav = fs.readFileSync(WAV)
    const r = await tr.transcribir(wav)
    assert.ok(r.texto.length > 20, `salida demasiado corta: "${r.texto}"`)
    // Palabras que TIENEN que estar: si falla, o el idioma está mal o el
    // modelo no es el que creemos.
    assert.match(r.texto, /buongiorno/i, `no dice buongiorno: "${r.texto}"`)
    assert.match(r.texto, /riunione/i, `no dice riunione: "${r.texto}"`)
    assert.match(r.texto, /consegna|cliente/i, `falta la segunda frase: "${r.texto}"`)
    console.log(`\n[transcripción] ${r.ms} ms · "${r.texto}"`)
  }, { timeout: 120000 })

  test('el modelo NO se recarga entre peticiones', async () => {
    const wav = fs.readFileSync(WAV)
    const a = await tr.transcribir(wav)
    const b = await tr.transcribir(wav)

    // Si el modelo se recargara, la segunda petición tardaría lo mismo que la
    // primera más los ~3-5 s de leer 465 MB de disco. Que sean comparables es
    // la prueba de que se queda en memoria: es justo lo que el proyecto base
    // hacía mal, recargándolo cada 2 segundos.
    const tolerancia = a.ms * 2 + 1500
    assert.ok(b.ms < tolerancia,
      `2a petición ${b.ms} ms frente a 1a ${a.ms} ms: parece que recarga el modelo`)
    assert.strictEqual(a.texto, b.texto, 'el mismo audio debe dar el mismo texto')
    console.log(`[sin recarga] 1a=${a.ms} ms  2a=${b.ms} ms`)
  }, { timeout: 120000 })

  test('escucha en 127.0.0.1 y no en 0.0.0.0', () => {
    // El fallo que esto previene: bind a 0.0.0.0 dispara el diálogo del
    // Firewall de Windows, el usuario cancela, y la app queda rota para
    // siempre sin ningún mensaje.  (PLAN.md §0.2)
    const salida = execSync(`lsof -nP -iTCP:${tr.puerto} -sTCP:LISTEN || true`).toString()
    assert.ok(salida.includes('127.0.0.1'), `no escucha en loopback:\n${salida}`)
    assert.ok(!salida.includes('*:'), `escucha en todas las interfaces:\n${salida}`)
  })

  test('stop() mata el proceso y no deja huérfanos', async () => {
    const otro = new Transcriber({ binario: BINARIO, modelo: MODELO })
    await otro.start()
    const pid = otro.proc.pid
    const puerto = otro.puerto
    otro.stop()

    await new Promise(r => setTimeout(r, 1500))
    assert.strictEqual(otro.estaVivo, false)

    const vivo = execSync(`ps -p ${pid} -o pid= || true`).toString().trim()
    assert.strictEqual(vivo, '', `el proceso ${pid} sigue vivo tras stop()`)

    const puertoOcupado = execSync(`lsof -nP -iTCP:${puerto} -sTCP:LISTEN || true`).toString().trim()
    assert.strictEqual(puertoOcupado, '', `el puerto ${puerto} sigue ocupado`)
  }, { timeout: 120000 })
})
