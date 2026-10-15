/**
 * F060 — estilo indirecto y fragmentos en inglés; verbo en 2.ª persona con «?» en
 * italiano. Frases medidas en la primera prueba de la v1.0.0.
 */
'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const ingles = require('../src/detectorPreguntasIngles')
const italiano = require('../src/questionDetector')

describe('F060 — inglés', () => {
  const CASOS = [
    // Dejan de ser pregunta.
    ['So he DMs me and he\'s like, are you ever in San Francisco or Austin?', false],
    ['And so we go there, we do the interview, and after the interview, Elon texts me and he\'s like, do you feel like going to Providence tonight? Rhode Island? Yeah.', false],
    ['with the silverware and the wine glasses. And he\'s like, do you want to take a picture? I\'m like, I can\'t.', false],
    // Cita + reacciones al final del turno: ninguna frase va al oyente.
    ['with the silverware and the wine glasses. And he\'s like, do you want to take a picture? I\'m like, I can\'t. Wait, he\'s what? He\'s balancing forks and glasses? Yeah.', false],
    ['And did he Sorry, go on.', false],
    // Ronda 2: quien cita no es un pronombre.
    ['And my boss was like, can you finish it by Monday?', false],
    ['Then the client said, do we really need the second phase?', false],
    // Ronda 2: lo que no es cita y sigue siendo pregunta.
    ['As I said, can you send me the file?', true],
    ['You said, three weeks?', true],
    ['Everything goes, right?', true],
    // Siguen siendo pregunta.
    ["Why do you think we're talking about podcasters? Because people will click on it.", true],
    ['How did you meet Elon Musk? He slid into my DMs.', true],
    ["world's richest man? Yep. Followed me, slid into my DMs. How old were you?", true],
    ['How was that trip?', true],
    ['And glasses on glasses. You spent a few days with him?', true],
    ['Did he straight away just say, do you want to make babies?', true],
    ['So what motivates Musk when it comes to?', true],
    ["Dangerous. But don't you kind of see the problem here is that everyone we've spoken about is like podcasts and streamers?", true],
  ]
  for (const [texto, esperado] of CASOS) {
    test(`${esperado ? 'pregunta' : 'no pregunta'}: ${texto.slice(0, 60)}`, () => {
      assert.strictEqual(ingles.analizar(texto).esPregunta, esperado)
    })
  }
})

describe('F060 — italiano: verbo en 2.ª persona con «?»', () => {
  test('«…hai fatto anche dei viaggi in Brasile?» es pregunta y merece respuesta', () => {
    const r = italiano.analizar('Stiamo per partire per la Sicilia, per la Sicilia. Ho già la valigia pronta. E in questi tanti viaggi hai fatto anche dei viaggi in Brasile?')
    assert.strictEqual(r.esPregunta, true)
    assert.strictEqual(r.merecePena, true)
  })
  test('sin «?» el mismo verbo a mitad de frase sigue sin bastar', () => {
    assert.strictEqual(italiano.analizar('Ho già la valigia pronta. E in questi tanti viaggi hai fatto anche dei viaggi in Brasile.').esPregunta, false)
  })
})
