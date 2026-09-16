/**
 * llm.js
 * La llamada al modelo de lenguaje que el usuario ha configurado.
 *
 * ## Por qué no se reutilizan los clientes heredados
 *
 * `geminiClient.js`, `claudeClient.js` y `openaiClient.js` vienen del proyecto
 * base inglés→español. Sus métodos públicos (`suggestReplies`, `translate`…)
 * hablan de `en`/`es` y de prompts que ya no existen en `shared/prompts.js`, así
 * que no encajan. Sus primitivos `_call` tampoco sirven tal cual: el de Gemini
 * fuerza `responseMimeType: application/json`, y la respuesta sugerida es texto
 * llano en italiano — con ese ajuste el modelo devolvería un JSON que nadie
 * pidió. Esto es el envoltorio fino que sí encaja: **una sola función**
 * `llamar(sistema, usuario)`, que es lo que `MotorRespuestas` recibe inyectado.
 *
 * **Los identificadores de modelo NO se heredan de esos clientes.** Se intentó,
 * con el argumento de no tener dos listas que se desincronicen, y salió mal: la
 * lista heredada traía `gemini-2.0-flash`, retirado, así que el panel de
 * preguntas fallaba el 100 % de las veces con la clave del cliente. Heredar una
 * lista hereda también su caducidad. Van abajo, con su procedencia cada uno.
 *
 * ## Cómo se elige proveedor: por el prefijo de la clave
 *
 * El usuario pega UNA clave en Ajustes y no elige proveedor en ningún desplegable.
 * El prefijo ya lo dice sin ambigüedad:
 *
 *   `sk-ant-…` → Anthropic · `AIza…` → Google · `sk-…` → OpenAI
 *
 * Es lo simple y honesto: una caja menos que rellenar y ningún estado que
 * pueda contradecir a la clave. Si el prefijo no se reconoce **no se adivina**:
 * se dice que la clave no se reconoce, porque probar contra los tres
 * proveedores sería mandar la clave del usuario a dos sitios que no son suyos.
 *
 * ## La clave nunca viaja en una URL
 *
 * Gemini admite la clave por query string (`?key=…`), que es como la manda el
 * cliente heredado. Aquí va en la cabecera `x-goog-api-key`: una URL acaba en
 * los registros de errores, en el historial de proxies y en cualquier traza que
 * alguien pegue en un informe. Ninguno de los errores que lanza este módulo
 * incluye la URL ni la clave.
 */

'use strict'

/** Tope de la respuesta del modelo. Cubre los 500 caracteres del panel. */
const MAX_TOKENS = 500

/**
 * Plazo máximo de una llamada, en milisegundos.
 *
 * Existe por el no negociable de esta tarea: un fallo del LLM **se dice**. Sin
 * plazo, una conexión que se queda colgada deja «Preparando…» en el panel para
 * el resto de la reunión, que es justo el fallo que no se puede detectar mirando
 * la pantalla. Con plazo, el motor recibe un error y lo pinta.
 *
 * 20 s es holgado a propósito: se prefiere una respuesta tardía a un falso
 * fallo. No está medido contra los tres proveedores. [por medir]
 */
const PLAZO_MS = 20_000

/**
 * Los tres proveedores y su modelo por defecto.
 *
 * ## Por qué Gemini va a Flash-Lite, y con la versión clavada
 *
 * Todo esto sale de **`PLAN.md` §10 «Instalación, claves y coste visible»**,
 * bloque **«Dos bombas de facturación», punto 2** (líneas 852-855 a día de hoy;
 * si han bailado, busca el título del bloque, que no baila).
 *
 * De ahí, `[verificado]`: **Gemini 3.6, 3.7 y 3.8 Flash doblan su precio el 1 de
 * enero de 2027** (0,75 → 1,50 $ de entrada; 3,75 → 7,50 $ de salida).
 * **Flash-Lite no sube.** Y ojo con el nombre: **Gemini 3.5 Flash —sin Lite— ya
 * está en 1,50/9,00 $**, o sea más caro que el precio *posterior* a la subida de
 * los otros. Para tres frases de respuesta en italiano, Flash-Lite sobra.
 *
 * Eso descarta también **la sugerencia que da la propia API al morir un modelo**:
 * su 404 recomienda `gemini-3.6-flash`, que es justo de los que doblan. Antes de
 * seguir esa sugerencia, léase ese punto 2 de §10.
 *
 * Y la versión va **exacta, nunca un alias móvil** como `gemini-flash-lite-latest`
 * (mismo punto 2: «si se fija un modelo por defecto, nombrar la versión
 * exacta»). Un alias cambia de modelo, de precio y de comportamiento bajo los
 * pies, y el día que cambie nadie lo relacionará con una respuesta peor. La
 * prueba de `llm.test.js` vigila las dos cosas.
 *
 * ## Procedencia de cada uno
 *
 *  - **gemini**: probado contra la API real con los prompts y el contexto de
 *    verdad — respuesta en italiano, con el glosario y dentro del tope de
 *    longitud; p50 878 ms (n=3, una máquina y una red).
 *    `[medido]` · `.arnes/progreso/explore_modelos_llm.md`
 *  - **openai** y **anthropic**: **SIN VERIFICAR.** Vienen de la misma lista
 *    heredada que traía el modelo muerto de Gemini, y no hay claves de esos
 *    proveedores para comprobarlos: **hay que asumir que pueden estar igual de
 *    caducados**. Quien consiga una clave, que llame una vez y lo confirme aquí.
 *    `[por medir]`
 */
const MODELOS = {
  anthropic: 'claude-haiku-4-5-20251001',   // [por medir] — sin verificar
  openai: 'gpt-4o-mini',                    // [por medir] — sin verificar
  gemini: 'gemini-3.5-flash-lite',          // [medido] — ver arriba
}

/**
 * Dónde preguntar qué modelos siguen vivos, por proveedor.
 *
 * Esto va en el mensaje de un 404 a propósito. El modelo de hoy también se
 * retirará algún día, y quien se lo encuentre no tendrá delante nada de este
 * contexto: verá «404» y un cuerpo de respuesta. Que el error diga dónde mirar
 * convierte media tarde de investigación en una consulta.
 */
const LISTA_DE_MODELOS = {
  anthropic: 'GET https://api.anthropic.com/v1/models',
  openai: 'GET https://api.openai.com/v1/models',
  gemini: 'GET https://generativelanguage.googleapis.com/v1beta/models',
}

/**
 * Deduce el proveedor a partir del prefijo de la clave.
 * @returns {'anthropic'|'openai'|'gemini'|null}
 */
function proveedorDeClave (clave) {
  const c = String(clave || '').trim()
  if (!c) return null
  // El orden importa: una clave de Anthropic también empieza por "sk-".
  if (c.startsWith('sk-ant-')) return 'anthropic'
  if (c.startsWith('AIza')) return 'gemini'
  if (c.startsWith('sk-')) return 'openai'
  return null
}

/** Quita las vallas de markdown que el modelo añade aunque se le prohíba. */
function quitarVallas (bruto) {
  let t = String(bruto || '').trim()
  if (t.startsWith('```')) {
    t = t.split('\n').slice(1).join('\n').split('```')[0].trim()
  }
  return t
}

/**
 * Cuerpo del error sin la clave y sin desbordar el panel.
 *
 * Un **404 se trata aparte** porque casi siempre significa lo mismo: el modelo
 * por defecto se ha retirado. Es lo que le pasó a `gemini-2.0-flash`, y lo que
 * volverá a pasar. Se dice cuál se pidió y dónde mirar los que siguen vivos.
 */
async function motivoDelFallo (resp, prov, modelo) {
  const cuerpo = await resp.text().catch(() => '')
  const base = `${resp.status}: ${cuerpo.slice(0, 200)}`
  if (resp.status !== 404) return base
  return `${base} — puede que el modelo "${modelo}" esté retirado; ` +
         `mira los que siguen vivos con ${LISTA_DE_MODELOS[prov]}`
}

// ── Un armador de petición por proveedor ────────────────────────────────────
// Cada uno devuelve { url, opciones } y sabe sacar el texto de su respuesta.

const API = {
  anthropic: {
    peticion (clave, modelo, sistema, usuario, { maxTokens }) {
      return {
        url: 'https://api.anthropic.com/v1/messages',
        opciones: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': clave,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: modelo,
            max_tokens: maxTokens,
            system: sistema,
            messages: [{ role: 'user', content: usuario }],
          }),
        },
      }
    },
    // No tiene modo JSON: el prompt ya pide JSON y `quitarVallas` limpia.
    texto: d => d?.content?.[0]?.text || '',
  },

  openai: {
    peticion (clave, modelo, sistema, usuario, { maxTokens, json }) {
      const cuerpo = {
        model: modelo,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: sistema },
          { role: 'user', content: usuario },
        ],
      }
      // `json_object` exige que la palabra "json" aparezca en el prompt.
      // `promptResumen` la lleva ("Devuelve SOLO JSON"), así que se cumple.
      if (json) cuerpo.response_format = { type: 'json_object' }
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        opciones: {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${clave}` },
          body: JSON.stringify(cuerpo),
        },
      }
    },
    texto: d => d?.choices?.[0]?.message?.content || '',
  },

  gemini: {
    peticion (clave, modelo, sistema, usuario, { maxTokens, json }) {
      const generationConfig = { temperature: 0.4, maxOutputTokens: maxTokens }
      if (json) generationConfig.responseMimeType = 'application/json'
      return {
        // La clave va en cabecera, NUNCA en la query: ver el encabezado.
        url: `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        opciones: {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': clave },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: sistema }] },
            contents: [{ role: 'user', parts: [{ text: usuario }] }],
            generationConfig,
          }),
        },
      }
    },
    texto: d => d?.candidates?.[0]?.content?.parts?.[0]?.text || '',
  },
}

/**
 * Construye la función que `MotorRespuestas` y `MotorResumen` reciben inyectada.
 *
 * @param {object} opts
 * @param {string} opts.clave          la que el usuario guardó con safeStorage
 * @param {string} [opts.proveedor]    por defecto, deducido del prefijo
 * @param {string} [opts.modelo]       por defecto, el de MODELOS
 * @param {Function} [opts.fetchImpl]  inyectable: así se prueba sin red
 * @param {number} [opts.plazoMs]
 * @returns {(sistema: string, usuario: string, opciones?: object) => Promise<string>}
 */
function crearLlamador ({ clave, proveedor, modelo, fetchImpl, plazoMs = PLAZO_MS } = {}) {
  const prov = proveedor || proveedorDeClave(clave)
  if (!clave) throw new Error('falta la clave del modelo de lenguaje')
  if (!prov || !API[prov]) {
    throw new Error('no se reconoce esa clave: se esperaba una de Anthropic (sk-ant-), OpenAI (sk-) o Google (AIza)')
  }
  const mod = modelo || MODELOS[prov]
  const hacerFetch = fetchImpl || globalThis.fetch

  return async function llamar (sistema, usuario, { json = false, maxTokens = MAX_TOKENS } = {}) {
    const { url, opciones } = API[prov].peticion(clave, mod, sistema, usuario, { json, maxTokens })

    let resp
    try {
      resp = await hacerFetch(url, { ...opciones, signal: AbortSignal.timeout(plazoMs) })
    } catch (err) {
      // El mensaje de red puede traer la URL; con Gemini eso bastaba para
      // filtrar la clave si viajara en la query. No se reenvía tal cual.
      const seAgotó = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      throw new Error(seAgotó
        ? `el modelo no respondió en ${Math.round(plazoMs / 1000)} s`
        : `no se pudo hablar con ${prov}`)
    }

    if (!resp.ok) throw new Error(`${prov} ${await motivoDelFallo(resp, prov, mod)}`)

    const datos = await resp.json()
    return quitarVallas(API[prov].texto(datos))
  }
}

module.exports = { crearLlamador, proveedorDeClave, MODELOS, LISTA_DE_MODELOS, MAX_TOKENS, PLAZO_MS }
module.exports._internos = { quitarVallas, API, motivoDelFallo }
