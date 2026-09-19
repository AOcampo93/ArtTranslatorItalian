/**
 * Pruebas de `frases.js`: la burbuja es la frase, no el turno.
 *
 * ## Qué se protege aquí
 *
 * Que a Marian no le llegue nunca media oración. No es una preferencia de
 * estilo: un trozo que empieza por la mitad **no sale a medias, sale
 * inventado**, y las dos veces que pasó están medidas en `sesion-2.jsonl` de
 * una reunión real. Las cadenas de este archivo son las **exactas** de ese
 * `.jsonl` —líneas 4 y 5 para el caso de Malena, 17 y 18 para el del resumen,
 * contando desde 1—, copiadas tal cual, con sus apóstrofos y sin recortar:
 * una prueba escrita «parecida» al caso real deja de probar el caso real.
 *
 * ## Lo que NO se prueba aquí
 *
 * Que la traducción mejore. Eso depende de Marian y sólo se puede ver con el
 * modelo cargado y con oído; lo que sí se puede fijar en una prueba es que el
 * texto que se le manda **empieza donde empieza la oración**, que es la causa
 * conocida de la invención.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')

const { partirTurno, arrastrar, acabaCerrada, TOPE_ARRASTRE } = require('../src/frases')

// ── Las cadenas medidas, tal cual salieron del archivo ──────────────────────

/** `sesion-2.jsonl`, línea 4 `[medido]`. No acaba ninguna oración. */
const MALENA_1 = 'Tu pensi che questo ruolo di Malena ti darà'
/**
 * `sesion-2.jsonl`, línea 5 `[medido]`. Empieza a media oración, y por eso
 * Marian tradujo «¿Cómo se puede dar el salto definitivo a nivel
 * internacional?»: el «Cómo» lo puso el modelo para cerrar la pregunta que le
 * faltaba.
 */
const MALENA_2 = "la possibilità di fare il salto definitivo a livello internazionale? "
  + "Ma il salto definitivo per un'attrice non c'è mai, perché c'è un film che"

/** `sesion-2.jsonl`, línea 17 `[medido]`. Cierra una pregunta y deja otra a medias. */
const RESUMEN_1 = "Se riesci a fare un riassunto rapido dell'argomento della pellicola, "
  + 'come la spiegheresti? Ci potresti fare un riassunto molto breve del'
/** `sesion-2.jsonl`, línea 18 `[medido]`. Empieza por «film?», y salió «¿Películas?». */
const RESUMEN_2 = 'film? Come lo spiegheresti? Ma posso dire che Malena è la storia '
  + "di una donna che vive nella Sicilia degli anni '40"

/** Lo que haría el proceso principal con dos turnos seguidos. */
function dosTurnos (primero, segundo) {
  const uno = partirTurno(primero)
  const union = arrastrar(uno.cola, segundo)
  return { uno, union, dos: partirTurno(union.texto) }
}

describe('los dos casos medidos en sesion-2.jsonl', () => {
  test('«Malena»: la pregunta llega entera a Marian, no desde «la possibilità»', () => {
    const { uno, union, dos } = dosTurnos(MALENA_1, MALENA_2)

    // El primer turno no cierra nada: entero a la cola, y por tanto a una
    // burbuja provisional.
    assert.strictEqual(uno.completas, '')
    assert.strictEqual(uno.cola, MALENA_1)

    // Y el segundo NO se traduce solo: se traduce pegado a lo que quedaba.
    assert.strictEqual(union.arrastre, true)
    assert.ok(union.texto.startsWith('Tu pensi che questo ruolo di Malena'),
      `lo que va a Marian empieza por «${union.texto.slice(0, 40)}…»`)

    // Ésta es la frase del caso: empieza en «Tu pensi» —o sea que el sujeto y
    // el verbo están— y acaba en la interrogación.
    assert.strictEqual(dos.oraciones.length, 1)
    assert.strictEqual(dos.oraciones[0],
      'Tu pensi che questo ruolo di Malena ti darà la possibilità di fare il salto '
      + 'definitivo a livello internazionale?')
    // Lo que quedaba después de la pregunta sigue abierto: es la cola nueva.
    assert.strictEqual(dos.cola,
      "Ma il salto definitivo per un'attrice non c'è mai, perché c'è un film che")
    // Nada de lo que se manda a Marian empieza a media oración.
    assert.ok(!dos.completas.startsWith('la possibilità'),
      'esto es exactamente lo que hacía que el modelo inventara el «Cómo»')
  })

  test('«film?»: el trozo que dio «¿Películas?» se traduce con su frase delante', () => {
    const { uno, union, dos } = dosTurnos(RESUMEN_1, RESUMEN_2)

    assert.strictEqual(uno.completas,
      "Se riesci a fare un riassunto rapido dell'argomento della pellicola, "
      + 'come la spiegheresti?')
    assert.strictEqual(uno.cola, 'Ci potresti fare un riassunto molto breve del')

    assert.strictEqual(union.arrastre, true)
    // «film?» deja de ser una frase suelta: es el final de «Ci potresti fare un
    // riassunto molto breve del film?».
    assert.deepStrictEqual(dos.oraciones, [
      'Ci potresti fare un riassunto molto breve del film?',
      'Come lo spiegheresti?',
    ])
    assert.strictEqual(dos.cola,
      "Ma posso dire che Malena è la storia di una donna che vive nella Sicilia degli anni '40")
    assert.ok(!dos.completas.startsWith('film?'),
      'traducir «film?» solo es lo que dio «¿Películas?»')
  })

  test('las dos colas siguen siendo el texto del hablante, sin recortar ni recomponer', () => {
    // Si el arrastre perdiera o añadiera un carácter, la traducción sería de
    // otra cosa y nadie lo notaría: el texto italiano de la burbuja saldría
    // igual de plausible.
    const { union } = dosTurnos(MALENA_1, MALENA_2)
    assert.strictEqual(union.texto, `${MALENA_1} ${MALENA_2}`)
  })
})

describe('partirTurno', () => {
  test('un turno sin ninguna puntuación es todo cola', () => {
    const r = partirTurno('E quindi')
    assert.deepStrictEqual(r, { completas: '', cola: 'E quindi', oraciones: [] })
  })

  test('un turno que acaba en punto no deja cola', () => {
    const r = partirTurno('Il film diventa quasi una specie di metafora.')
    assert.strictEqual(r.cola, '')
    assert.strictEqual(r.completas, 'Il film diventa quasi una specie di metafora.')
  })

  test('varias oraciones seguidas y una cola detrás', () => {
    const r = partirTurno('Ce l\'ho fatta. Sono arrivata. Quello che posso dire è')
    assert.deepStrictEqual(r.oraciones, ["Ce l'ho fatta.", 'Sono arrivata.'])
    assert.strictEqual(r.cola, 'Quello che posso dire è')
  })

  test('un turno vacío o en blanco no es nada', () => {
    for (const vacio of ['', '   ', null, undefined]) {
      assert.deepStrictEqual(partirTurno(vacio), { completas: '', cola: '', oraciones: [] })
    }
  })

  test('un turno que es todo puntuación se cierra y no deja cola', () => {
    // Pasa de verdad: un turno de ruido puede salir como «...» o «?». No puede
    // quedarse de cola, porque entonces se arrastraría a la frase siguiente y
    // se traduciría pegado a ella.
    for (const raro of ['...', '?', '!?', '….']) {
      const r = partirTurno(raro)
      assert.strictEqual(r.cola, '', `«${raro}» no puede quedar de cola`)
      assert.strictEqual(r.completas, raro)
    }
  })

  test('el punto de un decimal no parte la frase', () => {
    const r = partirTurno('Il biglietto costa 3.5 euro e non 4.20 come dicevano')
    assert.strictEqual(r.completas, '', 'no hay ninguna oración cerrada aquí')
    assert.strictEqual(r.cola, 'Il biglietto costa 3.5 euro e non 4.20 come dicevano')
  })

  test('las abreviaturas no cierran oración', () => {
    // «sig.», «ecc.» y compañía: partir ahí mandaría a Marian «Rossi ha detto
    // che…» sin sujeto, que es el fallo de siempre con otra ropa.
    const r = partirTurno('Il sig. Rossi ha portato pane, vino, ecc. e poi è uscito')
    assert.strictEqual(r.oraciones.length, 0)
    assert.strictEqual(r.cola, 'Il sig. Rossi ha portato pane, vino, ecc. e poi è uscito')
  })

  test('una inicial de nombre propio tampoco', () => {
    const r = partirTurno('Questo ragazzino, Giuseppe G. Sulfaro, era alla prima esperienza.')
    assert.deepStrictEqual(r.oraciones,
      ['Questo ragazzino, Giuseppe G. Sulfaro, era alla prima esperienza.'])
  })

  test('un terminador pegado a la palabra siguiente no parte nada', () => {
    // Formateo, no puntuación: sin espacio detrás, ese signo es parte de algo
    // —un número, una sigla, una palabra mal separada— y partir ahí fabricaría
    // dos trozos donde no había dos oraciones. Equivocarse por este lado sólo
    // alarga la cola; por el otro es el fallo que este módulo existe para no
    // cometer.
    assert.strictEqual(partirTurno('Davvero?Non lo so').cola, 'Davvero?Non lo so')
    assert.strictEqual(partirTurno('Il prezzo è 4.Poi vedremo').cola, 'Il prezzo è 4.Poi vedremo')
    // Con el espacio, en cambio, sí son dos oraciones.
    assert.deepStrictEqual(partirTurno('Davvero? Non lo so.').oraciones,
      ['Davvero?', 'Non lo so.'])
  })

  test('un terminador seguido de minúscula no cierra oración, vaya solo o en racha', () => {
    // El hueco que dejaba consultar esta regla sólo para el punto suelto: una
    // racha («...», «?!») o un `?` partían la oración y a Marian le llegaba el
    // trozo sin su principio, sin que fuera el tope de arrastre. Es el mismo
    // fallo de «la possibilità…», con otra puntuación delante.
    for (const turno of ['Ho pensato... che potrebbe funzionare',
                         'Davvero?! non me lo aspettavo',
                         'Perché? perché non mi va']) {
      const r = partirTurno(turno)
      assert.strictEqual(r.completas, '', `«${turno}» no puede partirse`)
      assert.strictEqual(r.cola, turno)
    }
    // Y con mayúscula detrás sí son dos oraciones, que es el caso normal del
    // texto formateado de AssemblyAI.
    assert.deepStrictEqual(partirTurno('Davvero?! Non me lo aspettavo.').oraciones,
      ['Davvero?!', 'Non me lo aspettavo.'])
  })

  test('la puntuación dentro de comillas no parte la frase que la contiene', () => {
    const r = partirTurno('«Davvero?!» disse lui. Poi uscì')
    assert.deepStrictEqual(r.oraciones, ['«Davvero?!» disse lui.'])
    assert.strictEqual(r.cola, 'Poi uscì')
  })

  test('la comilla de cierre se queda con la oración que acaba', () => {
    const r = partirTurno('Lui gridò: «Basta!» Poi se ne andò')
    assert.deepStrictEqual(r.oraciones, ['Lui gridò: «Basta!»'])
    assert.strictEqual(r.cola, 'Poi se ne andò')
  })
})

describe('arrastrar', () => {
  test('sin cola anterior, el turno va solo', () => {
    const r = arrastrar('', 'Sono arrivata.')
    assert.deepStrictEqual(r,
      { texto: 'Sono arrivata.', arrastre: false, colaSuelta: null, motivo: 'sin-cola' })
  })

  test('una cola de 300 caracteres todavía se arrastra', () => {
    const cola = 'a'.repeat(TOPE_ARRASTRE)
    const r = arrastrar(cola, 'e poi basta.')
    assert.strictEqual(r.arrastre, true, 'el tope es «pasado de», no «llegado a»')
    assert.strictEqual(r.colaSuelta, null)
    assert.strictEqual(r.texto, `${cola} e poi basta.`)
  })

  test('pasado el tope, la cola se suelta y el turno empieza por donde empiece', () => {
    // Es la ÚNICA excepción admitida al «nada llega a Marian empezado por la
    // mitad», y existe porque traducir se paga por carácter: 300 caracteres
    // son ≈ 1.960 ms en el equipo del cliente [estimado a partir de lo medido].
    const cola = 'a'.repeat(TOPE_ARRASTRE + 1)
    const r = arrastrar(cola, 'e poi basta.')
    assert.strictEqual(r.arrastre, false)
    assert.strictEqual(r.colaSuelta, cola, 'quien llama tiene que cerrarla')
    assert.strictEqual(r.texto, 'e poi basta.')
    assert.strictEqual(r.motivo, 'tope-arrastre')
  })

  test('el tope se mira sobre la cola, no sobre la unión', () => {
    // La unión puede pasarse de 300 sin problema: lo que no puede crecer sin
    // freno es la cola, que es la que se acumula turno tras turno cuando el
    // hablante no cierra ninguna oración.
    const cola = 'a'.repeat(TOPE_ARRASTRE - 10)
    const r = arrastrar(cola, 'b'.repeat(200))
    assert.strictEqual(r.arrastre, true)
    assert.ok(r.texto.length > TOPE_ARRASTRE)
  })

  test('una cola sin turno nuevo se queda como está', () => {
    const r = arrastrar('E quindi', '')
    assert.strictEqual(r.texto, 'E quindi')
    assert.strictEqual(r.colaSuelta, null)
  })
})

describe('acabaCerrada', () => {
  test('dice si el texto que se GUARDA acaba una oración', () => {
    assert.strictEqual(acabaCerrada('Sono arrivata.'), true)
    assert.strictEqual(acabaCerrada('Come lo spiegheresti?'), true)
    assert.strictEqual(acabaCerrada('E quindi'), false)
    assert.strictEqual(acabaCerrada(''), false)
  })

  test('usa el MISMO criterio que partirTurno', () => {
    // Con dos definiciones, una burbuja podría guardarse diciendo que acaba
    // cerrada y volver a partirse por otro sitio.
    for (const t of ['ecc.', 'Il costo è 3.5', 'Il sig.', '«Davvero?!» disse lui']) {
      assert.strictEqual(acabaCerrada(t), false, `«${t}» no acaba ninguna oración`)
    }
  })
})
