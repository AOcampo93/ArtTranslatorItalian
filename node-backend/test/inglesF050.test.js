/**
 * F050 — la configuración inglesa (PLAN.md §17.3).
 *
 * Una prueba por criterio de aceptación. Las 12 frases del detector son las del
 * encargo de F050, escritas sin signo para que el detector tenga que decidir por
 * la forma; no salen de una reunión real, porque todavía no hay ninguna en inglés
 * `[por medir]`.
 *
 *  1. La entrada «en» del registro: la URL lleva `language_codes=["en"]`, Marian es
 *     `opus-mt-en-es` y los prompts traducen del inglés y responden EN INGLÉS.
 *  2. El detector inglés acierta las 12 frases, y «Can you hear me?» es pregunta
 *     sin llamada.
 *  3. (La suite italiana verde y el diff sin tocar ningún archivo del italiano no
 *     se prueban aquí: lo comprueba `init.sh` y `git diff --stat`.)
 *
 * Ronda 2: una interrogativa que cierra con punto o exclamación es una afirmación,
 * y «No.» no es una abreviatura. El cierre de la sesión de `app:comprobar` cuando
 * algo lanza no se prueba aquí —nada ejecuta ese tramo—: se comprobó a mano.
 *
 * Y tres comprobaciones de piezas que F050 toca sin ser el inglés: las
 * abreviaturas, el prefijo «Translation:» y el WAV de la comprobación previa.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { obtenerIdioma } = require('../src/idiomas')
const { _internos } = require('../src/assemblyLive')
const detectorIngles = require('../src/detectorPreguntasIngles')
const { ABREVIATURAS_INGLES } = require('../src/abreviaturasIngles')
const { partirTurno, acabaCerrada } = require('../src/frases')
const { _internos: internosTraduccion } = require('../src/traduccionLlm')
const { leerMuestrasWav } = require('../src/wav')
const detectorItaliano = require('../src/questionDetector')

const FIXTURES = path.join(__dirname, 'fixtures')

// Los saltos de línea del prompt no son parte de la regla: se comparan con los
// espacios colapsados.
const plano = texto => texto.replace(/\s+/g, ' ')

// ── 1. La entrada «en» ──────────────────────────────────────────────────────

describe('F050 (1) — la entrada «en» del registro', () => {
  const en = obtenerIdioma('en')

  test('AssemblyAI recibe «en», Marian es opus-mt-en-es y hay un audio de prueba', () => {
    assert.strictEqual(en.codigo, 'en')
    assert.strictEqual(en.codigoStt, 'en')
    assert.strictEqual(en.prefijoContexto, 'Project')
    assert.strictEqual(en.modeloMarian, 'Xenova/opus-mt-en-es')
    assert.strictEqual(en.calentamientoMarian, 'hello')
    assert.strictEqual(en.detector, detectorIngles)
    assert.strictEqual(en.abreviaturas, ABREVIATURAS_INGLES)
    assert.ok(Object.isFrozen(en))

    const url = new URL(_internos.construirUrl({ idioma: en.codigoStt, glosario: [], contexto: '' }))
    assert.strictEqual(url.searchParams.get('language_codes'), '["en"]')

    assert.strictEqual(en.muestra, 'ingles.wav')
    assert.ok(fs.existsSync(path.join(FIXTURES, en.muestra)), 'el audio de la comprobación previa existe')
  })

  test('los prompts traducen del inglés, responden EN INGLÉS y resumen en español de México', () => {
    const traduccion = plano(en.promptTraduccion('BLOQUE-X', ['Good morning everyone.', "Let's start."]))
    assert.match(traduccion, /traductor profesional de inglés a español/)
    assert.match(traduccion, /BLOQUE-X/, 'el contexto de la reunión entra')
    assert.match(traduccion, /«Good morning everyone\.» «Let's start\.»/, 'las dos frases anteriores entran como contexto')
    assert.match(traduccion, /español de México/)
    assert.match(traduccion, /nunca «vosotros»/)
    assert.match(traduccion, /«you» no distingue entre «tú» y «usted»/)
    assert.match(traduccion, /«usted» si el contexto muestra un trato claramente formal/)
    assert.match(traduccion, /mismo trato en toda la reunión/)
    assert.match(traduccion, /no lleva «\?», la traducción no es una pregunta/)
    assert.match(traduccion, /conserva los nombres propios/i)
    assert.doesNotMatch(traduccion, /italiano/i, 'ni una palabra del idioma de al lado')

    const respuesta = plano(en.promptRespuesta('BLOQUE-X'))
    assert.match(respuesta, /BLOQUE-X/)
    assert.match(respuesta, /Escribe en INGLÉS/)
    assert.match(respuesta, /dos o tres frases, máximo 500 caracteres/)
    assert.match(respuesta, /Del perfil usa SOLO lo que la pregunta pide/)
    assert.match(respuesta, /NUNCA inventes hechos personales/)
    assert.match(respuesta, /nada sobre el interlocutor ni sobre su empresa que no esté en la transcripción o en el contexto/)
    assert.doesNotMatch(respuesta, /italiano/i)

    const resumen = plano(en.promptResumen('BLOQUE-X'))
    assert.match(resumen, /reunión en inglés/)
    assert.match(resumen, /SIEMPRE en español de México, aunque la reunión sea en inglés/)
    assert.match(resumen, /"tema_nuevo"/, 'el mismo JSON que lee MotorResumen')
    assert.doesNotMatch(resumen, /italiano/i)
  })
})

// ── 2. El detector inglés ───────────────────────────────────────────────────

describe('F050 (2) — el detector inglés', () => {
  const { analizar, preguntaEnCamino } = detectorIngles

  test('las 12 frases sin signo: 6 preguntas y 6 afirmaciones, todas bien', () => {
    const CASOS = [
      // Una pregunta por cada forma que mira el detector.
      ['Can you walk me through the timeline', true, 'auxiliar invertido'],
      ['Have you finished the report', true, 'auxiliar invertido'],
      ['Do you think we can ship by Friday', true, 'auxiliar invertido'],
      ["What's your take on the proposal", true, 'interrogativa'],
      ["You'll send it tomorrow, right", true, 'coletilla'],
      ['Could you share your screen', true, 'petición'],
      // Afirmaciones: las muletillas del inicio y la subordinada con «when».
      ['So the budget covers maintenance too', false, 'muletilla «so»'],
      ['You know, the client asked for more time', false, 'muletilla «you know»'],
      ['Well, that makes sense to me', false, 'muletilla «well»'],
      ['I mean, we can ship by Friday', false, 'muletilla «I mean»; «we can» no está invertido'],
      ['When we finished the report, we sent it to the client', false, '«when» sin auxiliar'],
      ['The meeting is scheduled for Monday', false, 'afirmación llana'],
    ]
    const fallos = CASOS
      .filter(([frase, esperado]) => analizar(frase).esPregunta !== esperado)
      .map(([frase, esperado, nota]) => `«${frase}» debía ser ${esperado ? 'pregunta' : 'afirmación'} (${nota})`)
    assert.deepStrictEqual(fallos, [])

    // Las preguntas, además, merecen la llamada: no son cortesía ni fragmentos.
    for (const [frase, esperado] of CASOS) {
      if (esperado) assert.strictEqual(analizar(frase).merecePena, true, `«${frase}» merece una llamada`)
    }
  })

  test('«Can you hear me?» es pregunta pero es cortesía: no gasta una llamada', () => {
    const r = analizar('Can you hear me?')
    assert.strictEqual(r.esPregunta, true)
    assert.strictEqual(r.merecePena, false)
  })

  test('una interrogativa que cierra con punto o exclamación es una afirmación; el auxiliar invertido y las coletillas siguen', () => {
    // MEDIDO por el líder en la revisión de F050: la primera salía como pregunta.
    // AssemblyAI puntúa casi siempre, así que un punto dice «afirmación», igual que
    // «perché» con punto en italiano (F049).
    for (const frase of ["What's important is that we ship on time.", 'When will it be ready.', 'Why would anyone do that!']) {
      assert.strictEqual(analizar(frase).esPregunta, false, `«${frase}» cierra con punto o exclamación`)
    }
    // Sin ninguna puntuación sigue valiendo «interrogativa + auxiliar» (las 12 de
    // arriba), y «?!» es signo y no una exclamación.
    assert.strictEqual(analizar('When will it be ready').esPregunta, true)
    assert.strictEqual(analizar('What are we doing here?!').esPregunta, true)
    // Lo que no cambia: una petición con punto sigue mereciendo respuesta, y la coletilla.
    const peticion = analizar('Can you send me the file.')
    assert.strictEqual(peticion.esPregunta, true)
    assert.strictEqual(peticion.merecePena, true)
    assert.strictEqual(analizar("You'll send it tomorrow, right.").esPregunta, true)
  })

  test('tiene la forma del detector italiano, y avisa de la pregunta en camino', () => {
    assert.deepStrictEqual(Object.keys(analizar('Can you hear me?')), Object.keys(detectorItaliano.analizar('Mi senti?')))
    assert.deepStrictEqual(Object.keys(analizar('')), Object.keys(detectorItaliano.analizar('')))
    assert.strictEqual(preguntaEnCamino('Can you'), true)
    assert.strictEqual(preguntaEnCamino('What do'), true)
    assert.strictEqual(preguntaEnCamino('When we'), false, 'una subordinada, no una pregunta')
    assert.strictEqual(preguntaEnCamino('The client asked'), false)
  })
})

// ── Lo que F050 toca sin ser el inglés ──────────────────────────────────────

describe('F050 — abreviaturas, prefijo «Translation:» y el audio de la comprobación', () => {
  test('las abreviaturas inglesas no cortan la oración, «e.g.» e «i.e.» tampoco', () => {
    const turno = 'Please ask Mr. Smith and Dr. Lee about Fig. 3, e.g. the budget, i.e. the total. Thanks.'
    assert.deepStrictEqual(
      partirTurno(turno, { abreviaturas: obtenerIdioma('en').abreviaturas }).oraciones,
      ['Please ask Mr. Smith and Dr. Lee about Fig. 3, e.g. the budget, i.e. the total.', 'Thanks.'])
    // Con las italianas, «Mr.» sí cortaba: es lo que la lista nueva evita.
    assert.ok(partirTurno(turno).oraciones.length > 2)

    // «No.» es una respuesta, no una abreviatura: «I said no.» cierra oración en vez
    // de quedarse de cola provisional esperando al turno siguiente (ronda 2).
    const opciones = { abreviaturas: obtenerIdioma('en').abreviaturas }
    assert.strictEqual(acabaCerrada('I said no.', opciones), true)
    assert.deepStrictEqual(partirTurno('Did you finish it? No. We still need the numbers.', opciones).oraciones,
      ['Did you finish it?', 'No.', 'We still need the numbers.'])
  })

  test('el LLM puede anunciar la traducción con «Translation:» y se quita', () => {
    assert.strictEqual(internosTraduccion.limpiar('Translation: Buenos días a todos'), 'Buenos días a todos')
    assert.strictEqual(internosTraduccion.limpiar('Traduzione: Buenos días a todos'), 'Buenos días a todos')
  })

  test('el audio de prueba se lee desde el trozo data, no desde el byte 44', () => {
    for (const nombre of ['italiano.wav', 'ingles.wav']) {
      const bytes = fs.readFileSync(path.join(FIXTURES, nombre))
      // En estos dos archivos el trozo `data` llega hasta el final.
      const inicio = bytes.indexOf('data') + 8
      assert.notStrictEqual(inicio, 44, `${nombre} lleva un trozo LIST: su cabecera no mide 44 bytes`)

      const muestras = leerMuestrasWav(path.join(FIXTURES, nombre))
      assert.strictEqual(muestras.length, (bytes.length - inicio) / 2, `${nombre}: todas las muestras y ninguna más`)
      assert.strictEqual(muestras[0], bytes.readInt16LE(inicio) / 32768, `${nombre}: empieza donde empieza el audio`)
    }
  })
})
