/**
 * frases.js
 * La burbuja es la frase, no el turno.
 *
 * ## El fallo que existe para arreglar
 *
 * AssemblyAI cierra el turno por silencio, y desde F031 nosotros lo cortamos
 * además por tope (6 s, tope duro 8 s). Un turno cortado así **no acaba donde
 * acaba una oración**: en `sesion-2.jsonl`, 10 de 13 trozos forzados acabaron a
 * media oración `[medido]`. Y Marian no traduce un trozo que empieza a media
 * oración: lo **completa por su cuenta**. Los dos casos medidos en ese archivo:
 *
 *   «Tu pensi che questo ruolo di Malena ti darà»
 *   «la possibilità di fare il salto definitivo a livello internazionale? …»
 *     → «¿Cómo se puede dar el salto definitivo a nivel internacional?»
 *       — el «Cómo» no lo dijo nadie.
 *
 *   «… Ci potresti fare un riassunto molto breve del»
 *   «film? Come lo spiegheresti? …»
 *     → «¿Películas?»
 *
 * No es un fallo de Marian: es que le estamos dando media oración y pidiéndole
 * una traducción entera. Bajar el tope del troceo (F031) lo hace **más**
 * frecuente, no menos.
 *
 * ## Qué hace este módulo
 *
 * Dos funciones puras, sin estado ni relojes, para que el mecanismo se pueda
 * probar con las cadenas exactas del archivo de una reunión real:
 *
 *  - `partirTurno(texto)` parte un turno en las **oraciones completas** (hasta
 *    el último `.?!…`) y la **cola** sin cerrar.
 *  - `arrastrar(colaAnterior, turnoNuevo)` decide qué se manda junto a Marian.
 *
 * Quien las usa (`mainApp.js`) traduce las completas y las pinta como frase
 * normal, traduce la cola y la pinta como burbuja **provisional**, y al llegar
 * el turno siguiente traduce `cola + turno` junto y sustituye la provisional
 * por la definitiva. Marian nunca ve una oración empezada por la mitad, salvo
 * por las excepciones que se nombran abajo.
 *
 * ## El tope de arrastre
 *
 * Arrastrar no puede ser gratis: el tiempo de Marian escala con el largo del
 * texto —`ms = 56 + 6,34·caracteres` en el HP Pavilion del cliente, R² 0,994
 * `[medido]` (`PLAN.md` §7bis)—, así que una cola que crece sin tope acaba
 * costando segundos y retrasando la burbuja que la sustituye. Con 300
 * caracteres la traducción de la unión sale por **≈ 1.960 ms**
 * `[estimado a partir de lo medido]`, que es el techo que se acepta. Pasado el
 * tope la cola se suelta y se cierra tal cual. Y ojo con dónde queda la marca:
 * la que se queda sin principio **no es esa cola** —empieza donde empezaba su
 * oración, y a Marian le llegó entera— sino el turno de después, y es ÉSA la
 * línea que el archivo marca con `empiezaAMedias` (lo pone `mainApp.js`). Es
 * una de las tres excepciones admitidas, y las tres son el mismo gesto —soltar
 * una cola sin que nadie la continúe—: el tope de arrastre, un fallo de Marian
 * traduciendo el turno que continuaba una cola, y la parada de la reunión con
 * un turno todavía por procesar. Las tres pasan por `cerrarColaEnMano` en
 * `mainApp.js`, que es quien pone la marca.
 */

'use strict'

/**
 * Tope de arrastre, en caracteres. Ver la cabecera: 300 caracteres son
 * ≈ 1.960 ms de Marian en el equipo lento del cliente
 * `[estimado a partir de lo medido]`.
 */
const TOPE_ARRASTRE = 300

/** Lo que cierra una oración. */
const TERMINADORES = '.?!…'

/**
 * Lo que puede ir DESPUÉS del terminador sin que la oración deje de estar
 * cerrada: comillas y paréntesis de cierre. Sin esto, «—Davvero?» Poi uscì.»
 * partía en el sitio equivocado y la comilla de cierre abría la cola siguiente.
 */
const CIERRES = '"\'»”’)]'

/**
 * Abreviaturas italianas frecuentes cuyo punto **no** cierra oración.
 *
 * Van sin el punto y en minúscula. La lista es corta a propósito: cada entrada
 * de más es una oración que dejamos sin cerrar y por tanto una burbuja que
 * tarda más en salir. Las iniciales de nombre propio («Giuseppe G. Sulfaro»)
 * no hacen falta aquí: las cubre la regla de la letra suelta.
 */
const ABREVIATURAS = new Set([
  'sig', 'sigg', 'sig.ra', 'dott', 'dr', 'prof', 'avv', 'ing', 'arch', 'geom',
  'on', 'sen', 'ecc', 'es', 'pag', 'pagg', 'cfr', 'art', 'artt', 'cap', 'fig',
  'vol', 'tel', 'sec', 'min', 'max', 'ca', 'etc', 'rif', 'egr', 'gent', 'spett',
])

/**
 * ¿El punto de `i` cierra de verdad una oración?
 *
 * Sólo se pregunta por el punto: `?`, `!` y `…` no aparecen dentro de números
 * ni de abreviaturas, así que para ellos la respuesta es siempre sí. La regla
 * de la minúscula NO está aquí: vale para todos los terminadores, así que vive
 * en `finDeOracion`.
 */
function puntoCierraOracion (texto, i) {
  // «3.5», «1.000», «art.5»: el punto pegado a lo que viene detrás no cierra
  // nada. Esta comprobación la hace además quien llama (exige espacio o fin de
  // texto detrás), y se deja aquí escrita porque es el caso que más se cita.
  if (/\d/.test(texto[i - 1] || '') && /\d/.test(texto[i + 1] || '')) return false

  const palabra = texto.slice(0, i).match(/([A-Za-zÀ-ÖØ-öø-ÿ]+)$/)
  if (palabra) {
    // Una letra suelta es una inicial («G.»), nunca un final de oración.
    if (palabra[1].length === 1) return false
    if (ABREVIATURAS.has(palabra[1].toLowerCase())) return false
  }

  return true
}

/** ¿Lo primero que se ve después de `i` es una letra minúscula? */
function sigueEnMinuscula (texto, i) {
  const siguiente = texto.slice(i + 1).match(/\S/)
  return Boolean(siguiente) && /[a-zà-öø-ÿ]/.test(siguiente[0])
}

/**
 * Si en `i` acaba una oración, devuelve el índice donde empieza la siguiente;
 * si no, `-1`.
 */
function finDeOracion (texto, i) {
  if (!TERMINADORES.includes(texto[i])) return -1

  // «?!», «...» y la comilla que cierra la cita van con la oración que acaba.
  let j = i
  while (j + 1 < texto.length && (TERMINADORES + CIERRES).includes(texto[j + 1])) j++

  // Detrás tiene que venir el final del texto o un espacio: un terminador
  // pegado a la palabra siguiente es parte de algo (un número, una URL), no un
  // final de oración.
  if (j + 1 < texto.length && !/\s/.test(texto[j + 1])) return -1

  if (texto[i] === '.' && j === i && !puntoCierraOracion(texto, i)) return -1

  // Un terminador seguido de minúscula no cierra oración, sea `.`, `?`, `!` o
  // `…`, vaya solo o en racha, y esté o no dentro de comillas. El final
  // formateado de AssemblyAI empieza cada oración con mayúscula, así que una
  // minúscula detrás dice que la oración sigue: «Ho pensato... che potrebbe
  // funzionare», «Davvero?! non me lo aspettavo», «Davvero?!» disse lui».
  // Partir ahí le mandaría a Marian el trozo sin su principio, que es el fallo
  // que este módulo existe para no cometer; equivocarse por este lado sólo
  // alarga la cola y la frase sale una burbuja más tarde.
  //
  // Antes esta regla sólo se consultaba para el punto SUELTO, así que una
  // racha («...», «?!») o un `?` se colaban y partían la oración por la mitad.
  if (sigueEnMinuscula(texto, j)) return -1

  return j + 1
}

/**
 * Parte un turno en oraciones completas y cola sin cerrar.
 *
 * @param {string} texto el turno tal como lo entrega el transcriptor
 * @returns {{completas: string, cola: string, oraciones: string[]}}
 *   `completas` es el texto hasta el último final de oración (cadena vacía si
 *   el turno no cierra ninguna), `cola` el resto sin cerrar, y `oraciones` el
 *   desglose de `completas`, que está para poder comprobar dónde cayó cada
 *   límite sin tener que adivinarlo desde fuera.
 */
function partirTurno (texto) {
  const limpio = String(texto ?? '').trim()
  if (!limpio) return { completas: '', cola: '', oraciones: [] }

  const oraciones = []
  let corte = 0
  for (let i = 0; i < limpio.length; i++) {
    const fin = finDeOracion(limpio, i)
    if (fin < 0) continue
    const oracion = limpio.slice(corte, fin).trim()
    if (oracion) oraciones.push(oracion)
    corte = fin
    i = fin - 1
  }

  return {
    // `slice` y no `oraciones.join(' ')`: lo que se manda a Marian tiene que
    // ser el texto del hablante tal cual, con sus espacios, no una
    // recomposición nuestra.
    completas: limpio.slice(0, corte).trim(),
    cola: limpio.slice(corte).trim(),
    oraciones,
  }
}

/**
 * Decide qué se manda junto a Marian cuando llega un turno nuevo.
 *
 * @param {string} colaAnterior la cola sin cerrar que quedó del turno previo
 * @param {string} turnoNuevo el turno que acaba de llegar
 * @returns {{texto: string, arrastre: boolean, colaSuelta: string|null, motivo: string}}
 *   `texto` es lo que hay que traducir, `arrastre` dice si lleva la cola
 *   pegada delante, y `colaSuelta` es la cola que **no** se pudo arrastrar
 *   porque pasó del tope: quien llama tiene que cerrarla por su cuenta —ya
 *   está traducida y pagada— antes de seguir. `motivo` nombra el caso:
 *   `'sin-cola'`, `'arrastre'` o `'tope-arrastre'`.
 */
function arrastrar (colaAnterior, turnoNuevo) {
  const cola = String(colaAnterior ?? '').trim()
  const turno = String(turnoNuevo ?? '').trim()

  if (!cola) return { texto: turno, arrastre: false, colaSuelta: null, motivo: 'sin-cola' }
  if (!turno) return { texto: cola, arrastre: true, colaSuelta: null, motivo: 'arrastre' }

  // El tope se mira sobre la cola que se iba a arrastrar, no sobre la unión: lo
  // que no puede crecer sin freno es la cola, porque es ella la que se acumula
  // turno tras turno cuando el hablante no cierra ninguna oración.
  if (cola.length > TOPE_ARRASTRE) {
    return { texto: turno, arrastre: false, colaSuelta: cola, motivo: 'tope-arrastre' }
  }

  return { texto: `${cola} ${turno}`, arrastre: true, colaSuelta: null, motivo: 'arrastre' }
}

/**
 * ¿Este texto acaba en oración cerrada?
 *
 * Es la medida del texto que se GUARDA —la burbuja—, no la del turno, y por eso
 * se define como «no le queda cola»: así hay UN solo criterio de dónde acaba
 * una oración en todo el proyecto. Con dos definiciones, una burbuja podría
 * guardarse diciendo que acaba cerrada y volver a partirse por otro sitio.
 */
function acabaCerrada (texto) {
  const partido = partirTurno(texto)
  return Boolean(partido.completas) && partido.cola === ''
}

module.exports = { partirTurno, arrastrar, acabaCerrada, TOPE_ARRASTRE }
