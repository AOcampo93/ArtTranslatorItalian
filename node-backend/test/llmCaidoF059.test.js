/**
 * F059 — si el LLM no responde: dejar de esperarlo, avisar y guardar el diagnóstico.
 * Una prueba por criterio. Datos inventados; el reloj del cortacircuitos se inyecta
 * y el plazo de cada llamada es de 20 ms reales.
 */
'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { crearTraductorLlm } = require('../src/traduccionLlm')
const { MotorRespuestas } = require('../src/respuestas')
const { Autosave } = require('../src/autosave')
const { recortarInformeAMetricas } = require('../src/informes')
const { diagnosticoLlm } = require('../src/llm')

const FRASE = 'Dobbiamo rivedere i tempi della consegna.'
const marian = () => ({ llamadas: [], async traducir (t) { this.llamadas.push(t); return { es: 'de Marian', ms: 5, traductor: 'marian' } } })
const GEMINI_503 = new Error('gemini 503: {"error":{"code":503,"message":"The model is overloaded, please retry later.","status":"UNAVAILABLE"}}')

describe('F059 (a) — el cortacircuitos', () => {
  test('desde la 3.ª frase no se espera el plazo; a los 60 s una frase prueba y, si responde, todo vuelve al LLM', async () => {
    let ahora = 1000
    let vivo = false
    let llamadasLlm = 0
    const llamar = (s, u) => { llamadasLlm++; return vivo ? Promise.resolve({ texto: 'Debemos revisar los plazos de entrega.' }) : new Promise(() => {}) }
    const eventos = []
    const respaldo = marian()
    const t = crearTraductorLlm({ llamar, respaldo, plazoMs: 20, ahora: () => ahora, alCambiarCircuito: e => eventos.push(e) })

    for (let i = 0; i < 2; i++) {
      const r = await t.traducir(FRASE)
      assert.strictEqual(r.traductor, 'marian')
      assert.strictEqual(r.llmTipo, 'sin_respuesta')
    }
    assert.deepStrictEqual(eventos, [{ abierto: true, causa: 'sin respuesta' }])

    // 3.ª y 4.ª: directas, sin tocar el LLM.
    const t0 = Date.now()
    for (let i = 0; i < 2; i++) {
      const r = await t.traducir(FRASE)
      assert.strictEqual(r.motivo, 'llm-caido')
      assert.strictEqual(r.traductor, 'marian')
    }
    assert.ok(Date.now() - t0 < 15, 'ni un plazo de 20 ms de espera')
    assert.strictEqual(llamadasLlm, 2, 'el LLM no se vuelve a llamar')

    // A los 60 s, UNA frase prueba (y sigue caído: abierto otros 60 s).
    ahora += 60000
    assert.strictEqual((await t.traducir(FRASE)).traductor, 'marian')
    assert.strictEqual(llamadasLlm, 3)
    assert.strictEqual((await t.traducir(FRASE)).motivo, 'llm-caido')
    assert.strictEqual(llamadasLlm, 3)

    // 60 s después el LLM ha vuelto: la prueba responde, el circuito se cierra.
    ahora += 60000
    vivo = true
    assert.strictEqual((await t.traducir(FRASE)).traductor, 'llm')
    assert.deepStrictEqual(eventos.at(-1), { abierto: false, causa: null })
    assert.strictEqual((await t.traducir(FRASE)).traductor, 'llm')
    assert.strictEqual(llamadasLlm, 5)
  })

  test('una respuesta charlatana no cuenta como fallo del servicio', async () => {
    const llamar = async () => ({ texto: 'No hay texto en italiano: proporciona la frase que necesitas traducir, por favor.' })
    const eventos = []
    const t = crearTraductorLlm({ llamar, respaldo: marian(), alCambiarCircuito: e => eventos.push(e) })
    for (let i = 0; i < 4; i++) assert.strictEqual((await t.traducir(FRASE)).motivo, 'respuesta-no-valida')
    assert.deepStrictEqual(eventos, [])
  })
})

describe('F059 (b) — el aviso en el en vivo', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../electron-app/src/renderer/app.html'), 'utf8')
  const fuente = html.match(/function pintarAvisoLlm[\s\S]*?\n}\n/)[0]
  const nodo = { textContent: '', clases: new Set(['oculto']), classList: { toggle (c, f) { f ? nodo.clases.add(c) : nodo.clases.delete(c) } } }
  const pintar = new Function('$', `${fuente}; return pintarAvisoLlm`)(() => nodo)

  test('aparece con el circuito abierto, con la causa, y desaparece al cerrarse', async () => {
    const t = crearTraductorLlm({
      llamar: async () => { throw GEMINI_503 }, respaldo: marian(),
      alCambiarCircuito: pintar,
    })
    assert.ok(nodo.clases.has('oculto'))
    await t.traducir(FRASE)
    assert.ok(nodo.clases.has('oculto'), 'con un solo fallo todavía no')
    await t.traducir(FRASE)
    assert.ok(!nodo.clases.has('oculto'))
    assert.strictEqual(nodo.textContent, 'La IA no responde (error 503): traduciendo con el traductor local; las respuestas sugeridas pueden fallar.')
    pintar({ abierto: false, causa: null })
    assert.ok(nodo.clases.has('oculto'))
    assert.strictEqual(nodo.textContent, '')
  })

  test('el proceso principal lo manda por app:avisoLlm y el preload lo expone', () => {
    const main = fs.readFileSync(path.join(__dirname, '../../electron-app/src/mainApp.js'), 'utf8')
    const pre = fs.readFileSync(path.join(__dirname, '../../electron-app/src/preloadApp.js'), 'utf8')
    assert.match(main, /alCambiarCircuito: c => aRenderer\('app:avisoLlm', c\)/)
    assert.match(pre, /alAvisoLlm: fn => escuchar\('app:avisoLlm', fn\)/)
  })
})

describe('F059 (c) — el diagnóstico en el .jsonl', () => {
  test('estado y código de cada proveedor, en vocabulario cerrado', () => {
    const d = e => { const { causa, ...x } = diagnosticoLlm(new Error(e)); return x }
    assert.deepStrictEqual(d(GEMINI_503.message), { llmTipo: 'desconocido', llmEstado: 503, llmCodigo: 'UNAVAILABLE' })
    assert.strictEqual(d('gemini 429: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}').llmCodigo, 'RESOURCE_EXHAUSTED')
    assert.strictEqual(d('anthropic 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').llmCodigo, 'overloaded_error')
    const oa = d('openai 429: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}')
    assert.deepStrictEqual(oa, { llmTipo: 'sin_credito', llmEstado: 429, llmCodigo: 'insufficient_quota' })
    assert.deepStrictEqual(d('gemini no respondió en 20 s'), { llmTipo: 'sin_respuesta', llmEstado: null, llmCodigo: null })
    // Texto libre bajo esas claves: no es un código.
    assert.strictEqual(d('gemini 500: {"status":"Algo ha ido muy mal con tu cuenta, Valdemar"}').llmCodigo, null)
  })

  test('las líneas de frase y respuestaLlm fallidas lo llevan, y el recorte a métricas lo deja salir sin texto', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f059-'))
    const auto = new Autosave({ directorio: dir })

    // Una respuesta fallida, por el motor de verdad.
    const motor = new MotorRespuestas({ llamar: async () => { throw GEMINI_503 } })
    const fallida = await new Promise(res => { motor.on('respuesta', res); motor._responder({ id: 'q', it: 'Quanto tempo ci vuole?' }) })
    auto.guardarRespuestaLlm({ it: 'Quanto tempo ci vuole?', es: '¿Cuánto falta?', texto: null, mensaje: fallida.mensaje,
      llmTipo: fallida.llmTipo, llmEstado: fallida.llmEstado, llmCodigo: fallida.llmCodigo })

    // Una frase que cayó a Marian por el fallo.
    const t = crearTraductorLlm({ llamar: async () => { throw GEMINI_503 }, respaldo: marian() })
    const tr = await t.traducir(FRASE)
    auto.escribir({ tipo: 'frase', it: FRASE, es: tr.es, traductor: tr.traductor, motivo: tr.motivo ?? null,
      llmTipo: tr.llmTipo, llmEstado: tr.llmEstado, llmCodigo: tr.llmCodigo })
    auto.cerrar?.()

    const archivo = fs.readdirSync(dir).map(f => path.join(dir, f)).find(f => f.endsWith('.jsonl'))
    const bruto = fs.readFileSync(archivo, 'utf8')
    const lineas = bruto.split('\n').filter(Boolean).map(l => JSON.parse(l))
    for (const l of lineas) {
      assert.deepStrictEqual([l.llmTipo, l.llmEstado, l.llmCodigo], ['desconocido', 503, 'UNAVAILABLE'], l.tipo)
    }

    const recortado = recortarInformeAMetricas(bruto)
    const out = recortado.split('\n').filter(Boolean).map(l => JSON.parse(l))
    for (const l of out) assert.deepStrictEqual([l.llmTipo, l.llmEstado, l.llmCodigo], ['desconocido', 503, 'UNAVAILABLE'], l.tipo)
    // Barrido: ninguna palabra de ≥ 4 letras del texto inventado sobrevive.
    const palabras = (FRASE + ' Quanto tempo ci vuole Cuánto falta overloaded retry later').toLowerCase().match(/\p{L}{4,}/gu)
    const texto = recortado.toLowerCase()
    for (const p of ['dobbiamo', 'rivedere', 'consegna', 'quanto', 'tempo', 'vuole', 'overloaded', 'retry']) {
      assert.ok(!texto.includes(p), `se escapó «${p}»`)
    }
    assert.ok(palabras.length > 5)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
