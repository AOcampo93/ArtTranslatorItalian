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

class Autosave {
  /**
   * @param {object} opts
   * @param {string} opts.directorio  dónde viven los archivos de sesión
   * @param {string} [opts.idSesion]  por defecto, la fecha y hora
   */
  constructor ({ directorio, idSesion }) {
    this.directorio = directorio
    this.idSesion = idSesion || new Date().toISOString().replace(/[:.]/g, '-')
    this.ruta = path.join(directorio, `sesion-${this.idSesion}.jsonl`)
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

  /** Metadatos de la sesión: con qué perfil y contexto se grabó. */
  guardarCabecera ({ perfil, contexto }) {
    this.escribir({ tipo: 'cabecera', perfil: perfil || null, contexto: contexto || null })
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

  /** Las sesiones guardadas en un directorio, de la más reciente a la más antigua. */
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
}

module.exports = { Autosave }
