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

  // Las tres causas se arreglan distinto: instalar algo, pedir permiso al
  // departamento de sistemas, o dar más plazo. Un `null` sin motivo dejó un
  // informe del HP Pavilion imposible de interpretar.
  test('distingue "no existe" de "expiró"', async () => {
    const falta = await _internos.ejecutar('comando-que-no-existe-12345', [])
    assert.strictEqual(falta.ok, false)
    assert.strictEqual(falta.motivo, 'no-existe')

    const tarde = await _internos.ejecutar('sleep', ['30'], 400)
    assert.strictEqual(tarde.ok, false)
    assert.strictEqual(tarde.motivo, 'expiró', 'un timeout no es lo mismo que no existir')
  })

  test('un comando que va bien lo dice y trae la salida', async () => {
    const r = await _internos.ejecutar('echo', ['hola'])
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.motivo, 'ok')
    assert.strictEqual(r.salida, 'hola')
  })
})

describe('un fallo NUNCA puede leerse como una medida', () => {
  const { interpretarEnergiaWindows: leer } = _internos

  // El fallo original: `correr()` devolvía null tanto si el equipo no tenía
  // batería como si la consulta expiraba, y la app respondía "corriente" en
  // ambos casos. En un portátil cuya consulta expira, eso afirma que está
  // enchufado sin saberlo — y a batería Windows recorta la frecuencia, así que
  // invalida en silencio el veredicto de rendimiento.
  test('una consulta que expira NO se convierte en "corriente"', () => {
    const r = leer({ ok: false, motivo: 'expiró', datos: null })
    assert.strictEqual(r.fuente, 'desconocida',
      'decir "corriente" cuando la consulta falló es inventarse el dato')
    assert.strictEqual(r.aBateria, null)
    assert.strictEqual(r.motivo, 'expiró', 'y debe decir por qué no lo sabe')
  })

  test('cero baterías SÍ es una medida: es un sobremesa', () => {
    const r = leer({ ok: true, motivo: 'ok', datos: { baterias: 0, estadoBateria: null } })
    assert.strictEqual(r.fuente, 'corriente')
    assert.strictEqual(r.aBateria, false)
    assert.match(r.nota, /sobremesa/)
  })

  test('con batería, distingue enchufado de a batería', () => {
    assert.strictEqual(leer({ ok: true, datos: { baterias: 1, estadoBateria: 2 } }).aBateria, false)
    assert.strictEqual(leer({ ok: true, datos: { baterias: 1, estadoBateria: 1 } }).aBateria, true)
  })

  test('una batería con estado ilegible tampoco se rellena', () => {
    const r = leer({ ok: true, datos: { baterias: 1, estadoBateria: null } })
    assert.strictEqual(r.fuente, 'desconocida')
    assert.strictEqual(r.motivo, 'estado-ilegible')
  })

  test('el perfil declara qué no pudo leer y por qué', async () => {
    const p = await perfilar()
    assert.ok(p.lecturas, 'falta el registro de lecturas')
    for (const k of ['consultaWindows', 'nucleosFisicos', 'energia']) {
      assert.strictEqual(typeof p.lecturas[k], 'string', `falta lecturas.${k}`)
    }
  })
})

describe('las consultas de Windows van en UNA sola invocación', () => {
  // Eran tres PowerShell simultáneos por Promise.all, con 4 s de plazo cada
  // uno. Arrancar PowerShell cuesta cientos de ms y tres arranques a la vez en
  // un portátil de 15 W compiten entre sí. En el HP Pavilion los núcleos
  // físicos salieron null en una ejecución y 4 en otra del mismo equipo.
  test('la consulta pide los tres datos de golpe', () => {
    const c = _internos.PS_CONSULTA
    assert.match(c, /Win32_Processor/, 'faltan los núcleos')
    assert.match(c, /Win32_VideoController/, 'falta la GPU')
    assert.match(c, /Win32_Battery/, 'falta la energía')
    assert.match(c, /ConvertTo-Json/, 'debe devolver JSON parseable')
  })

  test('cuenta las baterías, no solo mira la primera', () => {
    // Es lo que permite distinguir un sobremesa de una consulta fallida.
    assert.match(_internos.PS_CONSULTA, /baterias=\$b\.Count/)
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
