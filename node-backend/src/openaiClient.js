/**
 * openaiClient.js
 * HTTP client for the OpenAI API (gpt-4o-mini, etc.).
 * Implements the same interface as ClaudeClient so aiOrchestrator
 * can swap them transparently.
 *
 * Note: suggestReplies always goes to Claude Sonnet per spec,
 * but this client implements it anyway so the orchestrator can
 * choose to override that behavior if the user selects GPT.
 */

'use strict'

const {
  TRANSLATION_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  REPLY_SUGGESTION_SYSTEM_PROMPT,
  CONTEXT_SYSTEM_PROMPT,
} = require('../../shared/prompts')

const OPENAI_API = 'https://api.openai.com/v1/chat/completions'

/** Strip markdown code fences the model occasionally adds */
function stripFences (raw) {
  if (raw.startsWith('```')) {
    raw = raw.split('\n').slice(1).join('\n').split('```')[0].trim()
  }
  return raw
}

class OpenAIClient {
  constructor (apiKey, model = 'gpt-4o-mini') {
    this._apiKey = apiKey || process.env.OPENAI_API_KEY || ''
    this._model  = model
  }

  /** POST to OpenAI chat completions, return the text content */
  async _call (systemPrompt, userContent, maxTokens = 300) {
    if (!this._apiKey) throw new Error('No OPENAI_API_KEY configured')

    const resp = await fetch(OPENAI_API, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify({
        model:      this._model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userContent  },
        ],
      }),
    })

    if (!resp.ok) {
      const err = await resp.text().catch(() => '')
      throw new Error(`OpenAI ${resp.status}: ${err.slice(0, 200)}`)
    }

    const data = await resp.json()
    return data.choices?.[0]?.message?.content?.trim() || ''
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

module.exports = OpenAIClient
