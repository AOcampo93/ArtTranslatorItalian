/**
 * coste.js
 * Duración, latencia y coste estimado de una reunión guardada (F038).
 *
 * Todo sale de las entradas de un `.jsonl` (`Autosave.leer`), que es la
 * fuente fiable (§0.3): la tabla `sessions` de `db.js` no guarda transcripción
 * ni preguntas —`db.js` lo dice en su propio comentario, «las transcripciones
 * no pasan por aquí»— así que no hay nada que leer de ahí para estas cifras.
 *
 * Cada número dice de dónde sale, porque `CLAUDE.md` §5 lo exige y porque un
 * coste sin procedencia es indistinguible de uno inventado.
 */

'use strict'

/**
 * $/hora de AssemblyAI Universal (`universal-3-5-pro`, el modelo que usa
 * `empezarSesion`): el tier Pro cubre inglés y multilingüe sin recargo.
 * `[verificado]` — `PLAN.md` §10 «Instalación, claves y coste visible», línea
 * 1213 a día de hoy.
 */
const TARIFA_STT_USD_HORA = 0.45

/**
 * Precio de lista público de cada modelo por defecto de `llm.js`, en
 * $ por millón de tokens. `[estimado]`: son los precios publicados por cada
 * proveedor a 19-09-2026, nunca contrastados contra un cargo real de la
 * cuenta del cliente —a diferencia del STT de arriba, aquí no hay factura que
 * lo confirme—, así que aunque los tokens de una llamada sean reales
 * (`[medido]`, cuando el proveedor los devuelve) el coste en dólares sigue
 * siendo `[estimado]` porque la tarifa lo es.
 */
const TARIFA_LLM_USD_POR_MILLON = {
  'claude-haiku-4-5-20251001': { entrada: 0.80, salida: 4.00 },
  'gpt-4o-mini': { entrada: 0.15, salida: 0.60 },
  'gemini-3.5-flash-lite': { entrada: 0.10, salida: 0.40 },
}

/** Tarifa a usar cuando no se conoce el modelo exacto de una llamada vieja. `[estimado]` */
const TARIFA_LLM_GENERICA = { entrada: 0.35, salida: 1.65 }

/** El percentil `p` (0-100) de una lista de números; `null` si no hay ninguno válido. */
function percentil (valores, p) {
  const v = (valores || []).filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))
  return v[idx]
}

/**
 * Duración de la reunión: desde la marca `t` más antigua hasta la más nueva.
 * No la hora del sistema al abrir/cerrar el archivo, porque `escribir()`
 * reabre el `.jsonl` si hace falta (§0.3) y lo que importa es lo que se dijo,
 * no cuánto estuvo el descriptor abierto.
 */
function duracionMs (entradas) {
  const tiempos = (entradas || []).map(e => new Date(e?.t).getTime()).filter(Number.isFinite)
  if (tiempos.length < 2) return 0
  return Math.max(0, Math.max(...tiempos) - Math.min(...tiempos))
}

/** Coste del STT: tarifa verificada × duración medida. */
function costeStt (msDuracion) {
  const horas = (msDuracion || 0) / 3_600_000
  return { usd: horas * TARIFA_STT_USD_HORA, procedencia: 'tarifa verificada, duración medida' }
}

/**
 * Coste del LLM de esta reunión, a partir de las líneas `respuestaLlm`
 * (F038, `mainApp.js` las escribe cuando `MotorRespuestas` emite `respuesta`).
 *
 * Por llamada: si trae `tokensEntrada`/`tokensSalida` (el proveedor los
 * devolvió), se usan tal cual `[medido]`. Si no, se estima con
 * caracteres/4 sobre la pregunta y la respuesta guardadas `[estimado]` — una
 * cota BAJA, porque el prompt real lleva además el contexto de la reunión,
 * que no se guarda entero en el `.jsonl`.
 */
function costeLlm (entradas) {
  const llamadas = (entradas || []).filter(e => e && e.tipo === 'respuestaLlm')
  if (!llamadas.length) return { usd: 0, procedencia: 'sin llamadas al LLM en esta reunión', tokensMedidos: false }

  let usd = 0
  let algunoMedido = false
  for (const l of llamadas) {
    const tarifa = TARIFA_LLM_USD_POR_MILLON[l.modelo] || TARIFA_LLM_GENERICA
    let entrada = l.tokensEntrada
    let salida = l.tokensSalida
    if (Number.isFinite(entrada) && Number.isFinite(salida)) {
      algunoMedido = true
    } else {
      entrada = Math.ceil((l.it || '').length / 4)
      salida = Math.ceil((l.texto || '').length / 4)
    }
    usd += (entrada / 1_000_000) * tarifa.entrada + (salida / 1_000_000) * tarifa.salida
  }
  return {
    usd,
    procedencia: algunoMedido
      ? 'tokens medidos; tarifa de lista sin contrastar contra factura'
      : 'tokens estimados por caracteres/4; tarifa de lista sin contrastar contra factura',
    tokensMedidos: algunoMedido,
  }
}

module.exports = {
  TARIFA_STT_USD_HORA, TARIFA_LLM_USD_POR_MILLON, TARIFA_LLM_GENERICA,
  percentil, duracionMs, costeStt, costeLlm,
}
