/**
 * contexto.js
 * Perfil de quien escucha y contexto de la reunión.
 *
 * Son dos entidades separadas a propósito: **el perfil cambia casi nunca** —
 * nombre, edad, ocupación— y **el contexto cambia en cada llamada** — tipo de
 * reunión, proyecto, glosario. Meterlos en una sola cosa obligaría a reescribir
 * los datos personales antes de cada junta.
 *
 * La pieza central es `buildContextBlock()`: **un solo constructor** que produce
 * el bloque que alimenta los cuatro prompts. Si cada prompt armara su propio
 * contexto, se desincronizarían a la segunda semana.
 *
 * Dos topes que no son decorativos, y vienen de la auditoría de costes:
 *
 *  - **El `--prompt` de Whisper tiene presupuesto.** Son unos 224 tokens de
 *    *initial prompt*; si se pasa, whisper lo trunca **en silencio** o desplaza
 *    contexto útil. Así que el glosario se recorta explícitamente y se dice
 *    cuánto se dejó fuera.
 *  - **El contexto del LLM también.** El escáner de preguntas corre cada 40 s;
 *    si el usuario pega 3.000 palabras de contexto, el coste por hora se
 *    multiplica por diez y el cálculo de 5,50 $/mes deja de valer.
 */

'use strict'

const db = require('./db')

/**
 * Tope del glosario que va a whisper. ~224 tokens de initial prompt, y en
 * italiano/español un token ronda 4 caracteres: dejamos margen.
 */
const MAX_GLOSARIO_CHARS = 600

/** Tope del bloque de contexto que va al LLM, en caracteres. */
const MAX_BLOQUE_CHARS = 1200

// ── Perfiles ────────────────────────────────────────────────────────────────

function crearPerfil ({ nombre, edad, ocupacion, contexto }) {
  if (!nombre?.trim()) throw new Error('el perfil necesita un nombre')
  const id = db.run(
    'INSERT INTO profiles (nombre, edad, ocupacion, contexto, activo, creado_en) VALUES (?, ?, ?, ?, 0, ?)',
    [nombre.trim(), edad ?? null, ocupacion ?? null, contexto ?? null, new Date().toISOString()]
  )
  db.persistAgrupado()
  return id
}

function actualizarPerfil (id, campos) {
  const permitidos = ['nombre', 'edad', 'ocupacion', 'contexto']
  const sets = [], vals = []
  for (const k of permitidos) {
    if (k in campos) { sets.push(`${k} = ?`); vals.push(campos[k]) }
  }
  if (!sets.length) return false
  db.run(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`, [...vals, id])
  db.persistAgrupado()
  return true
}

function borrarPerfil (id) {
  db.run('DELETE FROM profiles WHERE id = ?', [id])
  db.persistAgrupado()
}

function listarPerfiles () {
  return db.all('SELECT * FROM profiles ORDER BY activo DESC, nombre')
}

/** Activa uno y desactiva el resto: solo puede haber un perfil activo. */
function activarPerfil (id) {
  db.run('UPDATE profiles SET activo = 0')
  db.run('UPDATE profiles SET activo = 1 WHERE id = ?', [id])
  db.persistAgrupado()
}

function perfilActivo () {
  return db.get('SELECT * FROM profiles WHERE activo = 1')
}

// ── Contextos de proyecto ───────────────────────────────────────────────────

function crearContexto ({ nombre, tipo_reunion, tipo_proyecto, contexto, glosario }) {
  if (!nombre?.trim()) throw new Error('el contexto necesita un nombre')
  const id = db.run(
    `INSERT INTO project_contexts
       (nombre, tipo_reunion, tipo_proyecto, contexto, glosario, activo, actualizado_en)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [nombre.trim(), tipo_reunion ?? null, tipo_proyecto ?? null,
     contexto ?? null, glosario ?? null, new Date().toISOString()]
  )
  db.persistAgrupado()
  return id
}

function actualizarContexto (id, campos) {
  const permitidos = ['nombre', 'tipo_reunion', 'tipo_proyecto', 'contexto', 'glosario']
  const sets = [], vals = []
  for (const k of permitidos) {
    if (k in campos) { sets.push(`${k} = ?`); vals.push(campos[k]) }
  }
  if (!sets.length) return false
  sets.push('actualizado_en = ?'); vals.push(new Date().toISOString())
  db.run(`UPDATE project_contexts SET ${sets.join(', ')} WHERE id = ?`, [...vals, id])
  db.persistAgrupado()
  return true
}

function borrarContexto (id) {
  db.run('DELETE FROM project_contexts WHERE id = ?', [id])
  db.persistAgrupado()
}

function listarContextos () {
  return db.all('SELECT * FROM project_contexts ORDER BY activo DESC, actualizado_en DESC')
}

function activarContexto (id) {
  db.run('UPDATE project_contexts SET activo = 0')
  db.run('UPDATE project_contexts SET activo = 1 WHERE id = ?', [id])
  db.persistAgrupado()
}

function contextoActivo () {
  return db.get('SELECT * FROM project_contexts WHERE activo = 1')
}

// ── El bloque que alimenta los prompts ──────────────────────────────────────

/** Recorta por palabras, nunca a mitad de una, y dice si recortó. */
function recortar (texto, maxChars) {
  const t = (texto || '').trim()
  if (t.length <= maxChars) return { texto: t, recortado: false }
  const corte = t.slice(0, maxChars)
  const ultimoEspacio = corte.lastIndexOf(' ')
  return {
    texto: (ultimoEspacio > maxChars * 0.6 ? corte.slice(0, ultimoEspacio) : corte).trim(),
    recortado: true,
  }
}

/**
 * Construye el bloque de contexto para los prompts del LLM.
 *
 * Es **el único** sitio donde se arma. Los cuatro prompts —refinado de
 * traducción, escáner de preguntas, redacción de respuesta y resumen— lo
 * reciben ya hecho.
 *
 * @param {object} [opts]
 * @param {object} [opts.perfil]    por defecto, el activo
 * @param {object} [opts.contexto]  por defecto, el activo
 * @returns {{ bloque: string, recortado: boolean, vacio: boolean }}
 */
function buildContextBlock ({ perfil, contexto } = {}) {
  const p = perfil !== undefined ? perfil : perfilActivo()
  const c = contexto !== undefined ? contexto : contextoActivo()

  const partes = []

  if (p) {
    const linea = [p.nombre, p.edad ? `${p.edad} años` : null, p.ocupacion]
      .filter(Boolean).join(' · ')
    partes.push('PERFIL DE QUIEN ESCUCHA')
    if (linea) partes.push(linea)
    if (p.contexto) partes.push(p.contexto.trim())
  }

  if (c) {
    if (partes.length) partes.push('')
    partes.push('REUNIÓN ACTUAL')
    if (c.tipo_reunion) partes.push(`Tipo: ${c.tipo_reunion}`)
    if (c.tipo_proyecto) partes.push(`Proyecto: ${c.tipo_proyecto}`)
    if (c.contexto) partes.push(c.contexto.trim())
    const g = glosarioParaLlm(c)
    if (g) partes.push(`Términos: ${g}`)
  }

  const crudo = partes.join('\n')
  const { texto, recortado } = recortar(crudo, MAX_BLOQUE_CHARS)
  return { bloque: texto, recortado, vacio: texto.length === 0 }
}

/** El glosario tal cual, normalizado, para el bloque del LLM. */
function glosarioParaLlm (c) {
  return (c?.glosario || '')
    .split(/[,\n·;]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .join(', ')
}

/**
 * El glosario para el `--prompt` de whisper.
 *
 * Whisper usa el initial prompt como sesgo léxico: los nombres propios y siglas
 * que aparezcan ahí se transcriben mucho mejor. Pero el presupuesto es de unos
 * 224 tokens, y pasarse hace que **trunque en silencio**, así que aquí se
 * recorta de forma explícita y se informa de cuántos términos se dejaron fuera.
 *
 * @returns {{ prompt: string, incluidos: number, omitidos: number }}
 */
function promptParaWhisper ({ contexto } = {}) {
  const c = contexto !== undefined ? contexto : contextoActivo()
  const terminos = (c?.glosario || '')
    .split(/[,\n·;]+/)
    .map(x => x.trim())
    .filter(Boolean)

  if (!terminos.length) return { prompt: '', incluidos: 0, omitidos: 0 }

  const incluidos = []
  let largo = 0
  for (const t of terminos) {
    const coste = t.length + 2                    // el término más ", "
    if (largo + coste > MAX_GLOSARIO_CHARS) break
    incluidos.push(t)
    largo += coste
  }

  return {
    prompt: incluidos.join(', ') + '.',
    incluidos: incluidos.length,
    omitidos: terminos.length - incluidos.length,
  }
}

// ── Export e import entre equipos ───────────────────────────────────────────

/**
 * Exporta perfiles y contextos para llevarlos al otro equipo.
 *
 * **Nunca incluye API keys.** Están cifradas con DPAPI, que ata el cifrado al
 * usuario Y a la máquina, así que no se podrían descifrar en el destino — y
 * meterlas en claro para sortearlo sería regalar las credenciales del cliente
 * en un archivo que viaja por correo.
 */
function exportar () {
  return {
    version: 1,
    exportadoEn: new Date().toISOString(),
    nota: 'No incluye API keys: van cifradas por máquina y hay que volver a pegarlas.',
    perfiles: listarPerfiles().map(({ id, activo, creado_en, ...resto }) => resto),
    contextos: listarContextos().map(({ id, activo, actualizado_en, ...resto }) => resto),
  }
}

/** Importa sin borrar lo que ya había. Devuelve cuántos entraron. */
function importar (datos) {
  if (!datos || datos.version !== 1) throw new Error('formato de importación no reconocido')
  let perfiles = 0, contextos = 0
  for (const p of datos.perfiles || []) { crearPerfil(p); perfiles++ }
  for (const c of datos.contextos || []) { crearContexto(c); contextos++ }
  db.vaciar()
  return { perfiles, contextos }
}

module.exports = {
  crearPerfil, actualizarPerfil, borrarPerfil, listarPerfiles, activarPerfil, perfilActivo,
  crearContexto, actualizarContexto, borrarContexto, listarContextos, activarContexto, contextoActivo,
  buildContextBlock, promptParaWhisper,
  exportar, importar,
  MAX_GLOSARIO_CHARS, MAX_BLOQUE_CHARS,
}
module.exports._internos = { recortar, glosarioParaLlm }
