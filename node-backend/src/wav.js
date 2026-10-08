/**
 * wav.js
 * Lee el audio de un WAV PCM de 16 bits, para la comprobación previa.
 *
 * ## Por qué no basta con `subarray(44)`
 *
 * 44 bytes es la cabecera de un WAV que solo lleva los trozos `fmt ` y `data`. Los
 * dos audios de prueba los escribe ffmpeg, que añade un trozo `LIST` con su
 * versión entre los dos, y la cabecera pasa a medir 78 bytes `[verificado]` en
 * `italiano.wav` y en `ingles.wav`. Con `subarray(44)` los 34 bytes de ese trozo
 * entran como audio: 17 muestras que no son voz al principio de la frase. Aquí se
 * recorren los trozos hasta el `data`, que es lo que dice el formato.
 *
 * El formato (PCM, 16 bits, mono, 16 kHz) se comprueba y no se asume: el
 * transcriptor da por hecho 16 kHz, y un audio de prueba con otra frecuencia
 * "funcionaría" y mediría una cosa distinta (PLAN.md §0.11, por el mismo motivo).
 */

'use strict'

const fs = require('fs')

const FRECUENCIA_ESPERADA = 16000

/**
 * @param {Buffer} wav el archivo entero
 * @returns {Float32Array} las muestras, entre -1 y 1
 */
function muestrasDeWav (wav) {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('el audio de prueba no es un WAV')
  }

  let formato = null
  let i = 12
  while (i + 8 <= wav.length) {
    const id = wav.toString('ascii', i, i + 4)
    const largo = wav.readUInt32LE(i + 4)
    const inicio = i + 8

    if (id === 'fmt ') {
      formato = {
        tipo: wav.readUInt16LE(inicio),
        canales: wav.readUInt16LE(inicio + 2),
        frecuencia: wav.readUInt32LE(inicio + 4),
        bits: wav.readUInt16LE(inicio + 14),
      }
    } else if (id === 'data') {
      if (!formato) throw new Error('el WAV trae el audio antes que su formato')
      if (formato.tipo !== 1 || formato.canales !== 1 || formato.bits !== 16 || formato.frecuencia !== FRECUENCIA_ESPERADA) {
        throw new Error(`el audio de prueba debe ser PCM de 16 bits, mono, a ${FRECUENCIA_ESPERADA} Hz, y es `
          + `tipo ${formato.tipo}, ${formato.canales} canal(es), ${formato.bits} bits, ${formato.frecuencia} Hz`)
      }
      // Un archivo cortado a medias declara más de lo que trae: se lee lo que haya.
      const fin = Math.min(inicio + largo, wav.length)
      const muestras = new Float32Array(Math.floor((fin - inicio) / 2))
      for (let k = 0; k < muestras.length; k++) muestras[k] = wav.readInt16LE(inicio + k * 2) / 32768
      return muestras
    }

    // Los trozos RIFF se alinean a un número par de bytes.
    i = inicio + largo + (largo % 2)
  }
  throw new Error('el WAV no tiene trozo data')
}

/** Lo mismo, desde una ruta. Un archivo que falta lanza el `ENOENT` de siempre. */
function leerMuestrasWav (ruta) {
  return muestrasDeWav(fs.readFileSync(ruta))
}

module.exports = { leerMuestrasWav, muestrasDeWav }
