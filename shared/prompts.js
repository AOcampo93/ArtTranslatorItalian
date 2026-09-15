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
 * Reparto de trabajo, y conviene no confundirlo: **la traducción NO la hace el
 * LLM.** La hace Marian en local, en unos 70 ms y gratis. El LLM solo refina
 * terminología de dominio, detecta preguntas que el análisis de texto no ve, y
 * redacta respuestas.
 */

'use strict'

/** Envuelve el bloque de contexto, o devuelve vacío si no hay. */
function conContexto (bloque) {
  return bloque?.trim()
    ? `\n\nCONTEXTO DE ESTA CONVERSACIÓN\n${bloque.trim()}\n`
    : ''
}

// ── 1. Refinado de traducción ───────────────────────────────────────────────
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
- Coherente con quién es: usa su ocupación y su papel en el proyecto.
- Si la pregunta pide un dato que no está en el contexto, no lo inventes:
  responde algo honesto y accionable, del tipo "lo confirmo y te digo".
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
- El resumen va SIEMPRE en español, aunque la reunión sea en italiano.
- Sé concreto: nombra los temas, las tecnologías y las personas reales.
- Si el contexto de arriba declara de qué iba la reunión, resume CONTRA eso:
  di si se está cumpliendo, desviando o ampliando.
- "tema_nuevo" solo true ante un cambio claro de asunto. Ante la duda, false.`
}

module.exports = {
  promptRefinado,
  promptPreguntas,
  promptRespuesta,
  promptResumen,
  conContexto,
}
