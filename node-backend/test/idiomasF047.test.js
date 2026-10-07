/**
 * F047 — el registro de idiomas: el italiano entra sin tocarse.
 *
 * El criterio (PLAN.md §17.3 y §0.20): con el idioma `'it'` o sin decir
 * idioma, el código del STT, el modelo de Marian, las abreviaturas, el
 * detector y los prompts son exactamente los de v0.9.
 *
 * Se comprueba por IDENTIDAD y no por parecido. La entrada `it` APUNTA a las
 * piezas de siempre; una copia idéntica hoy sería una pieza que mañana se
 * desvía sin que nadie lo vea, y de ahí a degradar el italiano en silencio hay
 * un paso (§0.20). La otra mitad de la garantía es que la suite anterior pasa
 * sin modificar ninguna prueba.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { obtenerIdioma, IDIOMA_POR_DEFECTO } = require('../src/idiomas')
const traductor = require('../src/translator')
const frases = require('../src/frases')
const detectorItaliano = require('../src/questionDetector')
const prompts = require('../../shared/prompts')
const { AssemblyLiveTranscriber, _internos } = require('../src/assemblyLive')
const { MotorRespuestas, MotorResumen } = require('../src/respuestas')
const { crearTraductorLlm } = require('../src/traduccionLlm')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')

/** Saca de `mainApp.js` el tramo entre dos anclas, y falla si no está donde debe. */
function tramo (desde, hasta) {
  const fuente = fs.readFileSync(MAIN_APP, 'utf8')
  const i = fuente.indexOf(desde)
  const j = fuente.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return fuente.slice(i, j)
}

describe('F047 — la entrada «it» son las piezas de hoy', () => {
  test('con «it» y sin código: la misma entrada, y cada pieza es la original', () => {
    const it = obtenerIdioma('it')
    assert.strictEqual(obtenerIdioma(), it, 'sin código es el italiano')
    assert.strictEqual(IDIOMA_POR_DEFECTO, 'it')

    assert.strictEqual(it.codigo, 'it')
    assert.strictEqual(it.codigoStt, 'it')
    assert.strictEqual(it.prefijoContexto, 'Progetto')
    assert.strictEqual(it.modeloMarian, 'Xenova/opus-mt-it-es')
    assert.strictEqual(it.modeloMarian, traductor.MODELO)
    assert.strictEqual(it.calentamientoMarian, 'ciao')
    assert.strictEqual(it.abreviaturas, frases.ABREVIATURAS, 'la lista de frases.js, no una copia')
    assert.strictEqual(it.detector, detectorItaliano, 'el módulo questionDetector, no uno parecido')
    assert.strictEqual(it.promptTraduccion, prompts.promptTraduccion)
    assert.strictEqual(it.promptRespuesta, prompts.promptRespuesta)
    assert.strictEqual(it.promptResumen, prompts.promptResumen)
    assert.strictEqual(it.muestra, 'italiano.wav')
    assert.ok(fs.existsSync(path.join(__dirname, 'fixtures', it.muestra)),
      'la muestra de la comprobación previa existe de verdad')
  })

  test('la URL de AssemblyAI lleva language_codes=["it"] con el código del registro y sin idioma', () => {
    const { construirUrl } = _internos
    const conRegistro = construirUrl({
      idioma: obtenerIdioma('it').codigoStt, glosario: [], contexto: '',
    })
    // F048: el nombre documentado (antes `language_code=it`, ver PLAN.md §17.8).
    assert.strictEqual(new URL(conRegistro).searchParams.get('language_codes'), '["it"]')

    // «Sin idioma»: lo que usa el transcriptor cuando nadie le dice cuál.
    const sinIdioma = new AssemblyLiveTranscriber({ apiKey: 'no-se-usa' })
    assert.strictEqual(construirUrl(sinIdioma.opciones), conRegistro,
      'con y sin idioma, la misma URL')
  })

  test('en cada sitio del motor, sin decir idioma valen las piezas del italiano', async () => {
    const it = obtenerIdioma()
    const llamar = async () => 'x'

    const motor = new MotorRespuestas({ llamar })
    assert.strictEqual(motor.detector, it.detector)
    assert.strictEqual(motor.promptRespuesta, it.promptRespuesta)
    assert.strictEqual(new MotorResumen({ llamar }).promptResumen, it.promptResumen)

    // El prompt de traducción se ve en lo que recibe el LLM.
    const vistos = []
    const traduccion = crearTraductorLlm({
      llamar: async sistema => { vistos.push(sistema); return 'Buenos días a todos' },
      bloqueContexto: () => 'BLOQUE',
      respaldo: { traducir: async () => { throw new Error('no debía caer a Marian') } },
    })
    await traduccion.traducir('Buongiorno a tutti')
    assert.strictEqual(vistos[0], it.promptTraduccion('BLOQUE'))

    // Las abreviaturas: con las del registro, el mismo troceo que sin decirlas,
    // y es el italiano de verdad: «dott.» no cierra oración.
    const turno = 'Il dott. Rossi ha chiamato. Poi ha scritto.'
    assert.deepStrictEqual(frases.partirTurno(turno), frases.partirTurno(turno, { abreviaturas: it.abreviaturas }))
    assert.deepStrictEqual(frases.partirTurno(turno).oraciones,
      ['Il dott. Rossi ha chiamato.', 'Poi ha scritto.'])
  })

  test('las abreviaturas por opción mandan de verdad: otra lista parte distinto, también en acabaCerrada', () => {
    // Aún no hay segundo idioma: una lista de mentira basta para ver que la opción llega a la regla.
    const turno = 'Good morning. Please welcome Mr.'
    const otras = { abreviaturas: new Set(['mr']) }
    assert.strictEqual(frases.partirTurno(turno).cola, '', 'con las italianas «Mr.» cierra oración')
    assert.deepStrictEqual(
      { completas: frases.partirTurno(turno, otras).completas, cola: frases.partirTurno(turno, otras).cola },
      { completas: 'Good morning.', cola: 'Please welcome Mr.' })
    assert.strictEqual(frases.acabaCerrada(turno), true)
    assert.strictEqual(frases.acabaCerrada(turno, otras), false, 'y las dos funciones parten con las mismas')
  })

  test('un código desconocido lanza un error que dice cuál era, y no cae en italiano', () => {
    assert.throws(() => obtenerIdioma('xx'), /idioma desconocido «xx»/)
    assert.throws(() => obtenerIdioma(''), /idioma desconocido/, 'una cadena vacía no es «sin código»')
  })
})

describe('F047 — el motor reparte las piezas del idioma que recibe', () => {
  /** El tramo real de `montarMotores`, con el LLM, Marian y el renderer de mentira. */
  function montar () {
    const traducidos = []
    const sistemas = []
    const codigo = tramo('function montarMotores', 'const GRACIA_EN_VUELO_MS')
      + '\nreturn montarMotores'
    const fabrica = new Function(
      'obtenerIdioma', 'crearLlamador', 'clasificarError', 'traductor', 'contexto', 'aRenderer',
      'MotorRespuestas', 'MotorResumen', 'crearTraductorLlm', codigo)
    const montarMotores = fabrica(
      obtenerIdioma,
      // Un LLM que contesta vacío: obliga a la traducción a caer en Marian y deja ver el modelo.
      () => async sistema => { sistemas.push(sistema); return '' },
      err => ({ mensaje: err.message }),
      { traducir: async (texto, modelo) => { traducidos.push({ texto, modelo }); return { es: 'respaldo', ms: 1 } } },
      { buildContextBlock: () => ({ bloque: 'BLOQUE' }) },
      () => {},
      MotorRespuestas, MotorResumen, crearTraductorLlm)
    return { montarMotores, traducidos, sistemas }
  }

  test('con un idioma dado: su detector, sus prompts y su modelo de Marian; sin idioma, los italianos', async () => {
    const { montarMotores, traducidos, sistemas } = montar()
    const otro = {
      ...obtenerIdioma(),
      codigo: 'zz',
      modeloMarian: 'modelo-zz',
      detector: { analizar: () => ({ esPregunta: false }) },
      promptTraduccion: bloque => `TRADUCE-ZZ ${bloque}`,
      promptRespuesta: bloque => `RESPONDE-ZZ ${bloque}`,
      promptResumen: bloque => `RESUME-ZZ ${bloque}`,
    }

    const m = montarMotores({ perfil: null, ctx: null, claveLlm: 'una-clave', autosave: null, idioma: otro })
    assert.strictEqual(m.motor.detector, otro.detector)
    assert.strictEqual(m.motor.promptRespuesta, otro.promptRespuesta)
    assert.strictEqual(m.resumen.promptResumen, otro.promptResumen)
    // La caída a Marian se avisa por `console.warn`; aquí es lo que se provoca.
    const consolaOriginal = console.warn
    console.warn = () => {}
    try { await m.traductor.traducir('una frase de la reunión') } finally { console.warn = consolaOriginal }
    assert.deepStrictEqual(sistemas, ['TRADUCE-ZZ BLOQUE'], 'el LLM recibe el prompt de traducción de ese idioma')
    assert.deepStrictEqual(traducidos, [{ texto: 'una frase de la reunión', modelo: 'modelo-zz' }],
      'y el respaldo de Marian usa el modelo de ese idioma')

    const it = obtenerIdioma()
    const porDefecto = montarMotores({ perfil: null, ctx: null, claveLlm: 'una-clave', autosave: null })
    assert.strictEqual(porDefecto.motor.detector, it.detector)
    assert.strictEqual(porDefecto.motor.promptRespuesta, it.promptRespuesta)
    assert.strictEqual(porDefecto.resumen.promptResumen, it.promptResumen)
  })

  test('empezarSesion le da al transcriptor, a Marian y a los motores el idioma que recibe', async () => {
    // El tramo real desde la firma hasta armar la sesión, como lo ejecuta
    // `mainAppSesionF040.test.js`: con los once nombres que esa prueba fija.
    const codigo = tramo('async function empezarSesion', 'sesion = {')
      + '\nreturn { idSesion }\n}\nreturn empezarSesion'
    async function empezarCon (idioma) {
      const visto = {}
      const empezar = new Function(
        'sesion', 'leerClaves', 'contexto', 'AssemblyLiveTranscriber', 'registroConexionesStt',
        'traductor', 'db', 'path', 'app', 'Autosave', 'montarMotores', codigo)(
        null, () => ({ stt: 'clave' }),
        { actualizarPerfil () {}, crearPerfil: () => 1, activarPerfil () {}, crearContexto () {} },
        class { constructor (opciones) { visto.transcriptor = opciones } }, {},
        { cargar: async (...args) => { visto.cargar = args } },
        { startSession: () => 1 }, path, { getPath: () => '/no-existe-f047', getVersion: () => '0' },
        class { abrir () {} guardarCabecera () {} },
        opciones => { visto.montarMotores = opciones; return { motor: null, resumen: null, traductor: null } })
      await empezar({
        perfil: null, idioma,
        contexto: { tipo_proyecto: 'Logistica', contexto: 'Riunione con il fornitore' },
      })
      return visto
    }

    // El italiano: exactamente lo que v0.9 le daba al transcriptor y a Marian.
    const it = obtenerIdioma()
    const v = await empezarCon(it)
    assert.strictEqual(v.transcriptor.idioma, 'it')
    assert.strictEqual(v.transcriptor.contexto, 'Progetto: Logistica. Riunione con il fornitore')
    assert.deepStrictEqual(v.cargar, ['Xenova/opus-mt-it-es', 'ciao'])
    assert.strictEqual(v.montarMotores.idioma, it)

    // Otro idioma (de mentira): todo lo suyo, nada del italiano.
    const otro = {
      ...it, codigo: 'zz', codigoStt: 'zz', prefijoContexto: 'Project',
      modeloMarian: 'modelo-zz', calentamientoMarian: 'hello',
    }
    const w = await empezarCon(otro)
    assert.strictEqual(w.transcriptor.idioma, 'zz')
    assert.strictEqual(w.transcriptor.contexto, 'Project: Logistica. Riunione con il fornitore')
    assert.deepStrictEqual(w.cargar, ['modelo-zz', 'hello'])
    assert.strictEqual(w.montarMotores.idioma, otro)
  })
})
