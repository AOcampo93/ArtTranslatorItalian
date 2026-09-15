/**
 * ollamaClient.js
 * HTTP client for a local Ollama instance (http://localhost:11434).
 * Implements the same interface as ClaudeClient so aiOrchestrator
 * can swap them without callers knowing.
 *
 * Note: suggestReplies always goes to Claude Sonnet (cloud) per spec,
 * so this method is a no-op pass-through that throws to signal the
 * orchestrator to use Claude instead.
 */

'use strict'

const http = require('http')
const {
  TRANSLATION_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  REPLY_SUGGESTION_SYSTEM_PROMPT,
  CONTEXT_SYSTEM_PROMPT,
} = require('../../shared/prompts')

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')
  .replace(/\/$/, '').replace('localhost', '127.0.0.1')
const OLLAMA_URL  = `${OLLAMA_BASE}/api/chat`

/** POST JSON to Ollama and return parsed response body */
function ollamaPost (body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const url  = new URL(OLLAMA_URL)
    const opts = {
      hostname: url.hostname,
      port:     url.port || 11434,
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }
    const req = http.request(opts, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) }
        catch (e) { reject(new Error(`Ollama JSON parse error: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(30_000, () => { req.destroy(new Error('Ollama request timed out')) })
    req.write(data)
    req.end()
  })
}

/** Strip markdown fences */
function stripFences (raw) {
  if (raw.startsWith('```')) {
    raw = raw.split('\n').slice(1).join('\n').split('```')[0].trim()
  }
  return raw
}

class OllamaClient {
  constructor (model) {
    this._model = model   // e.g. 'llama3.2:3b' | 'qwen3:8b'
  }

  async translate (englishText) {
    const data = await ollamaPost({
      model:   this._model,
      messages: [
        { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
        { role: 'user',   content: englishText },
      ],
      stream: false,
      format: 'json',
    })
    const raw     = stripFences(data.message.content.trim())
    const payload = JSON.parse(raw)
    return {
      en:          englishText,
      es:          payload.es          ?? '',
      intent:      payload.intent      ?? 'unknown',
      is_question: payload.is_question ?? false,
      pos_tags:    payload.pos_tags    ?? [],
    }
  }

  async summarizeSection (transcriptBlock) {
    const data = await ollamaPost({
      model:   this._model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user',   content: transcriptBlock },
      ],
      stream: false,
      format: 'json',
    })
    const raw = stripFences(data.message.content.trim())
    return JSON.parse(raw)
  }

  /** Question extraction — Ollama not suited for structured multi-question extraction */
  async extractQuestions () { return [] }

  async suggestReplies (questionEn, context = []) {
    const ctxStr  = context.map(m => `Speaker: ${m.en}`).join('\n')
    const userMsg = `Question: ${questionEn}\nRecent context:\n${ctxStr}`
    const data = await ollamaPost({
      model:   this._model,
      messages: [
        { role: 'system', content: REPLY_SUGGESTION_SYSTEM_PROMPT },
        { role: 'user',   content: userMsg },
      ],
      stream: false,
      format: 'json',
    })
    const raw = stripFences(data.message.content.trim())
    return JSON.parse(raw)
  }

  async generateContext (lines) {
    const recent  = lines.slice(-20).join('\n')
    const data = await ollamaPost({
      model:   this._model,
      messages: [
        { role: 'system', content: CONTEXT_SYSTEM_PROMPT },
        { role: 'user',   content: recent },
      ],
      stream: false,
      format: 'json',
    })
    const raw = stripFences(data.message.content.trim())
    return JSON.parse(raw)
  }
}

module.exports = OllamaClient
