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
      line_count  INTEGER DEFAULT 0
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

    CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
    CREATE INDEX IF NOT EXISTS idx_questions_session   ON questions(session_id);
  `)

  persist()
  console.log('[db] SQLite ready at', DB_PATH)
}

/** Write the in-memory DB to disk */
function persist () {
  if (!db) return
  const data = db.export()
  fs.writeFileSync(DB_PATH, Buffer.from(data))
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
function startSession (aiModel) {
  const id = run(
    'INSERT INTO sessions (started_at, ai_model) VALUES (?, ?)',
    [new Date().toISOString(), aiModel]
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
  persist()
}

/**
 * Persist one translated chunk.
 * @param {number} sessionId
 * @param {{ en, es, intent, is_question, pos_tags }} chunk
 */
function saveTranscript (sessionId, { en, es, intent, is_question, pos_tags }) {
  run(
    'INSERT INTO transcripts (session_id, created_at, en, es, intent, is_question, pos_tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [sessionId, new Date().toISOString(), en, es, intent || '', is_question ? 1 : 0, JSON.stringify(pos_tags || [])]
  )
  persist()
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
  persist()
  return id
}

/** Attach AI-generated responses to a saved question. */
function updateQuestionResponses (questionId, responses) {
  run('UPDATE questions SET responses = ? WHERE id = ?', [JSON.stringify(responses), questionId])
  persist()
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

module.exports = {
  init,
  persist,
  startSession,
  endSession,
  saveTranscript,
  saveQuestion,
  updateQuestionResponses,
  loadSession,
  recentSessions,
  get _db () { return db },
}
