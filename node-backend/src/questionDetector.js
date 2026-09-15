/**
 * questionDetector.js
 * Detecta preguntas en italiano sin gastar una llamada al LLM.
 *
 * Por qué hace falta, y por qué es más difícil que en inglés: en italiano
 * **muchas preguntas se escriben exactamente igual que una afirmación** y solo
 * se distinguen por la entonación, que el texto no conserva. Encima Whisper
 * omite buena parte de los signos de interrogación.
 *
 * Está medido sobre italiano sin `?`: buscar "¿" en la traducción española
 * acierta **2 de 6**.  [medido]
 *
 *   Quanto tempo ci vuole per completare l'integrazione  → ¿Cuánto…?      ✓
 *   Che ne pensi della proposta                          → ¿Qué opinas…?  ✓
 *   Puoi spiegarmi come funziona il sistema              → Puedes…        ✗
 *   Hai finito il report                                 → Has terminado. ✗
 *   Avete già parlato con il fornitore                   → Ya ha hablado. ✗
 *   Il budget copre anche la manutenzione                → El presupuesto ✗
 *
 * Las tres que se perdían empiezan por **verbo conjugado en 2ª persona**, que es
 * el patrón interrogativo italiano cuando no hay palabra interrogativa. Ese es
 * el aporte real de este módulo frente a buscar signos.
 *
 * El último caso es genuinamente ambiguo: ni una persona leyendo solo ese texto
 * sabría si es pregunta. Para eso está la tercera capa (escáner LLM del
 * transcript, PLAN.md §9), no este módulo.
 */

'use strict'

/** Interrogativas: si abren la frase, es pregunta casi seguro. */
const INTERROGATIVAS = [
  'che cosa', 'per quale motivo', 'da quanto tempo', 'quanto tempo',
  'che', 'cosa', 'come', 'quando', 'dove', 'perché', 'perche',
  'quale', 'quali', 'chi', 'quanto', 'quanta', 'quanti', 'quante',
]

/**
 * Verbos en 2ª persona (tú y vosotros) que abren pregunta sin interrogativa.
 * Esta lista es la que rescata "Hai finito il report" y "Avete già parlato".
 */
const VERBOS_2A = [
  'hai', 'avete', 'sei', 'siete', 'puoi', 'potete', 'vuoi', 'volete',
  'sai', 'sapete', 'riesci', 'riuscite', 'conosci', 'conoscete',
  'pensi', 'pensate', 'credi', 'credete', 'ricordi', 'ricordate',
  'potresti', 'potreste', 'vorresti', 'vorreste', 'saresti', 'sareste',
  'hai visto', 'avete visto', 'ti va', 'vi va',
  // Percepción: son las de "¿me oyes?", que salen en toda videollamada.
  'senti', 'sentite', 'sente', 'vedi', 'vedete', 'vede',
]

/*
 * Deliberadamente NO se incluye la 1a persona del plural (possiamo, dobbiamo,
 * facciamo). "Possiamo iniziare?" es pregunta, pero "Dobbiamo rivedere i tempi"
 * es afirmación, y por escrito no se distinguen. Meterlas daría falsos
 * positivos en frases corrientes de reunión; esos casos los recoge la capa
 * del LLM (PLAN.md §9), que sí ve el contexto.
 */

/**
 * Pronombres clíticos que se cuelan entre el inicio y el verbo:
 * "mi senti", "ci sentite", "ti va", "lo sai". Sin contemplarlos se pierden
 * preguntas tan corrientes como "¿me oyes?".
 *
 * Solo se saltan para buscar el verbo, nunca para las interrogativas: así
 * "la proposta include..." no se convierte en pregunta por empezar por "la".
 */
const CLITICOS = new Set(['mi', 'ti', 'ci', 'vi', 'si', 'lo', 'la', 'li', 'le', 'ne', 'gli'])

/** Perífrasis que introducen pregunta indirecta. */
const PERIFRASIS = [
  'mi puoi dire', 'mi potresti dire', 'mi spieghi', 'mi spiega',
  'vorrei sapere', 'mi dici', 'dimmi', 'ditemi',
  'che ne pensi', 'che ne pensate', 'come funziona', 'come mai',
  "c'è", 'ci sono', 'cè',
]

/**
 * Relleno conversacional que precede al verdadero comienzo.
 * "Allora, che ne pensi" tiene que detectarse igual que "che ne pensi".
 */
const RELLENO = new Set([
  'allora', 'quindi', 'ecco', 'beh', 'be', 'senti', 'senta', 'scusa', 'scusi',
  'ok', 'okay', 'va bene', 'dunque', 'insomma', 'cioè', 'cioe', 'ma', 'e',
  'però', 'pero', 'comunque', 'praticamente', 'diciamo', 'niente',
])

/**
 * Fórmulas sociales: son preguntas, pero no merecen una llamada al LLM.
 * Sin este triaje se gastaría dinero en "¿me oyes?".
 */
const CORTESIA = [
  'come stai', 'come sta', 'come state', 'come va', 'come andiamo',
  'mi senti', 'mi sentite', 'mi sente', 'si sente', 'ci sentite',
  'mi vedi', 'mi vedete', 'si vede', 'vedete lo schermo',
  'tutto bene', 'tutto a posto', 'ci siamo', 'siamo tutti',
  'possiamo iniziare', 'possiamo cominciare', 'cominciamo',
  'avete domande', 'ci sono domande', 'domande',
  'ha senso', 'va bene', "d'accordo", 'chiaro', 'tutto chiaro',
]

/** Minúsculas, sin puntuación y con espacios colapsados. */
function normalizar (texto) {
  return (texto || '')
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** La última frase del texto: la que se está diciendo ahora. */
function ultimaFrase (texto) {
  const partes = (texto || '').split(/(?<=[.!?…])\s+/)
  return partes[partes.length - 1] || texto || ''
}

/** Quita el relleno inicial y devuelve el resto. */
function sinRelleno (normalizado) {
  let palabras = normalizado.split(' ').filter(Boolean)
  let cambió = true
  while (cambió && palabras.length) {
    cambió = false
    // Probamos primero dos palabras ("va bene"), luego una.
    for (const n of [2, 1]) {
      if (palabras.length < n) continue
      if (RELLENO.has(palabras.slice(0, n).join(' '))) {
        palabras = palabras.slice(n)
        cambió = true
        break
      }
    }
  }
  return palabras.join(' ')
}

/** Quita un único pronombre clítico inicial, si lo hay. */
function sinClitico (normalizado) {
  const palabras = normalizado.split(' ')
  return palabras.length > 1 && CLITICOS.has(palabras[0])
    ? palabras.slice(1).join(' ')
    : normalizado
}

/** ¿El texto empieza por alguna de estas expresiones? */
function abrePor (texto, lista) {
  for (const exp of [...lista].sort((a, b) => b.length - a.length)) {
    if (texto === exp || texto.startsWith(exp + ' ')) return exp
  }
  return null
}

/**
 * Analiza una frase italiana.
 * @param {string} texto
 * @returns {{
 *   esPregunta: boolean,
 *   motivo: string|null,
 *   apertura: string|null,
 *   merecePena: boolean
 * }}
 */
function analizar (texto) {
  const crudo = (texto || '').trim()
  const cola = ultimaFrase(crudo)
  const norm = sinRelleno(normalizar(cola))

  const nulo = { esPregunta: false, motivo: null, apertura: null, merecePena: false }
  if (!norm) return nulo

  // 1. El signo, cuando Whisper lo pone. Es la señal más fiable de todas.
  const tieneSigno = /\?\s*$/.test(cola.trim())

  // 2. Palabra interrogativa al inicio.
  const interrogativa = abrePor(norm, INTERROGATIVAS)

  // 3. Perífrasis.
  const perifrasis = abrePor(norm, PERIFRASIS)

  // 4. Verbo en 2ª persona al inicio: el patrón que el resto se pierde.
  //    Se prueba también saltando un clítico inicial ("mi senti").
  const verbo = abrePor(norm, VERBOS_2A) || abrePor(sinClitico(norm), VERBOS_2A)

  const apertura = perifrasis || interrogativa || verbo
  const esPregunta = tieneSigno || Boolean(apertura)
  if (!esPregunta) return nulo

  const motivo = tieneSigno ? 'signo'
    : perifrasis ? 'perífrasis'
    : interrogativa ? 'interrogativa'
    : 'verbo-2a'

  return {
    esPregunta: true,
    motivo,
    apertura: apertura || null,
    merecePena: valeLaPena(norm),
  }
}

/**
 * Triaje gratis: separa lo que merece una llamada al LLM de lo que no.
 * Una fórmula social o un fragmento de tres palabras no se responden.
 */
function valeLaPena (normalizado) {
  if (CORTESIA.some(f => normalizado === f || normalizado.startsWith(f + ' ') || normalizado.includes(' ' + f))) {
    return false
  }
  return normalizado.split(' ').filter(Boolean).length >= 4
}

/**
 * Detección sobre la hipótesis en vivo: permite avisar "pregunta en camino"
 * antes de que la frase termine, porque solo mira cómo empieza.
 */
function preguntaEnCamino (hipotesis) {
  const norm = sinRelleno(normalizar(ultimaFrase(hipotesis)))
  if (!norm) return false
  return Boolean(
    abrePor(norm, PERIFRASIS) ||
    abrePor(norm, INTERROGATIVAS) ||
    abrePor(norm, VERBOS_2A) ||
    abrePor(sinClitico(norm), VERBOS_2A)
  )
}

module.exports = { analizar, preguntaEnCamino }
module.exports._internos = {
  normalizar, ultimaFrase, sinRelleno, sinClitico, abrePor, valeLaPena,
  INTERROGATIVAS, VERBOS_2A, PERIFRASIS, CORTESIA, RELLENO,
}
