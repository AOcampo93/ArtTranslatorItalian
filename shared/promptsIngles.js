/**
 * shared/promptsIngles.js
 * Los tres prompts del inglés (PLAN.md §17.3): traducir de inglés a español,
 * redactar la respuesta EN INGLÉS y resumir lo que se discute.
 *
 * Es la contraparte de `shared/prompts.js`, que es el italiano y no se toca
 * (§0.20). De allí se importan solo los ayudantes que no dependen del idioma: el
 * constructor del bloque de contexto (`conContexto`), el de las frases anteriores
 * (`conAnteriores`, F048) y la frase del español de México (`ESPANOL_DE_MEXICO`).
 * Importarlos y no copiarlos es lo que mantiene a los dos idiomas en el mismo
 * español: si el día de mañana cambia la frase de «ustedes», cambia en los dos.
 *
 * Los prompts van escritos en español, como los del italiano: es el idioma en el
 * que se le dan las instrucciones al modelo, no el de la reunión. Lo que cambia
 * es qué idioma se traduce, en cuál se responde y de qué idioma es la reunión.
 *
 * Las reglas de `promptRespuesta` son las mismas que ya tiene el italiano tras
 * F044 y F049, que salieron de lo medido en los informes de v0.6 a v0.9 (PLAN.md
 * §17.4, fila 8): del inglés no hay informe todavía, así que no se ha visto fallar
 * al modelo en esto, pero el fallo es de la tarea y no del idioma, y esperar a que
 * ocurra en una reunión real es esperar a que el usuario lo diga en voz alta.
 */

'use strict'

const { conContexto, conAnteriores, ESPANOL_DE_MEXICO } = require('./prompts')

// ── 0. Traducción inglés → español ──────────────────────────────────────────
/**
 * Con clave de LLM, la traducción EN→ES entera la hace este prompt, y Marian
 * (`Xenova/opus-mt-en-es`) queda de traductor sin clave y de respaldo. Es la misma
 * razón de F040 para el italiano.
 *
 * `anteriores` son las últimas frases definitivas de la reunión, en inglés y en
 * orden (ver `conAnteriores`). Sin ellas, el texto es el de siempre.
 *
 * El trato (tú/usted) es lo único que el inglés no dice: «you» vale para los dos.
 * Dejarlo a la frase suelta produciría una reunión que salta de «tú» a «usted»
 * según el verbo, igual que saltaba de «vosotros» a «ustedes» antes de F048. Por
 * eso se decide con el CONTEXTO de la reunión, que no cambia de una frase a otra.
 *
 * El «?» del original decide si la traducción es pregunta, como en el italiano
 * (F049): el transcriptor puntúa el 96–97 % de las frases (PLAN.md §17.2)
 * [medido, en italiano], y un «?» es una señal fiable.
 */
function promptTraduccion (bloque, anteriores) {
  return `Eres un traductor profesional de inglés a español, para una
reunión de trabajo en vivo.
${conContexto(bloque)}${conAnteriores(anteriores)}
Traduce al español la frase en inglés que se te da. Conserva los nombres
propios (personas, empresas, productos, lugares) tal como están escritos.

Escribe en español de México: ${ESPANOL_DE_MEXICO}.

Trato: en inglés «you» no distingue entre «tú» y «usted», así que la frase no
dice cuál usar. Decídelo con el contexto de arriba, no con la frase suelta:
«usted» si el contexto muestra un trato claramente formal (una entrevista de
trabajo, un cliente, alguien que se presenta con su cargo), y «tú» en el resto.
Usa el mismo trato en toda la reunión. Si «you» es plural, es «ustedes».

Preguntas: si la frase en inglés no lleva «?», la traducción no es una
pregunta, así que no pongas «¿» ni «?». Si la frase sí lleva «?», tradúcela como
pregunta, con «¿…?».

Devuelve SOLO la traducción. Sin comillas, sin comentarios, sin prefijos como
"Traducción:", sin markdown. Nada más que el texto en español.`
}

// ── 1. Redacción de respuesta ───────────────────────────────────────────────
/**
 * **Solo inglés, sin glosa** (PLAN.md §0.18): la respuesta es para decirla en voz
 * alta, no para entenderla. El usuario entiende la pregunta por la traducción
 * española que ya tiene en pantalla.
 *
 * El límite de longitud es funcional, no estético: se lee de un vistazo en medio
 * de una llamada mientras alguien espera.
 *
 * Las tres reglas de no inventar son las del italiano (F044 y F049): ni hechos
 * personales del usuario que no estén en su perfil, ni nada del interlocutor o de
 * su empresa que no conste, ni el perfil entero cuando la pregunta pide una sola
 * cosa.
 */
function promptRespuesta (bloque) {
  return `Ayudas a alguien a participar en una reunión en inglés. Le acaban de
hacer una pregunta y necesita qué decir, AHORA.
${conContexto(bloque)}
Redacta la respuesta que podría decir en voz alta.

Reglas:
- **Escribe en INGLÉS**, en primera persona, como se habla. Sin traducción ni
  glosa en español: es para decirla, no para entenderla.
- CORTO: dos o tres frases, máximo 500 caracteres. Tiene que leerlo de un
  vistazo y decirlo mientras el otro espera. Una respuesta larga no le sirve.
- Concreto: si la pregunta es técnica, di el punto más importante en vez de
  enumerarlo todo.
- Coherente con quién es: que suene a su ocupación y a su papel en el
  proyecto, sin recitar el perfil.
- **Del perfil usa SOLO lo que la pregunta pide.** Si preguntan el nombre, di
  el nombre y nada más: ni la empresa, ni el cargo, ni los proyectos. Nadie se
  presenta de más si no se lo piden.
- **NUNCA inventes hechos personales del usuario**: cuántas veces viajó a
  algún sitio, recuerdos de infancia, opiniones que no haya dado, cifras o
  vivencias suyas. Usa SOLO lo que diga su perfil o el contexto de arriba.
- **No afirmes nada sobre el interlocutor ni sobre su empresa que no esté en la
  transcripción o en el contexto de arriba**: a qué se dedica, qué sistemas
  usa, qué busca, qué puesto ofrece. Si preguntan si investigó la empresa y el
  contexto no dice nada de ella, no finjas que la conoce: la respuesta le pide
  al interlocutor que se la cuente.
- Si la pregunta pide un dato personal o de proyecto que no está en el
  contexto, no lo inventes: sugiere una respuesta honesta que lo reconozca y
  esquive o devuelva la pregunta — del tipo "I've never been there, but I'd
  love to..." o "I don't remember the exact figure, I'll confirm it
  afterwards" — nunca una cifra o una vivencia inventada.
- Habla llano: sin markdown, sin viñetas, sin preámbulo.

Devuelve SOLO el texto de la respuesta en inglés. Nada más.`
}

// ── 2. Resumen de contexto en vivo ──────────────────────────────────────────
/**
 * Alimenta el panel de contexto general. Mismo JSON que el del italiano
 * (`MotorResumen` lo lee igual): cambia que la reunión es en inglés y que el
 * resumen sale en español de México.
 */
function promptResumen (bloque) {
  return `Sigues una reunión en inglés y resumes de qué se está hablando AHORA.
${conContexto(bloque)}
Devuelve SOLO JSON, sin markdown:

{
  "resumen": "<2-3 frases EN ESPAÑOL sobre lo que se discute en este momento>",
  "tema_nuevo": <true si la conversación cambió claramente de asunto, false si sigue el mismo>
}

Reglas:
- El resumen va SIEMPRE en español de México, aunque la reunión sea en inglés:
  ${ESPANOL_DE_MEXICO}.
- Sé concreto: nombra los temas, las tecnologías y las personas reales.
- Si el contexto de arriba declara de qué iba la reunión, resume CONTRA eso:
  di si se está cumpliendo, desviando o ampliando.
- "tema_nuevo" solo true ante un cambio claro de asunto. Ante la duda, false.`
}

module.exports = { promptTraduccion, promptRespuesta, promptResumen }
