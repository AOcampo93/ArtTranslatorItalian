/**
 * idiomas.js
 * El registro de idiomas: qué piezas usa cada idioma que la app traduce.
 *
 * ## Por qué existe (PLAN.md §17.3 y §0.20)
 *
 * La V2 añade un segundo idioma sin tocar el italiano, que es el que ya
 * funciona en casa del cliente. El motor es común —captura, AssemblyAI, troceo,
 * autoguardado, perfiles, informes—, pero hay piezas que dependen del idioma y
 * hasta ahora cada una estaba nombrada en el sitio que la usa: el código para
 * AssemblyAI en `mainApp.js`, el modelo de Marian en `translator.js`, las
 * abreviaturas en `frases.js`, el detector en `respuestas.js`, los prompts en
 * `traduccionLlm.js` y `respuestas.js`. Este registro las junta en **una entrada
 * por idioma**, y el motor pregunta aquí en vez de nombrarlas.
 *
 * ## La entrada `it` APUNTA, no copia
 *
 * Señala las piezas que ya existían, las mismas, con la misma identidad: ni se
 * han movido de archivo ni se ha duplicado ninguna lista ni ningún texto. Esa
 * es la garantía de que el italiano no cambió —que no una promesa—, y la
 * comprueban dos cosas: la suite anterior pasa sin modificar ninguna prueba, y
 * `idiomasF047.test.js` compara cada pieza de la entrada con su original.
 *
 * ## Qué lleva una entrada
 *
 *  - `codigo`: el nombre del idioma en la app. Es lo que se guarda en la
 *    cabecera del `.jsonl` (`idioma`) y en `sessions.language`.
 *  - `codigoStt`: el que se le manda a AssemblyAI. Hoy coincide con `codigo`,
 *    pero son cosas distintas: uno es nuestro y el otro es del proveedor.
 *  - `prefijoContexto`: la etiqueta con la que el tipo de proyecto entra en el
 *    contexto que se le da al STT. Va en el idioma de la reunión porque
 *    describe el audio que el modelo va a oír.
 *  - `modeloMarian` y `calentamientoMarian`: el modelo de traducción local de
 *    ese idioma y la palabra con la que se paga su primera inferencia en frío.
 *  - `abreviaturas`: las que no cierran oración al partir un turno.
 *  - `detector`: el detector de preguntas (la forma de `questionDetector.js`).
 *  - `promptTraduccion`, `promptRespuesta` y `promptResumen`: los prompts del LLM.
 *  - `muestra`: el WAV de la comprobación previa, en `node-backend/test/fixtures`.
 */

'use strict'

const traductor = require('./translator')
const { ABREVIATURAS } = require('./frases')
const detectorItaliano = require('./questionDetector')
const { promptTraduccion, promptRespuesta, promptResumen } = require('../../shared/prompts')

/** El idioma que se usa cuando nadie dice cuál: el que ya funcionaba antes de la V2. */
const IDIOMA_POR_DEFECTO = 'it'

/**
 * Congelada cada entrada: es un objeto compartido por toda la sesión, y que
 * alguien le reasigne una pieza en caliente cambiaría el idioma de la reunión
 * en silencio. (El congelado es superficial: la lista de abreviaturas sigue
 * siendo la de `frases.js`, y eso es justo lo que se quiere.)
 */
const IDIOMAS = new Map([
  ['it', Object.freeze({
    codigo: 'it',
    codigoStt: 'it',
    // Hasta F047 era un literal dentro de `empezarSesion`, en `mainApp.js`.
    prefijoContexto: 'Progetto',
    modeloMarian: traductor.MODELO,
    calentamientoMarian: traductor.CALENTAMIENTO,
    abreviaturas: ABREVIATURAS,
    detector: detectorItaliano,
    promptTraduccion,
    promptRespuesta,
    promptResumen,
    muestra: 'italiano.wav',
  })],
])

/**
 * La entrada de un idioma. Sin código, la del idioma por defecto (`it`); con un
 * código que no está en el registro, un error que dice cuál era y cuáles hay —
 * y no un `it` de rebote: la reunión de quien pidió otro idioma se transcribiría
 * en italiano, y facturando, sin avisar a nadie.
 *
 * @param {string} [codigo]
 * @returns {object} la entrada, ver la cabecera del archivo
 */
function obtenerIdioma (codigo) {
  if (codigo === undefined || codigo === null) return IDIOMAS.get(IDIOMA_POR_DEFECTO)
  const idioma = IDIOMAS.get(codigo)
  if (!idioma) {
    throw new Error(`idioma desconocido «${String(codigo)}»; los disponibles son: ${[...IDIOMAS.keys()].join(', ')}`)
  }
  return idioma
}

module.exports = { obtenerIdioma, IDIOMA_POR_DEFECTO }
