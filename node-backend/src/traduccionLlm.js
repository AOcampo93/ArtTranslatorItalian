/**
 * traduccionLlm.js
 * Traduce italiano → español con el LLM que el usuario ya configuró (F040).
 *
 * ## Por qué existe, con la cifra que lo justifica
 *
 * Medido en la prueba de v0.6.0: Marian se come palabras sueltas —«erotismo»
 * sale «heroísmo», «pazzo» se queda sin traducir, «perché» sale «para que»,
 * «timidezes»— y ese defecto pesa más que el troceo de turnos, que era el otro
 * candidato a mejora. Con clave de LLM, ese mismo modelo que ya redacta las
 * respuestas traduce también la frase, con el contexto de la reunión y el
 * glosario delante. `[medido]` — `.arnes/progreso` de la prueba de v0.6.0.
 *
 * ## Por qué Marian no desaparece
 *
 * Sin clave, la traducción tiene que seguir funcionando: es el producto, las
 * respuestas son el extra (ver `montarMotores` en `mainApp.js`). Y CON clave,
 * un LLM en la nube puede fallar, tardar o devolver vacío a media reunión —
 * `respaldo` es Marian, en local, y no depende de la red que acaba de fallar.
 *
 * ## `plazoMs` por defecto: 3 s
 *
 * El mismo motivo que `GRACIA_EN_VUELO_MS` en `mainApp.js`: la burbuja tiene
 * que aparecer mientras el interlocutor sigue hablando, no cuando el LLM
 * decida contestar. 20 s (el plazo de `llm.js` para las respuestas, que
 * nadie espera leyendo en vivo) sería demasiado para una traducción que el
 * usuario está mirando aparecer en pantalla.
 */

'use strict'

const { promptTraduccion } = require('../../shared/prompts')

/** Quita las vallas de markdown que el modelo añade aunque se le prohíba. */
function quitarVallas (bruto) {
  let t = String(bruto || '').trim()
  if (t.startsWith('```')) {
    t = t.split('\n').slice(1).join('\n').split('```')[0].trim()
  }
  return t
}

/**
 * Pares de comillas que el modelo pone al "citar" su propia traducción.
 * Solo se quitan si envuelven el texto entero, igual que en `respuestas.js`.
 */
const COMILLAS = [['"', '"'], ["'", "'"], ['«', '»'], ['“', '”']]

function sinComillasEnvolventes (t) {
  for (const [abre, cierra] of COMILLAS) {
    if (t.length > 2 && t.startsWith(abre) && t.endsWith(cierra)) {
      const dentro = t.slice(1, -1)
      if (!dentro.includes(cierra)) return dentro.trim()
    }
  }
  return t
}

/** Prefijos que el modelo añade aunque el prompt pida solo la traducción. */
const RE_PREFIJO = /^(traducci[oó]n|traduzione|es|español)\s*:\s*/i

/**
 * Cuenta palabras con alguna letra (ignora puntuación suelta: «.», «¿», «!»).
 * «Mm.» tiene una; «sí, claro» tiene dos.
 */
function contarPalabrasConLetras (t) {
  const palabras = String(t || '').trim().split(/\s+/).filter(Boolean)
  return palabras.filter(p => /\p{L}/u.test(p)).length
}

/**
 * F043, medido en la prueba de v0.7.0: a «Mm.» el LLM contestó «No hay texto
 * en italiano para traducir. Por favor, proporciona la frase que necesitas
 * que traduzca» en vez de dejarlo tal cual. Con menos de 2 palabras con
 * letras no hay nada que traducir de verdad —una muletilla, un «sí», un
 * «mm»— así que ni se llama al LLM: se enseña el texto tal cual.
 */
function sinContenido (t) {
  return contarPalabrasConLetras(t) < 2
}

/**
 * Frases del LLM «charlando» en vez de traducir — el mismo caso medido de
 * arriba. Se comprueban contra la RESPUESTA, y solo cuentan si la ENTRADA no
 * las traía ya (una frase italiana real puede contener «tradurre»).
 */
const FRASES_CHARLATANAS = ['proporciona', 'no hay texto', 'traducir']

/**
 * Detecta una respuesta que no es traducción: o bien mucho más larga que la
 * entrada (el LLM explica en vez de traducir), o bien trae una de las frases
 * charlatanas de arriba que la entrada no tenía.
 */
function esRespuestaNoValida (entrada, salida) {
  if (!salida) return false
  if (salida.length > entrada.length * 3) return true
  const salidaBaja = salida.toLowerCase()
  const entradaBaja = entrada.toLowerCase()
  return FRASES_CHARLATANAS.some(f => salidaBaja.includes(f) && !entradaBaja.includes(f))
}

/**
 * Deja solo la traducción: sin vallas de markdown, sin comillas que envuelvan
 * el texto entero y sin el prefijo con el que el modelo a veces anuncia lo
 * que va a decir.
 */
function limpiar (bruto) {
  let t = quitarVallas(bruto)
  t = t.replace(RE_PREFIJO, '')
  t = sinComillasEnvolventes(t.trim())
  return t.trim()
}

/**
 * Construye el traductor que usa el LLM, con Marian de respaldo.
 *
 * @param {object} opts
 * @param {Function} opts.llamar          (sistema, usuario, opciones) => Promise
 *   — de `crearLlamador()` en `llm.js`, ya inyectado en `montarMotores`.
 * @param {Function} [opts.bloqueContexto] () => string, igual que en
 *   `MotorRespuestas`: el contexto de la reunión y el glosario van en el
 *   sistema, no en cada frase.
 * @param {number} [opts.plazoMs]
 * @param {{ traducir: (texto: string) => Promise<object> }} opts.respaldo
 *   Marian, ya cargado. Su resultado se devuelve TAL CUAL en el fallback —
 *   es él quien anota `traductor: 'marian'` en lo que devuelve.
 * @returns {{ traducir: (texto: string) => Promise<{ es: string, ms: number, traductor: 'llm'|'marian', modelo?: string|null }> }}
 */
function crearTraductorLlm ({ llamar, bloqueContexto, plazoMs = 3000, respaldo } = {}) {
  if (typeof llamar !== 'function') {
    throw new Error('hace falta una función para llamar al LLM')
  }
  if (!respaldo || typeof respaldo.traducir !== 'function') {
    throw new Error('hace falta un traductor de respaldo (Marian)')
  }
  const bloque = bloqueContexto || (() => '')

  /**
   * `motivoJsonl`, si se da, viaja hasta el `.jsonl` de la sesión (F043): es
   * lo que permite comprobar en el informe que el LLM SÍ intentó traducir y
   * cayó a Marian por una respuesta charlatana, no por elección.
   */
  async function conRespaldo (texto, motivo, err, motivoJsonl) {
    console.warn(`[traduccionLlm] ${motivo}, se traduce con Marian:`, err?.message || motivo)
    const resultado = await respaldo.traducir(texto)
    return motivoJsonl ? { ...resultado, motivo: motivoJsonl } : resultado
  }

  async function traducir (texto) {
    const limpio = (texto || '').trim()
    if (!limpio) return { es: '', ms: 0, traductor: 'llm', modelo: null }

    // F043: «Mm.», «sí», «¿eh?» — sin contenido que traducir de verdad, y el
    // LLM charla en vez de callarse (medido: ver `sinContenido` arriba).
    if (sinContenido(limpio)) {
      return { es: limpio, ms: 0, traductor: 'ninguno', modelo: null }
    }

    const t0 = Date.now()
    let venció = false
    let reloj = null
    const tope = new Promise(res => {
      reloj = setTimeout(() => { venció = true; res(null) }, plazoMs)
    })

    let bruto
    try {
      const sistema = promptTraduccion(bloque())
      bruto = await Promise.race([llamar(sistema, limpio, { maxTokens: 300 }), tope])
    } catch (err) {
      clearTimeout(reloj)
      return conRespaldo(limpio, 'el LLM falló', err)
    }
    clearTimeout(reloj)

    if (venció) {
      return conRespaldo(limpio, `el LLM no respondió en ${Math.round(plazoMs / 1000)} s`, null)
    }

    const crudo = typeof bruto === 'string' ? bruto : bruto?.texto
    const modelo = typeof bruto === 'string' ? null : (bruto?.modelo ?? null)
    const es = limpiar(crudo)
    if (!es) {
      return conRespaldo(limpio, 'el LLM devolvió una traducción vacía', null)
    }
    if (esRespuestaNoValida(limpio, es)) {
      return conRespaldo(limpio, 'el LLM devolvió una respuesta que no es traducción', null, 'respuesta-no-valida')
    }

    return { es, ms: Date.now() - t0, traductor: 'llm', modelo }
  }

  return { traducir }
}

module.exports = { crearTraductorLlm }

// Exportado solo para las pruebas: no forma parte de la API del módulo.
module.exports._internos = {
  limpiar, quitarVallas, sinComillasEnvolventes,
  contarPalabrasConLetras, sinContenido, esRespuestaNoValida,
}
