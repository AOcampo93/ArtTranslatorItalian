/**
 * Pruebas de la burbuja de traducción y del rótulo de retardo.
 *
 * ## Qué se protege aquí
 *
 * El rótulo de la barra dice «retardo» y el pie de cada burbuja enseña un
 * número en milisegundos. Durante la primera prueba real ese número era **sólo
 * la traducción**: 21 frases con `msTranscribir: null` y el rótulo diciendo
 * «retardo» igual. Una cifra etiquetada como una cosa midiendo otra, y además
 * por lo bajo, que es la dirección en la que nadie sospecha.
 *
 * Que el productor sume bien no basta: quien pone la etiqueta es esta función,
 * así que la suma se hace y se comprueba aquí. Por eso las pruebas le pasan a
 * propósito un `ms` que miente y exigen que la pantalla enseñe la suma real.
 *
 * El renderer vive dentro de `app.html` y el proyecto no trae jsdom, así que se
 * **extrae el bloque real del archivo** y se ejecuta contra un DOM mínimo,
 * igual que en `rendererPreguntas.test.js`. Cada archivo lleva el suyo porque
 * cada bloque usa una parte distinta del DOM.
 *
 * ## Y también la barra de estado al detener
 *
 * Se montan **dos** bloques del HTML, el de las burbujas y el de arrancar y
 * parar, uno detrás del otro y en el mismo ámbito, que es como están en el
 * archivo. Así el botón «Detener» se puede **pulsar de verdad** y comprobar qué
 * queda escrito en la barra, en vez de comprobar por separado una función que
 * a lo mejor nadie llama. Eso importa especialmente ahora: el número de turnos
 * troceados es el criterio con nombre de la próxima prueba en Windows, así que
 * una función que calcula bien un texto que no llega a la pantalla no vale.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const APP_HTML = path.join(__dirname, '..', '..', 'electron-app', 'src', 'renderer', 'app.html')
const DESDE = '// ── Estado de pantalla ─'
const HASTA = '// ── Preguntas ─'
const DESDE2 = '// ── Arrancar y parar ─'
const HASTA2 = '// ── Puente con el proceso principal ─'

// ── Un DOM mínimo: lo justo que usan las burbujas ───────────────────────────

class Nodo {
  constructor (tag) {
    this.tag = tag
    this.id = ''
    this.hijos = []
    this._clases = new Set()
    this._texto = ''
    this.html = ''
    this.padre = null
    // `abajo()` sólo sigue el final si el usuario ya estaba abajo.
    this.scrollHeight = 0
    this.scrollTop = 0
    this.clientHeight = 0
    this.classList = {
      add: (...c) => c.forEach(x => this._clases.add(x)),
      remove: (...c) => c.forEach(x => this._clases.delete(x)),
      contains: c => this._clases.has(c),
      toggle: (c, on) => {
        const poner = on === undefined ? !this._clases.has(c) : Boolean(on)
        poner ? this._clases.add(c) : this._clases.delete(c)
        return poner
      },
    }
  }

  get className () { return [...this._clases].join(' ') }
  set className (v) { this._clases = new Set(String(v).split(/\s+/).filter(Boolean)) }
  get textContent () { return this._texto }
  set textContent (v) { this._texto = String(v); this.hijos = [] }
  get innerHTML () { return this.html }
  /**
   * Sólo entiende `<tag class="...">`, que es lo único que el renderer asigna
   * por innerHTML. Con más sintaxis esto sería un navegador de mentira, y un
   * navegador de mentira acaba probándose a sí mismo.
   */
  set innerHTML (v) {
    this.html = String(v)
    this.hijos = []
    for (const [, tag, clase] of this.html.matchAll(/<(\w+)(?:\s+class="([^"]*)")?\s*>/g)) {
      const n = new Nodo(tag)
      if (clase) n.className = clase
      this.append(n)
    }
  }
  get oculto () { return this._clases.has('oculto') }

  append (...n) { for (const x of n) { x.padre = this; this.hijos.push(x) } }
  appendChild (n) { this.append(n); return n }
  remove () { if (this.padre) this.padre.hijos = this.padre.hijos.filter(x => x !== this) }

  encaja (sel) {
    const id = sel.match(/^#([\w-]+)/)
    if (id) return this.id === id[1]
    const clase = sel.match(/^\.([\w-]+)/)
    return Boolean(clase) && this._clases.has(clase[1])
  }

  querySelector (sel) {
    for (const h of this.hijos) {
      if (h.encaja(sel)) return h
      const dentro = h.querySelector(sel)
      if (dentro) return dentro
    }
    return null
  }

  querySelectorAll (sel) {
    const r = []
    for (const h of this.hijos) {
      if (h.encaja(sel)) r.push(h)
      r.push(...h.querySelectorAll(sel))
    }
    return r
  }
}

/**
 * Monta las burbujas y la barra tal como están en el HTML, en el mismo ámbito,
 * y devuelve las funciones reales más los botones para pulsarlos.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.api] el puente con el proceso principal; `null`
 *   monta el modo de ejemplo, que es el que corre al abrir el HTML en un
 *   navegador.
 */
function montar ({ api = null } = {}) {
  const html = fs.readFileSync(APP_HTML, 'utf8')
  const i = html.indexOf(DESDE)
  const j = html.indexOf(HASTA)
  const i2 = html.indexOf(DESDE2)
  const j2 = html.indexOf(HASTA2)
  assert.ok(i > 0 && j > i, `no se encontró el bloque de burbujas en ${APP_HTML}`)
  assert.ok(i2 > j && j2 > i2, `no se encontró el bloque de arrancar y parar en ${APP_HTML}`)
  const codigo = html.slice(i, j) + '\n' + html.slice(i2, j2)

  const raiz = new Nodo('body')
  for (const id of ['conversacion', 'vacio', 'retardo', 'punto', 'txtEstado',
                    'btnEscuchar', 'btnParar', 'preparar', 'envivo', 'pistaEscuchar',
                    'ajustes', 'kSTT', 'kLLM', 'btnAjustes', 'btnCerrarAjustes',
                    'btnGuardarAjustes']) {
    const n = new Nodo('div')
    n.id = id
    raiz.append(n)
  }

  const $ = sel => (raiz.encaja(sel) ? raiz : raiz.querySelector(sel))
  const crear = (t, c) => { const e = new Nodo(t); if (c) e.className = c; return e }

  // Lo que el bloque de arrancar y parar usa de fuera de estos dos bloques.
  class CapturaAudio {
    constructor (o) { this.o = o }
    async empezar () { return { entradaHz: 48000, salidaHz: 16000, etiqueta: 'de prueba' } }
    detener () {}
  }
  const perfil = () => ({ nombre: 'Arturo' })
  const contextoProyecto = () => ({ nombre: 'Rossi' })
  const demo = () => {}

  const fabrica = new Function('$', 'crear', 'api', 'CapturaAudio', 'perfil',
    'contextoProyecto', 'demo',
    `${codigo}\n return {
       pintarFrase, pintarParcial, reemplazarFrase, retardos, resumenAlDetener,
       reiniciarMedidas,
       // Cuántas burbujas provisionales siguen vivas (F037). Función, por lo
       // mismo que las dos de abajo.
       vivas: () => burbujasProvisionales.size,
       // Función y no getter: al repartir el objeto con \`...\` un getter se
       // evalúa una sola vez y se copia el número, así que una prueba podría
       // ponerse verde leyendo un cero viejo. Pasó.
       cortadas: () => frasesCortadas,
       aMedia: () => frasesAMediaFrase,
     }`)

  return {
    raiz,
    retardo: () => raiz.querySelector('#retardo'),
    barra: () => raiz.querySelector('#txtEstado').textContent,
    pulsarParar: () => raiz.querySelector('#btnParar').onclick(),
    pulsarEscuchar: () => raiz.querySelector('#btnEscuchar').onclick(),
    conversacion: () => raiz.querySelector('#conversacion'),
    burbujas: () => raiz.querySelector('#conversacion').querySelectorAll('.burbuja'),
    es: (n = 0) => raiz.querySelector('#conversacion')
      .querySelectorAll('.burbuja')[n].querySelector('.es').textContent,
    it: (n = 0) => raiz.querySelector('#conversacion')
      .querySelectorAll('.burbuja')[n].querySelector('.it').textContent,
    pie: (n = 0) => raiz.querySelector('#conversacion')
      .querySelectorAll('.burbuja')[n].querySelector('.pie').textContent,
    ...fabrica($, crear, api, CapturaAudio, perfil, contextoProyecto, demo),
  }
}

/** Un puente falso que devuelve al detener lo que devuelve `pararSesion`. */
const apiQueDevuelve = alParar => ({
  empezar: async () => ({ ok: true }),
  parar: async () => alParar,
  audio: () => {},
  guardarClaves: async () => ({ ok: true }),
})

describe('el troceo en la barra al detener', () => {
  // `turnosForzados > 0` y al menos una frase con `forzado: true` son el
  // criterio con nombre de la próxima prueba en Windows. Un número que hay que
  // sacar del `.jsonl` a mano no es un criterio, así que aquí se comprueba que
  // llega a la pantalla — pulsando el botón de verdad.

  test('dice cuántas frases se trocearon', async () => {
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 21, costeUsd: 0.0234, stats: { turnosForzados: 2 },
    }) })
    b.pintarFrase({ it: 'a', es: 'a', msTranscribir: 200, msTraducir: 50, forzado: true })
    b.pintarFrase({ it: 'b', es: 'b', msTranscribir: 200, msTraducir: 50 })
    b.pintarFrase({ it: 'c', es: 'c', msTranscribir: 200, msTraducir: 50, forzado: true })

    await b.pulsarParar()

    assert.match(b.barra(), /2 troceadas/, `la barra dice "${b.barra()}"`)
    assert.match(b.barra(), /21 frases/, 'y no puede perder lo que ya decía')
    assert.match(b.barra(), /\$0\.0234/)
  })

  test('la barra dice cuántas frases acabaron a media frase (F031)', async () => {
    // Es el precio del troceo, y en la segunda prueba real hubo que contarlo a
    // mano sobre el `.jsonl`: 10 de 13 trozos forzados [medido]. Un número que
    // se calcula después de la reunión no sirve para decidir durante la
    // reunión si el tope está bien puesto.
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 4, costeUsd: 0.01, stats: { turnosForzados: 2 },
    }) })
    b.pintarFrase({ it: 'E quindi', es: 'Y entonces', msTranscribir: 200, msTraducir: 50, forzado: true, acabaEnPuntuacion: false })
    b.pintarFrase({ it: 'Sono arrivata.', es: 'Llegué.', msTranscribir: 200, msTraducir: 50, acabaEnPuntuacion: true })
    b.pintarFrase({ it: 'in Francia', es: 'en Francia', msTranscribir: 200, msTraducir: 50, forzado: true, acabaEnPuntuacion: false })

    assert.strictEqual(b.aMedia(), 2)
    await b.pulsarParar()
    assert.match(b.barra(), /2 a media frase/, `la barra dice "${b.barra()}"`)
  })

  test('el cero se dice en voz alta, como «sin troceos»', async () => {
    // Callarlo haría indistinguible «ninguna quedó a medias» de «esta versión
    // no lo mide», que es la ambigüedad que ya costó una prueba.
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 2, costeUsd: 0.01, stats: { turnosForzados: 0 },
    }) })
    b.pintarFrase({ it: 'Sono arrivata.', es: 'Llegué.', msTranscribir: 200, msTraducir: 50, acabaEnPuntuacion: true })
    await b.pulsarParar()
    assert.match(b.barra(), /0 a media frase/, `la barra dice "${b.barra()}"`)
  })

  test('una frase sin el campo no se cuenta como frase a medias', async () => {
    // El modo de ejemplo pinta frases sin `acabaEnPuntuacion`. Contarlas como
    // cortadas inventaría el número que la prueba en Windows tiene que leer.
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 1, costeUsd: 0.01, stats: { turnosForzados: 0 },
    }) })
    b.pintarFrase({ it: 'Mm.', es: 'Mm.', msTranscribir: 200, msTraducir: 50 })
    assert.strictEqual(b.aMedia(), 0)
    await b.pulsarParar()
    assert.match(b.barra(), /0 a media frase/, `la barra dice "${b.barra()}"`)
  })

  test('si se pidieron cortes y NINGUNO se aplicó, la barra lo dice', async () => {
    // Éste es el fallo que el criterio busca: el vigilante disparó pero el
    // servidor ignoró el ForceEndpoint. Con un solo número —«2 troceadas»— este
    // caso y «no hizo falta trocear» se verían igual, y son cosas opuestas.
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 18, costeUsd: 0.02, stats: { turnosForzados: 4 },
    }) })
    b.pintarFrase({ it: 'a', es: 'a', msTranscribir: 200, msTraducir: 50 })

    await b.pulsarParar()

    assert.match(b.barra(), /4 troceos pedidos, NINGUNO aplicado/, `la barra dice "${b.barra()}"`)
  })

  test('cuando no hubo troceos se dice en voz alta, no se calla', async () => {
    // Callar sería ambiguo: no se sabría si no hizo falta o si el vigilante no
    // llegó a dispararse nunca, que es justo lo que hay que distinguir.
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 12, costeUsd: 0.01, stats: { turnosForzados: 0 },
    }) })
    await b.pulsarParar()
    assert.match(b.barra(), /sin troceos/, `la barra dice "${b.barra()}"`)
  })

  test('si una frase se quedó traduciéndose al parar, la barra lo dice (F022)', async () => {
    // `frases` cuenta lo que ya está en el `.jsonl`. Si la gracia de
    // `pararSesion` vence con una traducción en vuelo, esa frase se escribe
    // después y no entra en la cuenta: sin este trozo la barra diría «12
    // frases» y el archivo tendría 13, y quien mida la prueba en Windows no
    // sabría cuál de los dos números creer.
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 12, enVuelo: 1, costeUsd: 0.02, stats: { turnosForzados: 0 },
    }) })
    await b.pulsarParar()
    assert.match(b.barra(), /12 frases · 1 aún traduciéndose/, `la barra dice "${b.barra()}"`)
  })

  test('y si no quedó ninguna, no se añade ruido a la barra', async () => {
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 9, enVuelo: 0, costeUsd: 0.02, stats: { turnosForzados: 0 },
    }) })
    await b.pulsarParar()
    assert.doesNotMatch(b.barra(), /traduciéndose/, `la barra dice "${b.barra()}"`)
    assert.match(b.barra(), /9 frases · sin troceos/)
  })

  test('en el modo de ejemplo no se inventa un resumen', async () => {
    const b = montar()                    // sin puente: la interfaz sin sesión
    await b.pulsarParar()
    assert.strictEqual(b.barra(), 'Detenido')
  })

  test('una reunión nueva no arrastra los troceos de la anterior', async () => {
    // Sin reinicio, la segunda reunión de la misma ventana enseñaría los
    // troceos de la primera: un número real midiendo otra reunión.
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 3, costeUsd: 0.01, stats: { turnosForzados: 0 },
    }) })
    b.pintarFrase({
      it: 'a', es: 'a', msTranscribir: 200, msTraducir: 50,
      forzado: true, acabaEnPuntuacion: false,
    })
    assert.strictEqual(b.cortadas(), 1)
    assert.strictEqual(b.aMedia(), 1)

    await b.pulsarEscuchar()              // reunión nueva
    assert.strictEqual(b.cortadas(), 0, 'el contador tiene que empezar de cero')
    assert.strictEqual(b.aMedia(), 0, 'y el de las frases a medias, también')
    assert.deepStrictEqual(b.retardos, [], 'y el p50 no puede mezclar dos reuniones')

    await b.pulsarParar()
    assert.match(b.barra(), /sin troceos/, `la barra dice "${b.barra()}"`)
  })
})

describe('la burbuja de traducción', () => {
  before(() => { assert.ok(fs.existsSync(APP_HTML)) })

  test('enseña el italiano, el español y las dos piernas por separado', () => {
    const b = montar()
    b.pintarFrase({
      it: 'Avevo la febbre a 39.', es: 'Tenía fiebre a 39.',
      ms: 500, msTranscribir: 412, msTraducir: 88,
    })

    const burbuja = b.burbujas()[0]
    assert.strictEqual(burbuja.querySelector('.it').textContent, 'Avevo la febbre a 39.')
    assert.strictEqual(burbuja.querySelector('.es').textContent, 'Tenía fiebre a 39.')
    assert.match(b.pie(), /oír 412/, 'falta la pierna de oír')
    assert.match(b.pie(), /traducir 88/, 'falta la pierna de traducir')
  })

  test('el número grande es la CADENA, aunque llegue un total equivocado', () => {
    // Esto es exactamente lo que llegaba en la primera prueba real: un `ms`
    // que valía lo mismo que `msTraducir`. La pantalla no puede repetirlo.
    const b = montar()
    b.pintarFrase({
      it: 'E la porta si è aperta.', es: 'Y la puerta se abrió.',
      ms: 88, msTranscribir: 412, msTraducir: 88,
    })
    assert.match(b.pie(), /^500 ms/, `el pie dice "${b.pie()}"`)
    assert.match(b.retardo().innerHTML, /500 ms/, 'el rótulo tiene que decir la cadena')
  })

  test('el rótulo enseña la mediana de las últimas frases', () => {
    const b = montar()
    for (const [oir, trad] of [[100, 100], [400, 100], [900, 100]]) {
      b.pintarFrase({ it: 'x', es: 'y', msTranscribir: oir, msTraducir: trad })
    }
    assert.deepStrictEqual(b.retardos, [200, 500, 1000])
    assert.match(b.retardo().innerHTML, /500 ms/)
    assert.strictEqual(b.retardo().oculto, false, 'el rótulo se enseña en cuanto hay una frase')
  })

  test('el aviso de lento mira la cadena, no la traducción sola', () => {
    // Una frase con 1.400 ms de oír y 300 de traducir es lenta de verdad; con
    // el número viejo (300 ms) el aviso no se habría encendido nunca.
    const b = montar()
    b.pintarFrase({ it: 'x', es: 'y', msTranscribir: 1400, msTraducir: 300 })
    assert.ok(b.retardo().classList.contains('lento'),
      `1.700 ms tienen que salir marcados; rótulo: ${b.retardo().innerHTML}`)
  })

  test('sin desglose se enseña lo que haya, sin inventar piernas', () => {
    // El modo de ejemplo de la interfaz pinta frases sin desglose.
    const b = montar()
    b.pintarFrase({ it: 'x', es: 'y', ms: 372 })
    assert.strictEqual(b.pie(), '372 ms')
  })

  test('la de un turno cortado lo dice en el pie, nunca en lo que se lee', () => {
    const b = montar()
    b.pintarFrase({
      it: 'Perché se non riesce ad aprire devo chiamare i pompieri, perché il bagno',
      es: 'Porque si no puede abrir tengo que llamar a los bomberos, porque el baño',
      msTranscribir: 260, msTraducir: 90, forzado: true,
    })

    assert.match(b.pie(), /cortada/, 'la frase puede acabar a media frase y hay que decirlo')
    const burbuja = b.burbujas()[0]
    assert.strictEqual(burbuja.querySelector('.es').textContent,
      'Porque si no puede abrir tengo que llamar a los bomberos, porque el baño',
      'la marca no puede ensuciar el texto que el usuario está leyendo')
    // Decisión, no ley: el aviso vive en el pie, en el mismo gris pequeño que
    // los milisegundos y sin clase propia, porque el usuario está leyendo una
    // reunión. Si alguien quiere resaltarlo, esta prueba se lo hará notar.
    assert.strictEqual(burbuja.className, 'burbuja',
      'sin clases nuevas: nada que parpadee ni resalte en mitad de la reunión')
  })

  test('una frase que nadie cortó no lleva la marca', () => {
    const b = montar()
    b.pintarFrase({ it: 'E la porta si è aperta.', es: 'Y la puerta se abrió.',
      msTranscribir: 200, msTraducir: 50 })
    assert.ok(!/cortada/.test(b.pie()), `el pie dice "${b.pie()}"`)
    assert.strictEqual(b.cortadas(), 0)
  })

  // «parcial» y no «provisional»: desde F037 la burbuja provisional es otra
  // cosa —una oración traducida que aún no ha acabado—, y confundirlas al leer
  // el archivo costaría un rato.
  test('la burbuja del parcial desaparece cuando llega la frase', () => {
    const b = montar()
    b.pintarParcial('Avevo la febbre')
    assert.strictEqual(b.raiz.querySelector('#conversacion').querySelectorAll('.parcial').length, 1)
    b.pintarFrase({ it: 'Avevo la febbre a 39.', es: 'Tenía fiebre.', msTranscribir: 200, msTraducir: 50 })
    assert.strictEqual(b.raiz.querySelector('#conversacion').querySelectorAll('.parcial').length, 0,
      'se quedarían las dos, la provisional y la buena')
    assert.strictEqual(b.burbujas().length, 1)
  })
})

describe('la burbuja provisional y su reemplazo (F037)', () => {
  // Una oración que todavía no ha acabado se pinta igual —esperar al turno
  // siguiente dejaría la pantalla en blanco varios segundos—, pero se pinta
  // DICIENDO que no está cerrada, y cuando llega la traducción entera ocupa su
  // sitio en vez de añadirse debajo. Pegar dos traducciones parciales daría una
  // frase que no dijo nadie, que es justo el fallo que F037 arregla.

  /** Lo que emite el proceso principal para la cola del primer turno. */
  const PROVISIONAL = {
    id: 'pv1', provisional: true,
    it: 'Tu pensi che questo ruolo di Malena ti darà',
    es: 'Crees que este papel de Malena te dará',
    msTranscribir: 300, msTraducir: 120,
  }
  /** Y lo que emite cuando el turno siguiente cierra la pregunta. */
  const DEFINITIVA = {
    idProvisional: 'pv1',
    it: 'Tu pensi che questo ruolo di Malena ti darà la possibilità di fare il salto '
      + 'definitivo a livello internazionale?',
    es: '¿Crees que este papel de Malena te dará la posibilidad de dar el salto '
      + 'definitivo a nivel internacional?',
    msTranscribir: 280, msTraducir: 420, arrastre: true, acabaEnPuntuacion: true,
  }

  test('se ve atenuada y con «…», y no dice «cortada»', () => {
    const b = montar()
    b.pintarFrase({ ...PROVISIONAL, forzado: true })

    const burbuja = b.burbujas()[0]
    assert.ok(burbuja.classList.contains('provisional'),
      `la burbuja lleva las clases "${burbuja.className}"`)
    assert.strictEqual(b.es(), 'Crees que este papel de Malena te dará …',
      'el «…» es lo que dice que la oración sigue')
    // «cortada» habla del turno; esta burbuja ya se ve a medias por el «…», y
    // la que hay que contar como cortada es la frase que quede al final.
    assert.ok(!/cortada/.test(b.pie()), `el pie dice "${b.pie()}"`)
  })

  test('no cuenta ni como troceada, ni como a media frase, ni en el retardo', () => {
    // Si contara, la provisional y su definitiva serían la misma frase contada
    // dos veces, y los tres números de la barra saldrían inflados.
    const b = montar()
    b.pintarFrase({ ...PROVISIONAL, forzado: true, acabaEnPuntuacion: false })
    assert.strictEqual(b.cortadas(), 0)
    assert.strictEqual(b.aMedia(), 0)
    assert.deepStrictEqual(b.retardos, [], 'el p50 mide frases cerradas')
  })

  test('la definitiva ocupa el sitio de la provisional, no se añade debajo', () => {
    const b = montar()
    b.pintarFrase(PROVISIONAL)
    assert.strictEqual(b.burbujas().length, 1)

    b.reemplazarFrase(DEFINITIVA)

    assert.strictEqual(b.burbujas().length, 1,
      'dos burbujas serían la misma frase dicha dos veces, una de ellas a medias')
    assert.strictEqual(b.es(), DEFINITIVA.es, 'se reemplaza entera, no se pega')
    assert.strictEqual(b.it(), DEFINITIVA.it)
    assert.ok(!b.burbujas()[0].classList.contains('provisional'),
      'ya está cerrada: ni atenuada ni con «…»')
    assert.match(b.pie(), /700 ms/, `el pie dice "${b.pie()}"`)
    assert.strictEqual(b.vivas(), 0, 'esa burbuja ya no es de nadie')
  })

  test('al cerrarse SÍ cuenta, y una sola vez', () => {
    const b = montar()
    b.pintarFrase({ ...PROVISIONAL, forzado: true })
    b.reemplazarFrase({ ...DEFINITIVA, forzado: true, acabaEnPuntuacion: true })

    assert.strictEqual(b.cortadas(), 1)
    assert.strictEqual(b.aMedia(), 0, 'esta frase acaba en interrogación')
    assert.deepStrictEqual(b.retardos, [700], 'el retardo se apunta al cerrarse')
    assert.match(b.pie(), /cortada/, 'ahora sí: es una frase definitiva de un turno cortado')
  })

  test('una cola que crece sigue siendo provisional y sigue en su sitio', () => {
    // Dos turnos seguidos sin que el hablante cierre ninguna oración: la
    // traducción de la unión sustituye a la anterior, con el mismo id.
    const b = montar()
    b.pintarFrase(PROVISIONAL)
    b.reemplazarFrase({
      idProvisional: 'pv1', id: 'pv1', provisional: true,
      it: 'Tu pensi che questo ruolo di Malena ti darà la possibilità',
      es: 'Crees que este papel de Malena te dará la posibilidad',
      msTranscribir: 200, msTraducir: 150,
    })

    assert.strictEqual(b.burbujas().length, 1)
    assert.ok(b.burbujas()[0].classList.contains('provisional'))
    assert.strictEqual(b.es(), 'Crees que este papel de Malena te dará la posibilidad …')
    assert.strictEqual(b.vivas(), 1, 'sigue habiendo una cola viva, la misma')
  })

  test('el reemplazo NO mueve el scroll si el usuario había subido a releer', () => {
    // Es la razón por la que esto importa más que en el resto de la
    // conversación: el reemplazo ocurre solo, sin que el usuario toque nada.
    // Si le arrastra la vista mientras relee, la culpa parece del programa.
    const b = montar()
    b.pintarFrase(PROVISIONAL)

    const c = b.conversacion()
    c.scrollHeight = 4000
    c.clientHeight = 300
    c.scrollTop = 100              // subió a releer: le faltan 3.600 px hasta el final

    b.reemplazarFrase(DEFINITIVA)

    assert.strictEqual(c.scrollTop, 100, 'le movió la vista mientras releía')
  })

  test('y sí lo mueve si estaba abajo del todo, como el resto de la conversación', () => {
    const b = montar()
    b.pintarFrase(PROVISIONAL)

    const c = b.conversacion()
    c.scrollHeight = 4000
    c.clientHeight = 300
    c.scrollTop = 3700             // pegado al final

    b.reemplazarFrase(DEFINITIVA)

    assert.strictEqual(c.scrollTop, 4000, 'estando abajo, hay que seguir el final')
  })

  test('un reemplazo sin burbuja que sustituir pinta la frase en vez de perderla', () => {
    // Pasa si la reunión se reinició entre medias. Enseñar el texto en el sitio
    // equivocado es malo; perderlo es peor, porque esa frase ya está pagada.
    const b = montar()
    b.reemplazarFrase(DEFINITIVA)
    assert.strictEqual(b.burbujas().length, 1)
    assert.strictEqual(b.es(), DEFINITIVA.es)
  })

  test('una reunión nueva no deja vivas las provisionales de la anterior', async () => {
    // Sin esto, un id repetido escribiría sobre un nodo que ya no está en
    // pantalla y la frase no se vería en ningún sitio.
    const b = montar({ api: apiQueDevuelve({
      ok: true, frases: 1, costeUsd: 0.01, stats: { turnosForzados: 0 },
    }) })
    b.pintarFrase(PROVISIONAL)
    assert.strictEqual(b.vivas(), 1)

    await b.pulsarEscuchar()
    assert.strictEqual(b.vivas(), 0)
  })
})

describe('el botón «→ Pregunta» de una burbuja (F033)', () => {
  /** Un puente de mentira que sólo apunta las llamadas a `preguntar`. */
  const apiConPreguntar = () => {
    const llamadas = []
    return { api: { preguntar: (it, es) => { llamadas.push({ it, es }); return Promise.resolve({ ok: true }) } }, llamadas }
  }

  test('pulsarlo manda la frase al proceso principal', () => {
    const { api, llamadas } = apiConPreguntar()
    const b = montar({ api })
    b.pintarFrase({ it: 'Il budget copre la manutenzione', es: 'El presupuesto cubre el mantenimiento', ms: 300 })

    b.burbujas()[0].querySelector('.preguntar').onclick()

    assert.strictEqual(llamadas.length, 1)
    assert.deepStrictEqual(llamadas[0], {
      it: 'Il budget copre la manutenzione', es: 'El presupuesto cubre el mantenimiento',
    })
  })

  test('queda «enviada» y un segundo clic no la manda otra vez', () => {
    const { api, llamadas } = apiConPreguntar()
    const b = montar({ api })
    b.pintarFrase({ it: 'x', es: 'y', ms: 100 })

    const boton = b.burbujas()[0].querySelector('.preguntar')
    boton.onclick()
    boton.onclick()
    boton.onclick()

    assert.strictEqual(llamadas.length, 1, 'no se manda dos veces sin querer')
    assert.strictEqual(boton.disabled, true)
    assert.ok(boton.classList.contains('enviada'))
  })

  test('una burbuja provisional (F037) no lleva el botón', () => {
    const b = montar()
    b.pintarFrase({
      id: 'pv1', provisional: true, it: 'Tu pensi che questo ruolo',
      es: 'Crees que este papel', msTranscribir: 300, msTraducir: 120,
    })
    assert.strictEqual(b.burbujas()[0].querySelector('.preguntar'), null,
      'una oración a medias no se puede mandar como pregunta: la va a sustituir otra entera')
  })

  test('el clic no pasa por el cuerpo de la burbuja: leer y seleccionar el texto no se disparan', () => {
    // El botón vive APARTE, no en el `onclick` de la burbuja ni de sus piernas:
    // así seleccionar el texto para copiarlo no manda nada por accidente.
    const b = montar()
    b.pintarFrase({ it: 'Ciao', es: 'Hola', ms: 100 })

    const burbuja = b.burbujas()[0]
    assert.strictEqual(burbuja.onclick, undefined, 'la burbuja entera no tiene manejador de clic')
    assert.strictEqual(burbuja.querySelector('.it').onclick, undefined)
    assert.strictEqual(burbuja.querySelector('.es').onclick, undefined)
  })
})
