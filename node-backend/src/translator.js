/**
 * translator.js
 * Vía rápida de traducción Italiano → Español, en local y sin red.
 *
 * Sustituye al `translate_server.swift` del proyecto base, que usaba Apple
 * Translation y por tanto no existe en Windows. Aquí usamos Marian
 * (Xenova/opus-mt-it-es) sobre ONNX Runtime, dentro del propio proceso Node.
 *
 * Medido en Apple M5 / Node 25: p50 131 ms, rango 120-139 ms, 101 MB en q8.  [medido]
 *
 * Dos cosas que este módulo hace y que no son obvias:
 *
 * 1. **Trocea las frases largas.** Los modelos NMT tipo Marian degeneran en
 *    repetición cuando la entrada es larga, y Whisper entrega tramos largos sin
 *    puntuar. Los 131 ms medidos son de una frase corta y NO generalizan: el
 *    tiempo crece de forma no lineal con la longitud.
 * 2. **Vigila la repetición.** Si el modelo entra en bucle, es mejor devolver
 *    el trozo truncado que una frase repetida veinte veces, porque el usuario
 *    la leería como si el interlocutor la hubiera dicho así.
 */

'use strict'

const MODELO = 'Xenova/opus-mt-it-es'

// Por encima de esto troceamos. Marian se entrenó con frases, no con párrafos.
const MAX_PALABRAS_POR_TROZO = 40
// Techo duro de salida: si el modelo se desboca, cortamos en vez de esperar.
const MAX_TOKENS_SALIDA = 256

let _pipe = null
let _cargando = null

/**
 * Carga el modelo una sola vez y lo deja caliente.
 * Llamar en el arranque de la app, no al pulsar Escuchar: así el tiempo de
 * carga se esconde detrás de la pantalla de preparación.  (PLAN.md §11)
 */
async function cargar () {
  if (_pipe) return _pipe
  if (_cargando) return _cargando

  _cargando = (async () => {
    const { pipeline } = await import('@huggingface/transformers')
    const t0 = Date.now()
    _pipe = await pipeline('translation', MODELO, { dtype: 'q8' })
    console.log(`[traductor] modelo listo en ${Date.now() - t0} ms`)
    // Primera inferencia en frío: la pagamos aquí y no en la primera frase real.
    await _pipe('ciao')
    return _pipe
  })()

  return _cargando
}

/** ¿Está el modelo cargado y listo para traducir sin esperar? */
function estaListo () {
  return _pipe !== null
}

/**
 * Trocea por frases, y si una frase sigue siendo enorme, por comas.
 * Preferimos varios trozos buenos a un trozo largo degenerado.
 */
function trocear (texto) {
  const frases = texto
    .split(/(?<=[.!?…])\s+/)
    .map(f => f.trim())
    .filter(Boolean)

  const trozos = []
  for (const frase of frases) {
    if (frase.split(/\s+/).length <= MAX_PALABRAS_POR_TROZO) {
      trozos.push(frase)
      continue
    }
    // Frase larguísima sin puntuar: la partimos por comas acumulando palabras.
    let acc = []
    for (const parte of frase.split(/,\s*/)) {
      acc.push(parte)
      if (acc.join(', ').split(/\s+/).length >= MAX_PALABRAS_POR_TROZO) {
        trozos.push(acc.join(', '))
        acc = []
      }
    }
    if (acc.length) trozos.push(acc.join(', '))
  }
  return trozos.length ? trozos : [texto]
}

/**
 * Detecta si la salida entró en bucle: el mismo grupo de 4 palabras repetido
 * tres veces o más. Es el modo de fallo típico de NMT con entradas largas.
 */
function pareceRepetido (texto) {
  const palabras = texto.toLowerCase().split(/\s+/).filter(Boolean)
  if (palabras.length < 12) return false

  const vistos = new Map()
  for (let i = 0; i + 4 <= palabras.length; i++) {
    const gram = palabras.slice(i, i + 4).join(' ')
    const n = (vistos.get(gram) || 0) + 1
    if (n >= 3) return true
    vistos.set(gram, n)
  }
  return false
}

/**
 * Traduce un texto italiano a español.
 * @param {string} italiano
 * @returns {Promise<{ es: string, ms: number, trozos: number, truncado: boolean }>}
 */
async function traducir (italiano) {
  const limpio = (italiano || '').trim()
  if (!limpio) return { es: '', ms: 0, trozos: 0, truncado: false }

  const pipe = await cargar()
  const t0 = Date.now()

  const trozos = trocear(limpio)
  const partes = []
  let truncado = false

  for (const trozo of trozos) {
    const salida = await pipe(trozo, { max_new_tokens: MAX_TOKENS_SALIDA })
    let texto = (salida?.[0]?.translation_text || '').trim()

    if (pareceRepetido(texto)) {
      // Nos quedamos con la primera frase: es lo último fiable antes del bucle.
      const corte = texto.split(/(?<=[.!?…])\s+/)[0] || texto.slice(0, 120)
      console.warn('[traductor] repetición detectada, se trunca la salida')
      texto = corte.trim()
      truncado = true
    }
    if (texto) partes.push(texto)
  }

  return {
    es: partes.join(' '),
    ms: Date.now() - t0,
    trozos: trozos.length,
    truncado,
  }
}

module.exports = { cargar, estaListo, traducir, MODELO }

// Exportado solo para las pruebas: no forma parte de la API del módulo.
module.exports._internos = { trocear, pareceRepetido }
