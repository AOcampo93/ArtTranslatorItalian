/**
 * Pruebas de los prompts.
 *
 * No se valida la CALIDAD de lo que devuelve el modelo —eso necesita llamadas
 * reales y está pendiente— pero sí se verifica lo que se le pide, que es lo que
 * determina si la respuesta puede siquiera ser correcta.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const P = require('../../shared/prompts')

const BLOQUE = `PERFIL DE QUIEN ESCUCHA
Omar Avila · 34 años · Responsable técnico

REUNIÓN ACTUAL
Tipo: negociación
Proyecto: ERP de logística, migración a SAP
Términos: SAP, ERP, fase 2`

describe('el contexto llega a los cinco prompts', () => {
  const cinco = ['promptTraduccion', 'promptRefinado', 'promptPreguntas', 'promptRespuesta', 'promptResumen']

  for (const nombre of cinco) {
    test(`${nombre} incluye el bloque`, () => {
      const p = P[nombre](BLOQUE)
      assert.match(p, /CONTEXTO DE ESTA CONVERSACIÓN/)
      assert.match(p, /Omar Avila/)
      assert.match(p, /SAP/)
    })

    test(`${nombre} funciona sin contexto`, () => {
      const p = P[nombre]('')
      assert.ok(p.length > 100, 'el prompt debe seguir siendo útil sin contexto')
      assert.doesNotMatch(p, /CONTEXTO DE ESTA CONVERSACIÓN/,
        'sin contexto no debe quedar una sección vacía')
    })
  }
})

describe('la respuesta va en italiano, que es el requisito del cliente', () => {
  test('pide explícitamente italiano y primera persona', () => {
    const p = P.promptRespuesta(BLOQUE)
    assert.match(p, /ITALIANO/)
    assert.match(p, /primera persona/)
  })

  test('impone el límite de longitud, que es funcional', () => {
    // Se lee de un vistazo en medio de una llamada: una respuesta larga es
    // inútil por perfecta que sea.
    const p = P.promptRespuesta(BLOQUE)
    assert.match(p, /500 caracteres/)
    assert.match(p, /dos o tres frases/i)
  })

  test('prohíbe inventarse datos que no estén en el contexto', () => {
    assert.match(P.promptRespuesta(BLOQUE), /no lo inventes/i)
  })

  // F044. MEDIDO en el informe de v0.8.0: ante «Quante volte sei stata in
  // Brasile?» el modelo contestaba «Sono stata in Brasile 9 volte» como si
  // fuera del usuario — un hecho que no está ni en su perfil ni en el
  // contexto. El prompt tiene que prohibirlo por su nombre, y dar una salida
  // honesta en vez de dejar que el modelo la rellene por su cuenta.
  test('F044: prohíbe inventar hechos personales del usuario', () => {
    const p = P.promptRespuesta(BLOQUE)
    assert.match(p, /hechos personales/i)
    assert.match(p, /cifras?\s+o\s+vivencias?/i,
      'debe nombrar el tipo de invención que se midió: cifras y vivencias')
  })

  test('F044: si falta el dato, pide esquivar o devolver la pregunta, no inventar', () => {
    const p = P.promptRespuesta(BLOQUE)
    assert.match(p, /esquive? o devuelva/i)
  })

  test('NO pide glosa en español: el cliente quiso solo italiano', () => {
    const p = P.promptRespuesta(BLOQUE)
    assert.doesNotMatch(p, /glosa|traducción al español de la respuesta/i)
  })
})

describe('el escáner de preguntas apunta a lo que el texto no ve', () => {
  test('pide explícitamente las entonativas, que son las difíciles', () => {
    const p = P.promptPreguntas(BLOQUE)
    assert.match(p, /entonativa/i)
    assert.match(p, /Il budget copre anche la manutenzione/,
      'debe llevar el caso concreto que las capas gratis no detectan')
  })

  test('excluye lo que no merece una llamada', () => {
    const p = P.promptPreguntas(BLOQUE)
    assert.match(p, /retóricas/i)
    assert.match(p, /come stai/, 'las fórmulas sociales no se responden')
  })

  test('exige la pregunta completa', () => {
    assert.match(P.promptPreguntas(BLOQUE), /nunca truncada/i)
  })
})

describe('F040 — la traducción por LLM pide SOLO la traducción', () => {
  test('pide traducir al español y conservar los nombres propios', () => {
    const p = P.promptTraduccion(BLOQUE)
    assert.match(p, /Traduce al español/)
    assert.match(p, /nombres\s+propios/)
  })

  test('prohíbe comentarios, comillas, markdown y el prefijo "Traducción:"', () => {
    const p = P.promptTraduccion(BLOQUE)
    assert.match(p, /SOLO la traducción/)
    assert.match(p, /[Ss]in comillas/)
    assert.match(p, /["“]Traducción:["”]/, 'nombra el prefijo típico para prohibirlo')
    assert.match(p, /markdown/)
  })
})

describe('el refinado NO traduce, solo corrige terminología', () => {
  test('deja claro que recibe una traducción ya hecha', () => {
    const p = P.promptRefinado(BLOQUE)
    assert.match(p, /traducción automática/i)
    assert.match(p, /SIN TOCAR/, 'si ya está bien, no debe reescribirla')
  })

  test('lleva el caso medido que lo justifica', () => {
    // "il gestionale" es el ERP, y Marian lo traduce como "la gestión".
    assert.match(P.promptRefinado(BLOQUE), /il gestionale/)
  })
})

describe('el resumen va en español aunque la reunión sea en italiano', () => {
  test('lo pide dos veces, porque es fácil que el modelo lo olvide', () => {
    const p = P.promptResumen(BLOQUE)
    assert.match(p, /EN ESPAÑOL/)
    assert.match(p, /SIEMPRE en español/)
  })

  test('ante la duda, no marca tema nuevo', () => {
    assert.match(P.promptResumen(BLOQUE), /Ante la duda, false/)
  })
})
