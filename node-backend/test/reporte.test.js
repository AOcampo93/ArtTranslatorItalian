/**
 * Pruebas del informe de diagnóstico.
 *
 * Este texto es lo ÚNICO que vamos a ver de los equipos del cliente. Si miente
 * o se calla algo, construiremos el producto sobre una certeza falsa. Por eso
 * lo que más se verifica aquí es que **distinga lo medido de lo que no se pudo
 * comprobar**.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const { construir, veredictoGlobal } = require('../src/reporte')

const PERFIL_BASE = {
  cpu: { modelo: 'AMD Ryzen 7 5800H', nucleosLogicos: 16, nucleosFisicos: 8, hibrida: false },
  memoria: { totalGB: 16 },
  gpu: { nombre: 'NVIDIA GeForce RTX 5060', vram: '8192 MiB' },
  energia: { fuente: 'corriente', aBateria: false },
}

const ADMISION_OK = {
  ok: true,
  veredicto: 'sobrado',
  consecuencia: 'La traducción aparecerá alrededor de 0,8 segundos después de que hablen.',
  accion: null,
  medidas: {
    whisper: { p50: 180, p95: 210 },
    marian: { p50: 90, p95: 120 },
    total: { p50: 280, p95: 340 },
    vecesTiempoReal: 18.5,
  },
  condiciones: { hilosWhisper: 6, sostenida: false, avisoSostenida: 'medición corta: no detecta la caída por temperatura', avisoEnergia: null },
}

const WIN = { plataforma: 'win32', electron: '43.7.0', loopbackSoportado: true }
const MAC = { plataforma: 'darwin', electron: '43.7.0', loopbackSoportado: false }

describe('lo medido frente a lo no comprobado', () => {
  test('un audio no concluyente NUNCA se presenta como correcto', () => {
    // Es el fallo más caro posible de este informe: si dijera "correcto" sin
    // haber probado, construiríamos la app creyendo que el audio funciona.
    const txt = construir({
      plataforma: MAC,
      audio: { ok: false, concluyente: false, motivo: 'solo existe en Windows' },
      backend: { perfil: PERFIL_BASE, admision: ADMISION_OK },
    })
    assert.match(txt, /NO CONCLUYENTE/)
    assert.doesNotMatch(txt, /AUDIO\n\s+Correcto/)
  })

  test('el audio correcto sí se declara, con sus números', () => {
    const txt = construir({
      plataforma: WIN,
      audio: { ok: true, concluyente: true, sampleRate: 48000, fondo: 0.001, conTono: 0.12 },
      backend: { perfil: PERFIL_BASE, admision: ADMISION_OK },
    })
    assert.match(txt, /Correcto: reproduje un tono y lo capté/)
    assert.match(txt, /48000 Hz/)
  })

  test('el audio fallido dice qué hacer', () => {
    const txt = construir({
      plataforma: WIN,
      audio: { ok: false, concluyente: true, motivo: 'no lo capté' },
      backend: { perfil: PERFIL_BASE, admision: ADMISION_OK },
    })
    assert.match(txt, /FALLÓ/)
    assert.match(txt, /selector de dispositivo/)
  })

  test('sin medida de rendimiento lo dice, no lo omite', () => {
    const txt = construir({
      plataforma: WIN,
      audio: { ok: true, concluyente: true, sampleRate: 48000 },
      backend: { perfil: PERFIL_BASE, motivoOmision: 'faltan componentes: ggml-small.bin' },
    })
    assert.match(txt, /NO MEDIDO/)
    assert.match(txt, /ggml-small\.bin/)
  })
})

describe('dispositivos de entrada — el plan C del audio', () => {
  // Es lo ÚNICO que una máquina virtual no puede contestar: Mezcla estéreo es
  // una función del driver de audio físico.
  test('declara Mezcla estéreo cuando existe', () => {
    const txt = construir({
      plataforma: WIN, audio: null, backend: { perfil: PERFIL_BASE, admision: ADMISION_OK },
      entradas: { total: 3, sinEtiqueta: 0, mezclaEstereo: 'Mezcla estéreo (Realtek)',
                  etiquetas: ['Micrófono', 'Mezcla estéreo (Realtek)', 'Línea'] },
    })
    assert.match(txt, /MEZCLA ESTÉREO DISPONIBLE/)
    assert.match(txt, /Realtek/)
  })

  test('dice claramente cuando NO hay, que es el caso probable en portátil', () => {
    const txt = construir({
      plataforma: WIN, audio: null, backend: { perfil: PERFIL_BASE, admision: ADMISION_OK },
      entradas: { total: 2, sinEtiqueta: 0, mezclaEstereo: null, etiquetas: ['Micrófono', 'Cámara'] },
    })
    assert.match(txt, /Sin Mezcla estéreo/)
    assert.match(txt, /no está disponible/)
  })

  test('distingue "sin permiso" de "sin dispositivos"', () => {
    // enumerateDevices devuelve entradas sin etiqueta cuando el permiso de
    // micrófono está desactivado. Confundirlo con "no hay nada" nos haría
    // descartar el plan C por un motivo equivocado.
    const txt = construir({
      plataforma: WIN, audio: null, backend: { perfil: PERFIL_BASE, admision: ADMISION_OK },
      entradas: { total: 3, sinEtiqueta: 3, permisoDudoso: true, mezclaEstereo: null, etiquetas: [] },
    })
    assert.match(txt, /SIN NOMBRE/)
    assert.match(txt, /permiso de micrófono/)
    assert.doesNotMatch(txt, /Sin Mezcla estéreo/, 'no debe concluir que no existe')
  })

  test('sin Mezcla estéreo, avisa de que no hay respaldo', () => {
    const txt = construir({
      plataforma: WIN,
      audio: { ok: true, concluyente: true, sampleRate: 44100 },
      backend: { perfil: PERFIL_BASE, admision: ADMISION_OK },
      entradas: { total: 2, sinEtiqueta: 0, mezclaEstereo: null, etiquetas: ['Micrófono'] },
    })
    assert.match(txt, /no hay Mezcla estéreo de respaldo/)
  })
})

describe('variante de CPU que eligió whisper', () => {
  test('avisa si cayó a una variante para CPUs antiguas', () => {
    // Si el empaquetado dispersa las DLL, el despacho cae a sse42 y el
    // rendimiento se hunde SIN dar ningún error. Este aviso es el health check.
    const txt = construir({
      plataforma: WIN, audio: null, entradas: null,
      backend: { perfil: PERFIL_BASE, admision: ADMISION_OK,
                 infoSistema: { nivel: 'solo SSE — variante sse42', sospechoso: true } },
    })
    assert.match(txt, /AVISO/)
    assert.match(txt, /ggml-cpu/)
  })

  test('sin aviso cuando la variante es la correcta', () => {
    const txt = construir({
      plataforma: WIN, audio: null, entradas: null,
      backend: { perfil: PERFIL_BASE, admision: ADMISION_OK,
                 infoSistema: { nivel: 'AVX2 (haswell o superior)', sospechoso: false } },
    })
    assert.match(txt, /AVX2/)
    assert.doesNotMatch(txt, /variante para CPUs antiguas/)
  })
})

describe('la sección de lo que el informe no dice', () => {
  test('en macOS advierte de las tres cosas que quedan sin saber', () => {
    const txt = construir({
      plataforma: MAC,
      audio: { ok: false, concluyente: false, motivo: 'solo Windows' },
      backend: { perfil: PERFIL_BASE, admision: ADMISION_OK },
    })
    assert.match(txt, /LO QUE ESTE INFORME NO DICE/)
    assert.match(txt, /loopback/)
    assert.match(txt, /Mezcla estéreo/)
    assert.match(txt, /caliente/)
  })

  test('en Windows con todo medido y sostenido, no sobra la sección', () => {
    const sostenida = JSON.parse(JSON.stringify(ADMISION_OK))
    sostenida.condiciones.sostenida = true
    sostenida.condiciones.avisoSostenida = null
    const txt = construir({
      plataforma: WIN,
      audio: { ok: true, concluyente: true, sampleRate: 48000 },
      backend: { perfil: PERFIL_BASE, admision: sostenida },
    })
    assert.doesNotMatch(txt, /LO QUE ESTE INFORME NO DICE/)
  })
})

describe('CPU híbrida', () => {
  test('declara que no puede contar los núcleos rápidos', () => {
    const perfil = JSON.parse(JSON.stringify(PERFIL_BASE))
    perfil.cpu = { modelo: 'Intel Core i9-13900HX', nucleosLogicos: 32, nucleosFisicos: 24, hibrida: true }
    const txt = construir({ plataforma: WIN, audio: null, backend: { perfil, admision: ADMISION_OK } })
    assert.match(txt, /híbrida/)
    assert.match(txt, /No se puede contar cuántos son rápidos/)
  })
})

describe('robustez', () => {
  test('sin datos no revienta y lo dice todo como no medido', () => {
    const txt = construir({ plataforma: null, audio: null, backend: null })
    assert.ok(txt.includes('DIAGNÓSTICO'))
    assert.ok((txt.match(/NO MEDIDO/g) || []).length >= 2)
  })
})

describe('veredicto global', () => {
  test('bien si el rendimiento se midió y el audio no falló', () => {
    assert.strictEqual(veredictoGlobal({
      audio: { ok: true, concluyente: true }, backend: { admision: ADMISION_OK },
    }), true)
  })

  test('un audio no concluyente no cuenta como fallo', () => {
    // No se probó: no es lo mismo que haber fallado.
    assert.strictEqual(veredictoGlobal({
      audio: { ok: false, concluyente: false }, backend: { admision: ADMISION_OK },
    }), true)
  })

  test('un audio que sí falló cuenta como fallo', () => {
    assert.strictEqual(veredictoGlobal({
      audio: { ok: false, concluyente: true }, backend: { admision: ADMISION_OK },
    }), false)
  })

  test('sin rendimiento medido, mal', () => {
    assert.strictEqual(veredictoGlobal({
      audio: { ok: true, concluyente: true }, backend: { motivoOmision: 'falta el modelo' },
    }), false)
  })
})
