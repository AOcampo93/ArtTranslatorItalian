/**
 * F048 — mejoras del motor común (PLAN.md §17.4, filas 1 a 5).
 *
 * Una prueba por criterio de aceptación. Los textos son los de los informes de
 * v0.6 a v0.9 `[medido]`, salvo el perfil, que es ficticio: el de un informe
 * nunca entra en el repositorio.
 *
 *  1. Las dos frases anteriores van de contexto en el prompt de sistema, y solo
 *     las definitivas: la cola provisional no entra en `s.anteriores`.
 *  2. Los nombres propios del contexto y del perfil entran en los términos clave.
 *  3. Una palabra suelta con contenido pasa por Marian; las interjecciones no.
 *  4. Los prompts que producen español piden el de México.
 *  5. El idioma viaja a AssemblyAI como `language_codes=["it"]`.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const { crearTraductorLlm } = require('../src/traduccionLlm')
const { promptTraduccion, promptResumen } = require('../../shared/prompts')
const { construirKeyterms } = require('../src/contexto')
const { obtenerIdioma } = require('../src/idiomas')
const { _internos } = require('../src/assemblyLive')
const { partirTurno, arrastrar, acabaCerrada } = require('../src/frases')
const { sanear } = require('../src/llm')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')

/** Saca de `mainApp.js` el tramo entre dos anclas, y falla si no está donde debe. */
function tramo (desde, hasta) {
  const fuente = fs.readFileSync(MAIN_APP, 'utf8')
  const i = fuente.indexOf(desde)
  const j = fuente.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i, `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return fuente.slice(i, j)
}

const esperar = ms => new Promise(r => setTimeout(r, ms))
async function hasta (cond, queEsperaba) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await esperar(5)
  }
  assert.fail(`nunca ocurrió: ${queEsperaba}`)
}

// ── 1. Las dos frases anteriores ────────────────────────────────────────────

describe('F048 (1) — las dos frases anteriores van de contexto en el sistema', () => {
  // Las tres frases son las del informe: «nella mata» salió «yerba mate» porque
  // lo que la aclara, «ho adorato la Mata Atlantica», estaba dos frases antes.
  const FRASE = "Perché nella mata c'è proprio l'energia, l'energia che arriva dalla terra e l'energia che arriva dagli alberi."
  const DOS_ANTES = "E abbiamo viaggiato quando stavamo da Giulia, un po' lei lavorava, io lavoravo online, "
    + 'e poi per un po\' di tempo, qualche settimana settimana si andava in giro per il Brasile e ho adorato la Mata Atlantica.'
  const UNA_ANTES = "Cioè, se io pensassi di tornare in Brasile, io vado nella questo tasto là."

  /** Un LLM que apunta lo que recibe, y un Marian que no debería hacer falta. */
  function montarTraductor () {
    const llamadas = []
    const traductor = crearTraductorLlm({
      llamar: async (sistema, usuario) => { llamadas.push({ sistema, usuario }); return 'Porque en la selva hay energía.' },
      respaldo: { traducir: async () => { throw new Error('no debía caer a Marian') } },
    })
    return { traductor, llamadas }
  }

  test('el sistema lleva las dos anteriores, en orden, y el mensaje es solo la frase', async () => {
    const { traductor, llamadas } = montarTraductor()

    await traductor.traducir(FRASE, { anteriores: [DOS_ANTES, UNA_ANTES] })
    assert.strictEqual(llamadas[0].usuario, FRASE, 'el mensaje del usuario sigue siendo solo la frase')
    assert.ok(llamadas[0].sistema.includes(
      `Lo que se dijo justo antes (solo contexto: no lo traduzcas ni lo repitas): «${DOS_ANTES}» «${UNA_ANTES}»`),
    `el sistema no lleva el bloque de contexto:\n${llamadas[0].sistema}`)
    assert.ok(DOS_ANTES.includes('ho adorato la Mata Atlantica'))

    // Hasta dos: con tres, la más vieja queda fuera.
    await traductor.traducir(FRASE, { anteriores: ['una muy vieja', DOS_ANTES, UNA_ANTES] })
    assert.ok(!llamadas[1].sistema.includes('una muy vieja'))
    assert.ok(llamadas[1].sistema.includes(DOS_ANTES))

    // Sin anteriores, el prompt no deja ningún bloque vacío.
    await traductor.traducir(FRASE)
    assert.doesNotMatch(llamadas[2].sistema, /Lo que se dijo justo antes/)
    assert.strictEqual(llamadas[2].sistema, promptTraduccion(''))
  })

  /**
   * Monta los tramos reales de `mainApp.js` que arman la sesión y procesan los
   * turnos, igual que `mainAppFrase.test.js`, con un traductor que apunta lo que
   * se le pide y un autoguardado en memoria.
   */
  function montarSesion () {
    const codigo = [
      tramo('const GRACIA_EN_VUELO_MS', '// ── La reunión'),
      tramo('sesion = {', "transcriptor.on('parcial'"),
      tramo("transcriptor.on('frase'", "transcriptor.on('estado'"),
      'return { sesion: s }',
    ].join('\n')

    const pedidos = []
    const traductor = {
      traducir: async (texto, opciones) => {
        pedidos.push({ texto, anteriores: [...(opciones?.anteriores || [])] })
        return { es: `[es] ${texto}`, ms: 5, traductor: 'marian' }
      },
    }
    const escritas = []
    const autosave = { abierto: true, escribir: linea => escritas.push(linea), cerrar () {} }
    const transcriptor = new EventEmitter()
    const pintado = []
    const motor = { considerar: async () => null }
    const resumen = { registrar: () => false }
    const fabrica = new Function(
      'transcriptor', 'traductor', 'traductorSesion', 'autosave', 'idSesion', 'motor', 'resumen',
      'aRenderer', 'db', 'console', 'sesion', 'partirTurno', 'arrastrar', 'acabaCerrada', 'sanear', codigo)
    const { sesion } = fabrica(transcriptor, traductor, traductor, autosave, 7, motor, resumen,
      (canal, datos) => pintado.push({ canal, datos }), {}, console, null,
      partirTurno, arrastrar, acabaCerrada, sanear)
    return { transcriptor, sesion, pedidos, escritas, pintado }
  }

  test('solo las líneas definitivas son contexto: la cola provisional y el arrastre no entran', async () => {
    const m = montarSesion()
    const turno = texto => m.transcriptor.emit('frase', { texto, msTranscribir: 100 })

    // Una línea cerrada y una cola a medias: la cola se pinta provisional.
    turno('Ciao a tutti. Oggi parliamo del')
    await hasta(() => m.pintado.some(p => p.datos.provisional), 'la cola provisional')
    assert.deepStrictEqual(m.sesion.anteriores, ['Ciao a tutti.'], 'la cola no es una frase todavía')

    // El turno siguiente cierra la cola: la línea definitiva lleva el arrastre pegado.
    turno('progetto di Rossi.')
    await hasta(() => m.escritas.length === 2, 'la línea con el arrastre')
    turno('Va bene, grazie.')
    await hasta(() => m.escritas.length === 3, 'la tercera línea')

    assert.deepStrictEqual(m.pedidos, [
      { texto: 'Ciao a tutti.', anteriores: [] },
      // La cola provisional ya ve la definitiva anterior...
      { texto: 'Oggi parliamo del', anteriores: ['Ciao a tutti.'] },
      // ...pero ella misma no es contexto de la unión que la completa.
      { texto: 'Oggi parliamo del progetto di Rossi.', anteriores: ['Ciao a tutti.'] },
      { texto: 'Va bene, grazie.', anteriores: ['Ciao a tutti.', 'Oggi parliamo del progetto di Rossi.'] },
    ])
    assert.deepStrictEqual(m.sesion.anteriores, ['Oggi parliamo del progetto di Rossi.', 'Va bene, grazie.'],
      'se quedan las dos últimas')
  })
})

// ── 2. Glosario automático ──────────────────────────────────────────────────

describe('F048 (2) — los nombres propios del contexto y del perfil son términos clave', () => {
  test('desde app:empezar hasta la URL: «Monica Belluci» y los del perfil, tras el glosario manual', async () => {
    // El tramo real de `empezarSesion` (con los once nombres que fijan las
    // pruebas de F040 y F047) y la puerta real de `app:empezar`.
    const codigo = tramo('async function empezarSesion', 'sesion = {') + '\nreturn { idSesion }\n}\n'
      + tramo('async function iniciarReunion', "ipcMain.handle('app:empezar'") + '\nreturn iniciarReunion'
    const visto = {}
    const iniciarReunion = new Function(
      'sesion', 'leerClaves', 'contexto', 'AssemblyLiveTranscriber', 'registroConexionesStt',
      'traductor', 'db', 'path', 'app', 'Autosave', 'montarMotores', 'obtenerIdioma', codigo)(
      null, () => ({ stt: 'clave' }),
      { construirKeyterms, actualizarPerfil () {}, crearPerfil: () => 1, activarPerfil () {}, crearContexto () {} },
      class { constructor (opciones) { visto.transcriptor = opciones } }, {},
      { cargar: async () => {} }, { startSession: () => 1 }, path,
      { getPath: () => '/no-existe-f048', getVersion: () => '0' },
      class { abrir () {} guardarCabecera () {} },
      () => ({ motor: null, resumen: null, traductor: null }), obtenerIdioma)

    await iniciarReunion({
      perfil: {
        nombre: 'Laura Ferrer',
        contexto: 'Analista egresada de la ZETA Cumbres del Instituto Tecnologico Andino, trabajo en ACME NORTE',
      },
      contexto: { nombre: 'entrevista Monica Belluci', glosario: 'SAP, WMS' },
    })

    const esperados = [
      'SAP', 'WMS', // el glosario manual, primero
      'Monica Belluci', 'Laura Ferrer', 'ZETA Cumbres', 'Instituto Tecnologico Andino', 'ACME NORTE',
    ]
    assert.deepStrictEqual(visto.transcriptor.glosario, esperados)
    const url = new URL(_internos.construirUrl(visto.transcriptor))
    assert.deepStrictEqual(JSON.parse(url.searchParams.get('keyterms_prompt')), esperados)
  })

  test('sin repetidos (ignorando mayúsculas), de 50 caracteres como mucho y 100 en total', () => {
    const largo = "Associazione Nazionale Costruttori Edili e Affini d'Italia sezione di Roma"
    const muchos = Array.from({ length: 150 }, (_, i) => `termino${i}`).join(', ')
    const terminos = construirKeyterms({
      contexto: { nombre: 'Rossi Logistica', glosario: `SAP, sap, ${largo}, ${muchos}` },
    })

    assert.strictEqual(terminos[0], 'SAP')
    assert.strictEqual(terminos.filter(t => t.toLowerCase() === 'sap').length, 1)
    assert.ok(terminos.every(t => t.length <= 50), 'todos de 50 caracteres como mucho')
    assert.strictEqual(terminos.length, 100)
    assert.ok(!terminos.includes('Rossi Logistica'), 'si sobran, se pierden los automáticos, que van al final')
  })
})

// ── 3. Palabra suelta ───────────────────────────────────────────────────────

describe('F048 (3) — una palabra suelta con contenido pasa por Marian', () => {
  test('«Perfetto.» sale de Marian; «Mm.» y «Ok.» siguen copiándose', async () => {
    const aMarian = []
    let alLlm = 0
    const traductor = crearTraductorLlm({
      llamar: async () => { alLlm++; return 'no debería llamarse' },
      respaldo: {
        traducir: async texto => { aMarian.push(texto); return { es: 'Perfecto.', ms: 5, traductor: 'marian' } },
      },
    })

    for (const palabra of ['Perfetto.', 'Brava!', 'Sì.']) {
      const r = await traductor.traducir(palabra)
      assert.strictEqual(r.traductor, 'marian', palabra)
      assert.strictEqual(r.es, 'Perfecto.', palabra)
    }
    assert.deepStrictEqual(aMarian, ['Perfetto.', 'Brava!', 'Sì.'])

    for (const interjeccion of ['Mm.', 'Ok.']) {
      const r = await traductor.traducir(interjeccion)
      assert.strictEqual(r.traductor, 'ninguno', interjeccion)
      assert.strictEqual(r.es, interjeccion)
    }
    assert.strictEqual(aMarian.length, 3, 'las interjecciones no gastan Marian')
    assert.strictEqual(alLlm, 0, 'y ninguna palabra suelta llega al LLM')
  })
})

// ── 4. Español de México ────────────────────────────────────────────────────

describe('F048 (4) — los prompts que producen español piden el de México', () => {
  test('promptTraduccion y promptResumen piden español de México y prohíben vosotros', () => {
    for (const prompt of [promptTraduccion(''), promptResumen('')]) {
      assert.match(prompt, /español de México/)
      assert.match(prompt, /«ustedes»/)
      assert.match(prompt, /nunca «vosotros»/)
      assert.match(prompt, /sabéis, tenéis/, 'nombra las formas que hay que evitar')
      assert.match(prompt, /computadora, auto, estacionar/)
    }
  })
})

// ── 5. Parámetro de idioma de AssemblyAI ────────────────────────────────────

describe('F048 (5) — el idioma va como language_codes, el nombre documentado', () => {
  test('la URL lleva language_codes=["it"] y ya no lleva language_code', () => {
    const { construirUrl } = _internos
    const it = new URL(construirUrl({ idioma: 'it' }))
    assert.strictEqual(it.searchParams.get('language_codes'), '["it"]')
    assert.strictEqual(it.searchParams.get('language_code'), null)
    assert.ok(!/[?&]language_code=/.test(it.search), 'ni siquiera con el nombre viejo')

    assert.strictEqual(new URL(construirUrl({ idioma: 'en' })).searchParams.get('language_codes'), '["en"]')
  })
})
