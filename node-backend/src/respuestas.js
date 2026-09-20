/**
 * respuestas.js
 * Detecta las preguntas dirigidas al usuario y redacta qué puede contestar.
 *
 * ## El triaje gratuito va DELANTE, y es lo que hace esto asequible
 *
 * `questionDetector.analizar()` corre en local y no cuesta nada. Sólo lo que
 * pasa ese filtro llega al LLM. Sin él habría que mandar cada frase de la
 * reunión —cientos por hora— y el coste se multiplicaría por veinte sin mejorar
 * nada: una fórmula social como *«come stai»* o un fragmento de tres palabras
 * no se responden.
 *
 * El detector acierta en italiano gracias a un patrón que el resto se pierde:
 * **el verbo en segunda persona al principio de la frase** —`hai`, `avete`,
 * `puoi`, `sai`— con o sin clítico delante (*«mi senti»*). Sobre los seis casos
 * de `PLAN.md` §9: buscar el signo de interrogación acertaba **2 de 6**
 * `[medido]`; este detector local acierta **5 de 6** `[medido]`. El sexto
 * —*«Il budget copre anche la manutenzione»*— es genuinamente ambiguo por
 * escrito y le toca a la capa del LLM, que **no se ha ejercido nunca** contra
 * una API real; `PLAN.md` §9 avisa además de que con las tres capas seguirán
 * quedando falsos negativos en las preguntas puramente entonativas.
 * `[por medir]`
 *
 * ## La respuesta va SOLO en italiano
 *
 * Confirmado con el cliente: es para decirla en voz alta, no para entenderla.
 * La **pregunta** sí se enseña también en español, porque el usuario necesita
 * saber qué le han preguntado — y esa traducción ya la hizo Marian gratis al
 * pintar la burbuja, así que no cuesta una llamada extra.
 *
 * ## Por qué el LLM se inyecta
 *
 * `llamar()` entra por el constructor en vez de instanciar aquí un cliente. Así
 * el usuario elige proveedor con su propia clave, y sobre todo: toda la lógica
 * de decisión —qué se responde, qué no, qué no se repite— se prueba **sin red**.
 * Es la lección del proyecto: lo que sólo se puede ejercer llamando al exterior
 * no se comprueba nunca.
 */

'use strict'

const { EventEmitter } = require('events')
const { analizar } = require('./questionDetector')
const { promptRespuesta, promptResumen } = require('../../shared/prompts')
const { clasificarError } = require('./llm')

/** Tope de la respuesta. Es funcional: se lee de un vistazo mientras esperan. */
const MAX_CARACTERES = 500

/**
 * Cuántas preguntas recientes se recuerdan para no repetir.
 *
 * En una reunión la misma pregunta se reformula («quanto tempo ci vuole?» /
 * «quanto tempo serve?») y responder dos veces llena el panel de ruido justo
 * cuando el usuario necesita leer una sola cosa.
 */
const MEMORIA = 12

/** Cuántas frases anteriores se le dan al LLM como contexto inmediato. */
const FRASES_DE_CONTEXTO = 6

/** Normaliza para comparar preguntas: sin signos, sin acentos, sin relleno. */
function huella (texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pares de comillas que el modelo pone cuando "cita" su propia respuesta.
 * Solo se quitan si envuelven el texto entero: `"Certo." Poi "vediamo"` NO se
 * toca, porque quitarle el primer y el último carácter lo deja roto.
 */
const COMILLAS = [['"', '"'], ["'", "'"], ['«', '»'], ['“', '”']]

function sinComillasEnvolventes (t) {
  for (const [abre, cierra] of COMILLAS) {
    if (t.length > 2 && t.startsWith(abre) && t.endsWith(cierra)) {
      const dentro = t.slice(1, -1)
      // Si dentro vuelve a aparecer el cierre, no envolvía: eran dos citas.
      if (!dentro.includes(cierra)) return dentro.trim()
    }
  }
  return t
}

/**
 * ¿Son la misma pregunta con otras palabras? Palabras en común sobre el tamaño
 * de la MÁS CORTA de las dos, no sobre la unión.
 *
 * Es deliberado y es el filo de este triaje. Con la unión (Jaccard puro),
 * *«quanto tempo ci vuole per completare l'integrazione»* y su reformulación
 * *«quanto tempo serve»* dan 0,29 y se responderían dos veces, que es
 * exactamente lo que el panel no debe hacer. Con la más corta dan 0,67 y se
 * reconocen.
 *
 * El precio: dos preguntas DISTINTAS de tres o cuatro palabras que compartan
 * dos se confunden. En la práctica no llegan aquí, porque `valeLaPena()` ya
 * descarta lo que baja de cuatro palabras, y a partir de cinco el ruido se
 * diluye —*«come funziona il sistema di pagamento»* y *«come funziona il modulo
 * di magazzino»* dan 0,5 y se tratan como distintas—. No está medido sobre
 * transcripciones reales de reunión. [por medir]
 */
function sonLaMisma (a, b, umbral = 0.6) {
  const A = new Set(huella(a).split(' ').filter(w => w.length > 2))
  const B = new Set(huella(b).split(' ').filter(w => w.length > 2))
  if (!A.size || !B.size) return false
  let comunes = 0
  for (const w of A) if (B.has(w)) comunes++
  return comunes / Math.min(A.size, B.size) >= umbral
}

class MotorRespuestas extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Function} opts.llamar       (systemPrompt, userContent) => Promise<string>
   * @param {Function} [opts.bloqueContexto] () => string, el perfil y la reunión
   */
  constructor ({ llamar, bloqueContexto } = {}) {
    super()
    if (typeof llamar !== 'function') {
      throw new Error('hace falta una función para llamar al LLM')
    }
    this.llamar = llamar
    this.bloqueContexto = bloqueContexto || (() => '')

    this._vistas = []          // { id, it, es }
    this._recientes = []       // últimas frases, para el contexto inmediato
    this._n = 0
    this.stats = {
      analizadas: 0, detectadas: 0, respondidas: 0, descartadas: 0, fallos: 0,
      // F033: cuántas de las detectadas las abrió el usuario a mano, pulsando
      // «→ Pregunta» en una burbuja. Es el dato que dice cuántas se le escapan
      // al detector local: si este número no fuera cero, el 5/6 medido en
      // `PLAN.md` §9 no se sostiene en habla real.
      preguntasManuales: 0,
    }
  }

  /**
   * Considera una frase ya transcrita. Devuelve el id si abrió una pregunta.
   * @param {string} it  la frase en italiano
   * @param {string} [es] su traducción, para enseñarla
   */
  async considerar (it, es) {
    const texto = (it || '').trim()
    if (!texto) return null
    this.stats.analizadas++

    this._recientes.push({ it: texto, es: es || '' })
    if (this._recientes.length > FRASES_DE_CONTEXTO) this._recientes.shift()

    const a = analizar(texto)
    if (!a.esPregunta) return null

    // El detector separa además lo que merece una llamada de lo que no: una
    // fórmula social o un fragmento corto se detectan pero no se responden.
    if (!a.merecePena) { this.stats.descartadas++; return null }

    if (this._vistas.some(v => sonLaMisma(v.it, texto))) {
      this.stats.descartadas++
      return null
    }

    const id = `q${++this._n}`
    const pregunta = { id, it: texto, es: es || '' }
    this._vistas.push(pregunta)
    if (this._vistas.length > MEMORIA) this._vistas.shift()
    this.stats.detectadas++

    // Se anuncia ANTES de llamar al LLM: el usuario ve que hay una pregunta
    // esperando mientras se redacta, en vez de un panel vacío durante un
    // segundo largo.
    this.emit('pregunta', { ...pregunta, motivo: a.motivo })
    this._lanzar(pregunta)
    return id
  }

  /**
   * Convierte una frase ya traducida en pregunta a mano (F033): el usuario
   * pulsó «→ Pregunta» en una burbuja porque el detector no la cachó.
   *
   * Se salta `analizar()` y `merecePena` a propósito —es la única razón de
   * ser de este método—, pero respeta el MISMO dedupe que `considerar()`: si
   * la pregunta ya está en el panel (la vio el detector, o el usuario ya la
   * forzó antes), no se abre una tarjeta repetida. El usuario decide qué es
   * una pregunta; no decide que la misma pregunta se responda dos veces.
   *
   * @param {string} it  la frase en italiano, tal como está en la burbuja
   * @param {string} [es] su traducción, ya pintada
   * @returns {string|null} el id de la tarjeta, o null si era la misma de antes
   */
  forzar (it, es) {
    const texto = (it || '').trim()
    if (!texto) return null

    if (this._vistas.some(v => sonLaMisma(v.it, texto))) {
      this.stats.descartadas++
      return null
    }

    const id = `q${++this._n}`
    const pregunta = { id, it: texto, es: es || '', manual: true }
    this._vistas.push(pregunta)
    if (this._vistas.length > MEMORIA) this._vistas.shift()
    this.stats.detectadas++
    this.stats.preguntasManuales++

    this.emit('pregunta', { ...pregunta })
    this._lanzar(pregunta)
    return id
  }

  /**
   * Vuelve a redactar, cuando el usuario pulsa «Otra».
   *
   * Si el id ya no está —`_vistas` solo recuerda las últimas MEMORIA, pero la
   * tarjeta sigue en pantalla toda la reunión— **hay que decirlo igual**: el
   * renderer ya ha puesto «Preparando…» al pulsar el botón, y sin respuesta se
   * queda así para siempre. Es el mismo fallo que el del LLM caído, por otra
   * puerta.
   */
  reintentar (id) {
    const p = this._vistas.find(v => v.id === id)
    if (!p) {
      // No es un fallo del LLM: no hay nada técnico que contar aparte, así
      // que `detalle` va vacío en vez de repetir el mensaje.
      this.emit('respuesta', {
        id,
        texto: null,
        tipo: 'desconocido',
        mensaje: 'Esa pregunta ya es demasiado antigua para redactarla otra vez.',
        detalle: '',
      })
      return false
    }
    this._lanzar(p, true)
    return true
  }

  /**
   * Dispara la redacción sin esperarla: la pregunta ya está pintada y el
   * usuario no debe esperar a que el modelo conteste para verla. `_responder`
   * atrapa sus propios fallos; este `catch` es la última red para que un
   * oyente que lance no tumbe el proceso en mitad de una reunión.
   */
  _lanzar (pregunta, otra = false) {
    this._responder(pregunta, otra).catch(err => {
      this.stats.fallos++
      console.error('[respuestas] fallo al redactar:', err.message)
    })
  }

  async _responder (pregunta, otra = false) {
    try {
      // Dentro del try a propósito: `bloqueContexto()` consulta la base de
      // datos y puede fallar. Fuera, ese fallo no emitiría nada y dejaría
      // «Preparando…» para siempre.
      const sistema = promptRespuesta(this.bloqueContexto())
      const anteriores = this._recientes
        .filter(f => f.it !== pregunta.it)
        .map(f => `- ${f.it}`)
        .join('\n')

      const usuario = [
        anteriores && `Lo que se dijo antes:\n${anteriores}`,
        `La pregunta que le han hecho:\n${pregunta.it}`,
        otra && 'Redáctala de otra forma, distinta a la anterior.',
      ].filter(Boolean).join('\n\n')

      const bruto = await this.llamar(sistema, usuario)
      const texto = this._limpiar(bruto)
      if (!texto) throw new Error('el modelo devolvió una respuesta vacía')
      this.stats.respondidas++
      this.emit('respuesta', { id: pregunta.id, texto })
    } catch (err) {
      this.stats.fallos++
      // Se dice que no hay respuesta, en vez de dejar «Preparando…» para
      // siempre: el usuario está en mitad de una reunión y necesita saber que
      // esto no va a llegar. F021: nunca `err.message` crudo — puede ser el
      // JSON entero del proveedor, o traer la clave a medio redactar (el 401
      // de OpenAI). `clasificarError` decide QUÉ pasó y QUÉ hacer; `detalle`
      // ya viene saneado para el «ver detalle» plegado.
      const { tipo, mensaje, detalle } = clasificarError(err)
      this.emit('respuesta', { id: pregunta.id, texto: null, tipo, mensaje, detalle })
    }
  }

  /**
   * El modelo a veces envuelve en markdown o añade preámbulo, aunque el prompt
   * lo prohíba. Se limpia aquí en vez de confiar.
   */
  _limpiar (bruto) {
    let t = String(bruto || '').trim()
    if (t.startsWith('```')) {
      t = t.split('\n').slice(1).join('\n').split('```')[0].trim()
    }
    t = sinComillasEnvolventes(t)
    if (t.length > MAX_CARACTERES) {
      // Se corta en la última frase completa: media frase en voz alta es peor
      // que una frase corta.
      const corte = t.slice(0, MAX_CARACTERES)
      const fin = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('! '), corte.lastIndexOf('? '))
      t = (fin > MAX_CARACTERES * 0.5 ? corte.slice(0, fin + 1) : corte).trim()
    }
    return t
  }
}

/**
 * El panel de contexto general: «de qué se está hablando».
 *
 * ## Es el tercero de tres paneles, y se nota en cada decisión de aquí
 *
 * Va colapsado por defecto y **no puede robarle llamadas a las respuestas**,
 * que son el panel por el que el cliente paga. De ahí las tres cosas raras que
 * tiene esta clase:
 *
 * 1. **No hay temporizador.** El reloj se mira cuando llega una frase. Un
 *    `setInterval` en el proceso principal de Electron sigue vivo cuando la
 *    reunión ya terminó y gasta llamadas resumiendo el silencio.
 * 2. **Hay un mínimo de frases nuevas.** Sin él, una reunión con dos frases por
 *    minuto pediría un resumen de dos frases cada dos minutos.
 * 3. **Un fallo no se pinta.** En el panel de respuestas un fallo SE DICE,
 *    porque el usuario está esperando esa respuesta para hablar. Aquí nadie
 *    espera nada: se cuenta en `stats.fallos`, se deja el resumen anterior en
 *    pantalla y se reintenta al siguiente intervalo. Un panel plegado que
 *    grita un error es ruido en mitad de una reunión.
 */

/**
 * Cada cuánto se pide un resumen, en milisegundos.
 *
 * 120 s, el triple que el escáner de preguntas (40 s, `shared/prompts.js`).
 * Dos razones, ninguna medida en producción:
 *
 *  - **Coste.** A 40 s son 90 llamadas en una reunión de una hora; a 120 s, 30.
 *    Es el panel menos importante y sería el que más gastara.
 *  - **Legibilidad.** Un párrafo que se reescribe cada 40 s no se puede leer
 *    mientras cambia, y el usuario está leyendo los otros dos paneles.
 *
 * El número es un punto de partida razonado, no medido contra reuniones
 * reales. [por medir]
 */
const INTERVALO_RESUMEN_MS = 120_000

/** Frases nuevas mínimas para que el resumen tenga algo que decir. */
const MIN_FRASES_RESUMEN = 6

/** Tope de frases que se le mandan al modelo, para acotar el coste por llamada. */
const MAX_FRASES_RESUMEN = 60

class MotorResumen extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Function} opts.llamar              (sistema, usuario, opciones) => Promise<string>
   * @param {Function} [opts.bloqueContexto]    () => string
   * @param {Function} [opts.ahora]             inyectable: así se prueba sin esperar 2 minutos
   * @param {number}   [opts.intervaloMs]
   * @param {number}   [opts.minFrases]
   */
  constructor ({ llamar, bloqueContexto, ahora, intervaloMs, minFrases } = {}) {
    super()
    if (typeof llamar !== 'function') {
      throw new Error('hace falta una función para llamar al LLM')
    }
    this.llamar = llamar
    this.bloqueContexto = bloqueContexto || (() => '')
    this.ahora = ahora || (() => Date.now())
    this.intervaloMs = intervaloMs ?? INTERVALO_RESUMEN_MS
    this.minFrases = minFrases ?? MIN_FRASES_RESUMEN

    this._nuevas = []          // frases desde el último resumen
    this._ultimo = null        // null = todavía ninguno
    this._enMarcha = false
    this.stats = { resumenes: 0, fallos: 0, llamadas: 0 }
  }

  /**
   * Registra una frase confirmada. Devuelve true si además disparó un resumen.
   *
   * Se le manda al modelo el **italiano**, no el español de Marian: es el
   * original, y mandar los dos duplicaría los tokens de cada llamada sin añadir
   * información. El resumen sale en español porque lo pide el prompt.
   */
  registrar (it, _es) {
    const texto = (it || '').trim()
    if (!texto) return false
    this._nuevas.push(texto)
    if (this._nuevas.length > MAX_FRASES_RESUMEN) this._nuevas.shift()

    if (!this._toca()) return false
    this._lanzar()
    return true
  }

  /**
   * ¿Toca resumir? El primero sale en cuanto hay conversación suficiente —si
   * esperara el intervalo entero, el panel estaría vacío los dos primeros
   * minutos, que es cuando se presenta la reunión y más se agradece.
   */
  _toca () {
    if (this._enMarcha) return false
    if (this._nuevas.length < this.minFrases) return false
    return this._ultimo === null || this.ahora() - this._ultimo >= this.intervaloMs
  }

  _lanzar () {
    this._enMarcha = true
    // El reloj se reinicia ANTES de la llamada: si se reiniciara al volver, una
    // llamada lenta correría el siguiente resumen y el intervalo dejaría de ser
    // el que dice arriba.
    this._ultimo = this.ahora()
    const frases = this._nuevas
    this._nuevas = []

    this._resumir(frases)
      .catch(err => {
        this.stats.fallos++
        console.error('[resumen] no se pudo resumir:', err.message)
      })
      .finally(() => { this._enMarcha = false })
  }

  async _resumir (frases) {
    this.stats.llamadas++
    const sistema = promptResumen(this.bloqueContexto())
    const usuario = `Lo que se ha dicho:\n${frases.map(f => `- ${f}`).join('\n')}`

    const bruto = await this.llamar(sistema, usuario, { json: true })
    const { texto, temaNuevo } = interpretarResumen(bruto)
    if (!texto) throw new Error('el modelo devolvió un resumen vacío')

    this.stats.resumenes++
    this.emit('contexto', { texto, temaNuevo })
  }
}

/**
 * Saca el resumen de lo que devuelva el modelo.
 *
 * El prompt pide JSON, pero si vuelve prosa llana se aprovecha igual en vez de
 * dejar el panel vacío: aquí no hay nada que parsear después, solo un párrafo
 * que se pinta. Es la lenidad que en el panel de respuestas NO nos podemos
 * permitir, porque allí un texto raro se dice en voz alta.
 */
function interpretarResumen (bruto) {
  let t = String(bruto || '').trim()
  if (t.startsWith('```')) {
    t = t.split('\n').slice(1).join('\n').split('```')[0].trim()
  }
  try {
    const d = JSON.parse(t)
    return {
      texto: String(d?.resumen || '').trim(),
      temaNuevo: d?.tema_nuevo === true,
    }
  } catch {
    return { texto: sinComillasEnvolventes(t).slice(0, 400), temaNuevo: false }
  }
}

module.exports = { MotorRespuestas, MotorResumen, MAX_CARACTERES }
module.exports._internos = {
  huella, sonLaMisma, sinComillasEnvolventes, interpretarResumen,
  MEMORIA, FRASES_DE_CONTEXTO, INTERVALO_RESUMEN_MS, MIN_FRASES_RESUMEN,
}
