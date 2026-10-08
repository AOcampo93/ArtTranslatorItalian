/**
 * informes.js
 * Cliente de subida de informes (F039b): manda el `.jsonl` de cada reunión al
 * receptor del VPS (`vps/servidor.js`, F039a) cuando la reunión termina, y
 * reintenta las que se quedaron pendientes en el siguiente arranque.
 *
 * ## Por qué una cola en disco, y no un intento en memoria
 *
 * La reunión puede terminar sin red (el hotel del cliente, un VPN que cae) o
 * con el VPS caído. Si el intento fallido sólo viviera en memoria, se perdería
 * al cerrar la app y el informe nunca llegaría — exactamente el problema que
 * F039 vino a resolver (WhatsApp a mano no escala). La cola persiste en un
 * JSON pequeño: qué archivos quedan por subir y con qué cabeceras. `encolar()`
 * es la única escritura obligatoria en el camino de `pararSesion`, y es
 * síncrona a propósito — mismo motivo que `Autosave.escribir()`: son pocos
 * bytes, y así el pendiente queda en disco antes de que la app pueda cerrarse.
 *
 * ## Por qué nunca bloquea
 *
 * `enviarPendientes()` no la espera nadie en `mainApp.js` (`.catch(() => {})`,
 * sin `await`): un VPS lento no puede retrasar el resumen de la reunión ni el
 * cierre de la ventana. Un envío a la vez (`this.enviando`) evita que dos
 * llamadas solapadas —una al parar, otra al arrancar la siguiente reunión—
 * suban el mismo archivo dos veces o se pisen escribiendo la cola.
 *
 * ## Por qué `fetch` nativo
 *
 * Node 20 (el runtime de este backend y de Electron 43) lo trae de serie.
 * Añadir `axios` o `node-fetch` sería una dependencia más para una sola
 * llamada POST.
 */

'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Los dos modos de consentimiento (F052). `completo` manda el informe tal cual;
 * `metricas` manda solo números. Antes había un tercero, `no` (no mandar nada), y
 * el interruptor de Ajustes lo escribía al apagarse: desde F052 apagado es
 * `metricas`, porque sin ningún informe no se sabe si alguien no usó la app o si
 * apagó el envío (PLAN.md §17.5).
 */
const MODOS_DE_INFORME = ['completo', 'metricas']

/**
 * Orden de restricción de los dos modos: cuanto más bajo el número, más
 * restrictivo. Sirve para decidir, entre el modo que había cuando se grabó la
 * reunión y el modo actual, cuál manda al enviar (F039b, corrección del revisor:
 * "el consentimiento que vale es el que había al grabar").
 */
const ORDEN_RESTRICCION = { metricas: 0, completo: 1 }

/**
 * Puro: el modo que vale para lo que haya guardado.
 *
 * - Nada guardado (`undefined`, `null`, ''): `completo`, el interruptor viene
 *   encendido (beta). También es lo que cuenta un pendiente de antes de la
 *   corrección de F039b, que no traía `modoAlEncolar`.
 * - `no`, el de la v0.9 (no mandar nada): `metricas`. Quien lo apagó en la v0.9
 *   pasa a mandar números, y el aviso de Ajustes lo dice.
 * - Cualquier otra cosa que no se reconozca: `metricas` también. Es un valor que
 *   ningún Ajustes escribió, y ante la duda no sale texto (§0.22). Antes caía en
 *   `completo`.
 */
function normalizarModo (modo) {
  if (modo === undefined || modo === null || modo === '') return 'completo'
  return modo === 'completo' ? 'completo' : 'metricas'
}

/** Puro: el más restrictivo de dos modos (devuelve el modo ya normalizado). */
function masRestrictivo (a, b) {
  const na = normalizarModo(a)
  const nb = normalizarModo(b)
  return ORDEN_RESTRICCION[na] <= ORDEN_RESTRICCION[nb] ? na : nb
}

/**
 * Las claves cuyo valor es texto pero NO es de la reunión, del perfil ni del
 * contexto: el tipo de línea, la marca de tiempo y los vocabularios cerrados que
 * escribe la propia app (con qué se tradujo, por qué se cortó el turno, el
 * modelo, el idioma). Son las únicas cadenas que `metricas` deja pasar tal cual.
 *
 * **Es una lista de lo que sale, no de lo que se oculta**, y es a propósito: la
 * lista de lo que se oculta (`it`, `es`, `texto`…) fue lo que dejó escapar la
 * cabecera entera. Con esta, un campo nuevo con texto que alguien añada a una
 * línea sale como longitud hasta que se decida —aquí, a mano— que es vocabulario.
 */
const CAMPOS_DE_VOCABULARIO = new Set([
  'tipo', 't', 'traductor', 'motivo', 'motivoCorte', 'cierre', 'modelo', 'idioma',
])

/*
 * Los formatos que la lista de arriba no puede comprobar sola: que una clave sea de
 * vocabulario dice qué ESPERAMOS en ella, no qué hay (`motivo` ha llevado `err.message`
 * en otros sitios). Todo lo que no encaje sale como longitud (un valor) o no sale (una
 * clave). Una forma no distingue una palabra clave de un nombre suelto; deja fuera las
 * frases, que es lo que un campo de vocabulario puede recibir por error.
 */

/** El valor de una clave de vocabulario: una palabra clave, sin espacios ni acentos. */
const VALOR_DE_VOCABULARIO = /^[\w.:-]{1,40}$/
/**
 * Una clave de campo: un identificador en camelCase, como todos los que escribe la app.
 * Con minúscula inicial a propósito: una clave con mayúscula es un nombre o un término
 * (`{ "Tramontana": 3 }`) y no un campo, y con `[A-Za-z]` saldría.
 */
const CLAVE_DE_CAMPO = /^[a-z][A-Za-z0-9_]{0,40}$/
/** La hora tal como la escribe `toISOString()` (la `t` de cada línea, `inicio`). */
const HORA_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/
/** `app.getVersion()`: números con puntos y, a lo sumo, un sufijo de prelanzamiento. */
const VERSION_DE_LA_APP = /^v?\d+(\.\d+)*([-+][0-9A-Za-z.+-]{1,30})?$/
/** El código de un idioma del registro: `it`, `en`, `pt-BR`. */
const CODIGO_DE_IDIOMA = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/

/**
 * Puro: recorta un valor cualquiera del árbol de una línea del `.jsonl`.
 * Una cadena bajo una clave que no es de vocabulario —o de vocabulario pero que no
 * tiene su forma— se sustituye por su longitud (`it` → `itLen`): la longitud sigue
 * sirviendo para medir huecos y calidad sin exponer una sola palabra. Una cadena
 * suelta (dentro de una lista, sin clave que la avale) se queda en su longitud. Una
 * clave que no es un nombre de campo no sale, ni su valor.
 */
function recortarValor (valor) {
  if (typeof valor === 'string') return valor.length
  if (valor === null || typeof valor !== 'object') return valor
  if (Array.isArray(valor)) return valor.map(recortarValor)
  const salida = {}
  for (const [clave, v] of Object.entries(valor)) {
    if (!CLAVE_DE_CAMPO.test(clave)) continue
    if (typeof v !== 'string') salida[clave] = recortarValor(v)
    else if (CAMPOS_DE_VOCABULARIO.has(clave) && (clave === 't' ? HORA_ISO : VALOR_DE_VOCABULARIO).test(v)) salida[clave] = v
    else salida[`${clave}Len`] = v.length
  }
  return salida
}

/** Longitud de una cadena; 0 si lo que hay no es una cadena (campo vacío o ausente). */
const largo = v => (typeof v === 'string' ? v.length : 0)

/**
 * Puro: de un perfil, lo que se puede contar sin decirlo. Ni la edad: solo si la
 * hay. Un campo que no esté en esta lista no sale (ni como longitud).
 */
function resumirPerfil (perfil) {
  if (!perfil || typeof perfil !== 'object' || Array.isArray(perfil)) return null
  return {
    nombreLen: largo(perfil.nombre),
    ocupacionLen: largo(perfil.ocupacion),
    contextoLen: largo(perfil.contexto),
    tieneEdad: perfil.edad !== null && perfil.edad !== undefined && perfil.edad !== '',
  }
}

/** Puro: lo mismo para el contexto del proyecto. */
function resumirContexto (contexto) {
  if (!contexto || typeof contexto !== 'object' || Array.isArray(contexto)) return null
  return {
    nombreLen: largo(contexto.nombre),
    tipoReunionLen: largo(contexto.tipo_reunion),
    tipoProyectoLen: largo(contexto.tipo_proyecto),
    contextoLen: largo(contexto.contexto),
    glosarioLen: largo(contexto.glosario),
  }
}

/**
 * Puro: la cabecera en solo-métricas (F052).
 *
 * Hasta F052 la cabecera salía TAL CUAL "porque perfil y contexto son
 * configuración, no lo que se dijo". Era un error: el perfil (nombre, edad,
 * ocupación, descripción) y el contexto (nombre del proyecto, glosario) son
 * justo lo que alguien que apaga el envío cree que no sale (PLAN.md §0.22).
 *
 * Se construye campo a campo, no recortando la que había: lo que no se nombra
 * aquí no sale. Se conserva lo que no es texto de nadie (versión, idioma, inicio,
 * id, las banderas de claves) y lo que dice cómo estaba el interruptor
 * (`modoInforme`, `cambiosModo`); perfil y contexto pasan a longitudes y banderas.
 */
function recortarCabecera (obj) {
  const salida = { tipo: 'cabecera' }
  // Cada cadena que pasa tiene que tener la forma de lo que es: una hora, una versión,
  // un código de idioma. Si no la tiene, el campo no sale.
  const formatos = { t: HORA_ISO, inicio: HORA_ISO, version: VERSION_DE_LA_APP, idioma: CODIGO_DE_IDIOMA }
  for (const [clave, formato] of Object.entries(formatos)) {
    if (typeof obj[clave] === 'string' && formato.test(obj[clave])) salida[clave] = obj[clave]
  }
  if (typeof obj.id === 'number' || /^\d{1,12}$/.test(String(obj.id))) salida.id = obj.id
  salida.claves = { stt: Boolean(obj.claves?.stt), llm: Boolean(obj.claves?.llm) }
  // Los modos solo pasan si son uno de los dos que existen: ese campo nunca
  // lleva otra cosa que una de esas dos palabras.
  if (MODOS_DE_INFORME.includes(obj.modoInforme)) salida.modoInforme = obj.modoInforme
  if (Array.isArray(obj.cambiosModo)) {
    salida.cambiosModo = obj.cambiosModo
      .filter(c => c && typeof c.t === 'string' && HORA_ISO.test(c.t) && MODOS_DE_INFORME.includes(c.a))
      .map(c => ({ t: c.t, a: c.a }))
  }
  salida.perfil = resumirPerfil(obj.perfil)
  salida.contexto = resumirContexto(obj.contexto)
  return salida
}

/**
 * Puro: recorta UNA línea del `.jsonl` (una cadena, tal como sale de
 * `Autosave`) a su versión solo-métricas.
 *
 * La cabecera tiene su propio recorte (`recortarCabecera`). Todo lo demás —
 * frase, pregunta, respuesta, error, o una línea sin `tipo` (hoy `mainApp.js`
 * escribe las frases con él, pero las de antes no) — pierde su texto y conserva
 * longitudes, milisegundos, banderas y tipos. Las líneas de error NO son una
 * excepción: nada las escribe hoy, pero su mensaje saldría de una excepción y
 * una excepción puede traer una ruta con el nombre del usuario o un trozo de lo
 * que se dijo.
 *
 * Una línea que no es JSON válido (la última de un archivo cortado a media
 * escritura, tolerada por `Autosave.leer`) NO se manda tal cual: está cortada a
 * media frase, o sea que es justo el texto de la reunión. Sale como una línea
 * ilegible con su longitud, que además dice que el archivo se cortó.
 */
function recortarAMetricas (linea) {
  let obj
  try { obj = JSON.parse(linea) } catch {
    return JSON.stringify({ tipo: 'ilegible', len: linea.length })
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.tipo === 'cabecera') {
    return JSON.stringify(recortarCabecera(obj))
  }
  return JSON.stringify(recortarValor(obj))
}

/** Puro: aplica `recortarAMetricas` a cada línea de un `.jsonl` completo. */
function recortarInformeAMetricas (contenido) {
  return contenido
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(recortarAMetricas)
    .join('\n') + '\n'
}

class ColaDeInformes {
  /**
   * @param {object} opts
   * @param {string} opts.directorioDatos  dónde vive el JSON de la cola
   *   (normalmente `app.getPath('userData')`, o un directorio temporal en
   *   pruebas — nunca `/datos/informes`, que es del receptor).
   * @param {string} [opts.token]  Bearer del receptor. Sin él, `encolar()`
   *   sigue funcionando (no se pierde el `.jsonl` de la cola) pero
   *   `enviarPendientes()` no manda nada.
   * @param {string} [opts.url]  `POST` del receptor, p. ej.
   *   `https://arturoocampo.com/informes`.
   * @param {() => ('metricas'|'completo')} [opts.obtenerModo]  se llama
   *   antes de CADA pendiente que se sube, no una vez por tanda ni al construir
   *   la cola: el usuario puede cambiar el ajuste en Ajustes mientras la app
   *   está viva. Cualquier valor pasa por `normalizarModo`, así que un `no` de
   *   la v0.9 se lee como `metricas`.
   */
  constructor ({ directorioDatos, token, url, obtenerModo } = {}) {
    this.rutaCola = path.join(directorioDatos, 'cola-informes.json')
    this.token = token || null
    this.url = url || null
    this.obtenerModo = obtenerModo || (() => 'completo')
    this._enviando = false
  }

  /** Nunca lanza: una cola ilegible (primer arranque, JSON roto) es una cola vacía. */
  _leer () {
    try {
      const bruto = fs.readFileSync(this.rutaCola, 'utf8')
      const lista = JSON.parse(bruto)
      return Array.isArray(lista) ? lista : []
    } catch { return [] }
  }

  _escribir (lista) {
    fs.mkdirSync(path.dirname(this.rutaCola), { recursive: true })
    fs.writeFileSync(this.rutaCola, JSON.stringify(lista))
  }

  /**
   * Añade un `.jsonl` a la cola. Síncrono a propósito (ver el porqué arriba):
   * `pararSesion` no puede quedar pendiente de esto.
   *
   * @param {string} rutaJsonl  la ruta del archivo de `Autosave`, tal cual.
   * @param {{maquina: string, version: string, reunion: string}} meta  las
   *   tres cabeceras del contrato (`X-Maquina`, `X-Version`, `X-Reunion`).
   * @param {{modoAlEmpezar?: string}} [opciones]  el modo del interruptor cuando
   *   EMPEZÓ la reunión (el de su cabecera). Sin él, solo cuenta el de ahora.
   */
  encolar (rutaJsonl, meta, { modoAlEmpezar } = {}) {
    // El consentimiento que vale es el que había CUANDO SE GRABÓ la reunión,
    // no el que haya en Ajustes el día que por fin hay red. Una reunión dura un
    // rato, y se graba entre dos lecturas del interruptor: la de cuando empezó y
    // la de ahora, que ha parado. Vale la más restrictiva (F052, lectura estricta
    // de F039b): quien empieza con el envío apagado no sube su conversación aunque
    // lo encienda antes de parar, y quien lo apaga en mitad tampoco. Se guarda aquí,
    // junto al pendiente, y `enviarPendientes()` aplica el más restrictivo entre
    // este y el modo del momento del envío — así tampoco sube si lo enciende
    // semanas después para otra reunión.
    const modoAlEncolar = masRestrictivo(modoAlEmpezar, this.obtenerModo())
    const lista = this._leer()
    lista.push({ rutaJsonl, meta, modoAlEncolar })
    this._escribir(lista)
  }

  /**
   * Intenta subir todo lo pendiente, en orden, uno detrás de otro. Se para en
   * el primer fallo (sin red, VPS caído, token rechazado) y deja el resto en
   * la cola para la siguiente llamada — no tiene sentido intentar el segundo
   * si el primero ya dijo que no hay red.
   *
   * Nunca lanza: quien la llama no tiene que envolverla en `try/catch`, y
   * `mainApp.js` la llama sin `await` porque nunca debe retrasar nada.
   */
  async enviarPendientes () {
    if (this._enviando) return
    if (!this.token || !this.url) return // sin token no hay a quién mandarle nada

    this._enviando = true
    try {
      let lista = this._leer()
      while (lista.length > 0) {
        const item = lista[0]
        let subida
        if (item.modoAlEncolar === 'no') {
          // Un pendiente que dejó la v0.9 grabado con "no mandar nada" (F052). Se
          // grabó con la promesa de que no saldría nada, y esa promesa no caduca
          // porque cambie la versión: se saca de la cola sin subirlo. Es el único
          // sitio donde `no` sigue siendo `no`; como ajuste actual se lee `metricas`.
          subida = true
        } else {
          // El modo que manda es el más restrictivo entre el que había al
          // grabar (`modoAlEncolar`, ausente en pendientes de antes de esta
          // corrección — entonces cuenta como 'completo', su comportamiento de
          // siempre) y el de ahora mismo. «Ahora» es AHORA, cada pendiente: leído
          // una vez por tanda, quien apaga el envío mientras sube el primero
          // veía salir el segundo con texto. `_enviarUno` arma el cuerpo en el
          // mismo tick que esta lectura, antes de su primer `await`.
          const modoEfectivo = masRestrictivo(item.modoAlEncolar, this.obtenerModo())
          subida = await this._enviarUno(item, modoEfectivo)
        }
        if (!subida) break
        // La cola se vuelve a leer del disco antes de escribirla: mientras subía,
        // `encolar` (la reunión que acaba de parar) pudo añadir otro pendiente, y
        // escribir la lista que había en memoria lo habría borrado.
        lista = this._leer()
        const i = lista.findIndex(p => p.rutaJsonl === item.rutaJsonl && p.meta?.reunion === item.meta?.reunion)
        if (i >= 0) lista.splice(i, 1)
        this._escribir(lista)
      }
    } finally {
      this._enviando = false
    }
  }

  /** @returns {Promise<boolean>} true si el pendiente ya no tiene que reintentarse (subió, o ya no hay nada que subir). */
  async _enviarUno (item, modo) {
    let cuerpo
    try {
      cuerpo = fs.readFileSync(item.rutaJsonl, 'utf8')
    } catch {
      // El archivo ya no existe (reunión borrada por el usuario antes de que
      // hubiera red). No hay nada que reintentar: se descarta el pendiente,
      // no se bloquea la cola por él para siempre.
      return true
    }
    // Solo `completo` manda el archivo entero; cualquier otra cosa, números. Así un modo que
    // no sea ninguno de los dos no abre la puerta.
    if (modo !== 'completo') cuerpo = recortarInformeAMetricas(cuerpo)

    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/x-ndjson',
          'X-Maquina': item.meta.maquina,
          'X-Version': item.meta.version,
          'X-Reunion': item.meta.reunion,
        },
        body: cuerpo,
        // Un SYN tragado por un firewall dejaría la cola bloqueada todo el rato.
        signal: AbortSignal.timeout(30000),
      })
      if (resp.ok) return true
      // 401 (token rotado), 413, 415…: permanente. Se descarta para no bloquear
      // a los que vienen detrás; solo 429, red y 5xx merecen reintento.
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) return true
      return false
    } catch {
      // Sin red, DNS caído, VPS apagado: se reintenta en el siguiente
      // `enviarPendientes()` (el siguiente arranque, o la siguiente reunión).
      return false
    }
  }
}

module.exports = {
  ColaDeInformes, recortarAMetricas, recortarInformeAMetricas, normalizarModo, masRestrictivo, MODOS_DE_INFORME,
}
