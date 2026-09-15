/**
 * Pruebas de perfiles y contexto de proyecto.
 *
 * Lo que más importa verificar:
 *  1. Que solo haya UNO activo de cada, porque los prompts leen el activo.
 *  2. Que `buildContextBlock()` sea el único constructor y produzca lo esperado.
 *  3. Que los topes existan de verdad: el `--prompt` de whisper trunca en
 *     silencio si se pasa, y el bloque del LLM multiplica el coste por hora.
 *  4. Que el export NUNCA lleve API keys.
 */

'use strict'

const { test, describe, before, beforeEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let db, ctx

before(async () => {
  process.env.DB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'))
  db = require('../src/db')
  await db.init()
  ctx = require('../src/contexto')
})

beforeEach(() => {
  db.run('DELETE FROM profiles')
  db.run('DELETE FROM project_contexts')
})

const PERFIL = {
  nombre: 'Omar Avila', edad: 34, ocupacion: 'Responsable técnico',
  contexto: 'No habla italiano; entiende algo escrito. Decide sobre plazos y alcance.',
}
const CONTEXTO = {
  nombre: 'Rossi Logistica — fase 2',
  tipo_reunion: 'negociación',
  tipo_proyecto: 'ERP de logística, migración a SAP',
  contexto: 'Se discute el alcance de la fase 2 y quién asume las horas extra.',
  glosario: 'SAP, ERP, fase 2, Rossi Logistica, WMS',
}

describe('solo uno activo de cada', () => {
  test('activar un perfil desactiva el anterior', () => {
    const a = ctx.crearPerfil({ nombre: 'Uno' })
    const b = ctx.crearPerfil({ nombre: 'Dos' })
    ctx.activarPerfil(a)
    assert.strictEqual(ctx.perfilActivo().id, a)
    ctx.activarPerfil(b)
    assert.strictEqual(ctx.perfilActivo().id, b, 'debe cambiar el activo')
    assert.strictEqual(ctx.listarPerfiles().filter(p => p.activo).length, 1,
      'nunca puede haber dos activos: los prompts leen el activo')
  })

  test('lo mismo con los contextos', () => {
    const a = ctx.crearContexto({ nombre: 'Daily' })
    const b = ctx.crearContexto({ nombre: 'Negociación' })
    ctx.activarContexto(a); ctx.activarContexto(b)
    assert.strictEqual(ctx.contextoActivo().id, b)
    assert.strictEqual(ctx.listarContextos().filter(c => c.activo).length, 1)
  })

  test('sin nada activo, no revienta', () => {
    assert.strictEqual(ctx.perfilActivo(), null)
    assert.strictEqual(ctx.contextoActivo(), null)
  })
})

describe('CRUD', () => {
  test('crear, actualizar, listar y borrar', () => {
    const id = ctx.crearPerfil(PERFIL)
    assert.ok(id > 0)
    ctx.actualizarPerfil(id, { ocupacion: 'Director técnico' })
    assert.strictEqual(ctx.listarPerfiles()[0].ocupacion, 'Director técnico')
    ctx.borrarPerfil(id)
    assert.strictEqual(ctx.listarPerfiles().length, 0)
  })

  test('un perfil sin nombre se rechaza', () => {
    assert.throws(() => ctx.crearPerfil({ nombre: '  ' }), /necesita un nombre/)
  })

  test('actualizar sin campos válidos no hace nada', () => {
    const id = ctx.crearPerfil({ nombre: 'X' })
    assert.strictEqual(ctx.actualizarPerfil(id, { campo_inventado: 1 }), false)
  })
})

describe('buildContextBlock — el único constructor', () => {
  test('mete perfil y reunión, con sus etiquetas', () => {
    const { bloque, vacio } = ctx.buildContextBlock({ perfil: PERFIL, contexto: CONTEXTO })
    assert.strictEqual(vacio, false)
    assert.match(bloque, /PERFIL DE QUIEN ESCUCHA/)
    assert.match(bloque, /Omar Avila · 34 años · Responsable técnico/)
    assert.match(bloque, /REUNIÓN ACTUAL/)
    assert.match(bloque, /Tipo: negociación/)
    assert.match(bloque, /SAP/, 'el glosario debe entrar como términos')
  })

  test('funciona con solo perfil, o solo contexto', () => {
    assert.match(ctx.buildContextBlock({ perfil: PERFIL, contexto: null }).bloque, /PERFIL/)
    assert.match(ctx.buildContextBlock({ perfil: null, contexto: CONTEXTO }).bloque, /REUNIÓN/)
  })

  test('sin nada, devuelve vacío y lo declara', () => {
    const r = ctx.buildContextBlock({ perfil: null, contexto: null })
    assert.strictEqual(r.vacio, true)
    assert.strictEqual(r.bloque, '')
  })

  test('lee los activos cuando no se le pasa nada', () => {
    const p = ctx.crearPerfil(PERFIL)
    const c = ctx.crearContexto(CONTEXTO)
    ctx.activarPerfil(p); ctx.activarContexto(c)
    assert.match(ctx.buildContextBlock().bloque, /Omar Avila/)
  })
})

describe('topes que no son decorativos', () => {
  test('un contexto enorme se recorta, y se dice', () => {
    // Si el usuario pega 3.000 palabras, el escáner de cada 40 s multiplica el
    // coste por hora por diez y el cálculo de 5,50 $/mes deja de valer.
    const enorme = { ...CONTEXTO, contexto: 'palabra '.repeat(2000) }
    const r = ctx.buildContextBlock({ perfil: PERFIL, contexto: enorme })
    assert.strictEqual(r.recortado, true, 'debe declarar que recortó')
    assert.ok(r.bloque.length <= ctx.MAX_BLOQUE_CHARS,
      `${r.bloque.length} caracteres supera el tope de ${ctx.MAX_BLOQUE_CHARS}`)
  })

  test('el recorte no parte una palabra por la mitad', () => {
    const r = ctx._internos.recortar('alfa beta gamma delta epsilon', 14)
    assert.strictEqual(r.recortado, true)
    assert.ok(!r.texto.endsWith('gam'), `cortó a media palabra: "${r.texto}"`)
  })
})

describe('el --prompt de whisper', () => {
  test('convierte el glosario en sesgo léxico', () => {
    const r = ctx.promptParaWhisper({ contexto: CONTEXTO })
    assert.match(r.prompt, /SAP/)
    assert.match(r.prompt, /Rossi Logistica/)
    assert.strictEqual(r.incluidos, 5)
    assert.strictEqual(r.omitidos, 0)
  })

  test('recorta explícitamente y dice cuántos dejó fuera', () => {
    // Whisper trunca EN SILENCIO si el initial prompt se pasa de ~224 tokens.
    // Recortar aquí y contar lo omitido es la diferencia entre saberlo y no.
    const muchos = Array.from({ length: 200 }, (_, i) => `termino${i}`).join(', ')
    const r = ctx.promptParaWhisper({ contexto: { glosario: muchos } })
    assert.ok(r.prompt.length <= ctx.MAX_GLOSARIO_CHARS + 1)
    assert.ok(r.omitidos > 0, 'debe informar de cuántos términos no entraron')
    assert.strictEqual(r.incluidos + r.omitidos, 200, 'la cuenta debe cuadrar')
  })

  test('sin glosario devuelve vacío, no basura', () => {
    const r = ctx.promptParaWhisper({ contexto: { glosario: '' } })
    assert.strictEqual(r.prompt, '')
    assert.strictEqual(r.incluidos, 0)
  })

  test('tolera separadores distintos', () => {
    const r = ctx.promptParaWhisper({ contexto: { glosario: 'uno, dos\ntres · cuatro; cinco' } })
    assert.strictEqual(r.incluidos, 5)
  })
})

describe('export e import entre equipos', () => {
  test('el export NUNCA lleva API keys', () => {
    // Están cifradas con DPAPI, atadas al usuario Y a la máquina: no se
    // podrían descifrar en el destino. Y meterlas en claro para sortearlo
    // sería regalar las credenciales del cliente en un archivo que viaja.
    ctx.crearPerfil(PERFIL); ctx.crearContexto(CONTEXTO)
    const texto = JSON.stringify(ctx.exportar())
    for (const pista of ['apiKey', 'api_key', 'sk-', 'AIza', 'ANTHROPIC', 'GEMINI', 'OPENAI']) {
      assert.ok(!texto.includes(pista), `el export contiene "${pista}"`)
    }
    assert.match(texto, /No incluye API keys/, 'y debe decir por qué no están')
  })

  test('lo exportado se puede importar', () => {
    ctx.crearPerfil(PERFIL); ctx.crearContexto(CONTEXTO)
    const datos = ctx.exportar()
    db.run('DELETE FROM profiles'); db.run('DELETE FROM project_contexts')

    const r = ctx.importar(datos)
    assert.strictEqual(r.perfiles, 1)
    assert.strictEqual(r.contextos, 1)
    assert.strictEqual(ctx.listarPerfiles()[0].nombre, 'Omar Avila')
    assert.strictEqual(ctx.listarContextos()[0].glosario, CONTEXTO.glosario)
  })

  test('el import no borra lo que ya había', () => {
    ctx.crearPerfil({ nombre: 'Existente' })
    ctx.importar({ version: 1, perfiles: [{ nombre: 'Importado' }], contextos: [] })
    const nombres = ctx.listarPerfiles().map(p => p.nombre)
    assert.ok(nombres.includes('Existente'), 'no debe borrar lo previo')
    assert.ok(nombres.includes('Importado'))
  })

  test('un formato desconocido se rechaza', () => {
    assert.throws(() => ctx.importar({ version: 99 }), /no reconocido/)
    assert.throws(() => ctx.importar(null), /no reconocido/)
  })
})
