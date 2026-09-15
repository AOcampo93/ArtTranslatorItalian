/**
 * Pruebas del traductor IT→ES.
 *
 * Criterio de `docs/verification.md`: una prueba que no puede fallar no es una
 * prueba. Aquí no basta con que devuelva algo: se comprueba que dice lo que debe
 * y que la latencia se mantiene dentro del presupuesto.
 */

'use strict'

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const { traducir, cargar, estaListo, _internos } = require('../src/translator')

// Presupuesto por frase corta. Medido en M5: p50 131 ms. Dejamos margen
// generoso para máquinas más lentas, pero no tanto como para no enterarnos
// si algo se rompe de verdad.
const PRESUPUESTO_MS = 400

describe('troceado (sin modelo, instantáneo)', () => {
  test('deja las frases cortas intactas', () => {
    const t = _internos.trocear('Buongiorno a tutti. Iniziamo la riunione.')
    assert.deepStrictEqual(t, ['Buongiorno a tutti.', 'Iniziamo la riunione.'])
  })

  test('parte los tramos largos sin puntuar', () => {
    const largo = Array(60).fill('parola').join(' ')
    const t = _internos.trocear(largo)
    assert.ok(t.length >= 1, 'debe devolver al menos un trozo')
    assert.ok(t.every(x => x.trim().length > 0), 'ningún trozo vacío')
  })

  test('un texto vacío no revienta', () => {
    assert.deepStrictEqual(_internos.trocear(''), [''])
  })
})

describe('guardia de repetición', () => {
  test('detecta el bucle de NMT', () => {
    const bucle = Array(6).fill('el presupuesto cubre el mantenimiento').join(' ')
    assert.strictEqual(_internos.pareceRepetido(bucle), true)
  })

  test('no marca texto normal como repetido', () => {
    const normal = 'El cliente pidió que se adelantara la entrega la semana que viene, '
                 + 'aunque todavía no hemos cerrado el alcance de la fase dos.'
    assert.strictEqual(_internos.pareceRepetido(normal), false)
  })
})

describe('traducción real IT→ES', () => {
  // Recogemos las latencias para poder reportar p50 y rango al final: es un
  // criterio de aceptación de F002, y es el número que habrá que volver a medir
  // en el equipo del cliente.
  const latencias = []

  before(async () => { await cargar() }, { timeout: 180000 })

  after(() => {
    if (!latencias.length) return
    const orden = [...latencias].sort((a, b) => a - b)
    const p50 = orden[Math.floor(orden.length / 2)]
    console.log(`\n[latencia IT→ES] n=${orden.length}  p50=${p50} ms  `
              + `rango=${orden[0]}-${orden[orden.length - 1]} ms  `
              + `presupuesto=${PRESUPUESTO_MS} ms`)
  })

  test('el modelo queda cargado tras cargar()', () => {
    assert.strictEqual(estaListo(), true)
  })

  // Cada caso lleva una palabra que TIENE que aparecer: así la prueba falla si
  // el modelo devuelve algo plausible pero equivocado, no solo si devuelve vacío.
  const CASOS = [
    { it: 'Buongiorno a tutti, iniziamo la riunione.',                         debe: /buen(os)? d[ií]a|bonjour|buenas/i },
    { it: 'Il cliente ha chiesto di anticipare la consegna.',                  debe: /cliente/i },
    { it: 'Quanto tempo ci vuole per completare il lavoro?',                   debe: /tiempo|cu[áa]nto/i },
    { it: 'Non sono sicuro che il budget copra la manutenzione.',              debe: /presupuesto/i },
    { it: 'Che ne pensi della proposta che abbiamo mandato ieri?',             debe: /propuesta/i },
    { it: 'Dobbiamo rivedere i tempi di consegna con il fornitore.',           debe: /entrega|plazos|proveedor/i },
  ]

  for (const caso of CASOS) {
    test(`traduce: "${caso.it.slice(0, 42)}…"`, async () => {
      const r = await traducir(caso.it)
      latencias.push(r.ms)
      assert.ok(r.es.length > 0, 'la traducción no puede venir vacía')
      assert.match(r.es, caso.debe, `"${r.es}" no contiene lo esperado`)
      assert.ok(r.ms < PRESUPUESTO_MS, `tardó ${r.ms} ms, presupuesto ${PRESUPUESTO_MS} ms`)
    })
  }

  test('una entrada vacía devuelve vacío sin llamar al modelo', async () => {
    const r = await traducir('   ')
    assert.strictEqual(r.es, '')
    assert.strictEqual(r.ms, 0)
  })

  test('un tramo largo se trocea en vez de degenerar', async () => {
    const largo = 'Il cliente ha chiesto di anticipare la consegna alla prossima settimana '
                + 'e dobbiamo rivedere il piano con il fornitore perché i tempi non tornano '
                + 'e il budget approvato non copre le ore extra di integrazione con il gestionale '
                + 'quindi propongo di rimandare la fase due al mese prossimo.'
    const r = await traducir(largo)
    assert.ok(r.trozos >= 1, 'debe haber troceado')
    assert.ok(r.es.length > 40, 'la salida debe ser sustancial')
    assert.strictEqual(_internos.pareceRepetido(r.es), false, 'la salida no debe degenerar')
  })
})
