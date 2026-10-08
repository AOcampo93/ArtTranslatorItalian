/**
 * detectorPreguntasIngles.js
 * Detecta preguntas en inglés sin gastar una llamada al LLM.
 *
 * ## Por qué es otro archivo y no una rama de `questionDetector.js`
 *
 * PLAN.md §0.20: añadir el inglés no puede tocar el italiano, que es el que ya
 * funciona en casa del cliente. Este módulo tiene la MISMA forma pública que el
 * italiano —`analizar` y `preguntaEnCamino`, que devuelven lo mismo— para que el
 * registro de idiomas (`idiomas.js`) los intercambie sin que `respuestas.js` se
 * entere.
 *
 * ## En qué se parece al italiano y en qué no
 *
 * El italiano escribe muchas preguntas igual que una afirmación, y por eso su
 * detector vive de una lista de verbos en 2ª persona. En inglés la pregunta suele
 * llevar una marca gramatical que el texto conserva: el auxiliar pasa delante del
 * sujeto («Do you…», «Have you…») o la abre una palabra interrogativa. Lo que el
 * texto no dice se lo deja al «?» de AssemblyAI, que en inglés pesa más porque la
 * pregunta entonativa sin forma interrogativa es menos frecuente (PLAN.md §17.3).
 *
 * ## Qué mira
 *
 *  1. **El signo.** Una frase que cierra con «?» es pregunta; si el turno trae
 *     varias, solo cuenta la que se dirige al oyente —abre con auxiliar, lleva
 *     «you» o cierra con una coletilla— o es una pregunta abierta (ver `analizar`).
 *  2. **Una palabra interrogativa** al inicio (what, why, how, when, where, who,
 *     whose, which; y what's, how's…). Sin «?», solo si la sigue un auxiliar
 *     —«what do», «how is», «when will»— y la frase no cierra con punto ni con
 *     exclamación: «When we finished, we sent it» es una afirmación, y también
 *     «What's important is that we ship on time.»
 *  3. **El auxiliar invertido** al inicio, delante de un sujeto: «Do you…»,
 *     «Have you…», «Isn't there…». Con «?» basta el auxiliar: «Did the client
 *     approve it?».
 *  4. **Una coletilla al final**, con o sin «?»: «…, right», «…, isn't it»,
 *     «…, don't you think», «…, correct».
 *  5. **Una perífrasis**: «I was wondering if», «any thoughts on», «what about».
 *
 * Antes de mirar nada se salta el relleno del inicio («so», «well», «you know»),
 * y las fórmulas de cortesía («can you hear me») se detectan pero no gastan una
 * llamada (ver `valeLaPena`).
 *
 * ## Qué no hace
 *
 * Ninguna regla de este archivo está medida con habla inglesa real: no hay todavía
 * ninguna reunión en inglés. Los números del triaje (4 y 3 palabras) se heredan
 * del italiano, donde sí se midieron (F049), y todo lo demás es `[por medir]`
 * (PLAN.md §17.10). Las frases de `inglesF050.test.js` son las del encargo de
 * F050, no un corpus.
 *
 * No intenta las preguntas que se escriben exactamente igual que una afirmación
 * («The budget covers maintenance too», dicha con entonación de pregunta, sin
 * signo): ni una persona leyendo solo ese texto lo sabría. Es el límite que el
 * italiano reconoce también, y lo recoge el «?» cuando llega.
 *
 * Y deja pasar un falso positivo conocido: «What's important is that we ship»,
 * SIN ninguna puntuación final, abre como «What's your take on…» —«what's» cuenta
 * como «what is», y el encargo pide que esa, sin signo, salga pregunta— y por
 * escrito las dos son iguales hasta la tercera palabra. Con punto ya no pasa (ver
 * `analizar`). Cuesta una llamada de más; cuántas, es `[por medir]` con una
 * reunión real.
 */

'use strict'

const { partirTurno } = require('./frases')
const { ABREVIATURAS_INGLES } = require('./abreviaturasIngles')

// ── Léxico ──────────────────────────────────────────────────────────────────

/** Interrogativas que abren una frase. */
const INTERROGATIVAS = new Set(['what', 'why', 'how', 'when', 'where', 'who', 'whom', 'whose', 'which'])

/** «What's», «how's»…: la interrogativa con el «is» pegado, que cuenta como las dos. */
const INTERROGATIVAS_CONTRAIDAS = new Set(["what's", "why's", "how's", "when's", "where's", "who's"])

/**
 * Auxiliares que abren pregunta cuando van DELANTE del sujeto, con sus negativas.
 * Sin «had» a propósito: «Had we known…» es un condicional, o sea una afirmación.
 * «Might» y «must» tampoco están: no los pedía el encargo, y no hay una reunión
 * inglesa que diga que haga falta.
 */
const AUXILIARES = new Set([
  'do', 'does', 'did', 'can', 'could', 'would', 'will', 'should', 'shall', 'may',
  'have', 'has', 'are', 'is', 'was', 'were',
  "don't", "doesn't", "didn't", "can't", "couldn't", "wouldn't", "won't", "shouldn't",
  "shan't", "haven't", "hasn't", "aren't", "isn't", "wasn't", "weren't",
])

/** Tras una interrogativa también vale «am»: «What am I supposed to…». */
const AUXILIARES_TRAS_INTERROGATIVA = new Set([...AUXILIARES, 'am'])

/**
 * Sujetos que, detrás de un auxiliar, dicen que se invirtió: los del encargo de
 * F050, más «anybody», «everybody» y «somebody». Sin «I» a propósito: sin signo,
 * «Do I have…» y «Have I…» pueden ser el hablante pensando en voz alta y no una
 * pregunta para el oyente. Con «?» no hace falta sujeto (ver `detectarApertura`).
 */
const SUJETOS = new Set([
  'you', 'we', 'there', 'it', 'this', 'that', 'they', 'he', 'she',
  'anyone', 'everyone', 'someone', 'anybody', 'everybody', 'somebody',
])

/**
 * «Do it by Friday», «Have this ready»: «do» y «have» son también verbos en
 * imperativo, y «it/this/that» son su complemento, no un sujeto. Sin «?», esa
 * pareja no es pregunta; con «?», sí.
 */
const AUXILIARES_QUE_TAMBIEN_MANDAN = new Set(['do', 'have'])
const COMPLEMENTOS_DE_MANDATO = new Set(['it', 'this', 'that'])

/**
 * Lo que puede ir entre la interrogativa y el auxiliar sin que deje de ser la
 * misma pregunta: «how LONG does it take», «what TIME is the call». Una lista
 * cerrada por interrogativa: «when one is tired…» no es una pregunta, y con una
 * regla general («cualquier palabra») lo sería.
 */
const COMPLEMENTOS_INTERROGATIVOS = new Map([
  ['how', new Set(['many', 'much', 'long', 'often', 'far', 'old', 'soon'])],
  ['what', new Set(['time', 'else'])],
  ['which', new Set(['one', 'ones'])],
])

/**
 * «Which is why we moved it» abre con «which is» y es una afirmación: un relativo
 * que continúa lo anterior. Sin «?», «which» + cópula no cuenta; «which one is»,
 * «which do you prefer» sí.
 */
const COPULAS = new Set(['is', 'are', 'was', 'were', 'am', 'has', 'have', "isn't", "aren't", "wasn't", "weren't", "hasn't", "haven't"])

/**
 * Detrás de una interrogativa, un sujeto delata una subordinada y no una
 * pregunta: «What you need is…», «When we finished…», «How this works is…». En una
 * pregunta de verdad el auxiliar va primero.
 */
const SUJETOS_DE_SUBORDINADA = new Set([...SUJETOS, 'i'])

/**
 * Perífrasis que introducen pregunta. «What about» y «how about» no llevan
 * auxiliar detrás, y por eso no las recoge la regla de las interrogativas.
 */
const PERIFRASIS = [
  'i was wondering if', 'i was wondering whether', "i'm wondering if", "i'm wondering whether",
  'i wonder if', 'i wonder whether', 'do you know if', 'do you know whether',
  'any thoughts on', 'what about', 'how about',
]

/**
 * Un «you» en cualquier punto de la frase la dirige al oyente: «You'll send it
 * tomorrow?», «By the way, would you share the deck?». En inglés el pronombre es
 * obligatorio, y por eso aquí vale en cualquier sitio, cosa que en italiano —que
 * lo omite— no se puede decir. Solo cuenta con el signo («You'll send it
 * tomorrow» es una afirmación) y para la puerta del turno de varias frases (ver
 * `analizar`).
 */
const SEGUNDA_PERSONA = /(?:^| )(?:you|your|yours|you'll|you're|you've|you'd)(?: |$)/

/**
 * Relleno del inicio que no cambia lo que se pregunta. «So, can you…» tiene que
 * detectarse igual que «can you…». Incluye las vacilaciones por si el
 * transcriptor las deja.
 */
const RELLENO = new Set([
  'so', 'okay', 'ok', 'well', 'alright', 'and', 'but', 'now', 'yeah', 'i mean', 'you know',
  'um', 'uh', 'er', 'erm', 'hmm', 'mm', 'oh',
])

/**
 * Coletilla al final de la frase: «You'll send it tomorrow, right». Lleva la coma
 * por delante a propósito: «turn right» no es una coletilla y «…, right» sí. Solo
 * las negativas («isn't it», «don't you think»), que son las que nombra el
 * encargo de F050; «…, do you» y «…, will you» quedan fuera hasta ver una reunión
 * real `[por medir]`.
 */
const COLETILLA = /,\s*(?:right|correct|(?:isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|couldn't|wouldn't|won't|shouldn't|haven't|hasn't)\s+(?:it|you|we|they|he|she|there|that|i)(?:\s+think)?)\s*$/i

/**
 * Fórmulas sociales: son preguntas, pero no merecen una llamada al LLM. Sin este
 * triaje se gastaría dinero en «can you hear me».
 */
const CORTESIA = [
  'can you hear me', 'can everyone hear me', 'can anyone hear me', 'can you hear us',
  'can you see my screen', 'can everyone see my screen', 'can you see the screen', 'can you see me',
  'how are you', "how's it going",
  'shall we start', 'shall we begin', 'shall we get started',
  'can we start', 'can we begin', 'can we get started',
  'is everyone here', 'is everybody here', 'are we all here', 'is everyone ready',
  'any questions', 'any other questions',
]

/**
 * Cuántas palabras pueden seguir a una fórmula de cortesía sin que deje de serlo:
 * «how are you DOING TODAY», «can you hear me OK NOW». Más que eso ya es otra
 * pregunta: «how are you planning to deploy» no es un saludo. El 2 es una
 * elección, no una medida `[por medir]`.
 */
const PALABRAS_TRAS_CORTESIA = 2

/**
 * Mínimo de palabras, sin el relleno inicial, para que una pregunta merezca una
 * llamada al LLM. Los dos números se heredan del italiano (F049, PLAN.md §17.4,
 * fila 7: «E tu la usi?» se descartaba con 4), donde se midieron; en inglés son
 * `[por medir]`. Con «?» explícito bastan 3 porque el signo es fiable: acaba en
 * puntuación el 96–97 % de las frases (PLAN.md §17.2) [medido, en italiano].
 */
const MIN_PALABRAS_SIN_SIGNO = 4
const MIN_PALABRAS_CON_SIGNO = 3

// ── Texto ───────────────────────────────────────────────────────────────────

/**
 * Minúsculas, sin puntuación y con espacios colapsados. Las comillas simples se
 * conservan DENTRO de la palabra («don't», «what's») y se quitan en los bordes,
 * donde son comillas de cita: `'Can you hear me?'` tiene que empezar por «can».
 */
function normalizar (texto) {
  return (texto || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Las frases del texto, en orden. Parte con `partirTurno` y las abreviaturas
 * inglesas, o sea con el mismo criterio de dónde acaba una oración que el troceo
 * de la reunión: «Could you ask Dr. Lee about it» es una sola frase aquí también.
 */
function todasLasFrases (texto) {
  const { oraciones, cola } = partirTurno(texto, { abreviaturas: ABREVIATURAS_INGLES })
  return cola ? [...oraciones, cola] : oraciones
}

/** La última frase: la que se está diciendo ahora. */
function ultimaFrase (frases) {
  return frases[frases.length - 1] || ''
}

/**
 * La racha de terminadores con la que cierra la frase —«.», «?», «?!», «...»—, sin
 * las comillas o paréntesis de detrás. Vacía si no cierra con ninguno.
 */
function cierreDe (frase) {
  return (String(frase || '').trim().match(/([.?!…]+)[\s"'”’»)\]]*$/) || [])[1] || ''
}

/** Las frases que cierran con «?», de la última a la primera. «?!» también es signo. */
function frasesConSigno (frases) {
  return frases.filter(f => cierreDe(f).includes('?')).reverse()
}

/** Quita el relleno inicial y devuelve el resto. */
function sinRelleno (normalizado) {
  let palabras = normalizado.split(' ').filter(Boolean)
  let cambio = true
  while (cambio && palabras.length) {
    cambio = false
    // Primero dos palabras («you know»), luego una.
    for (const n of [2, 1]) {
      if (palabras.length < n) continue
      if (RELLENO.has(palabras.slice(0, n).join(' '))) {
        palabras = palabras.slice(n)
        cambio = true
        break
      }
    }
  }
  return palabras.join(' ')
}

/** ¿El texto empieza por alguna de estas expresiones? Devuelve la más larga que sí. */
function abrePor (texto, lista) {
  for (const exp of [...lista].sort((a, b) => b.length - a.length)) {
    if (texto === exp || texto.startsWith(exp + ' ')) return exp
  }
  return null
}

/**
 * La coletilla con la que cierra la frase CRUDA —con su coma, que `normalizar`
 * borra—, o `null`. Con «?» o sin él, y con comillas detrás o no.
 */
function tieneColetilla (frase) {
  const sinCierre = String(frase || '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .trim()
    .replace(/[\s?!.…"'”’»)\]]+$/, '')
  const m = sinCierre.match(COLETILLA)
  return m ? m[0].replace(/^,\s*/, '').toLowerCase() : null
}

// ── Reglas ──────────────────────────────────────────────────────────────────

/**
 * Busca perífrasis, interrogativa o auxiliar invertido al inicio del texto ya
 * normalizado y sin relleno. Devuelve `null` si no hay ninguna marca.
 *
 * @param {string} norm
 * @param {{conSigno?: boolean, afirmada?: boolean}} [opciones]
 *   `conSigno`: la frase de la que sale `norm` cierra con «?». Basta una
 *   interrogativa («What a question?») o un auxiliar al inicio, sea cual sea el
 *   sujeto («Did the client approve it?»), y «Do it?» es pregunta; sin él hace
 *   falta lo que dice cada regla.
 *   `afirmada`: cierra con «.», «!» o «…». El transcriptor ya dijo que es una
 *   afirmación, y una interrogativa sin «?» deja de ser pregunta (F050, ronda 2;
 *   ver `analizar`). Solo afecta a las interrogativas: el auxiliar invertido
 *   —«Can you send me the file.», una petición— y las perífrasis siguen valiendo.
 */
function detectarApertura (norm, { conSigno = false, afirmada = false } = {}) {
  const perifrasis = abrePor(norm, PERIFRASIS)
  if (perifrasis) return { motivo: 'perífrasis', apertura: perifrasis }

  const palabras = norm.split(' ')
  const [primera, segunda] = palabras

  if (INTERROGATIVAS_CONTRAIDAS.has(primera)) {
    return afirmada ? null : { motivo: 'interrogativa', apertura: primera }
  }

  if (INTERROGATIVAS.has(primera)) {
    if (conSigno) return { motivo: 'interrogativa', apertura: primera }
    if (afirmada) return null

    const largo = COMPLEMENTOS_INTERROGATIVOS.get(primera)?.has(segunda) ? 2 : 1
    const auxiliar = palabras[largo]
    const esRelativo = primera === 'which' && largo === 1 && COPULAS.has(auxiliar)
    if (AUXILIARES_TRAS_INTERROGATIVA.has(auxiliar) && !esRelativo) {
      return { motivo: 'interrogativa', apertura: palabras.slice(0, largo + 1).join(' ') }
    }
    return null
  }

  if (AUXILIARES.has(primera)) {
    const conSujeto = SUJETOS.has(segunda)
    const apertura = conSujeto ? `${primera} ${segunda}` : primera
    if (conSigno) return { motivo: 'inversión', apertura }
    const esMandato = AUXILIARES_QUE_TAMBIEN_MANDAN.has(primera) && COMPLEMENTOS_DE_MANDATO.has(segunda)
    if (conSujeto && !esMandato) return { motivo: 'inversión', apertura }
  }

  return null
}

/**
 * ¿Es una fórmula social? La fórmula puede ir en cualquier punto de la frase
 * —«Hi everyone, can you hear me»— pero no seguida de mucho más (ver
 * `PALABRAS_TRAS_CORTESIA`).
 */
function esCortesia (norm) {
  const relleno = ` ${norm} `
  return CORTESIA.some(f => {
    const i = relleno.indexOf(` ${f} `)
    if (i < 0) return false
    const resto = relleno.slice(i + f.length + 2).trim()
    return (resto ? resto.split(' ').length : 0) <= PALABRAS_TRAS_CORTESIA
  })
}

/**
 * Triaje gratis: separa lo que merece una llamada al LLM de lo que no. La fórmula
 * social manda sobre el signo: «Can you hear me?» sigue sin gastar una llamada.
 * @param {string} norm
 * @param {boolean} [conSigno] la frase cerraba con «?»
 */
function valeLaPena (norm, conSigno = false) {
  if (esCortesia(norm)) return false
  const minimo = conSigno ? MIN_PALABRAS_CON_SIGNO : MIN_PALABRAS_SIN_SIGNO
  return norm.split(' ').filter(Boolean).length >= minimo
}

/**
 * Analiza una frase inglesa.
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

  // 1. El signo, cuando AssemblyAI lo pone. Es la señal más fiable —y en inglés
  //    más que en italiano—, pero solo cuando cierra la única frase del turno. Si
  //    el turno trae varias, un «?» puede cerrar un comentario que sigue a una
  //    narración: hace falta además que la propia frase se dirija al oyente (abre
  //    con auxiliar o con perífrasis, lleva «you» o cierra con una coletilla) o
  //    sea una pregunta abierta (abre con interrogativa). Se miran todas las que
  //    llevan «?», de la última a la primera: «Have you finished the report? And
  //    the budget?» tiene la pregunta en la primera.
  const frases = todasLasFrases(crudo)
  for (const frase of frasesConSigno(frases)) {
    const normSigno = sinRelleno(normalizar(frase))
    if (!normSigno) continue
    const apertura = detectarApertura(normSigno, { conSigno: true })
    const dirigida = apertura
      ? apertura.apertura
      : (normSigno.match(SEGUNDA_PERSONA)?.[0].trim() || tieneColetilla(frase))
    if (frases.length <= 1 || dirigida) {
      return {
        esPregunta: true,
        motivo: 'signo',
        apertura: dirigida || null,
        merecePena: valeLaPena(normSigno, true),
      }
    }
  }

  // 2. Sin signo aprovechable: solo la última frase, la que se está diciendo ahora.
  //
  //    F050, ronda 2. Si cierra con punto, exclamación o puntos suspensivos, el
  //    transcriptor ya dijo que es una afirmación, y una interrogativa sin «?»
  //    —«What's important is that we ship on time.»— deja de ser pregunta: es lo
  //    mismo que hace F049 con «perché» en italiano. MEDIDO por el líder en la
  //    revisión de F050: esa frase salía como pregunta. Acaban en puntuación el
  //    96–97 % de las frases (PLAN.md §17.2) [medido, en italiano]; el resto, las
  //    que llegan sin ningún signo, conserva la regla de «interrogativa +
  //    auxiliar». Lo que NO cambia es el auxiliar invertido («Can you send me the
  //    file.» es una petición y merece respuesta aunque acabe en punto), ni las
  //    coletillas, ni las perífrasis.
  const cola = ultimaFrase(frases)
  const norm = sinRelleno(normalizar(cola))
  if (!norm) return nulo

  const cierre = cierreDe(cola)
  const apertura = detectarApertura(norm, { afirmada: cierre !== '' && !cierre.includes('?') })
  const coletilla = apertura ? null : tieneColetilla(cola)
  if (!apertura && !coletilla) return nulo

  return {
    esPregunta: true,
    motivo: apertura ? apertura.motivo : 'coletilla',
    apertura: apertura ? apertura.apertura : coletilla,
    merecePena: valeLaPena(norm),
  }
}

/**
 * Detección sobre la hipótesis en vivo: permite avisar «pregunta en camino» antes
 * de que la frase termine, porque solo mira cómo empieza. Por eso no mira las
 * coletillas, que están al final, y por eso una interrogativa sola ya cuenta
 * mientras no la siga un sujeto: «What» puede acabar en «What do you think», y
 * «When we» ya es una subordinada.
 */
function preguntaEnCamino (hipotesis) {
  const norm = sinRelleno(normalizar(ultimaFrase(todasLasFrases(hipotesis))))
  if (!norm) return false
  if (abrePor(norm, PERIFRASIS)) return true

  const [primera, segunda] = norm.split(' ')
  if (INTERROGATIVAS_CONTRAIDAS.has(primera)) return true
  if (INTERROGATIVAS.has(primera)) return !SUJETOS_DE_SUBORDINADA.has(segunda)
  return Boolean(detectarApertura(norm))
}

module.exports = { analizar, preguntaEnCamino }
module.exports._internos = {
  normalizar, ultimaFrase, todasLasFrases, cierreDe, frasesConSigno, sinRelleno, abrePor,
  tieneColetilla, detectarApertura, esCortesia, valeLaPena,
  INTERROGATIVAS, AUXILIARES, SUJETOS, PERIFRASIS, CORTESIA, RELLENO, SEGUNDA_PERSONA,
}
