/**
 * db.js
 * SQLite persistence via sql.js (pure WebAssembly — no native compilation).
 * Database file: node-backend/data/artranslator.db
 *
 * Usage: call await db.init() once before any other method.
 *
 * Tables:
 *   sessions    — one row per recording session
 *   transcripts — one row per translated chunk
 *   questions   — one row per detected question (with generated responses)
 */

'use strict'

const path = require('path')
const fs   = require('fs')

// In packaged mode, write to userData (always writable, even when app is on DMG).
// main.js passes DB_DATA_DIR via env. Fall back to local data/ for dev.
const DATA_DIR = process.env.DB_DATA_DIR || path.join(__dirname, '..', 'data')
const DB_PATH  = path.join(DATA_DIR, 'artranslator.db')

let SQL  = null   // sql.js module
let db   = null   // Database instance

// ── Init ──────────────────────────────────────────────────────────────────
async function init () {
  if (db) return   // already initialised

  fs.mkdirSync(DATA_DIR, { recursive: true })

  SQL = await require('sql.js')()

  // Load existing DB from disk, or start fresh
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buf)
  } else {
    db = new SQL.Database()
  }

  db.run(`PRAGMA journal_mode = WAL;`)

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT    NOT NULL,
      ended_at    TEXT,
      duration_s  INTEGER,
      ai_model    TEXT,
      line_count  INTEGER DEFAULT 0,
      profile_id  INTEGER,
      context_id  INTEGER
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL,
      created_at  TEXT    NOT NULL,
      en          TEXT    NOT NULL,
      es          TEXT    NOT NULL DEFAULT '',
      intent      TEXT,
      is_question INTEGER NOT NULL DEFAULT 0,
      pos_tags    TEXT    NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS questions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL,
      created_at  TEXT    NOT NULL,
      question_en TEXT    NOT NULL,
      question_es TEXT    NOT NULL DEFAULT '',
      context     TEXT    NOT NULL DEFAULT '[]',
      responses   TEXT
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT    NOT NULL,
      edad       INTEGER,
      ocupacion  TEXT,
      contexto   TEXT,
      activo     INTEGER NOT NULL DEFAULT 0,
      creado_en  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_contexts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre         TEXT    NOT NULL,
      tipo_reunion   TEXT,
      tipo_proyecto  TEXT,
      contexto       TEXT,
      glosario       TEXT,
      activo         INTEGER NOT NULL DEFAULT 0,
      actualizado_en TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
    CREATE INDEX IF NOT EXISTS idx_questions_session   ON questions(session_id);
  `)

  // Migración de bases anteriores: ALTER TABLE falla si la columna ya está,
  // así que se intenta y se ignora el error. Es más simple que consultar el
  // esquema y no tiene efecto si ya está migrada.
  for (const col of ['profile_id INTEGER', 'context_id INTEGER']) {
    try { db.run(`ALTER TABLE sessions ADD COLUMN ${col}`) } catch { /* ya existe */ }
  }

  persist()
  console.log('[db] SQLite ready at', DB_PATH)
}

/**
 * Escribe la base a disco de forma ATÓMICA: primero a un temporal y luego
 * `rename`, que el sistema garantiza indivisible.
 *
 * Por qué importa: la versión anterior escribía directamente sobre el archivo
 * bueno. Si el proceso moría a media escritura, no se perdía la sesión — se
 * perdían **los perfiles y los contextos de proyecto**, que es justo lo
 * laborioso de volver a escribir.
 */
function persist () {
  if (!db) return
  const data = db.export()
  const tmp = DB_PATH + '.tmp'
  fs.writeFileSync(tmp, Buffer.from(data))
  fs.renameSync(tmp, DB_PATH)   // atómico: o está el viejo o está el nuevo
  _pendiente = false
}

// ── Agrupación de escrituras ────────────────────────────────────────────────
// La versión heredada llamaba a persist() en CADA inserción, y persist()
// serializa la base COMPLETA. Con 3.936 transcripciones en 1 MB, cada línea
// nueva reescribía 1 MB entero, de forma síncrona y en el mismo hilo del
// pipeline. Una reunión de 200 frases escribía ~200 MB para guardar 200 filas.
//
// Ahora las transcripciones no pasan por aquí (van al .jsonl de autosave.js) y
// lo que sí pasa —sesiones, perfiles, contextos— se agrupa.
let _pendiente = false
let _temporizador = null
const RETRASO_MS = 400

/** Marca que hay cambios y programa una escritura. */
function persistAgrupado () {
  if (!db) return
  _pendiente = true
  if (_temporizador) return
  _temporizador = setTimeout(() => {
    _temporizador = null
    if (_pendiente) persist()
  }, RETRASO_MS)
  _temporizador.unref?.()
}

/** Fuerza la escritura ya, si queda algo pendiente. Para el cierre limpio. */
function vaciar () {
  if (_temporizador) { clearTimeout(_temporizador); _temporizador = null }
  if (_pendiente) persist()
}

/** Run a statement and return lastInsertRowid */
function run (sql, params = []) {
  db.run(sql, params)
  // sql.js doesn't expose lastInsertRowid directly; query for it
  const [[id]] = db.exec('SELECT last_insert_rowid()')[0]?.values || [[null]]
  return Number(id)
}

/** Run a SELECT and return all rows as array of objects */
function all (sql, params = []) {
  const result = db.exec(sql, params)
  if (!result.length) return []
  const { columns, values } = result[0]
  return values.map(row =>
    Object.fromEntries(columns.map((col, i) => [col, row[i]]))
  )
}

/** Run a SELECT and return the first row as an object (or null) */
function get (sql, params = []) {
  const rows = all(sql, params)
  return rows[0] || null
}

// ── Public API ────────────────────────────────────────────────────────────

/** Create a new session row. Returns the new session id. */
function startSession (aiModel, { profileId = null, contextId = null } = {}) {
  const id = run(
    'INSERT INTO sessions (started_at, ai_model, profile_id, context_id) VALUES (?, ?, ?, ?)',
    [new Date().toISOString(), aiModel, profileId, contextId]
  )
  persist()
  return id
}

/** Mark a session as ended and record final stats. */
function endSession (sessionId, { durationSeconds, lineCount }) {
  run(
    'UPDATE sessions SET ended_at = ?, duration_s = ?, line_count = ? WHERE id = ?',
    [new Date().toISOString(), durationSeconds, lineCount, sessionId]
  )
  persistAgrupado()
}

/**
 * Persist one translated chunk.
 * @param {number} sessionId
 * @param {{ en, es, intent, is_question, pos_tags }} chunk
 */
/**
 * OBSOLETO. Las transcripciones ya no van a sql.js.
 *
 * Guardarlas aquí era el defecto heredado: cada frase reescribía la base
 * completa. Ahora van al `.jsonl` de `autosave.js`, que escribe en modo append
 * y no puede corromper lo anterior.
 *
 * Se mantiene la función para no romper a quien la llame, pero no escribe a
 * disco: solo avisa una vez.
 */
let _avisadoTranscript = false
function saveTranscript () {
  if (!_avisadoTranscript) {
    console.warn('[db] saveTranscript está obsoleto: las transcripciones van al autoguardado (.jsonl)')
    _avisadoTranscript = true
  }
}

/**
 * Persist a detected question (without responses yet).
 * Returns the new question id.
 */
function saveQuestion (sessionId, { question_en, question_es, context }) {
  const id = run(
    'INSERT INTO questions (session_id, created_at, question_en, question_es, context) VALUES (?, ?, ?, ?, ?)',
    [sessionId, new Date().toISOString(), question_en, question_es || '', JSON.stringify(context || [])]
  )
  persistAgrupado()
  return id
}

/** Attach AI-generated responses to a saved question. */
function updateQuestionResponses (questionId, responses) {
  run('UPDATE questions SET responses = ? WHERE id = ?', [JSON.stringify(responses), questionId])
  persistAgrupado()
}

/** Load a full session with all its transcripts and questions. */
function loadSession (sessionId) {
  const session = get('SELECT * FROM sessions WHERE id = ?', [sessionId])
  if (!session) return null

  const transcripts = all('SELECT * FROM transcripts WHERE session_id = ? ORDER BY id', [sessionId])
  const questions   = all('SELECT * FROM questions WHERE session_id = ? ORDER BY id', [sessionId])

  return {
    ...session,
    transcripts: transcripts.map(t => ({
      ...t,
      is_question: Boolean(t.is_question),
      pos_tags:    JSON.parse(t.pos_tags),
    })),
    questions: questions.map(q => ({
      ...q,
      context:   JSON.parse(q.context),
      responses: q.responses ? JSON.parse(q.responses) : null,
    })),
  }
}

/** List the N most recent sessions (metadata only, no transcripts). */
function recentSessions (limit = 20) {
  return all('SELECT * FROM sessions ORDER BY id DESC LIMIT ?', [limit])
}

/**
 * Borra la fila de `sessions` de una reunión (F038, «Borrar»).
 *
 * `transcripts`/`questions` ya no se rellenan (ver `saveTranscript`, arriba),
 * pero se limpian igual por si quedó algo de una versión anterior a este
 * cambio. El `.jsonl` no lo borra esto: es responsabilidad de quien llama,
 * que también tiene la ruta del archivo (`mainApp.js`, `borrarConversacion`).
 */
function deleteSession (sessionId) {
  if (sessionId === null || sessionId === undefined) return
  run('DELETE FROM transcripts WHERE session_id = ?', [sessionId])
  run('DELETE FROM questions WHERE session_id = ?', [sessionId])
  run('DELETE FROM sessions WHERE id = ?', [sessionId])
  persistAgrupado()
}

module.exports = {
  init,
  persist,
  persistAgrupado,
  vaciar,
  // Acceso de bajo nivel, para los módulos que gestionan sus propias tablas
  // (contexto.js). No es para uso general: las consultas viven con su dominio.
  run,
  all,
  get,
  startSession,
  endSession,
  saveTranscript,
  saveQuestion,
  updateQuestionResponses,
  loadSession,
  recentSessions,
  deleteSession,
  get _db () { return db },
}
