/**
 * autosave.js
 * Guarda cada frase en cuanto se produce, no al final.
 *
 * Es el no negociable §0.3, y resuelve a la vez un defecto heredado.
 *
 * **Por qué existe:** el flujo dice "al terminar, exporta". Eso significa que
 * un cierre accidental, un crash del renderer o un reinicio por Windows Update
 * en el minuto 58 **borra la reunión entera**. Es el fallo que más rápido
 * destruye la confianza en un producto así: el usuario no pierde una función,
 * pierde su trabajo.
 *
 * **Por qué `.jsonl` y no la base de datos:** `db.js` serializa la base
 * completa en cada inserción. Con las transcripciones dentro, una reunión de
 * 200 frases reescribe el archivo 200 veces, cada vez más grande, y de forma
 * síncrona en el mismo hilo del pipeline. Un archivo de líneas con apertura en
 * modo `append` escribe solo lo nuevo y no puede corromper lo anterior.
 *
 * **Por qué append-only importa:** si el proceso muere a media escritura, lo
 * único que se puede perder es la última línea. Todo lo anterior sigue
 * íntegro y legible. Con una reescritura completa se perdería todo.
 */

'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Hueco máximo, hacia adelante, entre dos líneas seguidas de una reunión en
 * curso antes de que `Autosave.detectarMezcla()` sospeche que en realidad
 * son dos reuniones distintas. `[estimado]`: no hay todavía una medición de
 * la pausa más larga de una reunión real (candidato para F038, que sí va a
 * leer `.jsonl` de reuniones de verdad); 30 min es el valor de partida y se
 * puede ajustar cuando haya datos.
 */
const UMBRAL_HUECO_MS = 30 * 60 * 1000

/**
 * Fecha y hora LOCALES en `AAAAMMDD-HHMMSS`, para el nombre del archivo.
 *
 * Local y no UTC a propósito: es la hora que el cliente reconoce si mira la
 * carpeta de reuniones.
 *
 * Con SEGUNDOS, no solo minutos (ronda 2 de F030): con minutos, dos arranques
 * de `db.js` reiniciada dentro del mismo minuto Y con el mismo `idSesion`
 * seguían cayendo en el mismo archivo — lo prueba `detectarMezcla…` con la
 * clase real (`autosave.test.js`), que fuerza ese choque a propósito para
 * comprobar la segunda red de seguridad. Los segundos no lo vuelven
 * imposible (dos arranques en el mismo segundo seguirían chocando), pero
 * reducen la ventana de choque ×60, de 60 000 ms a 1 000 ms. Cerrarla del
 * todo exigiría que `abrir()` sufijara el nombre si el archivo ya existe, y
 * eso rompería el invariante de "reabrir la misma sesión añade, no
 * reemplaza" (ver el constructor) sin ganar nada en el producto real: hoy
 * `mainApp.js` nunca reabre una sesión ya empezada, crea un `Autosave` nuevo
 * en cada `empezarSesion()`, así que el choque de segundo exacto no es
 * alcanzable desde la app tal como está hoy.
 */
function marcaLocal (fecha) {
  const p = n => String(n).padStart(2, '0')
  return `${fecha.getFullYear()}${p(fecha.getMonth() + 1)}${p(fecha.getDate())}`
       + `-${p(fecha.getHours())}${p(fecha.getMinutes())}${p(fecha.getSeconds())}`
}

class Autosave {
  /**
   * @param {object} opts
   * @param {string} opts.directorio  dónde viven los archivos de sesión
   * @param {string} [opts.idSesion]  por defecto, la fecha y hora ISO
   * @param {Date|string} [opts.inicio]  cuándo arrancó la reunión; por
   *   defecto, ahora. Entra en el nombre del archivo (F030): antes el nombre
   *   era solo `sesion-<idSesion>.jsonl`, y `idSesion` es un autoincremento
   *   de `db.js` que vuelve a 1 cada vez que la base se reinicia — MEDIDO en
   *   `sesion-1.jsonl` del cliente, que fundió 21 frases del 16-09 (v0.2) con
   *   6 del 17-09 (v0.4) porque las dos reuniones cayeron en el mismo id y
   *   por tanto en el mismo archivo.
   * @param {string} [opts.version]  versión de la app, para la cabecera
   */
  constructor ({ directorio, idSesion, inicio, version }) {
    this.directorio = directorio
    this.inicio = inicio ? new Date(inicio) : new Date()
    this.idSesion = idSesion || this.inicio.toISOString().replace(/[:.]/g, '-')
    this.version = version || null
    // El id solo ya no basta (ver arriba): la marca de tiempo local, CON
    // segundos (ver `marcaLocal`), lo acompaña siempre. `listar()` sigue
    // reconociendo el formato viejo `sesion-<id>.jsonl` porque su patrón no
    // exige la marca.
    this.ruta = path.join(directorio, `sesion-${marcaLocal(this.inicio)}-${this.idSesion}.jsonl`)
    this._fd = null
    this._lineas = 0
  }

  /** Abre el archivo en modo append. Idempotente. */
  abrir () {
    if (this._fd !== null) return
    fs.mkdirSync(this.directorio, { recursive: true })
    // 'a' = append. El sistema garantiza que cada escritura va al final,
    // así que dos escrituras no se pisan ni corrompen lo ya guardado.
    this._fd = fs.openSync(this.ruta, 'a')
  }

  /**
   * Escribe una entrada. Síncrono a propósito: son pocos bytes y así la
   * frase está en disco antes de seguir. Un `await` aquí abriría una ventana
   * en la que la app puede morir con la frase solo en memoria.
   * @param {object} entrada
   */
  escribir (entrada) {
    this.abrir()
    const linea = JSON.stringify({ t: new Date().toISOString(), ...entrada }) + '\n'
    fs.writeSync(this._fd, linea)
    this._lineas++
  }

  /** Una frase traducida del pipeline. */
  guardarFrase ({ it, es, msWhisper, msMarian, msTotal }) {
    this.escribir({ tipo: 'frase', it, es, msWhisper, msMarian, msTotal })
  }

  /** Una pregunta detectada, con su respuesta si ya la hay. */
  guardarPregunta ({ it, es, respuesta }) {
    this.escribir({ tipo: 'pregunta', it, es, respuesta: respuesta || null })
  }

  /**
   * Metadatos de la sesión: con qué perfil y contexto se grabó, con qué
   * versión de la app, cuándo empezó y con qué id de `db.js`.
   *
   * Se escribe una sola vez, como PRIMERA línea del archivo (F030): así se
   * sabe de qué reunión y versión es sin mirar el nombre, y un archivo con
   * más de una cabecera es la huella de dos reuniones fundidas —
   * `detectarMezcla()` la busca.
   */
  guardarCabecera ({ perfil, contexto, version, inicio, id } = {}) {
    this.escribir({
      tipo: 'cabecera',
      perfil: perfil || null,
      contexto: contexto || null,
      version: version || this.version || null,
      inicio: (inicio ? new Date(inicio) : this.inicio).toISOString(),
      id: id !== undefined ? id : this.idSesion,
    })
  }

  cerrar () {
    if (this._fd === null) return
    try { fs.closeSync(this._fd) } catch { /* ya cerrado */ }
    this._fd = null
  }

  /**
   * ¿Está el archivo abierto ahora mismo?
   *
   * Existe porque `escribir()` REABRE el archivo si hace falta, y eso es lo que
   * permite guardar una frase que llega cuando la sesión ya se cerró (el caso
   * de parar la reunión con una traducción en vuelo). Quien escribe entonces
   * necesita saber si lo ha reabierto él para volver a cerrarlo: nadie más lo
   * va a hacer, y un descriptor por sesión terminada se acumula.
   */
  get abierto () { return this._fd !== null }

  get lineasEscritas () { return this._lineas }

  /**
   * Lee una sesión guardada. Tolera la última línea truncada, que es
   * exactamente lo que deja un cierre a media escritura.
   * @returns {{ entradas: object[], truncadas: number }}
   */
  static leer (ruta) {
    if (!fs.existsSync(ruta)) return { entradas: [], truncadas: 0 }
    const texto = fs.readFileSync(ruta, 'utf8')
    const entradas = []
    let truncadas = 0
    for (const linea of texto.split('\n')) {
      if (!linea.trim()) continue
      try { entradas.push(JSON.parse(linea)) }
      catch { truncadas++ }   // línea a medias: se cuenta y se sigue
    }
    return { entradas, truncadas }
  }

  /**
   * Las sesiones guardadas en un directorio, de la más reciente a la más
   * antigua. El patrón es deliberadamente laxo (`sesion-*.jsonl`): así
   * encuentra tanto el nombre nuevo (`sesion-AAAAMMDD-HHMMSS-<id>.jsonl`,
   * F030, con segundos desde la ronda 2) como el viejo (`sesion-<id>.jsonl`)
   * sin distinguir uno de otro. Un cambio de formato de nombre no puede
   * volver invisibles las reuniones grabadas antes del cambio.
   */
  static listar (directorio) {
    if (!fs.existsSync(directorio)) return []
    return fs.readdirSync(directorio)
      .filter(f => /^sesion-.*\.jsonl$/.test(f))
      .map(f => ({
        archivo: f,
        ruta: path.join(directorio, f),
        tamano: fs.statSync(path.join(directorio, f)).size,
      }))
      .sort((a, b) => b.archivo.localeCompare(a.archivo))
  }

  /**
   * ¿Este archivo trae dos reuniones fundidas en una (el fallo de F030)?
   *
   * No repara nada: solo avisa, con el motivo. Tres señales, cualquiera basta:
   *
   *  - **Más de una cabecera.** Desde que `guardarCabecera()` se llama al
   *    abrir cada sesión, un archivo con dos es la prueba directa de que dos
   *    reuniones escribieron en el mismo sitio.
   *  - **Un hueco desproporcionado hacia adelante.** Cada línea lleva su `t`
   *    (`escribir()`, arriba). Con escritura `append`, dos reuniones fundidas
   *    se escriben SIEMPRE en orden cronológico — la segunda va después de la
   *    primera, nunca al revés —, así que esta es la señal que de verdad
   *    detecta el caso MEDIDO en `sesion-1.jsonl` del cliente: 21 frases del
   *    16-09 (v0.2) seguidas de 6 del 17-09 (v0.4), con el `t` avanzando todo
   *    el rato. Ninguna pausa real de una reunión en curso dura
   *    `UMBRAL_HUECO_MS`; si el hueco entre dos líneas seguidas lo pasa, lo
   *    más probable es que la segunda sea otra reunión. (Ronda 2 de F030: la
   *    ronda 1 solo tenía la señal de abajo, que con escritura `append` NUNCA
   *    puede ser cierta para el caso real —el `t` avanza, no retrocede—; la
   *    prueba «archivo real del cliente…» de `autosave.test.js` reproduce esa
   *    forma exacta y por eso hacía falta esta señal.)
   *  - **El reloj retrocede.** Si una entrada es anterior a la de justo
   *    antes, el archivo no se escribió en una sola pasada `append`
   *    continua: alguien escribió las líneas fuera de orden, o el reloj del
   *    sistema saltó hacia atrás a media escritura. No es el caso medido del
   *    cliente (ver arriba), pero sí un archivo sospechoso.
   *
   * Sirve tanto para archivos nuevos como para los ya mezclados de antes del
   * arreglo, que no tienen cabecera y donde solo las dos últimas señales
   * aplican.
   *
   * @returns {{ mezclado: boolean, motivo: string|null }}
   */
  static detectarMezcla (ruta) {
    const { entradas } = Autosave.leer(ruta)
    const cabeceras = entradas.filter(e => e && e.tipo === 'cabecera')
    if (cabeceras.length > 1) {
      return { mezclado: true, motivo: `${cabeceras.length} cabeceras en el mismo archivo` }
    }
    for (let i = 1; i < entradas.length; i++) {
      const anterior = entradas[i - 1]
      const actual = entradas[i]
      if (!anterior || !actual) continue
      // Ronda 3 de F030: la cabecera se escribe al ABRIR la sesión, antes de
      // que nadie haya hablado, así que el primer par (cabecera → primera
      // frase) mide tiempo de espera del usuario, no una pausa de la
      // conversación. Sin este salto, una reunión sana con la app abierta
      // 30+ min antes de la primera frase salía `mezclado: true` — falso
      // positivo determinista, medido por el revisor (review_F030_correccion.md).
      if (anterior.tipo === 'cabecera') continue
      const tAnterior = new Date(anterior.t).getTime()
      const tActual = new Date(actual.t).getTime()
      if (tActual < tAnterior) {
        return { mezclado: true, motivo: `la marca de tiempo retrocede en la línea ${i + 1}` }
      }
      if (tActual - tAnterior > UMBRAL_HUECO_MS) {
        const minutos = Math.round((tActual - tAnterior) / 60000)
        return { mezclado: true, motivo: `hueco de ${minutos} min entre las líneas ${i} y ${i + 1}` }
      }
    }
    return { mezclado: false, motivo: null }
  }
}

module.exports = { Autosave }
