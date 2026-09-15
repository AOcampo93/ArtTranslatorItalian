/**
 * wsServer.js
 * ArtTranslator Node.js WebSocket server — port 3001.
 *
 * Architecture (native pipeline):
 *   NativePipeline drives audio_capture → whisper-cli → translate_server
 *   Claude Haiku enriches async (pos_tags, intent, is_question)
 *   All connected WebSocket clients receive both payloads.
 *
 * WS protocol (Server → Client):
 *   { en, es, intent, is_question, pos_tags }          — fast chunk
 *   { en, es, intent, is_question, pos_tags, _update } — Claude enrichment
 *   { error: "..." }
 *   { session_ended: true, session_id: N }
 *
 * Client → Server:
 *   "stop"   — end session
 *   { start: true } / { stop: true }  — pipeline control
 *
 * HTTP:
 *   GET /health             → { status, model, backend, uptime_s, pipeline }
 *   GET /ollama/models      → { models: string[] }
 *   GET /ollama/pull/:name  → SSE stream { status, pct, completed, total }
 *
 * Run:
 *   node src/wsServer.js
 */

'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') })

const http              = require('http')
const { WebSocketServer } = require('ws')
const AiOrchestrator    = require('./aiOrchestrator')
const NativePipeline    = require('./nativePipeline')
const db                = require('./db')

const PORT      = parseInt(process.env.NODE_WS_PORT || '3001', 10)
const startedAt = Date.now()

const orchestrator = new AiOrchestrator()
console.log(`[ws] AI backend: ${orchestrator.backend} — model: ${orchestrator.model}`)

const pipeline = new NativePipeline(orchestrator)

db.init().then(startServer).catch(err => {
  console.error('[ws] DB init failed:', err.message)
  process.exit(1)
})

function startServer () {

// ── Ollama HTTP helper (avoids fetch IPv6/IPv4 ambiguity) ─────────────────
const OLLAMA_ORIGIN = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')
  .replace(/\/$/, '').replace('localhost', '127.0.0.1')

function ollamaGet (urlPath) {
  return new Promise((resolve, reject) => {
    const target = new URL(OLLAMA_ORIGIN + urlPath)
    const opts = {
      hostname: target.hostname,
      port:     target.port || (target.protocol === 'https:' ? 443 : 80),
      path:     target.pathname + target.search,
      timeout:  5000,
    }
    const req = http.get(opts, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 100))) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// ── HTTP server ───────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {

  // ── /health ─────────────────────────────────────────────────────────────
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status:   'ok',
      model:    orchestrator.model,
      backend:  orchestrator.backend,
      pipeline: pipeline.isRunning ? 'running' : 'stopped',
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    }))

  // ── /ollama/models — list installed models ───────────────────────────────
  } else if (req.url === '/ollama/models' && req.method === 'GET') {
    ollamaGet('/api/tags')
      .then(data => {
        const models = (data.models || []).map(m => m.name)
        console.log('[ollama] installed models:', models)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ models }))
      })
      .catch(e => {
        console.warn('[ollama] /ollama/models error:', e.message)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ models: [], error: e.message }))
      })

  // ── /ollama/pull/:name — pull model with SSE progress ───────────────────
  } else if (req.url?.startsWith('/ollama/pull/') && req.method === 'GET') {
    const modelName = decodeURIComponent(req.url.replace('/ollama/pull/', ''))
    console.log('[ollama] pulling model:', modelName)

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })

    const send = (d) => { try { res.write(`data: ${JSON.stringify(d)}\n\n`) } catch {} }

    const postData = JSON.stringify({ name: modelName, stream: true })
    const pullTarget = new URL(OLLAMA_ORIGIN + '/api/pull')
    const pullReq  = http.request({
      hostname: pullTarget.hostname,
      port:     pullTarget.port || (pullTarget.protocol === 'https:' ? 443 : 80),
      path:     '/api/pull',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (pullRes) => {
      let buf = ''
      pullRes.on('data', chunk => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()   // keep incomplete line for next chunk
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const json = JSON.parse(line)
            const pct  = json.total ? Math.round((json.completed || 0) / json.total * 100) : null
            send({ status: json.status || '', pct, completed: json.completed, total: json.total })
            if (json.status === 'success') { res.end(); return }
          } catch {}
        }
      })
      pullRes.on('end', () => { send({ status: 'done', pct: 100 }); res.end() })
    })

    pullReq.on('error', e => {
      console.warn('[ollama] pull error:', e.message)
      send({ error: e.message })
      res.end()
    })

    pullReq.write(postData)
    pullReq.end()

  // ── POST /suggest-replies — generate reply suggestions for a question ─────
  } else if (req.url === '/suggest-replies' && req.method === 'POST') {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      let questionEn = '', context = []
      try { const p = JSON.parse(body); questionEn = p.question_en || ''; context = p.context || [] } catch {}
      orchestrator.suggestReplies(questionEn, context)
        .then(result => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result || {}))
        })
        .catch(e => {
          console.warn('[suggest-replies] error:', e.message)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        })
    })

  // ── POST /context — generate conversation context summary ────────────────
  } else if (req.url === '/context' && req.method === 'POST') {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      let lines = []
      try { lines = JSON.parse(body).lines || [] } catch {}
      orchestrator.generateContext(lines)
        .then(result => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result || {}))
        })
        .catch(e => {
          console.warn('[context] generateContext error:', e.message)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        })
    })

  } else {
    res.writeHead(404)
    res.end()
  }
})

// ── WebSocket server ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

// Shared session state (one session across all clients)
let sessionId        = null
let recentMsgs       = []
let lineCount        = 0
let sessionStart     = Date.now()

// Question scanner state
let transcriptBuffer    = []   // { en, es, timestamp }
let lastQuestionScan    = 0
let questionScanInterval = null
const QUESTION_SCAN_INTERVAL = 25000  // scan at most every 25s

function broadcastToAll (payload) {
  const str = JSON.stringify(payload)
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(str)
  }
}

// ── Question scanner ─────────────────────────────────────────────────────
function startQuestionScanner () {
  return setInterval(async () => {
    const now = Date.now()
    if (now - lastQuestionScan < QUESTION_SCAN_INTERVAL) return
    if (transcriptBuffer.length < 3) return
    if (sessionId === null) return

    lastQuestionScan = now

    const recent   = transcriptBuffer.slice(-15)
    const captured = recentMsgs.filter(m => m.is_question).map(m => m.en)

    let questions
    try {
      questions = await orchestrator.extractQuestions(recent, captured)
    } catch (err) {
      console.error('[questions] scan error:', err.message)
      return
    }

    for (const q of questions) {
      if (!q.text_en) continue
      console.log('[questions] found:', q.text_en.slice(0, 60))

      const qId = db.saveQuestion(sessionId, {
        question_en: q.text_en,
        question_es: q.text_es || q.text_en,
        context:     recent.slice(-5),
      })

      const timestamp = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
      broadcastToAll({
        _question:   true,
        question_en: q.text_en,
        question_es: q.text_es || q.text_en,
        qId,
        timestamp,
      })

      orchestrator.suggestReplies(q.text_en, recent.slice(-5))
        .then(responses => {
          db.updateQuestionResponses(qId, responses)
          broadcastToAll({ _question_responses: true, qId, responses })
        })
        .catch(err => console.error('[questions] suggestReplies error:', err.message))
    }
  }, 5000)  // check every 5s, rate-limited by lastQuestionScan
}

// ── NativePipeline events → broadcast to all clients ─────────────────────
pipeline.on('translation', (chunk) => {
  if (!chunk._update) {
    if (sessionId !== null) db.saveTranscript(sessionId, chunk)
    lineCount++

    recentMsgs.push({ en: chunk.en, es: chunk.es })
    if (recentMsgs.length > 5) recentMsgs.shift()

    if (chunk.en) {
      transcriptBuffer.push({ en: chunk.en, es: chunk.es, timestamp: Date.now() })
      if (transcriptBuffer.length > 100) transcriptBuffer = transcriptBuffer.slice(-100)
    }
  }

  broadcastToAll(chunk)
})

pipeline.on('status', msg => {
  console.log('[pipeline]', msg)
  broadcastToAll({ pipeline_status: msg })
})

pipeline.on('error', err => {
  console.error('[pipeline] error:', err.message)
  broadcastToAll({ error: err.message })
})

// ── Per-client connection handling ────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress
  console.log(`[ws] Client connected from ${clientIp}`)

  // Start a new DB session when the first client connects
  if (wss.clients.size === 1 && sessionId === null) {
    sessionId    = db.startSession(orchestrator.model)
    lineCount    = 0
    recentMsgs   = []
    sessionStart = Date.now()
    console.log(`[ws] Started session ${sessionId}`)
  }

  ws.on('message', (raw) => {
    const text = raw.toString().trim()
    console.log('[ws] msg:', text.slice(0, 80))

    let msg
    try { msg = JSON.parse(text) } catch { msg = text }

    // Start — any form: { start: true }, 'start'
    if (msg === 'start' || (typeof msg === 'object' && msg.start)) {
      console.log('[ws] starting pipeline…')
      if (!pipeline.isRunning) {
        transcriptBuffer  = []
        lastQuestionScan  = 0
        pipeline.start()
        questionScanInterval = startQuestionScanner()
      }
      return
    }

    // Stop — any form: { stop: true }, 'stop'
    if (msg === 'stop' || (typeof msg === 'object' && msg.stop)) {
      console.log('[ws] stopping pipeline…')
      if (questionScanInterval) { clearInterval(questionScanInterval); questionScanInterval = null }
      pipeline.stop()
      if (sessionId !== null) {
        db.endSession(sessionId, {
          durationSeconds: Math.floor((Date.now() - sessionStart) / 1000),
          lineCount,
        })
        console.log(`[ws] Session ${sessionId} closed — ${lineCount} lines`)
        sessionId = null
      }
      broadcastToAll({ session_ended: true })
      return
    }

    console.log('[ws] unknown message, ignored')
  })

  ws.on('close', () => {
    console.log(`[ws] Client disconnected from ${clientIp}`)
    // Stop pipeline if no clients remain
    if (wss.clients.size === 0 && pipeline.isRunning) {
      if (questionScanInterval) { clearInterval(questionScanInterval); questionScanInterval = null }
      pipeline.stop()
      if (sessionId !== null) {
        db.endSession(sessionId, {
          durationSeconds: Math.floor((Date.now() - sessionStart) / 1000),
          lineCount,
        })
        console.log(`[ws] Session ${sessionId} auto-closed (no clients)`)
        sessionId = null
      }
    }
  })

  ws.on('error', err => {
    console.error(`[ws] Socket error from ${clientIp}:`, err.message)
  })
})

// ── Start ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[ws] ArtTranslator node-backend listening on port ${PORT}`)
  console.log(`[ws] Health: http://localhost:${PORT}/health`)
  console.log(`[ws] WebSocket: ws://localhost:${PORT}/ws`)
})

httpServer.on('error', err => {
  console.error('[ws] Server error:', err.message)
  process.exit(1)
})

// ── Graceful shutdown ─────────────────────────────────────────────────────
function shutdown () {
  console.log('[ws] Shutting down…')
  pipeline.stop()
  wss.close(() => {
    httpServer.close(() => {
      db.persist()
      if (db._db) db._db.close()
      process.exit(0)
    })
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

} // end startServer
