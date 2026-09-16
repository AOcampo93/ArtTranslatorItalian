/**
 * audio.js — captura del audio del sistema.
 *
 * Es la única pieza de la app que depende del sistema operativo. Todo lo demás
 * —transcripción, traducción, preguntas, respuestas— corre igual en cualquier
 * sitio porque va por la nube; esto no.
 *
 * ## Cómo se capta el audio de la videollamada
 *
 * `getDisplayMedia` con audio. El proceso principal intercepta la petición y
 * responde `audio: 'loopback'`, que en Windows entrega **lo que suena en el
 * equipo** en vez del micrófono. Así el usuario no configura nada: ni Mezcla
 * estéreo, ni cables virtuales, ni elegir dispositivo. Es la prioridad nº 1
 * del proyecto.
 *
 * Verificado en dos equipos Windows: una máquina virtual a 44.100 Hz y un HP
 * Pavilion a 48.000 Hz. **Que dieran frecuencias distintas es justo el motivo**
 * por el que aquí nunca se supone la frecuencia (§0.11).
 *
 * En macOS `loopback` no existe: `soportado()` lo dice y la app cae al
 * micrófono, que sirve para desarrollar pero no es el producto.
 *
 * ## Por qué se pide vídeo si sólo queremos audio
 *
 * `getDisplayMedia` no entrega audio del sistema sin una pista de vídeo. Se
 * pide, se descarta de inmediato y no se mira nunca: si se dejara viva,
 * gastaría CPU capturando pantalla durante toda la reunión.
 */

'use strict'

const DESTINO_HZ = 16000
const MS_BLOQUE = 100

class CapturaAudio {
  constructor ({ alBloque, alError }) {
    this.alBloque = alBloque
    this.alError = alError
    this.stream = null
    this.contexto = null
    this.nodo = null
    this.info = null
  }

  /** ¿Puede este sistema dar el audio de la videollamada? */
  static soportado () {
    return typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getDisplayMedia
  }

  async empezar () {
    // El vídeo se pide porque sin él no hay audio de sistema; se tira enseguida.
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 1, height: 1, frameRate: 1 },
    })

    const pistas = this.stream.getAudioTracks()
    if (!pistas.length) {
      this.detener()
      throw new Error(
        'El sistema no entregó audio. En Windows suele significar que se eligió '
        + 'una ventana en vez de la pantalla completa.')
    }
    for (const v of this.stream.getVideoTracks()) v.stop()

    this.contexto = new AudioContext()
    // NUNCA suponer 48.000: medido 44.100 en una VM y 48.000 en un portátil.
    const entradaHz = this.contexto.sampleRate

    await this.contexto.audioWorklet.addModule('captura-worklet.js')

    const fuente = this.contexto.createMediaStreamSource(this.stream)
    this.nodo = new AudioWorkletNode(this.contexto, 'captura', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { destino: DESTINO_HZ, msBloque: MS_BLOQUE },
    })

    this.nodo.port.onmessage = ev => {
      const m = ev.data
      if (m.tipo === 'audio') this.alBloque(m.muestras)
      else if (m.tipo === 'listo') this.info = m
    }
    this.nodo.onprocessorerror = () =>
      this.alError?.(new Error('el procesador de audio falló; hay que reiniciar la escucha'))

    fuente.connect(this.nodo)

    // Si el usuario para la compartición desde el aviso de Windows, la pista
    // termina y aquí no llegaría más audio. Sin esto, la app se quedaría con
    // cara de estar escuchando y en silencio para siempre.
    pistas[0].addEventListener('ended', () =>
      this.alError?.(new Error('se dejó de compartir el audio del sistema')))

    const ajustes = pistas[0].getSettings?.() || {}
    return {
      entradaHz,
      salidaHz: DESTINO_HZ,
      etiqueta: pistas[0].label || 'audio del sistema',
      canales: ajustes.channelCount ?? null,
    }
  }

  /** Nivel de audio del último bloque, para el medidor de la prueba de sonido. */
  static nivel (muestras) {
    let suma = 0
    for (let i = 0; i < muestras.length; i++) suma += muestras[i] * muestras[i]
    return Math.sqrt(suma / muestras.length)
  }

  detener () {
    try { this.nodo?.port.close() } catch { /* ya cerrado */ }
    try { this.nodo?.disconnect() } catch { /* ya desconectado */ }
    // El AudioContext se cierra de verdad: dejarlo abierto mantiene el
    // dispositivo de audio tomado y en portátil eso se nota en la batería.
    try { this.contexto?.close() } catch { /* ya cerrado */ }
    for (const p of this.stream?.getTracks() || []) p.stop()
    this.stream = this.contexto = this.nodo = null
  }
}

if (typeof window !== 'undefined') window.CapturaAudio = CapturaAudio
if (typeof module !== 'undefined') module.exports = { CapturaAudio, DESTINO_HZ, MS_BLOQUE }
