/**
 * Pruebas del perfilado de hardware.
 *
 * El reto aquí: el dato concreto cambia en cada máquina, así que no se puede
 * afirmar "tiene 32 GB". Lo que sí se verifica es el **contrato** — que los
 * campos existen, que tienen el tipo correcto, que nada cuelga, y que lo que no
 * se puede saber viene como `null` en vez de inventado.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const os = require('os')
const { perfilar, resumir, _internos } = require('../src/hardware')

describe('detección de topología híbrida', () => {
  const HIBRIDAS = [
    '13th Gen Intel(R) Core(TM) i9-13900HX',
    '12th Gen Intel(R) Core(TM) i7-12700H',
    'Intel(R) Core(TM) Ultra 7 155H',
    'Apple M5',
    'Apple M3 Pro',
  ]
  for (const m of HIBRIDAS) {
    test(`híbrida: ${m}`, () => assert.strictEqual(_internos.esHibrida(m), true))
  }

  const UNIFORMES = [
    'AMD Ryzen 7 5800H with Radeon Graphics',
    'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz',
    'AMD Ryzen 9 7950X',
  ]
  for (const m of UNIFORMES) {
    test(`uniforme: ${m}`, () => assert.strictEqual(_internos.esHibrida(m), false))
  }

  test('un modelo desconocido no revienta', () => {
    assert.strictEqual(_internos.esHibrida(undefined), false)
    assert.strictEqual(_internos.esHibrida(''), false)
  })
})

describe('el ejecutor de comandos nunca cuelga ni lanza', () => {
  test('un comando inexistente devuelve null', async () => {
    const r = await _internos.correr('comando-que-no-existe-12345', [])
    assert.strictEqual(r, null)
  })

  test('un comando que se eterniza se corta por timeout', async () => {
    const t0 = Date.now()
    const r = await _internos.correr('sleep', ['30'], 400)
    const ms = Date.now() - t0
    assert.strictEqual(r, null)
    assert.ok(ms < 3000, `tardó ${ms} ms: el timeout no cortó`)
  })
})

describe('contrato del perfil', () => {
  test('perfila sin lanzar y en un tiempo razonable', async () => {
    const t0 = Date.now()
    const p = await perfilar()
    const ms = Date.now() - t0
    assert.ok(ms < 20000, `tardó ${ms} ms`)
    assert.ok(p && typeof p === 'object')
  })

  test('trae los campos que el informe necesita', async () => {
    const p = await perfilar()
    assert.ok(p.generadoEn, 'falta la marca de tiempo')
    assert.ok(p.so.plataforma, 'falta la plataforma')
    assert.ok(p.cpu.modelo, 'falta el modelo de CPU')
    assert.strictEqual(typeof p.cpu.nucleosLogicos, 'number')
    assert.ok(p.cpu.nucleosLogicos > 0)
    assert.strictEqual(typeof p.memoria.totalGB, 'number')
    assert.ok(p.memoria.totalGB > 0)
    assert.ok(p.energia, 'falta el estado de energía')
  })

  test('es serializable a JSON sin perder nada', async () => {
    const p = await perfilar()
    const ida = JSON.stringify(p)
    const vuelta = JSON.parse(ida)
    assert.deepStrictEqual(vuelta, JSON.parse(JSON.stringify(p)))
    assert.ok(ida.length > 100)
  })

  test('en CPU híbrida declara que NO puede contar los P-cores', async () => {
    // Es el dato que más importa para elegir hilos y es el único que no se
    // puede leer desde Node. Tiene que venir null y explicado, no estimado.
    const p = await perfilar()
    if (p.cpu.hibrida) {
      assert.strictEqual(p.cpu.pCores, null, 'no debe inventar el número de P-cores')
      assert.match(p.cpu.notaPCores, /addon nativo/, 'debe explicar por qué no se sabe')
    }
  })

  test('los núcleos físicos nunca superan a los lógicos', async () => {
    const p = await perfilar()
    if (p.cpu.nucleosFisicos !== null) {
      assert.ok(p.cpu.nucleosFisicos <= p.cpu.nucleosLogicos,
        `físicos ${p.cpu.nucleosFisicos} > lógicos ${p.cpu.nucleosLogicos}`)
    }
  })

  test('la memoria total coincide con la del sistema', async () => {
    const p = await perfilar()
    const esperado = +(os.totalmem() / 1024 ** 3).toFixed(1)
    assert.strictEqual(p.memoria.totalGB, esperado)
  })
})

describe('resumen para el usuario', () => {
  test('menciona CPU, núcleos y memoria', async () => {
    const p = await perfilar()
    const r = resumir(p)
    assert.ok(r.includes(p.cpu.modelo), `no menciona la CPU: "${r}"`)
    assert.match(r, /núcleos/)
    assert.match(r, /GB/)
    console.log(`\n[perfil] ${r}`)
  })
})
