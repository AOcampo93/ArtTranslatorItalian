/**
 * captura-worklet.js — corre dentro del hilo de audio.
 *
 * Su único trabajo es **remuestrear a 16 kHz** y entregar bloques de 100 ms.
 *
 * Va en un AudioWorklet y no en un ScriptProcessorNode porque el segundo corre
 * en el hilo principal: cualquier repintado de la interfaz —y esta app pinta
 * burbujas constantemente— produce cortes en el audio que luego aparecen como
 * palabras perdidas, sin ningún error que lo explique.
 *
 * La frecuencia de entrada **se recibe como dato**, nunca se supone. Es el
 * no negociable §0.11 del plan: en la máquina virtual el audio llegó a 44.100 Hz
 * y en el HP Pavilion a 48.000 Hz. Dar por hecho 48.000 hace que el remuestreo
 * salga mal, que todo "funcione" y que la transcripción empeore sin que nadie
 * entienda por qué.
 */

class CapturaProcessor extends AudioWorkletProcessor {
  constructor (opciones) {
    super()
    const { destino = 16000, msBloque = 100 } = opciones.processorOptions || {}
    this.destino = destino
    this.muestrasBloque = Math.round(destino * msBloque / 1000)

    // `sampleRate` es una global del ámbito del worklet: la frecuencia real
    // del contexto, no una suposición.
    this.razon = sampleRate / destino
    this.posicion = 0
    this.salida = new Float32Array(this.muestrasBloque)
    this.escritos = 0

    this.port.postMessage({ tipo: 'listo', entrada: sampleRate, salida: destino })
  }

  /**
   * Remuestreo lineal. Suficiente para voz a 16 kHz: el contenido por encima
   * de 8 kHz no aporta a la transcripción, y un filtro de mejor calidad
   * costaría CPU en el hilo de audio, que es justo donde no sobra.
   */
  process (entradas) {
    const canal = entradas[0]?.[0]
    if (!canal || !canal.length) return true

    while (this.posicion < canal.length) {
      const i = Math.floor(this.posicion)
      const frac = this.posicion - i
      const a = canal[i]
      const b = i + 1 < canal.length ? canal[i + 1] : a
      this.salida[this.escritos++] = a + (b - a) * frac

      if (this.escritos >= this.muestrasBloque) {
        // Se transfiere el buffer en vez de copiarlo: a 10 bloques por segundo
        // durante una reunión de 90 minutos, copiar sí se nota.
        const bloque = this.salida
        this.port.postMessage({ tipo: 'audio', muestras: bloque }, [bloque.buffer])
        this.salida = new Float32Array(this.muestrasBloque)
        this.escritos = 0
      }
      this.posicion += this.razon
    }
    this.posicion -= canal.length
    return true
  }
}

registerProcessor('captura', CapturaProcessor)
