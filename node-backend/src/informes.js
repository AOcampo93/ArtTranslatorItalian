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
 * Campos que llevan texto libre de la reunión (lo que el usuario dijo, lo que
 * el LLM respondió) y que el modo "solo métricas" no puede mandar. Se
 * sustituyen por su longitud, nunca se borran sin dejar rastro: la longitud
 * sigue sirviendo para medir huecos y calidad sin exponer una sola palabra.
 */
const CAMPOS_LIBRES = ['it', 'es', 'texto', 'mensaje', 'detalle']

/**
 * Orden de restricción de los tres modos de consentimiento: cuanto más bajo
 * el número, más restrictivo. Sirve para decidir, entre el modo que había
 * cuando se grabó la reunión y el modo actual, cuál manda al enviar (F039b,
 * corrección del revisor: "el consentimiento que vale es el que había al
 * grabar").
 */
const ORDEN_RESTRICCION = { no: 0, metricas: 1, completo: 2 }

/** Puro: el más restrictivo de dos modos. Un modo desconocido cuenta como 'completo'. */
function masRestrictivo (a, b) {
  const oa = ORDEN_RESTRICCION[a] ?? ORDEN_RESTRICCION.completo
  const ob = ORDEN_RESTRICCION[b] ?? ORDEN_RESTRICCION.completo
  return oa <= ob ? a : b
}

/** Puro: recorta un valor cualquiera del árbol de una línea del `.jsonl`. */
function recortarValor (valor) {
  if (valor === null || typeof valor !== 'object') return valor
  if (Array.isArray(valor)) return valor.map(recortarValor)
  const salida = {}
  for (const [clave, v] of Object.entries(valor)) {
    if (CAMPOS_LIBRES.includes(clave) && typeof v === 'string') {
      salida[`${clave}Len`] = v.length
    } else {
      salida[clave] = recortarValor(v)
    }
  }
  return salida
}

/**
 * Puro: recorta UNA línea del `.jsonl` (una cadena, tal como sale de
 * `Autosave`) a su versión solo-métricas.
 *
 * La cabecera y los errores se conservan tal cual, tal como pide el contrato:
 * la cabecera no lleva texto de la reunión (perfil y contexto son
 * configuración, no lo que se dijo) y un error es diagnóstico del equipo, no
 * una frase de nadie. Todo lo demás (frase, pregunta, o una línea sin `tipo`
 * — hoy `mainApp.js` escribe las frases sin ese campo) pierde `it`/`es`/
 * texto libre y conserva longitudes, milisegundos, banderas y tipos.
 *
 * Una línea que no es JSON válido (la última de un archivo cortado a media
 * escritura, tolerada por `Autosave.leer`) se deja tal cual: no hay nada que
 * recortar y no es texto de la reunión, es ruido de disco.
 */
function recortarAMetricas (linea) {
  let obj
  try { obj = JSON.parse(linea) } catch { return linea }
  if (obj && typeof obj === 'object' && (obj.tipo === 'cabecera' || obj.tipo === 'error')) {
    return JSON.stringify(obj)
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
   * @param {() => ('no'|'metricas'|'completo')} [opts.obtenerModo]  se llama
   *   en cada `enviarPendientes()`, no una sola vez al construir la cola: el
   *   usuario puede cambiar el ajuste en Ajustes mientras la app está viva.
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
   */
  encolar (rutaJsonl, meta) {
    // El consentimiento que vale es el que había CUANDO SE GRABÓ la reunión,
    // no el que haya en Ajustes el día que por fin hay red. Se guarda aquí,
    // junto al pendiente, y `enviarPendientes()` aplica el más restrictivo
    // entre este y el modo del momento del envío — así una reunión grabada en
    // "no mandar nada" no sube nunca, aunque el usuario cambie el ajuste a
    // "completo" semanas después para otra reunión.
    const modoAlEncolar = this.obtenerModo()
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
    const modo = this.obtenerModo()
    if (modo === 'no') return

    this._enviando = true
    try {
      let lista = this._leer()
      while (lista.length > 0) {
        const item = lista[0]
        // El modo que manda es el más restrictivo entre el que había al
        // grabar (`modoAlEncolar`, ausente en pendientes de antes de esta
        // corrección — entonces cuenta como 'completo', su comportamiento de
        // siempre) y el de ahora mismo.
        const modoEfectivo = masRestrictivo(item.modoAlEncolar, modo)
        const subida = await this._enviarUno(item, modoEfectivo)
        if (!subida) break
        lista = lista.slice(1)
        this._escribir(lista)
      }
    } finally {
      this._enviando = false
    }
  }

  /** @returns {Promise<boolean>} true si el pendiente ya no tiene que reintentarse (subió, no hay nada que subir, o el modo con el que se grabó prohíbe mandar algo). */
  async _enviarUno (item, modo) {
    if (modo === 'no') {
      // Se grabó (o se está reintentando) bajo "no mandar nada": se descarta
      // sin tocar la red, no se reintenta jamás con un modo más permisivo.
      return true
    }
    let cuerpo
    try {
      cuerpo = fs.readFileSync(item.rutaJsonl, 'utf8')
    } catch {
      // El archivo ya no existe (reunión borrada por el usuario antes de que
      // hubiera red). No hay nada que reintentar: se descarta el pendiente,
      // no se bloquea la cola por él para siempre.
      return true
    }
    if (modo === 'metricas') cuerpo = recortarInformeAMetricas(cuerpo)

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

module.exports = { ColaDeInformes, recortarAMetricas, recortarInformeAMetricas }
