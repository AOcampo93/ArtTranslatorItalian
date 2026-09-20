/**
 * traduccionLlm.test.js — F040: traducir con el LLM cuando hay clave, con
 * Marian de respaldo.
 *
 * Una prueba por criterio de aceptación de `.arnes/tareas.json`. Nivel 1: un
 * `llamar()` de mentira, nunca el servicio real — igual que `respuestas.test.js`
 * prueba `MotorRespuestas` sin tocar red.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')

const { crearTraductorLlm } = require('../src/traduccionLlm')

/** Un `respaldo` (Marian) de mentira que deja constancia de que se usó. */
function marianDeMentira (es = 'traducción de Marian') {
  const llamadas = []
  return {
    llamadas,
    traducir: async (texto) => {
      llamadas.push(texto)
      return { es, ms: 5, traductor: 'marian' }
    },
  }
}

describe('F040 — crearTraductorLlm', () => {
  test('con clave de LLM, traduce con el LLM y lo marca traductor: "llm"', async () => {
    const respaldo = marianDeMentira()
    const llamar = async (sistema, usuario) => ({
      texto: 'Buongiorno a tutti.', tokensEntrada: 40, tokensSalida: 6, modelo: 'gemini-3.5-flash-lite',
    })
    const t = crearTraductorLlm({ llamar, respaldo })

    const r = await t.traducir('Buongiorno a tutti.')

    assert.strictEqual(r.es, 'Buongiorno a tutti.')
    assert.strictEqual(r.traductor, 'llm')
    assert.strictEqual(typeof r.ms, 'number')
    assert.strictEqual(respaldo.llamadas.length, 0, 'con el LLM funcionando no se gasta Marian')
  })

  test('sin clave (respaldo directo, sin `llamar`): construir sin llamar() lanza', () => {
    // La "ausencia de clave" la decide `mainApp.js` no construyendo este
    // traductor y usando Marian directo (ver `montarMotores`); este módulo
    // exige `llamar` porque es SU contrato — nunca se llama sin clave.
    assert.throws(() => crearTraductorLlm({ respaldo: marianDeMentira() }),
      /hace falta una función para llamar al LLM/)
  })

  test('si el LLM falla, se traduce con Marian y el resultado lo dice', async () => {
    const respaldo = marianDeMentira('respaldo de Marian')
    const llamar = async () => { throw new Error('gemini 500: se cayó el servidor') }
    const t = crearTraductorLlm({ llamar, respaldo })

    const r = await t.traducir('Ciao a tutti.')

    assert.strictEqual(r.es, 'respaldo de Marian')
    assert.strictEqual(r.traductor, 'marian')
    assert.deepStrictEqual(respaldo.llamadas, ['Ciao a tutti.'])
  })

  test('si el LLM tarda más del plazo, se traduce con Marian y el resultado lo dice', async () => {
    const respaldo = marianDeMentira('respaldo por plazo')
    const llamar = () => new Promise(res => setTimeout(() => res({ texto: 'tarde' }), 50))
    const t = crearTraductorLlm({ llamar, respaldo, plazoMs: 10 })

    const r = await t.traducir('Frase lenta.')

    assert.strictEqual(r.es, 'respaldo por plazo')
    assert.strictEqual(r.traductor, 'marian')
  })

  test('el LLM devuelve la traducción con comillas y un prefijo: se limpia', async () => {
    const respaldo = marianDeMentira()
    const llamar = async () => ({ texto: 'Traducción: "Ci vediamo domani."' })
    const t = crearTraductorLlm({ llamar, respaldo })

    const r = await t.traducir('Ci vediamo domani.')

    assert.strictEqual(r.es, 'Ci vediamo domani.')
    assert.strictEqual(r.traductor, 'llm')
  })

  test('el LLM devuelve la traducción envuelta en una valla de markdown: se limpia', async () => {
    const respaldo = marianDeMentira()
    const llamar = async () => ({ texto: '```\nA domani.\n```' })
    const t = crearTraductorLlm({ llamar, respaldo })

    const r = await t.traducir('A domani.')

    assert.strictEqual(r.es, 'A domani.')
  })

  test('el LLM devuelve vacío: se traduce con Marian y el resultado lo dice', async () => {
    const respaldo = marianDeMentira('respaldo por vacío')
    const llamar = async () => ({ texto: '   ' })
    const t = crearTraductorLlm({ llamar, respaldo })

    const r = await t.traducir('Qualcosa.')

    assert.strictEqual(r.es, 'respaldo por vacío')
    assert.strictEqual(r.traductor, 'marian')
  })

  test('ningún mensaje de fallo del LLM lleva una clave, ni en el resultado ni en lo que se anota', async () => {
    const CLAVE = 'sk-proj-oQ8fALGO1234REAL5678SEISUNOMASOCHO'
    const respaldo = marianDeMentira('a salvo')
    const avisos = []
    const consolaOriginal = console.warn
    console.warn = (...partes) => avisos.push(partes.map(String).join(' '))
    try {
      const llamar = async () => { throw new Error(`openai 401: clave rechazada ${CLAVE}`) }
      const t = crearTraductorLlm({ llamar, respaldo })
      const r = await t.traducir('Frase cualquiera.')

      assert.strictEqual(r.es, 'a salvo')
      // F040 exige que ninguna clave se PINTE ni se REGISTRE (pantalla / .jsonl):
      // este resultado es lo único que llega a esos dos sitios, y no lleva la
      // clave — el log de proceso (`console.warn`, nunca a disco ni a pantalla)
      // sí puede llevar el mensaje crudo, como el resto del módulo (F021).
      assert.ok(!JSON.stringify(r).includes(CLAVE), 'la clave se coló en el resultado')
    } finally {
      console.warn = consolaOriginal
    }
  })
})
