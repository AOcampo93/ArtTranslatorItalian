/**
 * claudeClient.js
 * Thin wrapper around @anthropic-ai/sdk.
 * All methods are async and return parsed JSON objects matching
 * the shapes defined in shared/prompts.js.
 */

'use strict'

const Anthropic = require('@anthropic-ai/sdk')
const {
  TRANSLATION_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  REPLY_SUGGESTION_SYSTEM_PROMPT,
  CONTEXT_SYSTEM_PROMPT,
} = require('../../shared/prompts')

// Model constants — keep aligned with main.js / api_server.py
const HAIKU  = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-4-6'

/** Strip markdown code fences the model occasionally adds */
function stripFences (raw) {
  if (raw.startsWith('```')) {
    raw = raw.split('\n').slice(1).join('\n').split('```')[0].trim()
  }
  return raw
}

class ClaudeClient {
  constructor (apiKey, model = HAIKU) {
    this._client = new Anthropic.default({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY })
    this._model  = model
  }

  /**
   * Translate an English chunk → JSON with es/intent/is_question/pos_tags.
   * @param {string} englishText
   * @param {string} [model]  defaults to instance model
   */
  async translate (englishText, model) {
    model = model || this._model
    const resp = await this._client.messages.create({
      model,
      max_tokens: 600,
      system:     TRANSLATION_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: englishText }],
    })
    const raw = stripFences(resp.content[0].text.trim())
    const payload = JSON.parse(raw)
    return {
      en:          englishText,
      es:          payload.es          ?? '',
      intent:      payload.intent      ?? 'unknown',
      is_question: payload.is_question ?? false,
      pos_tags:    payload.pos_tags    ?? [],
    }
  }

  /**
   * Summarize a transcript section → JSON with title/summary/key_terms.
   * @param {string} transcriptBlock  English text of the section
   * @param {string} [model]
   */
  async summarizeSection (transcriptBlock, model) {
    model = model || this._model
    const resp = await this._client.messages.create({
      model,
      max_tokens: 400,
      system:     SUMMARY_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: transcriptBlock }],
    })
    const raw = stripFences(resp.content[0].text.trim())
    return JSON.parse(raw)
  }

  /**
   * Scan a transcript block and extract complete questions.
   * Always uses Haiku — called periodically by wsServer.
   * @param {{ en: string, es: string }[]} lines  recent transcript lines
   * @param {string[]} alreadyCaptured  question_en strings already in log
   * @returns {{ text_en, text_es }[]}
   */
  async extractQuestions (lines, alreadyCaptured = []) {
    const text = lines.map(l => l.en).join(' ')
    const already = alreadyCaptured.length
      ? 'Already captured:\n' + alreadyCaptured.join('\n')
      : 'None captured yet.'

    const resp = await this._client.messages.create({
      model:      this._model,
      max_tokens: 400,
      system: `You scan conversation transcripts and extract COMPLETE questions.
A question is:
- Direct: ends with ?
- Indirect: "Tell me about...", "Describe your...", "Walk me through...", "Can you explain..."
- Request for personal experience: "Have you ever...", "What would you do if..."
Return ONLY valid JSON — no markdown, no explanation:
{"questions":[{"text_en":"complete question","text_es":"traducción completa"}]}
If no new questions, return {"questions":[]}.
Only include questions NOT already captured. Extract the FULL question — never truncate.`,
      messages: [{
        role: 'user',
        content: `Transcript:\n${text}\n\n${already}`,
      }],
    })

    const raw    = stripFences(resp.content[0].text.trim())
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.questions) ? parsed.questions : []
  }

  /**
   * Generate reply suggestions for a detected question.
   * Always uses Sonnet (cloud-only, per spec).
   * @param {string} questionEn
   * @param {{ en: string, es: string }[]} context  last ≤5 messages
   */
  async suggestReplies (questionEn, context = []) {
    const ctxStr  = context.map(m => `Speaker: ${m.en}`).join('\n')
    const userMsg = `Question: ${questionEn}\nRecent context:\n${ctxStr}`
    const resp = await this._client.messages.create({
      model:      this._model,
      max_tokens: 800,
      system:     REPLY_SUGGESTION_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMsg }],
    })
    const raw = stripFences(resp.content[0].text.trim())
    return JSON.parse(raw)
  }

  async generateContext (lines) {
    const recent = lines.slice(-20).join('\n')
    const resp = await this._client.messages.create({
      model:      this._model,
      max_tokens: 200,
      system:     CONTEXT_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: recent }],
    })
    const raw = stripFences(resp.content[0].text.trim()).replace(/```json|```/g, '').trim()
    return JSON.parse(raw)
  }
}

module.exports = ClaudeClient
