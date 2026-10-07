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

// ── Términos clave para la transcripción (F048) ─────────────────────────────

/**
 * Los límites de `keyterms_prompt` de AssemblyAI `[verificado en
 * assemblyai.com/docs/streaming/prompting-and-keyterms, 07-10-2026]`: 100
 * términos por sesión y 50 caracteres como mucho cada uno. Con más de 100 la
 * solicitud da error; un término de más de 50 se ignora sin avisar.
 */
const MAX_KEYTERMS = 100
const MAX_CARACTERES_KEYTERM = 50

/**
 * Palabras cortas que pueden ir DENTRO de un nombre: «Università di Bologna»,
 * «Bank of America». Solo en minúscula: «De Luca» o «The Hague» empiezan por
 * una palabra con mayúscula como cualquier otra.
 */
const CONECTORES = new Set(['de', 'del', 'di', 'della', 'da', 'of', 'the'])

/** Lo que cierra una oración, con las comillas y paréntesis que pueden ir detrás. */
const RE_CIERRA_ORACION = /[.!?…]["'”»’)\]]*$/
/** Lo que corta una secuencia en medio: «Nacional, trabajo», «(IPN)», «“Rossi”». */
const RE_ABRE_CORTE = /^[("«“\[¿¡]/
const RE_CIERRA_CORTE = /[,;:.!?…)"»”\]]$/

/**
 * 'sigla' (SAP, ACME), 'capitalizada' (Cumbres), 'conector' (del) u 'otra'.
 * Una sola letra no es nada: «A», «E» y las iniciales no hacen un nombre.
 */
function clasificar (palabra) {
  if (CONECTORES.has(palabra)) return 'conector'
  const letras = palabra.match(/\p{L}/gu) || []
  if (letras.length < 2) return 'otra'
  if (!/\p{Ll}/u.test(palabra)) {
    return letras.filter(l => /\p{Lu}/u.test(l)).length >= 2 ? 'sigla' : 'otra'
  }
  return /^\p{Lu}/u.test(palabra) ? 'capitalizada' : 'otra'
}

/** Las palabras de una línea, con lo que hace falta saber de cada una para agruparlas. */
function palabrasDe (linea) {
  const palabras = []
  let inicioOracion = true
  for (const crudo of linea.split(/\s+/)) {
    if (!crudo) continue
    const limpia = crudo.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    palabras.push({
      limpia,
      tipo: limpia ? clasificar(limpia) : 'otra',
      abre: RE_ABRE_CORTE.test(crudo),
      cierra: RE_CIERRA_CORTE.test(crudo),
      inicioOracion,
    })
    inicioOracion = RE_CIERRA_ORACION.test(crudo)
  }
  return palabras
}

/**
 * Los nombres propios de unos textos: secuencias de palabras con mayúscula o
 * siglas en mayúsculas («Monica Belluci», «ACME NORTE»), en el orden en que
 * aparecen y sin quitar repetidos. Función pura.
 *
 * Es una heurística de mayúsculas, sin diccionario, y por eso vale para
 * cualquier idioma. Sus reglas, por el error que evita cada una:
 *
 *  - Una palabra con mayúscula a principio de oración solo cuenta si la sigue
 *    otra con mayúscula («Analista egresada…» no es un nombre; «Monica Belluci
 *    es…» sí). Ni siquiera un conector la salva: «Analista de México» deja
 *    «México», no la frase entera.
 *  - Un conector (de, del, di, della, da, of, the) une dos tramos solo si lo que
 *    le sigue es UNA palabra con mayúscula: «Universidad Nacional Autónoma de
 *    México», «Bank of America». Delante de dos o más empieza otro nombre: «ZETA
 *    Cumbres del Instituto Tecnologico Andino» son dos, y unidos serían un
 *    término demasiado largo para ayudar a nadie.
 *  - Una coma, un paréntesis o unas comillas cortan la secuencia.
 *
 * @param {Array<string>|string} textos  los campos de donde sacar nombres
 * @returns {string[]}
 */
function nombresPropios (textos) {
  const nombres = []
  for (const texto of [].concat(textos ?? [])) {
    if (typeof texto !== 'string') continue
    for (const linea of texto.split(/\n+/)) {
      const palabras = palabrasDe(linea)
      const n = palabras.length
      const esNombre = p => p.tipo === 'sigla' || p.tipo === 'capitalizada'
      // `k` va pegada a la anterior, sin coma ni paréntesis entre las dos.
      const junto = k => !palabras[k - 1].cierra && !palabras[k].abre

      let i = 0
      while (i < n) {
        if (!esNombre(palabras[i])) { i++; continue }
        let j = i + 1
        while (j < n && esNombre(palabras[j]) && junto(j)) j++
        if (j - i === 1 && palabras[i].inicioOracion && palabras[i].tipo === 'capitalizada') {
          i = j
          continue
        }

        const partes = palabras.slice(i, j).map(p => p.limpia)
        for (;;) {
          let k = j
          while (k < n && palabras[k].tipo === 'conector' && junto(k)) k++   // «of the»
          if (k === j || k >= n || !esNombre(palabras[k]) || !junto(k)) break
          let m = k + 1
          while (m < n && esNombre(palabras[m]) && junto(m)) m++
          if (m - k !== 1) break
          partes.push(...palabras.slice(j, m).map(p => p.limpia))
          j = m
        }
        nombres.push(partes.join(' '))
        i = j
      }
    }
  }
  return nombres
}

/**
 * La lista que se manda a AssemblyAI como `keyterms_prompt`: el glosario manual
 * del contexto primero —es lo que el usuario escribió y manda—, y después los
 * nombres propios del nombre, el tipo de proyecto y la descripción del contexto
 * y del nombre y la descripción del perfil. Hasta F048 el glosario venía vacío
 * en las cinco sesiones medidas, y «Tornatore» salió de cuatro maneras (PLAN.md
 * §17.4, fila 2 `[medido]`).
 *
 * Sin repetidos (ignorando mayúsculas: queda la primera grafía), cada término
 * con 50 caracteres como mucho y 100 en total. Si sobran, se pierden los
 * últimos, que son los automáticos.
 *
 * @param {object} [opts]
 * @param {object} [opts.perfil]    `nombre` y `contexto`
 * @param {object} [opts.contexto]  `nombre`, `tipo_proyecto`, `contexto` y `glosario`
 * @returns {string[]}
 */
function construirKeyterms ({ perfil, contexto } = {}) {
  const manual = String(contexto?.glosario || '').split(/[,\n·;]+/)
  const automaticos = nombresPropios([
    contexto?.nombre, contexto?.tipo_proyecto, contexto?.contexto, perfil?.nombre, perfil?.contexto,
  ])

  const vistos = new Set()
  const terminos = []
  for (const crudo of [...manual, ...automaticos]) {
    const termino = recortar(crudo.replace(/\s+/g, ' '), MAX_CARACTERES_KEYTERM).texto
    const clave = termino.toLowerCase()
    if (!termino || vistos.has(clave)) continue
    vistos.add(clave)
    terminos.push(termino)
    if (terminos.length === MAX_KEYTERMS) break
  }
  return terminos
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
  buildContextBlock, promptParaWhisper, construirKeyterms, nombresPropios,
  exportar, importar,
  MAX_GLOSARIO_CHARS, MAX_BLOQUE_CHARS, MAX_KEYTERMS, MAX_CARACTERES_KEYTERM,
}
module.exports._internos = { recortar, glosarioParaLlm }
