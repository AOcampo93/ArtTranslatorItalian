/**
 * shared/prompts.js
 * Los cuatro prompts del proyecto, en su versión italiana.
 *
 * Reemplaza los del proyecto base, que iban de inglés a español y no conocían
 * el perfil ni el contexto de reunión.
 *
 * **Todos reciben el mismo bloque de contexto**, construido por
 * `contexto.buildContextBlock()`. Un solo constructor para los cuatro: si cada
 * prompt armara el suyo, se desincronizarían a la segunda semana.
 *
 * Reparto de trabajo — actualizado en F040, ver `promptTraduccion` abajo:
 * **con clave de LLM, la traducción la hace el LLM**, con el mismo prompt de
 * contexto que las respuestas. Marian sigue siendo el traductor sin clave, y
 * el respaldo cuando el LLM falla o tarda más del plazo. Aparte de traducir,
 * el LLM también refina terminología de dominio (F027, hoy sin usar), detecta
 * preguntas que el análisis de texto no ve, y redacta respuestas.
 */

'use strict'

/** Envuelve el bloque de contexto, o devuelve vacío si no hay. */
function conContexto (bloque) {
  return bloque?.trim()
    ? `\n\nCONTEXTO DE ESTA CONVERSACIÓN\n${bloque.trim()}\n`
    : ''
}

/**
 * F048. Las frases que se dijeron justo antes de la que se traduce, como
 * contexto y nada más. Va en el sistema y no en el mensaje del usuario: el
 * mensaje tiene que seguir siendo SOLO la frase, o el modelo la traduce junto
 * con lo que la precede. Sin frases devuelve vacío, y el prompt queda como si
 * esto no existiera.
 *
 * Medido en los informes v0.6–v0.9 (PLAN.md §17.4, fila 1): «nella mata» salió
 * «yerba mate» porque la palabra que lo aclara, «ho adorato la Mata Atlantica»,
 * estaba dos frases antes y Marian no la veía.
 */
function conAnteriores (anteriores) {
  const frases = (Array.isArray(anteriores) ? anteriores : [])
    .map(f => String(f ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return frases.length
    ? `\nLo que se dijo justo antes (solo contexto: no lo traduzcas ni lo repitas): ${frases.map(f => `«${f}»`).join(' ')}\n`
    : ''
}

/**
 * F048. El español que sale de cualquier prompt de esta aplicación es el de
 * México. Medido en los informes v0.6–v0.9 (PLAN.md §17.4, fila 4): las
 * traducciones mezclaban «vosotros» y «ustedes». Una sola frase para todos los
 * prompts que producen español, para que no se desincronicen; la configuración
 * de cada idioma la reutiliza.
 */
const ESPANOL_DE_MEXICO = 'usa «ustedes» y nunca «vosotros» ni sus formas (sabéis, tenéis, vuestro…), '
  + 'y el vocabulario de México (computadora, auto, estacionar)'

// ── 0. Traducción italiano → español ────────────────────────────────────────
/**
 * F040. Con clave de LLM, la traducción IT→ES entera la hace este prompt —
 * no Marian. Medido en la prueba de v0.6.0: Marian se come palabras sueltas
 * («erotismo» → «heroísmo», «pazzo» sin traducir, «perché» → «para que»,
 * «timidezes»), y ese defecto pesa más que el troceo de turnos. Sustituye a
 * `promptRefinado` (§ siguiente, F027), que pedía corregir una traducción ya
 * hecha: aquí se pide la traducción entera, y sale mejor que corregirla a
 * medias. `promptRefinado` se queda sin usar — no se borra por si hiciera
 * falta retomar ese enfoque, pero el que corre en producción es este.
 *
 * F048: `anteriores` son las últimas frases definitivas de la reunión, en el
 * idioma original y en orden (ver `conAnteriores`). Sin ellas, el texto es el
 * de siempre salvo por la línea del español de México.
 *
 * F049: el «?» del original decide si la traducción es pregunta. Medido en los
 * informes v0.6–v0.9 (PLAN.md §17.4, fila 6): «Perché Giulia per tanti anni è
 * stata in Brasile.» —una explicación, con punto— salía «¿Por qué Giulia…?».
 * El transcriptor puntúa el 96–97 % de las frases (PLAN.md §17.2) [medido],
 * así que el «?» es una señal fiable y se obedece al pie de la letra.
 */
function promptTraduccion (bloque, anteriores) {
  return `Eres un traductor profesional de italiano a español, para una
reunión de trabajo en vivo.
${conContexto(bloque)}${conAnteriores(anteriores)}
Traduce al español la frase en italiano que se te da. Conserva los nombres
propios tal como se pronuncian, y el registro (tú/usted) del original.

Escribe en español de México: ${ESPANOL_DE_MEXICO}.

«lei»/«Lei» se traduce como «ella» (tercera persona), salvo que el contexto
muestre un tratamiento formal evidente hacia el interlocutor —ahí es «usted».
Por defecto es «ella»: es el caso más frecuente en una reunión de trabajo.

Preguntas: si la frase en italiano no lleva «?», la traducción no es una
pregunta, así que no pongas «¿» ni «?». «Perché» al inicio de una frase sin «?»
es «porque» (explica algo), nunca «por qué»: «Perché il cliente ha cambiato
idea.» es «Porque el cliente cambió de opinión.». Si la frase sí lleva «?»,
tradúcela como pregunta, con «¿…?».

Devuelve SOLO la traducción. Sin comillas, sin comentarios, sin prefijos como
"Traducción:", sin markdown. Nada más que el texto en español.`
}

// ── 1. Refinado de traducción (F027, sin usar desde F040) ──────────────────
/**
 * Corre DESPUÉS de que Marian ya haya traducido y pintado. Su único trabajo es
 * corregir lo que un modelo de traducción genérico no puede saber: la
 * terminología del dominio.
 *
 * El caso que lo justifica, medido: *"l'integrazione con il gestionale"* →
 * Marian da *"la integración con la gestión"*, y *il gestionale* es el ERP.
 * Con el glosario cargado, esto lo corrige.
 */
function promptRefinado (bloque) {
  return `Eres un intérprete de italiano a español en una reunión en vivo.

Recibes una frase en italiano y una traducción automática al español ya hecha.
Tu único trabajo es corregir la traducción si contiene un error de TERMINOLOGÍA
del dominio de esta conversación. No la reescribas por estilo.
${conContexto(bloque)}
Devuelve SOLO un objeto JSON, sin markdown ni explicación:

{
  "es": "<la traducción corregida, o la misma si ya estaba bien>",
  "cambio": "<qué corregiste, en 5 palabras, o cadena vacía si no cambiaste nada>"
}

Reglas:
- Si la traducción automática ya es correcta, devuélvela SIN TOCAR y "cambio" vacío.
- Corrige solo términos del dominio, siglas y nombres propios. Ejemplo típico:
  "il gestionale" traducido como "la gestión" cuando significa "el ERP".
- No añadas información que no esté en el italiano original.
- Conserva el registro: si hablan de tú, mantén el tú.`
}

// ── 2. Escáner de preguntas ─────────────────────────────────────────────────
/**
 * Tercera capa del detector. Las dos primeras —palabras de apertura y el signo
 * de interrogación— son gratis y corren en local; esta cuesta dinero y se
 * reserva para lo que solo el contexto delata.
 *
 * En italiano hace falta de verdad: muchas preguntas se escriben **idénticas a
 * una afirmación** y solo se distinguen por la entonación, que el texto no
 * conserva. *"Il budget copre anche la manutenzione"* es el caso puro.
 *
 * Corre cada 40 s, no cada 25: bajarlo recorta un 34% del coste por hora,
 * porque con 144 llamadas el 66% de los tokens de entrada es contexto repetido
 * y el *prompt caching* no lo amortiza (el mínimo cacheable son 4.096 tokens y
 * nuestro prefijo ronda 400).
 */
function promptPreguntas (bloque) {
  return `Analizas la transcripción de una reunión en italiano y extraes las
preguntas COMPLETAS dirigidas a la persona que usa esta aplicación.
${conContexto(bloque)}
Devuelve SOLO JSON, sin markdown:

{"preguntas": [{"it": "<la pregunta completa en italiano>", "es": "<su traducción>"}]}

Qué cuenta como pregunta:
- Directa, con o sin signo: "Quanto tempo ci vuole", "Hai finito il report".
- Indirecta: "Mi puoi spiegare...", "Vorrei sapere...", "Dimmi...".
- **Entonativa**: en italiano muchas preguntas se escriben igual que una
  afirmación. "Il budget copre anche la manutenzione" puede ser pregunta, y solo
  el contexto lo dice. Estas son las que de verdad te toca detectar, porque el
  análisis de texto no puede.

Qué NO incluir:
- Preguntas retóricas que el hablante se responde solo.
- Preguntas dirigidas a otra persona de la reunión, no al usuario.
- Fórmulas sociales: "come stai", "mi sentite", "tutto bene".
- Preguntas que ya estén en la lista de capturadas que se te pasa.

Extrae la pregunta ENTERA, nunca truncada. Si no hay ninguna nueva, devuelve
{"preguntas": []}.`
}

// ── 3. Redacción de respuesta ───────────────────────────────────────────────
/**
 * **Solo italiano, sin glosa.** Confirmado con el cliente: la respuesta es para
 * decirla en voz alta, no para entenderla.
 *
 * El límite de longitud es funcional, no estético: esto se lee de un vistazo en
 * medio de una llamada mientras alguien espera. Una respuesta de diez líneas es
 * inútil por perfecta que sea.
 *
 * Es donde el contexto pesa más: la respuesta tiene que sonar a quien es el
 * usuario y hablar del proyecto que es.
 *
 * F044. MEDIDO en el informe de v0.8.0: ante preguntas biográficas
 * («Quante volte sei stata in Brasile?», «Come pensi che sia cambiata
 * l'Italia?») el modelo inventaba hechos personales del usuario como si los
 * supiera — «Sono stata in Brasile 9 volte», «Quando ero bambino c'era molta
 * più industria» — datos que no están en ningún perfil ni contexto y que el
 * usuario tendría que decir en voz alta como si fueran suyos. La regla de
 * abajo lo prohíbe explícitamente y da una salida honesta cuando el dato
 * falta, en vez de dejar que el modelo lo complete por su cuenta.
 *
 * F049. Dos fallos más, MEDIDOS en los informes v0.6–v0.9 (PLAN.md §17.4,
 * fila 8): ante «Hai fatto delle ricerche sull'azienda?» la respuesta afirmaba
 * a qué se dedicaba la empresa cuando el contexto no decía nada de ella, y ante
 * «Posso avere il tuo nome?» soltaba nombre, empresa y proyectos del perfil.
 * Lo primero es inventar algo del interlocutor —que el usuario diría en voz
 * alta como cierto—; lo segundo, regalar datos que nadie pidió. Por eso la
 * regla «coherente con quién es» ya no manda recitar la ocupación y el papel.
 */
function promptRespuesta (bloque) {
  return `Ayudas a alguien a participar en una reunión en italiano. Le acaban de
hacer una pregunta y necesita qué decir, AHORA.
${conContexto(bloque)}
Redacta la respuesta que podría decir en voz alta.

Reglas:
- **Escribe en ITALIANO**, en primera persona, como se habla.
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
  esquive o devuelva la pregunta — del tipo "Non ci sono mai stato, ma mi
  piacerebbe..." o "Non ricordo la cifra esatta, te la confermo dopo" — nunca
  una cifra o una vivencia inventada.
- Habla llano: sin markdown, sin viñetas, sin preámbulo.

Devuelve SOLO el texto de la respuesta en italiano. Nada más.`
}

// ── 4. Resumen de contexto en vivo ──────────────────────────────────────────
/**
 * Alimenta el panel de contexto general, el que va colapsado por defecto.
 * Resume contra el tema declarado en el contexto de proyecto, en vez de
 * deducirlo desde cero cada vez.
 */
function promptResumen (bloque) {
  return `Sigues una reunión en italiano y resumes de qué se está hablando AHORA.
${conContexto(bloque)}
Devuelve SOLO JSON, sin markdown:

{
  "resumen": "<2-3 frases EN ESPAÑOL sobre lo que se discute en este momento>",
  "tema_nuevo": <true si la conversación cambió claramente de asunto, false si sigue el mismo>
}

Reglas:
- El resumen va SIEMPRE en español de México, aunque la reunión sea en italiano:
  ${ESPANOL_DE_MEXICO}.
- Sé concreto: nombra los temas, las tecnologías y las personas reales.
- Si el contexto de arriba declara de qué iba la reunión, resume CONTRA eso:
  di si se está cumpliendo, desviando o ampliando.
- "tema_nuevo" solo true ante un cambio claro de asunto. Ante la duda, false.`
}

module.exports = {
  promptTraduccion,
  promptRefinado,
  promptPreguntas,
  promptRespuesta,
  promptResumen,
  conContexto,
  conAnteriores,
  ESPANOL_DE_MEXICO,
}
