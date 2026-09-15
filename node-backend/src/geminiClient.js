/**
 * geminiClient.js
 * HTTP client for the Google Gemini API.
 * Implements the same interface as ClaudeClient / OpenAIClient.
 *
 * API endpoint: POST /v1beta/models/{model}:generateContent?key=…
 * Auth: API key in query string (no Authorization header).
 */

'use strict'

const {
  TRANSLATION_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  REPLY_SUGGESTION_SYSTEM_PROMPT,
  CONTEXT_SYSTEM_PROMPT,
} = require('../../shared/prompts')

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Strip markdown code fences the model occasionally adds */
function stripFences (raw) {
  if (raw.startsWith('```')) {
    raw = raw.split('\n').slice(1).join('\n').split('```')[0].trim()
  }
  return raw
}

class GeminiClient {
  constructor (apiKey, model = 'gemini-2.0-flash') {
    this._apiKey = apiKey || process.env.GEMINI_API_KEY || ''
    this._model  = model
    this._url    = `${GEMINI_BASE}/${model}:generateContent`
  }

  /** POST to Gemini generateContent, return the text of the first candidate */
  async _call (systemPrompt, userContent, maxTokens = 300) {
    if (!this._apiKey) throw new Error('No GEMINI_API_KEY configured')

    const resp = await fetch(`${this._url}?key=${this._apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        generationConfig: {
          temperature:      0.1,
          maxOutputTokens:  maxTokens,
          responseMimeType: 'application/json',
        },
      }),
    })

    if (!resp.ok) {
      const err = await resp.text().catch(() => '')
      throw new Error(`Gemini ${resp.status}: ${err.slice(0, 200)}`)
    }

    const data = await resp.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
  }

  async translate (englishText) {
    const raw    = await this._call(TRANSLATION_SYSTEM_PROMPT, englishText, 400)
    const parsed = JSON.parse(stripFences(raw))
    return {
      en:          englishText,
      es:          parsed.es          ?? '',
      intent:      parsed.intent      ?? 'unknown',
      is_question: parsed.is_question ?? false,
      pos_tags:    parsed.pos_tags    ?? [],
    }
  }

  async summarizeSection (transcriptBlock) {
    const raw = await this._call(SUMMARY_SYSTEM_PROMPT, transcriptBlock, 400)
    return JSON.parse(stripFences(raw))
  }

  async extractQuestions (lines, alreadyCaptured = []) {
    const text    = lines.map(l => l.en).join(' ')
    const already = alreadyCaptured.length
      ? 'Already captured:\n' + alreadyCaptured.join('\n')
      : 'None captured yet.'

    const system = `You scan conversation transcripts and extract COMPLETE questions.
A question is:
- Direct: ends with ?
- Indirect: "Tell me about...", "Describe your...", "Walk me through...", "Can you explain..."
- Request for personal experience: "Have you ever...", "What would you do if..."
Return ONLY valid JSON — no markdown, no explanation:
{"questions":[{"text_en":"complete question","text_es":"traducción completa"}]}
If no new questions, return {"questions":[]}.
Only include questions NOT already captured. Extract the FULL question — never truncate.`

    const raw    = await this._call(system, `Transcript:\n${text}\n\n${already}`, 400)
    const parsed = JSON.parse(stripFences(raw))
    return Array.isArray(parsed.questions) ? parsed.questions : []
  }

  async suggestReplies (questionEn, context = []) {
    const ctxStr  = context.map(m => `Speaker: ${m.en}`).join('\n')
    const userMsg = `Question: ${questionEn}\nRecent context:\n${ctxStr}`
    const raw     = await this._call(REPLY_SUGGESTION_SYSTEM_PROMPT, userMsg, 600)
    return JSON.parse(stripFences(raw))
  }

  async generateContext (lines) {
    const raw = await this._call(CONTEXT_SYSTEM_PROMPT, lines.slice(-20).join('\n'), 200)
    return JSON.parse(stripFences(raw).replace(/```json|```/g, '').trim())
  }
}

module.exports = GeminiClient
