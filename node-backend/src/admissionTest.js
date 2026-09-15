/**
 * admissionTest.js
 * Mide la máquina y dictamina en qué modo debe funcionar la app.
 *
 * Resuelve la tensión "si tu equipo no da la latencia, vete a la nube" **sin
 * preguntarle al usuario**, que es la prioridad nº 1 del proyecto. Se mide y se
 * decide; él solo ve el veredicto.
 *
 * Por qué mide en vez de predecir: el nombre de la CPU no determina el
 * resultado. No contiene el límite de potencia, el canal de memoria, la
 * topología híbrida, el estado térmico, ni —lo que más pesa— la carga
 * competidora, que aquí es siempre una videollamada. Dos equipos con el mismo
 * procesador pueden rendir el doble uno que otro.
 *
 * Qué se le enseña al usuario, y en este orden (PLAN.md §5):
 *   1. La consecuencia en segundos. Es lo único que experimenta.
 *   2. Un veredicto de tres estados, con su acción.
 *   3. Las condiciones de la medición, plegadas.
 *
 * Lo que NO se le enseña: un porcentaje. "80% de rendimiento" no significa
 * nada sin una escala, e invita a la pregunta que no tiene respuesta honesta:
 * ¿80% de qué?
 */

'use strict'

const { Pipeline, SAMPLE_RATE } = require('./pipeline')

/**
 * Duración de frase típica en reunión, para traducir la medida a consecuencia.
 *
 * **Este número no está medido `[por medir]`, y el veredicto es extremadamente
 * sensible a él.** Conviene saberlo antes de darle peso a un veredicto:
 *
 * Con los números reales del HP Pavilion i5-10210U:
 *
 * | frase supuesta | a 6 hilos      | a 3 hilos                   |
 * |---------------:|----------------|-----------------------------|
 * |          4,0 s | justo          | **no-llega** → nube de pago |
 * |          3,2 s | sobrado        | justo → local, gratis       |
 * |          3,0 s | sobrado        | justo → local, gratis       |
 *
 * O sea que el mismo equipo, con la misma medición, pasa de "local gratis" a
 * "0,15 USD la hora" solo por cambiar este supuesto entre 3 y 4 segundos. Es
 * la constante más cara del proyecto y la única que nadie comprobó.
 *
 * El audio de prueba dura 6,5 s y contiene dos frases, o sea unos 3,2 s por
 * frase — pero es voz sintética de una muestra, no una reunión real, así que
 * tampoco sirve para fijar el valor. Se mantiene 4 s por ser el supuesto
 * conservador (empuja al veredicto pesimista, no al optimista) y el informe
 * dice de qué depende. Lo que lo resolvería: la mediana de `segundosAudio` de
 * los eventos 'frase' de una reunión real, que el pipeline ya emite. Ver §15.
 */
const FRASE_TIPICA_S = 4

/**
 * Duraciones alternativas con las que se recalcula el veredicto, para que el
 * informe pueda decir si la conclusión aguanta o depende del supuesto.
 */
const FRASES_ALTERNATIVAS_S = [3, 5]

/** Umbrales sobre la latencia estimada de una frase típica. */
const UMBRAL_COMODO_MS = 1500
const UMBRAL_JUSTO_MS = 3000

/**
 * Una medición corta NO detecta el throttling térmico: las frecuencias caen
 * pasados los primeros minutos, y en un portátil eso cambia el veredicto. Por
 * debajo de esto, el informe lo dice en vez de callarlo.
 */
const SEGUNDOS_PARA_SOSTENIDO = 180

function percentil (valores, p) {
  if (!valores.length) return null
  const orden = [...valores].sort((a, b) => a - b)
  const i = Math.min(orden.length - 1, Math.ceil(p / 100 * orden.length) - 1)
  return orden[Math.max(0, i)]
}

/** Lee las muestras de un WAV PCM16, buscando el chunk 'data' de verdad. */
function muestrasDeWav (buf) {
  let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      const n = Math.floor(size / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768
      return out
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('WAV sin chunk data')
}

/**
 * Ejecuta el test.
 *
 * @param {object} deps
 * @param {object} deps.transcriber  ya arrancado
 * @param {object} deps.translator   ya cargado
 * @param {Buffer} deps.wavItaliano  muestra embebida
 * @param {object} [deps.perfil]     salida de hardware.perfilar()
 * @param {object} [opts]
 * @param {number} [opts.rondas]     pasadas a medir
 * @param {Function} [opts.onProgreso]
 */
async function ejecutar ({ transcriber, translator, wavItaliano, perfil }, opts = {}) {
  const rondas = opts.rondas ?? 3
  const muestras = muestrasDeWav(wavItaliano)
  const segundosAudio = muestras.length / SAMPLE_RATE

  const whisper = []
  const marian = []
  const total = []
  const t0 = Date.now()

  for (let r = 0; r < rondas; r++) {
    const p = new Pipeline({ transcriber, translator })
    const frases = []
    p.on('frase', f => frases.push(f))
    p.start()

    // Alimentamos en trozos de 100 ms, como hará la captura real, y cerramos
    // con silencio para que el VAD corte la última frase.
    const trozo = Math.floor(SAMPLE_RATE * 0.1)
    for (let i = 0; i < muestras.length; i += trozo) {
      p.alimentar(muestras.subarray(i, Math.min(i + trozo, muestras.length)))
    }
    p.alimentar(new Float32Array(Math.floor(SAMPLE_RATE * 0.9)))
    await p.stop()

    for (const f of frases) {
      whisper.push(f.msWhisper)
      marian.push(f.msMarian)
      total.push(f.msTotal)
    }
    opts.onProgreso?.({ ronda: r + 1, de: rondas })
  }

  const duracionS = (Date.now() - t0) / 1000

  if (!total.length) {
    return {
      ok: false,
      motivo: 'el pipeline no produjo ninguna frase con la muestra de prueba',
    }
  }

  // Factor de tiempo real: cuántos ms cuesta cada segundo de audio.
  const msPorSegundo = percentil(total, 95) / segundosAudio
  const latenciaFraseMs = Math.round(msPorSegundo * FRASE_TIPICA_S)

  const veredicto = clasificar(latenciaFraseMs)

  return {
    ok: true,
    veredicto,
    // Lo primero que ve el usuario: qué va a experimentar.
    consecuencia: frase(veredicto, latenciaFraseMs),
    accion: accion(veredicto),
    latenciaFraseMs,
    // La medida cruda, que no depende de ningún supuesto: cuántos ms cuesta
    // cada segundo de audio. Todo lo de arriba se deriva de esto multiplicado
    // por FRASE_TIPICA_S, que NO está medido.
    msPorSegundoAudio: Math.round(msPorSegundo),
    supuestoFraseS: FRASE_TIPICA_S,
    // Si el veredicto cambia al mover el supuesto, el informe tiene que
    // decirlo: es la diferencia entre "local gratis" y "0,15 USD la hora".
    sensibilidad: FRASES_ALTERNATIVAS_S.map(s => {
      const ms = Math.round(msPorSegundo * s)
      return { fraseS: s, latenciaFraseMs: ms, veredicto: clasificar(ms) }
    }),
    medidas: {
      segundosAudio: +segundosAudio.toFixed(2),
      muestras: total.length,
      whisper: { p50: percentil(whisper, 50), p95: percentil(whisper, 95) },
      marian: { p50: percentil(marian, 50), p95: percentil(marian, 95) },
      total: { p50: percentil(total, 50), p95: percentil(total, 95) },
      vecesTiempoReal: +(segundosAudio * 1000 / percentil(total, 95)).toFixed(1),
    },
    condiciones: {
      fecha: new Date().toISOString(),
      duracionPruebaS: +duracionS.toFixed(1),
      sostenida: duracionS >= SEGUNDOS_PARA_SOSTENIDO,
      avisoSostenida: duracionS < SEGUNDOS_PARA_SOSTENIDO
        ? 'medición corta: no detecta la caída de frecuencia por temperatura, que en portátil aparece pasados unos minutos'
        : null,
      hilosWhisper: transcriber.hilos ?? null,
      cpu: perfil?.cpu?.modelo ?? null,
      cpuHibrida: perfil?.cpu?.hibrida ?? null,
      energia: perfil?.energia?.fuente ?? null,
      avisoEnergia: perfil?.energia?.aBateria
        ? 'medido a batería: enchufado puede ir bastante más rápido, y al revés'
        : null,
      memoriaTotalGB: perfil?.memoria?.totalGB ?? null,
    // La libre se guarda para depurar, pero NO se enseña en el informe:
    // os.freemem() infravalora mucho la disponible real y un "0,1 GB libres"
    // alarmaría al cliente sin motivo.
    memoriaLibreGB: perfil?.memoria?.libreGB ?? null,
    },
  }
}

/** Un solo sitio donde viven los umbrales. */
function clasificar (ms) {
  return ms <= UMBRAL_COMODO_MS ? 'sobrado' : ms <= UMBRAL_JUSTO_MS ? 'justo' : 'no-llega'
}

/** La consecuencia en el idioma del usuario, que es lo único que percibe. */
function frase (veredicto, ms) {
  const seg = (ms / 1000).toFixed(1).replace('.', ',')
  if (veredicto === 'sobrado') {
    return `La traducción aparecerá alrededor de ${seg} segundos después de que hablen.`
  }
  if (veredicto === 'justo') {
    return `La traducción aparecerá alrededor de ${seg} segundos después de que hablen, `
         + 'y puede tardar más si tienes muchos programas abiertos.'
  }
  return `Tu equipo tardaría unos ${seg} segundos en traducir cada frase, que es demasiado `
       + 'para seguir una conversación.'
}

/** Qué hacer al respecto. Una acción, no una lista. */
function accion (veredicto) {
  if (veredicto === 'sobrado') return null
  if (veredicto === 'justo') return 'Cierra el navegador antes de reuniones largas.'
  return 'Se usará transcripción en la nube, con un coste aproximado de 0,15 USD por hora.'
}

/** Informe en texto plano, para que el cliente lo devuelva por correo. */
function informe (r, perfil) {
  if (!r.ok) return `TEST DE ADMISIÓN — FALLÓ\n${r.motivo}\n`

  const L = []
  L.push('TEST DE ADMISIÓN — ArtTranslator Italian')
  L.push('='.repeat(46))
  L.push('')
  L.push(r.consecuencia)
  if (r.accion) L.push(`→ ${r.accion}`)
  L.push('')
  L.push(`Veredicto: ${r.veredicto}`)
  L.push('')
  L.push('MEDIDAS')
  L.push(`  transcripción   p50 ${r.medidas.whisper.p50} ms · p95 ${r.medidas.whisper.p95} ms`)
  L.push(`  traducción      p50 ${r.medidas.marian.p50} ms · p95 ${r.medidas.marian.p95} ms`)
  L.push(`  total           p50 ${r.medidas.total.p50} ms · p95 ${r.medidas.total.p95} ms`)
  L.push(`  ${r.medidas.vecesTiempoReal}× tiempo real sobre ${r.medidas.segundosAudio} s de audio`)
  L.push('')
  L.push('CONDICIONES')
  L.push(`  ${r.condiciones.cpu || 'CPU desconocida'}${r.condiciones.cpuHibrida ? ' (híbrida)' : ''}`)
  L.push(`  ${r.condiciones.hilosWhisper ?? '?'} hilos · ${r.condiciones.energia || 'energía desconocida'}`)
  if (perfil?.gpu?.nombre) L.push(`  GPU: ${perfil.gpu.nombre}`)
  if (r.condiciones.memoriaTotalGB != null) L.push(`  ${r.condiciones.memoriaTotalGB} GB de memoria`)
  L.push(`  prueba de ${r.condiciones.duracionPruebaS} s`)
  if (r.condiciones.avisoSostenida) L.push(`  ⚠ ${r.condiciones.avisoSostenida}`)
  if (r.condiciones.avisoEnergia) L.push(`  ⚠ ${r.condiciones.avisoEnergia}`)
  L.push('')
  return L.join('\n')
}

module.exports = { ejecutar, informe, UMBRAL_COMODO_MS, UMBRAL_JUSTO_MS, FRASE_TIPICA_S }
module.exports._internos = { percentil, muestrasDeWav, frase, accion, clasificar, FRASES_ALTERNATIVAS_S }
