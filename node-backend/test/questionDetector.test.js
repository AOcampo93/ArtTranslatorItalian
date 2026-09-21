/**
 * Pruebas del detector de preguntas en italiano.
 *
 * Incluye los seis casos medidos en PLAN.md §9 — los mismos sobre los que
 * buscar "¿" en la traducción solo acertaba 2 de 6. Aquí tienen que salir
 * 5 de 6: el sexto es genuinamente ambiguo y le toca a la capa del LLM.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const { analizar, preguntaEnCamino, _internos } = require('../src/questionDetector')

describe('normalización', () => {
  test('quita puntuación y baja a minúsculas', () => {
    assert.strictEqual(_internos.normalizar('¿Che NE pensi?!'), 'che ne pensi')
  })

  test('conserva los acentos, que en italiano distinguen palabras', () => {
    assert.strictEqual(_internos.normalizar('Perché?'), 'perché')
  })

  test('se queda con la última frase', () => {
    const t = 'Va bene. Allora, hai finito il report'
    assert.strictEqual(_internos.ultimaFrase(t), 'Allora, hai finito il report')
  })

  test('descarta el relleno inicial', () => {
    assert.strictEqual(_internos.sinRelleno('allora quindi che ne pensi'), 'che ne pensi')
  })
})

describe('los seis casos medidos de PLAN.md §9', () => {
  // Sin signo de interrogación, que es como llega de Whisper.
  const CASOS = [
    { it: "Quanto tempo ci vuole per completare l'integrazione", esperado: true,  nota: 'interrogativa' },
    { it: 'Che ne pensi della proposta',                        esperado: true,  nota: 'perífrasis' },
    { it: 'Puoi spiegarmi come funziona il sistema',            esperado: true,  nota: 'verbo 2a — se perdía' },
    { it: 'Hai finito il report',                               esperado: true,  nota: 'verbo 2a — se perdía' },
    { it: 'Avete già parlato con il fornitore',                 esperado: true,  nota: 'verbo 2a — se perdía' },
    { it: 'Il budget copre anche la manutenzione',              esperado: false, nota: 'ambiguo de verdad' },
  ]

  for (const c of CASOS) {
    test(`${c.esperado ? 'detecta' : 'NO detecta'}: "${c.it}" (${c.nota})`, () => {
      assert.strictEqual(analizar(c.it).esPregunta, c.esperado)
    })
  }

  test('acierta 5 de 6, frente a 2 de 6 buscando el signo', () => {
    const aciertos = CASOS.filter(c => analizar(c.it).esPregunta === c.esperado).length
    assert.strictEqual(aciertos, 6, 'los seis casos deben clasificarse bien')
  })
})

describe('afirmaciones que NO son preguntas', () => {
  const AFIRMACIONES = [
    'Buongiorno a tutti, iniziamo la riunione',
    'Il cliente ha chiesto di anticipare la consegna',
    'Dobbiamo rivedere i tempi con il fornitore',
    'Non sono sicuro che il budget copra la manutenzione',
    'Ieri abbiamo parlato con il team di sviluppo',
    'La proposta include anche la manutenzione annuale',
    'Ho visto il documento che mi hai mandato',
  ]
  for (const a of AFIRMACIONES) {
    test(`afirmación: "${a.slice(0, 44)}…"`, () => {
      assert.strictEqual(analizar(a).esPregunta, false, `marcó como pregunta: "${a}"`)
    })
  }
})

describe('preguntas con interrogativa', () => {
  const PREGUNTAS = [
    'Come funziona il sistema di autenticazione',
    'Quando possiamo iniziare la fase due',
    'Dove sono i documenti del progetto',
    'Perché il budget non copre le ore extra',
    'Quali sono i rischi principali',
    'Chi si occupa della migrazione',
    'Cosa ne facciamo del vecchio gestionale',
  ]
  for (const p of PREGUNTAS) {
    test(`pregunta: "${p.slice(0, 44)}…"`, () => {
      assert.strictEqual(analizar(p).esPregunta, true, `no detectó: "${p}"`)
    })
  }
})

describe('relleno inicial', () => {
  test('"Allora, che ne pensi" se detecta igual', () => {
    assert.strictEqual(analizar('Allora, che ne pensi della proposta').esPregunta, true)
  })

  test('"Senti, hai finito" se detecta igual', () => {
    assert.strictEqual(analizar('Senti, hai finito il report').esPregunta, true)
  })

  test('el relleno no convierte una afirmación en pregunta', () => {
    assert.strictEqual(analizar('Allora, il cliente ha firmato').esPregunta, false)
  })
})

describe('triaje: qué merece una llamada al LLM', () => {
  // El contrato es el triaje: si se detecta como pregunta, que NO gaste una
  // llamada al LLM. Que además se detecte depende de si tiene apertura
  // reconocible, y algunas fórmulas no la tienen sin signo de interrogación.
  test('las fórmulas sociales nunca gastan una llamada', () => {
    for (const f of ['Come stai', 'Mi sentite', 'Mi senti', 'Tutto bene', 'Possiamo iniziare']) {
      assert.strictEqual(analizar(f).merecePena, false, `"${f}" NO debería gastar una llamada`)
    }
  })

  test('las que sí tienen apertura reconocible se detectan', () => {
    for (const f of ['Come stai', 'Mi sentite', 'Mi senti']) {
      assert.strictEqual(analizar(f).esPregunta, true, `"${f}" debería detectarse`)
    }
  })

  // "Tutto bene" y "Possiamo iniziare" sin signo son indistinguibles de una
  // afirmación por escrito. Se documenta como límite conocido, no se fuerza:
  // forzarlo metería falsos positivos en frases normales de reunión.
  test('límite conocido: sin signo, algunas fórmulas no se detectan', () => {
    assert.strictEqual(analizar('Tutto bene').esPregunta, false)
    assert.strictEqual(analizar('Tutto bene?').esPregunta, true, 'con signo sí')
  })

  test('los fragmentos cortos tampoco', () => {
    assert.strictEqual(analizar('Come').merecePena, false)
    assert.strictEqual(analizar('Cosa?').merecePena, false)
  })

  test('una pregunta sustantiva sí la merece', () => {
    const r = analizar("Quanto tempo ci vuole per completare l'integrazione con il gestionale")
    assert.strictEqual(r.esPregunta, true)
    assert.strictEqual(r.merecePena, true)
  })
})

describe('el signo, cuando Whisper lo pone', () => {
  test('un signo final basta aunque no haya apertura reconocible', () => {
    const r = analizar('Il budget copre anche la manutenzione?')
    assert.strictEqual(r.esPregunta, true)
    assert.strictEqual(r.motivo, 'signo')
  })
})

describe('F044 — las 8 frases reales del informe de v0.8.0', () => {
  // MEDIDO: sesión Liz3t del 21/09/2026 (36 frases). El detector marcó estas
  // 8 como pregunta y lanzó una respuesta; solo 3 eran preguntas de verdad.
  // Los textos son los del campo "it" de esas 8 entradas `respuestaLlm`, tal
  // cual llegaron — turnos completos, a veces de varias frases.
  const CASOS = [
    {
      it: 'Adesso stiamo per partire, stiamo per partire per la Sicilia. Ho già la valigia pronta. E in questi tanti viaggi hai fatto anche dei viaggi in Brasile?',
      esperado: false,
      nota: 'afirmación sobre el propio viaje; el "?" final no abre con marca dirigida al oyente',
    },
    {
      it: 'Mi fai ricordarti quante volte sei stata in Brasile? Perché Giulia per tanti anni è stata in Brasile.',
      esperado: true,
      nota: 'pregunta real, aunque no sea la última frase del turno',
    },
    {
      it: "Perché nella mata c'è proprio l'energia, l'energia che arriva dalla terra e l'energia che arriva dagli alberi.",
      esperado: false,
      nota: '"perché" = "porque", no "por qué": explica, no pregunta',
    },
    {
      it: "Come pensi che sia cambiata l'Italia nel tempo?",
      esperado: true,
      nota: 'pregunta real',
    },
    {
      it: "Tipo se paragoni Bergamo quando eri bambina e oggi, o l'Italia Italia a quando eri piccola e adesso?",
      esperado: true,
      nota: 'pregunta real',
    },
    {
      it: "Bergamo quando io ero bambina era una città piccolina E non so se, forse non tutti sanno, Bergamo è su due livelli. C'è una parte alta che si chiama Città Alta, è su una collina.",
      esperado: false,
      nota: 'afirmación descriptiva; "c\'è" no es una perífrasis de pregunta',
    },
    {
      it: 'Ci sono dei vantaggi perché hanno molto valorizzato dei tesori medievali che ci sono a Bergamo.',
      esperado: false,
      nota: 'afirmación; "ci sono" no es una perífrasis de pregunta',
    },
    {
      it: "Ci sono veramente delle opere d'arte medievali che quando io ero piccola manco sapevamo che ci fossero.",
      esperado: false,
      nota: 'afirmación',
    },
  ]

  for (const c of CASOS) {
    test(`${c.esperado ? 'acepta' : 'rechaza'}: "${c.it.slice(0, 50)}…" (${c.nota})`, () => {
      assert.strictEqual(analizar(c.it).esPregunta, c.esperado)
    })
  }

  test('de las 8, acepta exactamente las 3 preguntas y rechaza las 5 afirmaciones', () => {
    const aciertos = CASOS.filter(c => analizar(c.it).esPregunta === c.esperado).length
    assert.strictEqual(aciertos, 8, 'las 8 deben clasificarse como en el informe')
    assert.strictEqual(CASOS.filter(c => c.esperado).length, 3)
    assert.strictEqual(CASOS.filter(c => !c.esperado).length, 5)
  })
})

describe('aviso sobre la hipótesis en vivo', () => {
  test('avisa antes de que la frase termine', () => {
    // Solo mira cómo empieza, así que puede avisar con la frase a medias.
    assert.strictEqual(preguntaEnCamino('Quanto tempo ci'), true)
    assert.strictEqual(preguntaEnCamino('Hai'), true)
    assert.strictEqual(preguntaEnCamino('Il cliente ha'), false)
  })
})
