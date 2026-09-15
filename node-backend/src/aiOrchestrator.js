/**
 * aiOrchestrator.js
 * Routes each AI task to the correct client based on per-task model env vars.
 *
 * Per-task models (from env, set by main.js based on electron-store):
 *   VERB_MODEL      — translate() / POS enrichment
 *   QUESTIONS_MODEL — extractQuestions()
 *   REPLIES_MODEL   — suggestReplies()
 *   CONTEXT_MODEL   — (used in renderer directly)
 *
 * Fallback: AI_MODEL → claude-haiku-4-5-20251001
 *
 * Client routing:
 *   claude-*              → ClaudeClient (Anthropic SDK)
 *   gpt-* / o1-* / o3-*  → OpenAIClient (OpenAI API)
 *   gemini-*              → ClaudeClient (placeholder — no GeminiClient yet)
 *   llama/qwen/mistral/…  → OllamaClient
 */

'use strict'

const ClaudeClient  = require('./claudeClient')
const OllamaClient  = require('./ollamaClient')
const OpenAIClient  = require('./openaiClient')
const GeminiClient  = require('./geminiClient')

const OLLAMA_PREFIXES = ['llama', 'mistral', 'qwen', 'phi', 'deepseek', 'gemma']

class AiOrchestrator {
  constructor () {
    this._apiKey    = process.env.ANTHROPIC_API_KEY || ''
    this._openaiKey = process.env.OPENAI_API_KEY    || ''
    this._geminiKey = process.env.GEMINI_API_KEY    || ''

    // Global model — kept for backward compat / health endpoint
    this.model   = process.env.AI_MODEL || 'claude-haiku-4-5-20251001'
    this.backend = this._detectBackend(this.model)

    // Per-task models
    this.verbModel      = process.env.VERB_MODEL      || this.model
    this.questionsModel = process.env.QUESTIONS_MODEL || this.model
    this.repliesModel   = process.env.REPLIES_MODEL   || this.model
    this.contextModel   = process.env.CONTEXT_MODEL   || this.model

    console.log('[orchestrator] task models:')
    console.log('  verb:      ', this.verbModel)
    console.log('  questions: ', this.questionsModel)
    console.log('  replies:   ', this.repliesModel)

    // Client cache — one instance per unique model string
    this._cache = new Map()
  }

  _detectBackend (model) {
    if (!model) return 'none'
    const m = model.toLowerCase()
    if (m.startsWith('claude'))                          return 'anthropic'
    if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai'
    if (m.startsWith('gemini'))                          return 'gemini'
    if (OLLAMA_PREFIXES.some(p => m.startsWith(p)) || m.includes(':')) return 'ollama'
    return 'anthropic'  // safe default
  }

  /** Return (or create) a client for the given model ID */
  _client (model) {
    if (this._cache.has(model)) return this._cache.get(model)
    const backend = this._detectBackend(model)
    console.log(`[orchestrator] client: ${model} → ${backend}`)
    let client
    switch (backend) {
      case 'openai':    client = new OpenAIClient(this._openaiKey, model); break
      case 'gemini':    client = new GeminiClient(this._geminiKey, model); break
      case 'ollama':    client = new OllamaClient(model);                   break
      case 'anthropic':
      default:          client = new ClaudeClient(this._apiKey, model);     break
    }
    this._cache.set(model, client)
    return client
  }

  // ── Public task methods ───────────────────────────────────────────────────

  /** POS enrichment — uses VERB_MODEL */
  async translate (englishText) {
    try {
      return await this._client(this.verbModel).translate(englishText, this.verbModel)
    } catch (err) {
      console.error('[orchestrator] translate error:', err.message)
      return { en: englishText, es: '', intent: 'error', is_question: false, pos_tags: [] }
    }
  }

  /** Extract questions from transcript — uses QUESTIONS_MODEL */
  async extractQuestions (lines, alreadyCaptured = []) {
    if (!this._apiKey) return []
    try {
      return await this._client(this.questionsModel).extractQuestions(lines, alreadyCaptured)
    } catch (err) {
      console.error('[orchestrator] extractQuestions error:', err.message)
      return []
    }
  }

  /** Suggest replies — uses REPLIES_MODEL (defaults to global model) */
  async suggestReplies (questionEn, context = []) {
    try {
      return await this._client(this.repliesModel).suggestReplies(questionEn, context)
    } catch (err) {
      console.error('[orchestrator] suggestReplies error:', err.message)
      return { type: 'options', responses: [], tip: '' }
    }
  }

  /** Section summary — uses global model */
  async summarizeSection (transcriptBlock) {
    try {
      return await this._client(this.model).summarizeSection(transcriptBlock, this.model)
    } catch (err) {
      console.error('[orchestrator] summarize error:', err.message)
      return { title: 'Sección', summary: '', key_terms: [] }
    }
  }

  /** Conversation context summary — uses CONTEXT_MODEL */
  async generateContext (lines) {
    try {
      return await this._client(this.contextModel).generateContext(lines)
    } catch (err) {
      console.error('[orchestrator] generateContext error:', err.message)
      return null
    }
  }
}

module.exports = AiOrchestrator
