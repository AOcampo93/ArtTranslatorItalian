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

describe('los núcleos se informan sin juzgar el número de hilos', () => {
  // Este bloque sustituye a otro llamado "la sobresuscripción de hilos se ve en
  // el informe", que exigía por prueba un AVISO diciéndole al cliente que 6
  // hilos sobre 4 núcleos físicos era "un fallo nuestro". La afirmación era
  // falsa —en ese mismo equipo, 6 hilos midieron 1.983 ms y 3 midieron 4.246—
  // y la prueba la blindaba: arreglar el código dejaba el arnés en rojo.
  //
  // Lo que sí merece prueba es que el informe distinga físicos de lógicos y
  // diga cuándo no pudo leerlos. Eso es información; el veredicto no lo era.
  const base = {
    perfil: {
      cpu: { modelo: 'Intel Core i5-10210U', nucleosFisicos: 4, nucleosLogicos: 8, hibrida: false },
      memoria: { totalGB: 15.8 },
      energia: { fuente: 'corriente', aBateria: false },
      lecturas: { consultaWindows: 'ok', nucleosFisicos: 'ok', energia: 'ok' },
    },
    admision: {
      ok: true, veredicto: 'justo', consecuencia: 'unos 1,7 s por frase',
      medidas: { whisper: { p50: 1983, p95: 2400 }, marian: { p50: 578, p95: 700 }, vecesTiempoReal: 1.2 },
      condiciones: { hilosWhisper: 6 },
    },
  }

  test('distingue físicos de lógicos', () => {
    assert.match(construir({ backend: base }), /4 núcleos físicos · 8 lógicos/)
  })

  test('dice los hilos con los que midió, sin calificarlos', () => {
    const t = construir({ backend: base })
    assert.match(t, /6 hilos/, 'el dato tiene que estar, para poder comparar informes')
    assert.doesNotMatch(t, /sobresuscripci|fallo nuestro|degrada/,
      'el informe no puede juzgar como defecto la configuración que mejor midió')
  })

  test('sin dato de físicos lo dice, en vez de dar un número que engaña', () => {
    const sin = { ...base, perfil: { ...base.perfil, cpu: { ...base.perfil.cpu, nucleosFisicos: null } } }
    assert.match(construir({ backend: sin }), /8 núcleos lógicos \(los físicos no se pudieron leer\)/)
  })
})

describe('una condición desconocida no se presenta como medida', () => {
  const conEnergia = (energia, lecturas) => ({
    perfil: {
      cpu: { modelo: 'Intel Core i5-10210U', nucleosFisicos: 4, nucleosLogicos: 8, hibrida: false },
      memoria: { totalGB: 15.8 },
      energia,
      lecturas: lecturas || { consultaWindows: 'ok', nucleosFisicos: 'ok', energia: 'ok' },
    },
    admision: {
      ok: true, veredicto: 'justo', consecuencia: 'unos 1,7 s por frase',
      medidas: { whisper: { p50: 1983, p95: 2400 }, marian: { p50: 578, p95: 700 }, vecesTiempoReal: 1.2 },
      condiciones: { hilosWhisper: 4 },
    },
  })

  test('si no se pudo leer la energía, lo dice con su motivo', () => {
    const t = construir({ backend: conEnergia(
      { fuente: 'desconocida', aBateria: null, motivo: 'expiró' },
      { consultaWindows: 'expiró', nucleosFisicos: 'expiró', energia: 'expiró' }) })
    assert.match(t, /Energía: NO SE PUDO LEER \(expiró\)/)
    assert.doesNotMatch(t, /Energía: corriente/, 'no puede afirmar corriente sin saberlo')
  })

  test('y advierte de que eso invalida la comparación de cifras', () => {
    const t = construir({ backend: conEnergia({ fuente: 'desconocida', motivo: 'expiró' }) })
    assert.match(t, /enchufado o a batería/)
    assert.match(t, /tardar el doble/)
  })

  test('enumera las consultas que fallaron, con la causa', () => {
    const t = construir({ backend: conEnergia(
      { fuente: 'desconocida', motivo: 'expiró' },
      { consultaWindows: 'expiró', nucleosFisicos: 'expiró', energia: 'expiró' }) })
    assert.match(t, /Consultas al sistema que fallaron:.*nucleosFisicos \(expiró\)/)
  })

  test('medido a batería, avisa de que no vale para enchufado', () => {
    const t = construir({ backend: conEnergia({ fuente: 'batería', aBateria: true }) })
    assert.match(t, /se midieron a batería/)
  })

  test('un sobremesa no genera ningún aviso: ahí sí se sabe', () => {
    const t = construir({ backend: conEnergia(
      { fuente: 'corriente', aBateria: false, nota: 'sin batería: sobremesa' }) })
    assert.match(t, /Energía: corriente — sin batería: sobremesa/)
    assert.doesNotMatch(t, /enchufado o a batería/)
    assert.doesNotMatch(t, /Consultas al sistema que fallaron/)
  })
})

describe('el informe dice de qué supuesto depende el veredicto', () => {
  // Reconstruye el caso del HP Pavilion, que es el que lo destapó: el veredicto
  // "no-llega" —que le dice al cliente que pague 0,15 USD la hora— salía de
  // multiplicar la medida por una duración de frase SUPUESTA de 4 s que nadie
  // midió. Con 3 s el mismo equipo es "justo" y se queda en local, gratis.
  const hp = {
    perfil: {
      cpu: { modelo: 'Intel Core i5-10210U', nucleosFisicos: 4, nucleosLogicos: 8, hibrida: false },
      memoria: { totalGB: 15.8 },
      energia: { fuente: 'corriente', aBateria: false },
      lecturas: { consultaWindows: 'ok', nucleosFisicos: 'ok', energia: 'ok' },
    },
    admision: {
      ok: true, veredicto: 'no-llega',
      consecuencia: 'Tu equipo tardaría unos 3,7 segundos en traducir cada frase',
      accion: 'Se usará transcripción en la nube, con un coste aproximado de 0,15 USD por hora.',
      latenciaFraseMs: 3700, msPorSegundoAudio: 925, supuestoFraseS: 4,
      sensibilidad: [
        { fraseS: 3, latenciaFraseMs: 2775, veredicto: 'justo' },
        { fraseS: 5, latenciaFraseMs: 4625, veredicto: 'no-llega' },
      ],
      medidas: { whisper: { p50: 4246, p95: 5141 }, marian: { p50: 707, p95: 749 }, vecesTiempoReal: 1.1 },
      condiciones: { hilosWhisper: 4 },
    },
  }

  test('avisa cuando el veredicto cambiaría con otro supuesto', () => {
    const t = construir({ backend: hp })
    assert.match(t, /El veredicto depende de un supuesto: frases de 4 s \(sin medir\)/)
    assert.match(t, /con frases de 3 s seria "justo"/)
  })

  test('da la medida cruda, que no depende de ningún supuesto', () => {
    assert.match(construir({ backend: hp }), /925 ms por segundo de audio/)
  })

  test('no repite los supuestos que dan el mismo veredicto', () => {
    // 5 s también da "no-llega": añadirlo solo haría ruido.
    const t = construir({ backend: hp })
    assert.doesNotMatch(t, /con frases de 5 s/)
  })

  test('si el veredicto aguanta cualquier supuesto, no dice nada', () => {
    const firme = { ...hp, admision: { ...hp.admision, veredicto: 'sobrado',
      sensibilidad: [{ fraseS: 3, latenciaFraseMs: 900, veredicto: 'sobrado' },
                     { fraseS: 5, latenciaFraseMs: 1400, veredicto: 'sobrado' }] } }
    assert.doesNotMatch(construir({ backend: firme }), /depende de un supuesto/)
  })
})
