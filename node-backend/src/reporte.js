/**
 * reporte.js
 * Construye el informe de diagnóstico que el cliente devuelve.
 *
 * Vive aquí y no en el renderer por dos motivos: en el renderer no se puede
 * probar —no hay `require` con `contextIsolation`— y este texto es lo único
 * que vamos a ver de sus equipos. Si sale mal, nos quedamos sin datos y sin
 * enterarnos.
 *
 * La regla que gobierna el formato: **distinguir lo medido de lo que no se
 * pudo comprobar.** Un informe que dice "audio: correcto" cuando en realidad
 * no se probó es peor que uno que no dice nada, porque nos haría construir
 * sobre una certeza falsa.
 */

'use strict'

/**
 * @param {object} datos
 * @param {object} datos.plataforma  { plataforma, electron, loopbackSoportado }
 * @param {object} datos.audio       resultado de la comprobación de audio
 * @param {object} datos.backend     { perfil, admision, motivoOmision, error }
 * @returns {string}
 */
function construir ({ plataforma, audio, backend, entradas }) {
  const L = []
  const p = backend?.perfil

  L.push('DIAGNÓSTICO — Traductor Italiano')
  L.push('='.repeat(46))
  L.push(`Fecha: ${new Date().toISOString()}`)
  L.push(`Sistema: ${plataforma?.plataforma || '?'} · Electron ${plataforma?.electron || '?'}`)
  L.push('')

  // ── Equipo ──────────────────────────────────────────────────────────────
  L.push('EQUIPO')
  if (p) {
    L.push(`  ${p.cpu.modelo}`)
    const nucleos = p.cpu.nucleosFisicos || p.cpu.nucleosLogicos
    L.push(`  ${nucleos} núcleos${p.cpu.hibrida ? ' (híbrida)' : ''} · ${p.memoria.totalGB} GB`)
    if (p.cpu.hibrida) {
      // Se dice que no se sabe, en vez de dar un número inventado.
      L.push('  No se puede contar cuántos son rápidos: requiere un componente nativo')
    }
    if (p.gpu?.nombre) L.push(`  GPU: ${p.gpu.nombre}${p.gpu.vram ? ' · ' + p.gpu.vram : ''}`)
    L.push(`  Energía: ${p.energia?.fuente || 'desconocida'}`)
  } else {
    L.push('  NO MEDIDO')
  }
  L.push('')

  // ── Audio ───────────────────────────────────────────────────────────────
  L.push('AUDIO')
  if (!audio) {
    L.push('  NO MEDIDO')
  } else if (!audio.concluyente) {
    L.push(`  NO CONCLUYENTE — ${audio.motivo}`)
    L.push('  Esta comprobación solo vale ejecutada en Windows.')
  } else if (audio.ok) {
    L.push(`  Correcto: reproduje un tono y lo capté (fondo ${audio.fondo} → ${audio.conTono})`)
    L.push(`  Frecuencia de muestreo: ${audio.sampleRate} Hz`)
  } else {
    L.push(`  FALLÓ — ${audio.motivo}`)
    L.push('  Habría que usar el selector de dispositivo de entrada.')
  }

  // ── Dispositivos de entrada: el plan C del audio ────────────────────────
  if (entradas) {
    L.push('DISPOSITIVOS DE ENTRADA')
    if (entradas.error) {
      L.push(`  NO SE PUDIERON LEER — ${entradas.error}`)
    } else if (entradas.permisoDudoso) {
      // enumerateDevices devuelve entradas sin etiqueta cuando el permiso de
      // micrófono de Windows está desactivado. No es que no haya dispositivos.
      L.push(`  ${entradas.total} dispositivos, todos SIN NOMBRE`)
      L.push('  Probablemente el permiso de micrófono de Windows está desactivado:')
      L.push('  Configuración > Privacidad > Micrófono > permitir a apps de escritorio')
    } else {
      L.push(`  ${entradas.total} dispositivos`)
      for (const e of entradas.etiquetas.slice(0, 8)) L.push(`    · ${e}`)
      L.push(entradas.mezclaEstereo
        ? `  MEZCLA ESTÉREO DISPONIBLE: ${entradas.mezclaEstereo}`
        : '  Sin Mezcla estéreo: el plan C del audio no está disponible en este equipo')
    }
    L.push('')
  }

  // ── Rendimiento ─────────────────────────────────────────────────────────
  L.push('RENDIMIENTO')
  const a = backend?.admision
  if (a?.ok) {
    L.push(`  ${a.consecuencia}`)
    if (a.accion) L.push(`  → ${a.accion}`)
    L.push(`  Veredicto: ${a.veredicto}`)
    L.push(`  transcripción  p50 ${a.medidas.whisper.p50} ms · p95 ${a.medidas.whisper.p95} ms`)
    L.push(`  traducción     p50 ${a.medidas.marian.p50} ms · p95 ${a.medidas.marian.p95} ms`)
    L.push(`  ${a.medidas.vecesTiempoReal}× tiempo real · ${a.condiciones.hilosWhisper} hilos`)
    if (backend.infoSistema) {
      L.push(`  Instrucciones de CPU: ${backend.infoSistema.nivel}`)
      if (backend.infoSistema.sospechoso) {
        L.push('  AVISO: cayó a una variante para CPUs antiguas. Revisar el empaquetado:')
        L.push('  las nueve DLL ggml-cpu-* tienen que estar junto a ggml-base.dll')
      }
    }
    if (a.condiciones.avisoSostenida) L.push(`  AVISO: ${a.condiciones.avisoSostenida}`)
    if (a.condiciones.avisoEnergia) L.push(`  AVISO: ${a.condiciones.avisoEnergia}`)
  } else {
    L.push(`  NO MEDIDO — ${backend?.motivoOmision || backend?.error || 'razón desconocida'}`)
  }
  L.push('')

  // ── Qué falta por saber ─────────────────────────────────────────────────
  const pendientes = []
  if (!audio?.concluyente) pendientes.push('si el loopback capta el audio de una videollamada real')
  if (plataforma?.plataforma !== 'win32') pendientes.push('si existe Mezcla estéreo como respaldo')
  if (a?.ok && !a.condiciones.sostenida) pendientes.push('cómo aguanta tras varios minutos, con la máquina caliente')
  if (entradas && !entradas.error && !entradas.mezclaEstereo && !entradas.permisoDudoso) {
    pendientes.push('si el loopback aguanta con una videollamada real, ya que no hay Mezcla estéreo de respaldo')
  }
  if (pendientes.length) {
    L.push('LO QUE ESTE INFORME NO DICE')
    for (const x of pendientes) L.push(`  · ${x}`)
    L.push('')
  }

  return L.join('\n')
}

/** ¿El diagnóstico salió bien en conjunto? */
function veredictoGlobal ({ audio, backend }) {
  const rendimientoOk = backend?.admision?.ok === true
  // Si el audio no es concluyente no se cuenta como fallo: no se probó.
  const audioMal = audio?.concluyente === true && audio.ok === false
  return rendimientoOk && !audioMal
}

module.exports = { construir, veredictoGlobal }
