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
  // F044: "mi fai ricordarti..." — verbo modal dirigido que faltaba,
  // medido en el informe de v0.8.0 («Quante volte sei stata in Brasile?»).
  'fai', 'fate',
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

/**
 * F049. «Sai,» y «Senti,» con coma al inicio son muletillas («¿sabes?»,
 * «oye»), no una pregunta. MEDIDO en los informes v0.6–v0.9 (PLAN.md §17.4,
 * fila 7): «Sai, a me piace molto l'arte brasiliana.» salía como pregunta por
 * el verbo «sai». Lo que decide es la coma: «Sai dov'è il documento» sí
 * pregunta, y una frase que cierra con «?» es pregunta pase lo que pase (ver
 * `sinMuletilla`).
 */
const MULETILLA_INICIAL = /^\s*(?:sai|senti)\s*,\s*/i

/**
 * F049. Pronombres que dirigen al oyente una frase con «?» aunque no abra con
 * interrogativa ni con verbo en 2ª persona: «E tu la usi?». Solo valen con el
 * signo —«Tu lavori con noi» es una afirmación— y solo para la puerta del
 * turno de varias frases (ver `analizar`). «Lei» queda fuera a propósito: casi
 * siempre es «ella» (ver `promptTraduccion`).
 */
const PRONOMBRES_2A = ['tu', 'voi']

/** Perífrasis que introducen pregunta indirecta. */
const PERIFRASIS = [
  'mi puoi dire', 'mi potresti dire', 'mi spieghi', 'mi spiega',
  'vorrei sapere', 'mi dici', 'dimmi', 'ditemi',
  'che ne pensi', 'che ne pensate', 'cosa ne pensi', 'cosa ne pensate',
  'come funziona', 'come mai',
]

/*
 * F044: "c'è" y "ci sono" ("hay") se quitaron de aquí — MEDIDO en el informe
 * de v0.8.0: abrían como pregunta frases puramente descriptivas («C'è una
 * parte alta che si chiama Città Alta…», «Ci sono dei vantaggi perché…»),
 * 3 de las 5 afirmaciones que el detector confundía con preguntas. "Hay" es
 * tan corriente en una frase declarativa que, sin signo de interrogación
 * detrás, no distingue nada.
 */

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

/** Todas las frases del texto, en orden. */
function todasLasFrases (texto) {
  return (texto || '').split(/(?<=[.!?…])\s+/).filter(Boolean)
}

/** La última frase del texto: la que se está diciendo ahora. */
function ultimaFrase (texto) {
  const partes = todasLasFrases(texto)
  return partes[partes.length - 1] || texto || ''
}

/**
 * F044: la última frase del texto que termina en "?", si la hay.
 *
 * Antes solo se miraba la última frase a secas. MEDIDO en el informe de
 * v0.8.0: en «Mi fai ricordarti quante volte sei stata in Brasile? Perché
 * Giulia per tanti anni è stata in Brasile.» la pregunta real es la PRIMERA
 * frase — la última es la explicación que sigue— y se perdía por completo.
 */
function ultimaConSigno (texto) {
  const frases = todasLasFrases(texto)
  for (let i = frases.length - 1; i >= 0; i--) {
    if (/\?\s*$/.test(frases[i].trim())) return frases[i]
  }
  return null
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

/**
 * F049. Quita la muletilla «Sai,»/«Senti,» del inicio de una frase CRUDA —con
 * su coma, que `normalizar` borra—, salvo que la frase cierre con «?»: ahí el
 * signo manda y la frase se deja entera. Lo que queda se evalúa como siempre:
 * «Sai, hai finito il report» sigue siendo pregunta por el «hai».
 */
function sinMuletilla (frase) {
  const f = (frase || '').trim()
  return /\?\s*$/.test(f) ? f : f.replace(MULETILLA_INICIAL, '')
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
 * F044: por encima de esta longitud, una frase que abre con "perché" ya no
 * cuenta como interrogativa sin signo.
 *
 * MEDIDO en el informe de v0.8.0: «Perché nella mata c'è proprio l'energia,
 * l'energia che arriva dalla terra e l'energia che arriva dagli alberi.»
 * (16 palabras) es una explicación ("porque"), no una pregunta ("¿por qué?"),
 * y se colaba como las otras cinco. El caso de PLAN.md §9 que sí es pregunta
 * —«Perché il budget non copre le ore extra»— tiene 8 palabras. Por escrito,
 * "perché" es ambiguo entre "por qué" y "porque"; la longitud es la única
 * señal barata que separa una pregunta directa de una frase que explica algo.
 *
 * F049: esa señal solo vale cuando la frase NO trae puntuación al final. Si
 * cierra con «.», «!» o «…» el transcriptor ya dijo que es una afirmación —
 * MEDIDO en v0.9: «Perché nella mata c'è proprio l'energia.» (6 palabras) se
 * colaba por debajo del límite— y con «?» explícito «perché» es siempre
 * pregunta, sea cual sea la longitud. Acaban en puntuación el 96–97 % de las
 * frases (PLAN.md §17.2) [medido]; el resto, las que llegan sin signo, conserva
 * el criterio de longitud de F044.
 */
const LIMITE_PALABRAS_PERCHE = 8

/**
 * Busca perífrasis, interrogativa o verbo en 2ª persona al inicio del texto
 * ya normalizado y sin relleno. Devuelve null si no hay ninguna marca.
 *
 * @param {string} norm
 * @param {{conSigno?: boolean, afirmada?: boolean}} [cierre] cómo cierra la
 *   frase de la que sale `norm` (F049): con «?» explícito, «perché» abre
 *   siempre una pregunta; si cierra con punto, exclamación o puntos
 *   suspensivos, nunca. Sin ninguna de las dos decide la longitud (F044).
 */
function detectarApertura (norm, { conSigno = false, afirmada = false } = {}) {
  const perifrasis = abrePor(norm, PERIFRASIS)
  if (perifrasis) return { motivo: 'perífrasis', apertura: perifrasis }

  const interrogativa = abrePor(norm, INTERROGATIVAS)
  if (interrogativa) {
    const esPerche = interrogativa === 'perché' || interrogativa === 'perche'
    const numPalabras = norm.split(' ').filter(Boolean).length
    const esPorque = esPerche && !conSigno &&
      (afirmada || numPalabras > LIMITE_PALABRAS_PERCHE)
    if (!esPorque) {
      return { motivo: 'interrogativa', apertura: interrogativa }
    }
  }

  // Verbo en 2ª persona al inicio: el patrón que el resto se pierde.
  // Se prueba también saltando un clítico inicial ("mi senti").
  const verbo = abrePor(norm, VERBOS_2A) || abrePor(sinClitico(norm), VERBOS_2A)
  if (verbo) return { motivo: 'verbo-2a', apertura: verbo }

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
  const nulo = { esPregunta: false, motivo: null, apertura: null, merecePena: false }
  if (!crudo) return nulo

  // 1. El signo, cuando Whisper lo pone. Es la señal más fiable de todas
  //    — pero solo cuando cierra la única frase del turno. Si el turno
  //    trae varias frases, un "?" al final de la última puede cerrar un
  //    comentario que solo sigue una narración (ver `ultimaConSigno`):
  //    hace falta además que la propia frase se dirija al oyente.
  //
  //    F049. «Dirigida al oyente» incluía solo la apertura (interrogativa,
  //    perífrasis o verbo en 2ª persona), y por eso «…per i lettini. E tu la
  //    usi?» se perdía: «tu la usi» no abre con ninguna de las tres, así que
  //    la puerta lo descartaba y el paso 2 miraba la misma frase y tampoco
  //    hallaba apertura. El pronombre «tu»/«voi» es la marca más explícita de
  //    todas. La narración que cierra con «?» y sin esa marca (F044: «E in
  //    questi tanti viaggi hai fatto…?») sigue sin pasar.
  const frases = todasLasFrases(crudo)
  const conSigno = ultimaConSigno(crudo)
  if (conSigno) {
    const normSigno = sinRelleno(normalizar(conSigno))
    if (normSigno) {
      const apertura = detectarApertura(normSigno, { conSigno: true })
      const dirigida = apertura ? apertura.apertura : abrePor(normSigno, PRONOMBRES_2A)
      if (frases.length <= 1 || dirigida) {
        return {
          esPregunta: true,
          motivo: 'signo',
          apertura: dirigida || null,
          merecePena: valeLaPena(normSigno, true),
        }
      }
    }
  }

  // 2. Sin signo aprovechable: se mira solo la última frase, la que se
  //    está diciendo ahora. F049: sin la muletilla «Sai,»/«Senti,» del
  //    inicio, y sabiendo si la frase cierra con punto (ver
  //    `LIMITE_PALABRAS_PERCHE`).
  const cola = ultimaFrase(crudo)
  const afirmada = /[.!…]\s*$/.test(cola)
  const norm = sinRelleno(normalizar(sinMuletilla(cola)))
  if (!norm) return nulo

  const apertura = detectarApertura(norm, { afirmada })
  if (!apertura) return nulo

  return {
    esPregunta: true,
    motivo: apertura.motivo,
    apertura: apertura.apertura,
    merecePena: valeLaPena(norm),
  }
}

/**
 * Mínimo de palabras, sin el relleno inicial, para que una pregunta merezca una
 * llamada al LLM. Sin signo son 4. Con «?» explícito bastan 3 (F049): MEDIDO en
 * v0.9 (PLAN.md §17.4, fila 7), «E tu la usi?» —«tu la usi» tras quitar «e»—
 * era una pregunta clara que el triaje descartaba. El signo es fiable porque el
 * 96–97 % de las frases acaba en puntuación (PLAN.md §17.2) [medido].
 */
const MIN_PALABRAS_SIN_SIGNO = 4
const MIN_PALABRAS_CON_SIGNO = 3

/**
 * Triaje gratis: separa lo que merece una llamada al LLM de lo que no.
 * Una fórmula social o un fragmento corto no se responden. La fórmula social
 * manda sobre el signo: «Mi sentite bene?» sigue sin gastar una llamada.
 * @param {string} normalizado
 * @param {boolean} [conSigno] la frase cerraba con «?»
 */
function valeLaPena (normalizado, conSigno = false) {
  if (CORTESIA.some(f => normalizado === f || normalizado.startsWith(f + ' ') || normalizado.includes(' ' + f))) {
    return false
  }
  const minimo = conSigno ? MIN_PALABRAS_CON_SIGNO : MIN_PALABRAS_SIN_SIGNO
  return normalizado.split(' ').filter(Boolean).length >= minimo
}

/**
 * Detección sobre la hipótesis en vivo: permite avisar "pregunta en camino"
 * antes de que la frase termine, porque solo mira cómo empieza. Tampoco la
 * dispara la muletilla «Sai,» (F049).
 */
function preguntaEnCamino (hipotesis) {
  const norm = sinRelleno(normalizar(sinMuletilla(ultimaFrase(hipotesis))))
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
  normalizar, ultimaFrase, todasLasFrases, ultimaConSigno, sinRelleno,
  sinMuletilla, sinClitico, abrePor, detectarApertura, valeLaPena,
  INTERROGATIVAS, VERBOS_2A, PERIFRASIS, CORTESIA, RELLENO, PRONOMBRES_2A,
}
