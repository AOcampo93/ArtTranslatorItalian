/**
 * Pruebas del punto donde la frase se convierte en número y en línea de
 * archivo: el manejador de `frase` de `mainApp.js` y el cierre de la sesión.
 *
 * ## Por qué se prueba aquí, y por qué así
 *
 * En la primera prueba real las 21 frases se guardaron con `ms` idéntico a
 * `msTraducir` y `msTranscribir: null`. El cronómetro arrancaba cuando el texto
 * YA había llegado, así que lo que el usuario leía como «retardo» era sólo la
 * pierna local y **subestimaba** lo que sentía — que es la dirección peligrosa
 * de equivocarse, porque un número optimista no se investiga.
 *
 * Ese defecto no vive en el transcriptor ni en el traductor: vive en las cinco
 * líneas de `mainApp.js` que arman la frase. Y `mainApp.js` no se puede
 * `require` desde una prueba, porque lo primero que hace es pedir `electron`.
 * Así que se **extraen los tramos reales del archivo** y se ejecutan con piezas
 * de mentira alrededor, igual que se hace con el panel de preguntas del
 * renderer. No es una copia del código: si alguien lo cambia, esto lo ejerce
 * cambiado; si alguien lo saca de su sitio, la extracción falla y se ve.
 *
 * ## Los cuatro tramos, y por qué hacen falta los cuatro (F022)
 *
 * La carrera que destapó F022 **no cabe en un solo tramo**: pasa entre el
 * manejador de `frase` y `pararSesion`, que se comunican por la variable
 * `sesion` del módulo y por el conjunto `enVuelo` de la sesión. Por eso aquí se
 * montan los cuatro tramos **en el mismo ámbito**, compartiendo esa variable:
 *
 *  1. `GRACIA_EN_VUELO_MS` y `esperarEnVuelo` — la espera acotada.
 *  2. El literal de la sesión y la captura `const s = sesion` — si alguien
 *     quita `enVuelo` de ahí, estas pruebas se caen.
 *  3. El manejador de `frase`.
 *  4. `pararSesion`.
 *
 * Con el código de antes de F022, parar a media traducción dejaba la frase sin
 * guardar y pintaba «no se pudo traducir: Cannot read properties of null». Las
 * pruebas de `parar la reunión a media traducción` son exactamente eso.
 *
 * El autoguardado NO se finge: se escribe un `.jsonl` de verdad en un
 * directorio temporal y se lee de vuelta, porque el criterio es justo sobre lo
 * que queda escrito en disco.
 */

'use strict'

const { test, describe, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const { Autosave } = require('../src/autosave')

const MAIN_APP = path.join(__dirname, '..', '..', 'electron-app', 'src', 'mainApp.js')

const esperar = ms => new Promise(r => setTimeout(r, ms))

/** Espera a que se cumpla algo, en vez de dormir una cifra al azar. */
async function hasta (cond, queEsperaba) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await esperar(5)
  }
  assert.fail(`nunca ocurrió: ${queEsperaba}`)
}

/** Una promesa que el propio test decide cuándo resolver. */
function diferido () {
  let soltar = null
  const promesa = new Promise(res => { soltar = res })
  return { promesa, soltar: () => soltar() }
}

/** Saca del archivo el tramo entre dos anclas, y falla si no está donde debe. */
function tramo (fuente, desde, hasta) {
  const i = fuente.indexOf(desde)
  const j = fuente.indexOf(hasta, i + 1)
  assert.ok(i > 0 && j > i,
    `no se encontró el tramo «${desde}» … «${hasta}» en ${MAIN_APP}`)
  return fuente.slice(i, j)
}

/**
 * Monta los tramos reales con un transcriptor, un traductor, un renderer, unos
 * motores y una base de datos falsos, y un autoguardado de verdad sobre un
 * directorio temporal.
 *
 * @param {object} opts
 * @param {Function} opts.traducir            el traductor de mentira
 * @param {string[]} [opts.traza]             orden en que pasan las cosas
 * @param {Function} [opts.alCerrarSocket]    lo que hace el transcriptor al parar
 * @param {boolean}  [opts.autoguardadoRoto]  un directorio donde no se puede escribir
 * @param {Function} [opts.pintar]            sustituye a `aRenderer`
 */
function montar ({ traducir, traza = [], alCerrarSocket, autoguardadoRoto = false, pintar } = {}) {
  const fuente = fs.readFileSync(MAIN_APP, 'utf8')
  const codigo = [
    tramo(fuente, 'const GRACIA_EN_VUELO_MS', '// ── La reunión'),
    tramo(fuente, 'sesion = {', "transcriptor.on('parcial'"),
    tramo(fuente, "transcriptor.on('frase'", "transcriptor.on('estado'"),
    tramo(fuente, 'async function pararSesion', '// ── IPC'),
    // Lo único que añade la prueba: la puerta para entrar al código de arriba.
    'return { pararSesion, sesion: s }',
  ].join('\n')

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'arttranslator-frase-'))
  let directorio = raiz
  if (autoguardadoRoto) {
    // Un ARCHIVO donde el autoguardado espera una carpeta: `mkdirSync` falla con
    // ENOTDIR. Es un fallo de disco de verdad, no un doble que lanza.
    fs.writeFileSync(path.join(raiz, 'ocupado'), 'no soy una carpeta')
    directorio = path.join(raiz, 'ocupado', 'reuniones')
  }
  const autosave = new Autosave({ directorio, idSesion: 'prueba' })
  if (!autoguardadoRoto) autosave.abrir()

  const transcriptor = new EventEmitter()
  transcriptor.stats = { frases: 0, turnosForzados: 0 }
  transcriptor.costeAproximadoUsd = () => '0.02'
  transcriptor.stop = async () => {
    traza.push('socket cerrado')
    // El servidor puede soltar la última frase mientras se espera el acuse de
    // `Terminate`; quien monte la prueba decide si eso pasa.
    if (alCerrarSocket) await alCerrarSocket(transcriptor)
  }

  const pintado = []
  // Se apunta cuántas líneas había YA en el archivo en el instante de pintar:
  // es la única forma de comprobar el orden entre disco y pantalla sin
  // fiarse de leer el código.
  const aRenderer = (canal, datos) => {
    pintado.push({ canal, datos, lineasEnDisco: Autosave.leer(autosave.ruta).entradas.length })
    if (pintar) pintar(canal, datos)
  }

  const alMotor = []
  const alResumen = []
  const motor = { considerar: async (it, es) => { alMotor.push({ it, es }); return null } }
  const resumen = { registrar: (it, es) => { alResumen.push({ it, es }); return false } }

  const cerradas = []
  const db = {
    endSession: (id, datos) => { cerradas.push({ id, ...datos }) },
    vaciar: () => { traza.push('db vaciada') },
  }

  const avisos = []
  const consola = { error: (...partes) => avisos.push(partes.map(String).join(' ')) }

  const traductor = { traducir }
  // `frases.js` entra por la puerta, con las funciones DE VERDAD: el manejador
  // las usa por `require` y aquí no hay `require` dentro del `new Function`.
  // Fingirlas convertiría estas pruebas en una comprobación de los dobles.
  const { partirTurno, arrastrar, acabaCerrada } = require('../src/frases')
  const fabrica = new Function(
    'transcriptor', 'traductor', 'autosave', 'idSesion', 'motor', 'resumen',
    'aRenderer', 'db', 'console', 'sesion',
    'partirTurno', 'arrastrar', 'acabaCerrada', codigo)
  const salida = fabrica(transcriptor, traductor, autosave, 7, motor, resumen,
    aRenderer, db, consola, null, partirTurno, arrastrar, acabaCerrada)

  return {
    transcriptor,
    autosave,
    pintado,
    traza,
    avisos,
    cerradas,
    alMotor,
    alResumen,
    sesion: salida.sesion,
    pararSesion: salida.pararSesion,
    guardadas: () => Autosave.leer(autosave.ruta).entradas,
    burbujas: () => pintado.filter(x => x.canal === 'app:frase').map(x => x.datos),
    // Las definitivas: lo que el usuario acaba leyendo como frase cerrada, sea
    // una burbuja nueva o la sustitución de una provisional (F037).
    definitivas: () => pintado
      .filter(x => (x.canal === 'app:frase' || x.canal === 'app:frase:reemplazo') && !x.datos.provisional)
      .map(x => x.datos),
    provisionales: () => pintado
      .filter(x => (x.canal === 'app:frase' || x.canal === 'app:frase:reemplazo') && x.datos.provisional)
      .map(x => x.datos),
    reemplazos: () => pintado.filter(x => x.canal === 'app:frase:reemplazo').map(x => x.datos),
    estados: () => pintado.filter(x => x.canal === 'app:estado').map(x => x.datos),
    cerrar: () => { autosave.cerrar(); fs.rmSync(raiz, { recursive: true, force: true }) },
  }
}

describe('la frase que se guarda y se pinta', () => {
  before(() => { assert.ok(fs.existsSync(MAIN_APP)) })

  test('el .jsonl guarda las DOS piernas: nunca más un msTranscribir en null', async () => {
    const m = montar({ traducir: async () => ({ es: 'Tenía fiebre a 39.', ms: 7 }) })
    m.transcriptor.emit('frase', {
      texto: 'Avevo la febbre a 39.', msTranscribir: 412,
      msTurno: 3100, acabaEnPuntuacion: true,
    })
    await hasta(() => m.guardadas().length === 1, 'que la frase llegue al disco')

    const e = m.guardadas()[0]
    assert.strictEqual(e.msTranscribir, 412, 'la pierna de oír se guarda tal cual')
    assert.strictEqual(typeof e.msTraducir, 'number')
    assert.strictEqual(e.forzado, false, 'hay que poder distinguir las frases troceadas')
    // Ningún campo de tiempo puede quedarse en null, que es como llegaron las
    // 21 frases de la primera prueba. Las dos excepciones son los campos que
    // sólo existen si NOSOTROS cortamos el turno, y que **tienen que** ser
    // null cuando nadie lo cortó: en `msHolgura` un cero se leería como «el
    // servidor obedeció al instante», y en `motivoCorte` cualquier etiqueta
    // sería un corte que no ocurrió. Las dos son medidas, no ausencias.
    // `msProvisional` se suma a las excepciones desde F037 por la misma razón:
    // es null cuando esta frase NUNCA tuvo burbuja provisional, o sea cuando lo
    // primero que se vio en pantalla fue ya la definitiva. Un cero ahí diría
    // «se vio al instante», que es una medida que nadie ha tomado.
    const sinLosDelCorte = { ...e, msHolgura: 0, motivoCorte: 'silencio', msProvisional: 0 }
    assert.ok(Object.values(sinLosDelCorte).every(v => v !== null),
      `hay un null en ${JSON.stringify(e)}`)
    assert.strictEqual(e.msHolgura, null, 'nadie cortó este turno')
    assert.strictEqual(e.motivoCorte, null, 'nadie cortó este turno')
    m.cerrar()
  })

  test('el .jsonl guarda las cuatro medidas del troceo (F031)', async () => {
    // La segunda prueba en Windows se contó a mano sobre el archivo: cuántos
    // trozos acababan a media oración, y cuánto tardaba el corte en aplicarse.
    // Si estos cuatro campos no llegan al `.jsonl`, la próxima se cuenta igual.
    //
    // Desde F037 «E quindi» no cierra ninguna oración, así que es una COLA:
    // se pinta provisional y no llega al disco hasta que se cierra —aquí, al
    // parar la reunión—. Las cuatro medidas del turno tienen que sobrevivir a
    // ese camino, que es lo que esta prueba vigila ahora.
    const m = montar({ traducir: async () => ({ es: 'Y entonces', ms: 7 }) })
    m.transcriptor.emit('frase', {
      texto: 'E quindi', msTranscribir: 300,
      msTurno: 8420, msHolgura: 260, acabaEnPuntuacion: false, motivoCorte: 'tope-duro',
    })
    await hasta(() => m.provisionales().length === 1, 'que la cola se vea en pantalla')
    await m.pararSesion('prueba', 50)
    assert.strictEqual(m.guardadas().length, 1, 'la cola tiene que acabar en disco')

    const e = m.guardadas()[0]
    assert.strictEqual(e.msTurno, 8420, 'sin esto el exceso del turno no se puede medir')
    assert.strictEqual(e.msHolgura, 260)
    assert.strictEqual(e.acabaEnPuntuacion, false, 'ésta es la que hay que contar')
    // El criterio «0 palabras partidas en trozos forzados CON silencio
    // detectado» se lee de aquí: `msTurno` no distingue un corte en la pausa
    // de uno encima de la voz, porque los dos caen casi en el mismo instante.
    assert.strictEqual(e.motivoCorte, 'tope-duro',
      'sin el motivo, un corte encima de la voz se cuenta igual que uno limpio')
    m.cerrar()
  })

  test('una frase de una versión sin los campos nuevos no inventa medidas', async () => {
    // El transcriptor de ejemplo y cualquier motor que no los emita —hoy
    // `pipeline.js` y `geminiLive.js`—: mejor un null declarado que un cero
    // que se contaría como medida.
    //
    // `acabaEnPuntuacion` es el que más muerde de los tres, porque su cero es
    // `false` y `false` significa «acabó a media oración»: el campo ausente se
    // leería en el archivo como el peor de los dos valores posibles, y de ese
    // archivo sale el «% de trozos a media frase» de la prueba en Windows.
    const m = montar({ traducir: async () => ({ es: 'Llegué.', ms: 7 }) })
    m.transcriptor.emit('frase', { texto: 'Sono arrivata.', msTranscribir: 300 })
    await hasta(() => m.guardadas().length === 1, 'que la frase llegue al disco')

    const e = m.guardadas()[0]
    assert.strictEqual(e.msTurno, null)
    assert.strictEqual(e.msHolgura, null)
    assert.strictEqual(e.acabaEnPuntuacion, null,
      'sin el campo no se sabe, y «no se sabe» no es «a media oración»')
    assert.strictEqual(e.motivoCorte, null,
      'un motivo inventado contaría un corte que nunca se pidió')
    m.cerrar()
  })

  test('un false medido SÍ se guarda como false, no como ausencia', async () => {
    // La contraprueba del anterior: honrar la ausencia no puede borrar la
    // medida. `null` y `false` tienen que significar cosas distintas en el
    // archivo, porque el renderer cuenta con `=== false` y el recuento de la
    // prueba en Windows se hará igual sobre el `.jsonl`.
    const m = montar({ traducir: async () => ({ es: 'Y entonces', ms: 7 }) })
    m.transcriptor.emit('frase', {
      texto: 'E quindi', msTranscribir: 300, acabaEnPuntuacion: false,
    })
    // Cola: al disco cuando se cierra (F037). El texto guardado es el del turno
    // tal cual, así que manda la medida del transcriptor.
    await hasta(() => m.provisionales().length === 1, 'que la cola se vea en pantalla')
    await m.pararSesion('prueba', 50)

    assert.strictEqual(m.guardadas()[0].acabaEnPuntuacion, false)
    m.cerrar()
  })

  test('el retardo guardado es la SUMA de oír y traducir, con reloj de pared', async () => {
    // Con el defecto viejo este número sería sólo el de traducir, o sea ~60 ms
    // cuando el usuario ha esperado ~470.
    //
    // Y el modelo declara MENOS de lo que tarda de verdad, a propósito: es la
    // única forma de distinguir el reloj de pared de `tr.ms`. Si se midiera con
    // lo que el modelo dice, la espera de una frase encolada detrás de otra
    // —que el usuario sufre— no aparecería en ninguna cifra. El umbral tiene
    // que ser DECLARADO estricto: ponerlo en `>= DECLARADO` deja pasar `tr.ms`,
    // que es exactamente lo que se quiere cazar.
    const DECLARADO = 55     // lo que el modelo dice que ha tardado
    const DORMIDO = 60       // lo que tarda de verdad
    const m = montar({
      traducir: async () => {
        await esperar(DORMIDO)
        return { es: 'Y la puerta se abrió.', ms: DECLARADO }
      },
    })
    m.transcriptor.emit('frase', { texto: 'E la porta si è aperta.', msTranscribir: 412 })
    await hasta(() => m.guardadas().length === 1, 'que la frase llegue al disco')

    const e = m.guardadas()[0]
    assert.ok(e.msTraducir > DECLARADO,
      `el reloj de pared tiene que pasar de los ${DECLARADO} ms que declara el modelo; `
      + `midió ${e.msTraducir}`)
    assert.ok(e.msTraducir >= DORMIDO - 5,
      `tardó ${DORMIDO} ms de verdad y midió ${e.msTraducir}`)
    assert.strictEqual(e.ms, e.msTranscribir + e.msTraducir, 'el total tiene que ser la suma')
    assert.ok(e.ms > 412, 'el total no puede ser menor que la pierna de oír')
    m.cerrar()
  })

  test('una frase de turno troceado queda marcada en el archivo', async () => {
    // Sin esta marca, en la próxima reunión real no se podría contar cuántas
    // frases parte el troceo, que es su único coste conocido.
    const m = montar({ traducir: async () => ({ es: 'Porque si no puede abrir', ms: 9 }) })
    m.transcriptor.emit('frase', {
      texto: 'Perché se non riesce ad aprire', msTranscribir: 260, forzado: true,
    })
    // Otra cola (F037): la marca del troceo tiene que llegar al archivo también
    // por el camino de la cola, no sólo por el de la frase cerrada.
    await hasta(() => m.provisionales().length === 1, 'que la cola se vea en pantalla')
    await m.pararSesion('prueba', 50)
    assert.strictEqual(m.guardadas()[0].forzado, true)
    m.cerrar()
  })

  test('la burbuja recibe exactamente lo mismo que el disco', async () => {
    // Si se separan, el usuario ve un número y el informe dice otro.
    const m = montar({ traducir: async () => ({ es: '¡Bravo!', ms: 3 }) })
    m.transcriptor.emit('frase', { texto: 'Brava!', msTranscribir: 201 })
    await hasta(() => m.burbujas().length === 1, 'que la burbuja salga')

    const e = m.guardadas()[0]
    const b = m.burbujas()[0]
    for (const campo of ['it', 'es', 'ms', 'msTranscribir', 'msTraducir', 'forzado']) {
      assert.deepStrictEqual(b[campo], e[campo], `el campo ${campo} no coincide`)
    }
    assert.strictEqual(m.sesion.frases, 1)
    m.cerrar()
  })

  test('con la reunión en marcha la frase sí pasa por el triaje y por el resumen', async () => {
    // El contrapunto de la prueba de más abajo: la puerta que ahorra llamadas
    // al LLM cuando la reunión ya terminó no puede cerrarse antes de tiempo.
    const m = montar({ traducir: async () => ({ es: '¿Cuánto tiempo hace falta?', ms: 5 }) })
    m.transcriptor.emit('frase', { texto: 'Quanto tempo ci vuole?', msTranscribir: 300 })
    await hasta(() => m.alMotor.length === 1, 'que la frase llegue al detector de preguntas')

    assert.deepStrictEqual(m.alMotor[0], {
      it: 'Quanto tempo ci vuole?', es: '¿Cuánto tiempo hace falta?',
    })
    assert.strictEqual(m.alResumen.length, 1, 'y también al resumen')
    m.cerrar()
  })

  test('el disco va ANTES que la pantalla (no negociable §0.3)', async () => {
    // Si la app muere repintando, la frase tiene que estar ya a salvo. Se
    // comprueba mirando el archivo en el instante mismo de pintar: con las dos
    // líneas al revés, aquí habría cero.
    //
    // Con puntuación a propósito: es una frase cerrada, o sea de las que van al
    // archivo. La cola provisional no se guarda (F037) y aquí se mide justo el
    // orden entre disco y pantalla.
    const m = montar({ traducir: async () => ({ es: '¡Hola!', ms: 1 }) })
    m.transcriptor.emit('frase', { texto: 'Ciao!', msTranscribir: 100 })
    await hasta(() => m.burbujas().length === 1, 'que la burbuja salga')

    const pintadaLaFrase = m.pintado.find(x => x.canal === 'app:frase')
    assert.strictEqual(pintadaLaFrase.lineasEnDisco, 1,
      'se pintó antes de que la frase estuviera escrita')
    m.cerrar()
  })

  test('si la traducción falla no se guarda una frase a medias, y se dice', async () => {
    const m = montar({ traducir: async () => { throw new Error('modelo no cargado') } })
    m.transcriptor.emit('frase', { texto: 'Cocciuta.', msTranscribir: 300 })
    await hasta(() => m.pintado.length > 0, 'que el fallo se cuente en pantalla')

    assert.deepStrictEqual(m.guardadas(), [], 'nada a medias en el archivo')
    const aviso = m.pintado.find(x => x.canal === 'app:estado')
    assert.match(aviso.datos.texto, /no se pudo traducir: modelo no cargado/)
    m.cerrar()
  })

  test('un fallo al GUARDAR no se pinta como un fallo de traducción', async () => {
    // El fallo que destapó F022 pintaba «no se pudo traducir: Cannot read
    // properties of null» con la traducción hecha y correcta. Aquí la
    // traducción también sale bien y lo que falla es el disco: tiene que
    // decirse con su nombre, porque confundirlos manda a investigar al sitio
    // equivocado —el usuario concluye que el traductor no sirve—.
    const m = montar({
      traducir: async () => ({ es: 'Sí, lo confirmo.', ms: 4 }),
      autoguardadoRoto: true,
    })
    m.transcriptor.emit('frase', { texto: 'Sì, lo confermo.', msTranscribir: 150 })
    await hasta(() => m.burbujas().length === 1, 'que la burbuja se pinte igual')

    const estados = m.estados()
    assert.strictEqual(estados.length, 1, `se pintó de más: ${JSON.stringify(estados)}`)
    assert.match(estados[0].texto, /^no se pudo guardar la frase: /)
    assert.doesNotMatch(estados[0].texto, /no se pudo traducir/)
    assert.strictEqual(estados[0].clase, 'mal')
    assert.strictEqual(m.burbujas()[0].es, 'Sí, lo confirmo.',
      'la traducción salió bien y el usuario tiene que verla')
    assert.strictEqual(m.sesion.frases, 0,
      'no se cuenta como guardada una frase que no llegó al disco')
    assert.ok(m.avisos.some(a => /\[autoguardado\]/.test(a)), 'y queda en el registro')
    m.cerrar()
  })

  test('un fallo al pintar no tumba el proceso ni pierde la frase', async () => {
    // Una promesa rechazada sin dueño tumba el proceso en Node, y aquí eso
    // sería perder la reunión entera por un repintado. Además la tarea tiene
    // que salir de `enVuelo` igual, o la gracia de `pararSesion` esperaría a un
    // fantasma hasta el tope.
    const m = montar({
      traducir: async () => ({ es: 'Buenos días.', ms: 2 }),
      pintar: canal => { if (canal === 'app:frase') throw new Error('renderer muerto') },
    })
    m.transcriptor.emit('frase', { texto: 'Buongiorno.', msTranscribir: 120 })
    await hasta(() => m.avisos.some(a => /fallo inesperado/.test(a)),
      'que el fallo inesperado quede en el registro')

    assert.strictEqual(m.guardadas().length, 1, 'la frase estaba en disco antes de pintar')
    assert.deepStrictEqual(m.estados(), [], 'un fallo de programación no se le cuenta al usuario')
    await hasta(() => m.sesion.enVuelo.size === 0, 'que la tarea salga de enVuelo')
    m.cerrar()
  })
})

describe('parar la reunión a media traducción (F022)', () => {
  test('la frase en vuelo NO se pierde, y el socket se cierra antes de esperarla', async () => {
    const traza = []
    const puerta = diferido()
    const m = montar({
      traza,
      traducir: async () => {
        traza.push('traduciendo')
        await puerta.promesa
        return { es: 'El presupuesto cubre también el mantenimiento.', ms: 40 }
      },
    })

    m.transcriptor.emit('frase', {
      texto: 'Il budget copre anche la manutenzione.', msTranscribir: 380,
    })
    await hasta(() => traza.includes('traduciendo'), 'que la traducción arranque')
    assert.deepStrictEqual(m.guardadas(), [], 'todavía no hay nada escrito')

    // Detener AQUÍ es la carrera: entre el transcriptor y el traductor.
    const parada = m.pararSesion()
    await hasta(() => traza.includes('socket cerrado'), 'que el socket se cierre')
    assert.deepStrictEqual(traza, ['traduciendo', 'socket cerrado'],
      'el socket se cierra SIN esperar a la traducción: abierto cuesta dinero')
    assert.strictEqual(m.sesion.cerrada, true)

    puerta.soltar()          // la traducción vuelve con la sesión ya cerrada
    const r = await parada

    // Primero el criterio 4, que es el que explica el defecto. Se espera a que
    // el manejador acabe DE UNA FORMA O DE OTRA —una burbuja o un aviso— en vez
    // de dar por hecho que ya acabó: con el código viejo `pararSesion` volvía
    // antes de que la traducción resumiera, y mirar aquí no vería nada. Y lo que
    // el código viejo pintaba un instante después era «no se pudo traducir:
    // Cannot read properties of null (reading 'frases')» —un error de
    // programación con la cara del único fallo que el usuario sabe interpretar,
    // con la traducción hecha y correcta—.
    await hasta(() => m.pintado.length > 0, 'que el manejador de la frase acabe')
    assert.deepStrictEqual(m.estados(), [],
      `no se pinta ningún fallo, y menos uno de traducción: ${JSON.stringify(m.estados())}`)

    assert.strictEqual(m.guardadas().length, 1, 'la frase en vuelo no puede perderse')
    const e = m.guardadas()[0]
    assert.strictEqual(e.it, 'Il budget copre anche la manutenzione.')
    assert.strictEqual(e.es, 'El presupuesto cubre también el mantenimiento.')
    assert.strictEqual(e.msTranscribir, 380, 'y con sus dos piernas, como cualquier otra')
    assert.strictEqual(e.ms, e.msTranscribir + e.msTraducir)

    assert.strictEqual(r.enVuelo, 0, 'la gracia alcanzó: no quedó ninguna sin esperar')
    assert.strictEqual(r.frases, 1, 'el pie de la interfaz cuenta la frase')
    assert.strictEqual(m.cerradas.length, 1, 'y la sesión se cierra en la base de datos')
    assert.strictEqual(m.cerradas[0].lineCount, 1,
      'lineCount tiene que coincidir con las líneas del .jsonl')
    m.cerrar()
  })

  test('la frase llega al autoguardado aunque la gracia haya vencido y el archivo esté cerrado', async () => {
    const traza = []
    const puerta = diferido()
    const m = montar({
      traza,
      traducir: async () => {
        traza.push('traduciendo')
        await puerta.promesa
        return { es: 'Tenemos que revisar los plazos.', ms: 90 }
      },
    })

    m.transcriptor.emit('frase', { texto: 'Dobbiamo rivedere i tempi.', msTranscribir: 300 })
    await hasta(() => traza.includes('traduciendo'), 'que la traducción arranque')

    // Gracia de 20 ms en vez de los 3.000 de producción: así la prueba ejerce
    // el VENCIMIENTO sin dormir tres segundos. Lo que se comprueba es que
    // `pararSesion` vuelve sin la traducción, no cuánto espera.
    const r = await m.pararSesion('el usuario paró', 20)

    assert.strictEqual(r.enVuelo, 1, 'tiene que decir que una se quedó en vuelo')
    assert.strictEqual(r.frases, 0, 'al cerrar todavía no había nada en disco')
    assert.deepStrictEqual(m.guardadas(), [])
    assert.strictEqual(m.autosave.abierto, false, 'el archivo de la sesión quedó cerrado')
    assert.ok(m.avisos.some(a => /seguían traduciéndose al cerrar/.test(a)),
      'y queda dicho en el registro, no en silencio')

    // Y ahora vuelve la traducción, con la sesión cerrada y el archivo cerrado.
    // Esto es el criterio 2 de F022: la frase está pagada y tiene que acabar en
    // disco igual.
    puerta.soltar()
    await hasta(() => m.guardadas().length === 1,
      'que la frase tardía llegue al disco con la sesión ya cerrada')

    const guardado = Autosave.leer(m.autosave.ruta)
    assert.strictEqual(guardado.entradas[0].es, 'Tenemos que revisar los plazos.')
    assert.strictEqual(guardado.entradas[0].msTranscribir, 300)
    assert.strictEqual(guardado.truncadas, 0, 'la línea tardía no corrompe el archivo')
    assert.strictEqual(m.autosave.abierto, false,
      'quien reabrió el archivo para escribir lo vuelve a cerrar')
    assert.strictEqual(m.sesion.frases, 1)
    assert.deepStrictEqual(m.estados(), [], 'y nada de fallos pintados')

    // La reunión terminó: una respuesta sugerida que nadie va a leer cuesta una
    // llamada al LLM y se pintaría en un panel que ya no está.
    assert.deepStrictEqual(m.alMotor, [], 'no se gasta una llamada al LLM tras parar')
    assert.deepStrictEqual(m.alResumen, [])
    m.cerrar()
  })

  test('si la escritura tardía falla DESPUÉS de reabrir, no queda un descriptor colgando', async () => {
    // El invariante que este arreglo promete: la frase tardía reabre el archivo
    // de la sesión (está en modo append) y quien lo reabrió lo vuelve a cerrar.
    //
    // El camino que hay que alcanzar es el que **falla con el archivo ya
    // abierto**: `escribir()` hace `abrir()` y LUEGO `writeSync()`, así que un
    // disco lleno o un EIO revientan con el descriptor recién creado en la mano.
    // La prueba de ENOTDIR de más arriba no vale para esto: rompe dentro de
    // `mkdirSync`, o sea antes de que exista descriptor alguno.
    const m = montar({ traducir: async () => ({ es: 'Muy bien.', ms: 3 }) })
    // Una frase normal primero: así el archivo tiene contenido que la escritura
    // fallida de después no puede estropear.
    m.transcriptor.emit('frase', { texto: 'Molto bene.', msTranscribir: 140 })
    await hasta(() => m.guardadas().length === 1, 'que la primera frase llegue al disco')

    await m.pararSesion()                     // la sesión cierra su archivo
    assert.strictEqual(m.autosave.abierto, false, 'de aquí tiene que partir cerrado')

    // Se finge la forma real del fallo —ENOSPC dentro de `writeSync`— sobre el
    // `Autosave` de verdad. Se dejan pasar los descriptores 0, 1 y 2: el propio
    // corredor de pruebas escribe por ahí cuando la salida va a un archivo, y
    // hacerle fallar eso rompería la ejecución en vez de probar nada.
    const writeSyncReal = fs.writeSync
    fs.writeSync = (fd, ...resto) => {
      if (fd <= 2) return writeSyncReal(fd, ...resto)
      const err = new Error('no queda espacio en el dispositivo')
      err.code = 'ENOSPC'
      throw err
    }
    try {
      m.transcriptor.emit('frase', { texto: 'Arrivederci.', msTranscribir: 160 })
      await hasta(() => m.estados().length > 0, 'que el fallo al guardar se cuente')
    } finally {
      fs.writeSync = writeSyncReal
    }

    assert.strictEqual(m.autosave.abierto, false,
      'la escritura reabrió el archivo, falló, y nadie cerró el descriptor')
    assert.match(m.estados()[0].texto, /^no se pudo guardar la frase: /)
    assert.match(m.estados()[0].texto, /no queda espacio/,
      'y el fallo tiene que venir de la ESCRITURA, no de crear la carpeta')
    const guardado = Autosave.leer(m.autosave.ruta)
    assert.deepStrictEqual(guardado.entradas.map(e => e.it), ['Molto bene.'],
      'la escritura fallida no puede añadir nada ni tocar lo que ya estaba')
    assert.strictEqual(guardado.truncadas, 0, 'y no deja una línea a medias')
    assert.strictEqual(m.sesion.frases, 1,
      'sólo cuenta la frase que sí se escribió; la que falló no')
    m.cerrar()
  })

  test('con la reunión en marcha el archivo se queda abierto entre frases', async () => {
    // El otro lado del mismo invariante: sólo se cierra el descriptor que la
    // frase tardía ha tenido que REABRIR. Cerrar siempre dejaría la reunión
    // abriendo y cerrando el archivo en cada frase, que es exactamente lo que
    // el autoguardado en modo append existe para no hacer.
    const m = montar({ traducir: async () => ({ es: 'Sí.', ms: 2 }) })
    m.transcriptor.emit('frase', { texto: 'Sì.', msTranscribir: 100 })
    await hasta(() => m.guardadas().length === 1, 'que la frase llegue al disco')

    assert.strictEqual(m.autosave.abierto, true,
      'el archivo de la reunión no se cierra entre frases')
    m.cerrar()
  })

  test('la última frase que suelta el servidor al recibir Terminate no se pierde', async () => {
    // La otra puerta del mismo defecto, y la que más se parece a una reunión de
    // verdad: `stop()` manda `Terminate` y el acuse tarda 1.067–1.224 ms
    // [medido]; en esa ventana el servidor puede soltar el turno final. Con el
    // código viejo `sesion` ya era null cuando volvía su traducción.
    const m = montar({
      traducir: async () => ({ es: 'Hasta luego a todos.', ms: 8 }),
      alCerrarSocket: t => t.emit('frase', { texto: 'Arrivederci a tutti.', msTranscribir: 210 }),
    })

    const r = await m.pararSesion()

    assert.strictEqual(m.guardadas().length, 1,
      'la frase del cierre tiene que estar en el .jsonl')
    assert.strictEqual(m.guardadas()[0].it, 'Arrivederci a tutti.')
    assert.strictEqual(r.frases, 1)
    assert.strictEqual(r.enVuelo, 0)
    assert.strictEqual(m.cerradas[0].lineCount, 1)
    assert.deepStrictEqual(m.estados(), [])
    m.cerrar()
  })

  test('dos frases en vuelo: se espera a las dos, y una que falla no arrastra a la otra', async () => {
    const traza = []
    const buena = diferido()
    const mala = diferido()
    const m = montar({
      traza,
      traducir: async texto => {
        traza.push(`traduciendo ${texto}`)
        if (texto === 'Uno.') { await buena.promesa; return { es: 'Uno.', ms: 5 } }
        await mala.promesa
        throw new Error('modelo no cargado')
      },
    })

    m.transcriptor.emit('frase', { texto: 'Uno.', msTranscribir: 100 })
    m.transcriptor.emit('frase', { texto: 'Due.', msTranscribir: 110 })
    await hasta(() => m.sesion.enVuelo.size === 2, 'que las dos estén en vuelo')

    const parada = m.pararSesion()
    await hasta(() => traza.includes('socket cerrado'), 'que el socket se cierre')
    mala.soltar()
    buena.soltar()
    const r = await parada

    assert.strictEqual(r.enVuelo, 0, 'se esperó a las dos, no a la primera que volviera')
    assert.strictEqual(r.frases, 1, 'sólo una llegó a traducirse')
    assert.strictEqual(m.guardadas().length, 1)
    assert.strictEqual(m.guardadas()[0].it, 'Uno.')
    const estados = m.estados()
    assert.strictEqual(estados.length, 1, 'la que falló se cuenta una vez')
    assert.match(estados[0].texto, /no se pudo traducir: modelo no cargado/)
    m.cerrar()
  })

  test('parar dos veces no cierra dos sesiones ni cuenta dos veces', async () => {
    // El botón se puede pulsar dos veces, y la ventana puede cerrarse justo
    // después de pulsarlo: `before-quit` llama otra vez.
    const m = montar({ traducir: async () => ({ es: 'Vale.', ms: 3 }) })
    const primera = await m.pararSesion()
    const segunda = await m.pararSesion()

    assert.strictEqual(primera.ok, true)
    assert.deepStrictEqual(segunda, { ok: true }, 'la segunda no repite el cierre')
    assert.strictEqual(m.cerradas.length, 1, 'la base de datos se cierra una sola vez')
    m.cerrar()
  })
})

describe('la burbuja es la frase, no el turno (F037)', () => {
  // Las dos cadenas son las EXACTAS de `sesion-2.jsonl`, líneas 4 y 5
  // `[medido]`. Traducido el segundo trozo por su cuenta, Marian devolvió
  // «¿Cómo se puede dar el salto definitivo a nivel internacional?»: inventó el
  // «Cómo» para cerrar la pregunta que no había visto empezar.
  const MALENA_1 = 'Tu pensi che questo ruolo di Malena ti darà'
  const MALENA_2 = "la possibilità di fare il salto definitivo a livello internazionale? "
    + "Ma il salto definitivo per un'attrice non c'è mai, perché c'è un film che"

  /** Monta con un Marian que apunta TODO lo que se le manda. */
  function conMarian (extra = {}) {
    const pedidos = []
    const m = montar({
      traducir: async texto => { pedidos.push(texto); return { es: `[es] ${texto}`, ms: 5 } },
      ...extra,
    })
    m.pedidos = pedidos
    return m
  }

  test('a Marian no le llega nunca una oración empezada por la mitad', async () => {
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300, forzado: true })
    await hasta(() => m.provisionales().length === 1, 'que salga la burbuja provisional')
    m.transcriptor.emit('frase', { texto: MALENA_2, msTranscribir: 280, forzado: true })
    await hasta(() => m.reemplazos().length === 1, 'que la definitiva sustituya a la provisional')

    // Éste es el criterio, y se comprueba sobre lo que se le pidió a Marian:
    // ninguna petición empieza por «la possibilità».
    for (const pedido of m.pedidos) {
      assert.ok(!pedido.startsWith('la possibilità'),
        `se le mandó a Marian un trozo a media frase: «${pedido.slice(0, 50)}…»`)
    }
    const definitiva = m.definitivas()[0]
    assert.strictEqual(definitiva.it,
      'Tu pensi che questo ruolo di Malena ti darà la possibilità di fare il salto '
      + 'definitivo a livello internazionale?',
      'la pregunta tiene que llegar entera, desde «Tu pensi»')
    assert.strictEqual(definitiva.arrastre, true, 'y el archivo tiene que decir que se unió')
    m.cerrar()
  })

  test('una llamada a Marian, una burbuja: nada se pega ni se alinea', async () => {
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    m.transcriptor.emit('frase', { texto: MALENA_2, msTranscribir: 280 })
    await hasta(() => m.provisionales().length === 2, 'la cola nueva')

    // Tres burbujas en pantalla en total: la provisional del primer turno, la
    // definitiva que la sustituye y la cola nueva. Tres llamadas, ni una más.
    assert.strictEqual(m.pedidos.length, 3, `se pidieron ${JSON.stringify(m.pedidos)}`)
    const pintado = m.definitivas().length + m.provisionales().length
    assert.strictEqual(pintado, 3)
    // Y el texto de cada burbuja es EXACTAMENTE lo que se tradujo, sin recortes.
    for (const frase of [...m.definitivas(), ...m.provisionales()]) {
      assert.ok(m.pedidos.includes(frase.it), `«${frase.it}» no se tradujo tal cual`)
      assert.strictEqual(frase.es, `[es] ${frase.it}`)
    }
    m.cerrar()
  })

  test('el reemplazo apunta a la burbuja que hay que sustituir', async () => {
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    const idProvisional = m.provisionales()[0].id
    assert.ok(idProvisional, 'una burbuja provisional sin id no se puede sustituir')

    m.transcriptor.emit('frase', { texto: MALENA_2, msTranscribir: 280 })
    await hasta(() => m.provisionales().length === 2, 'el reemplazo y la cola nueva')

    assert.strictEqual(m.reemplazos().length, 1, 'un solo reemplazo: el de la definitiva')
    assert.strictEqual(m.reemplazos()[0].idProvisional, idProvisional)
    assert.notStrictEqual(m.provisionales()[1].id, idProvisional,
      'la cola nueva es otra burbuja, no la misma')
    m.cerrar()
  })

  test('al .jsonl sólo van líneas definitivas', async () => {
    // El archivo es el instrumento de medida de la prueba en Windows: una
    // provisional y su definitiva serían la misma frase contada dos veces, y el
    // `lineCount` de la base de datos diría lo mismo.
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    assert.deepStrictEqual(m.guardadas(), [], 'la cola no se guarda: todavía no es una frase')

    m.transcriptor.emit('frase', { texto: MALENA_2, msTranscribir: 280 })
    await hasta(() => m.guardadas().length === 1, 'que la definitiva llegue al disco')

    assert.strictEqual(m.guardadas().length, 1)
    assert.strictEqual(m.sesion.frases, 1, 'lineCount cuenta lo que está en el archivo')
    assert.ok(!('provisional' in m.guardadas()[0]))
    m.cerrar()
  })

  test('el motor de respuestas y el resumen NO ven la cola provisional', async () => {
    // Una pregunta leída a medias se contesta a medias, y esa respuesta es la
    // que el usuario va a decir en voz alta en la reunión.
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    assert.deepStrictEqual(m.alMotor, [], 'la cola no puede llegar al triaje');
    assert.deepStrictEqual(m.alResumen, [])

    m.transcriptor.emit('frase', { texto: MALENA_2, msTranscribir: 280 })
    await hasta(() => m.alMotor.length === 1, 'que la frase cerrada sí llegue')

    assert.strictEqual(m.alMotor.length, 1, 'una frase, una consideración')
    assert.ok(m.alMotor[0].it.startsWith('Tu pensi'),
      `al motor le llegó «${m.alMotor[0].it.slice(0, 40)}…»`)
    assert.ok(m.alMotor[0].it.endsWith('internazionale?'), 'y con la pregunta cerrada')
    assert.deepStrictEqual(m.alResumen, m.alMotor, 'el resumen ve lo mismo que el motor')
    m.cerrar()
  })

  test('msProvisional dice cuánto tardó en verse ALGO de esa frase', async () => {
    // Es el número que sostiene «la pantalla sigue mostrando algo enseguida»
    // aunque la frase tarde dos turnos en cerrarse. Sin él, el archivo sólo
    // tendría el retardo de la definitiva y parecería que se tardó más.
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    m.transcriptor.emit('frase', { texto: MALENA_2, msTranscribir: 280 })
    await hasta(() => m.guardadas().length === 1, 'la definitiva')

    const linea = m.guardadas()[0]
    assert.strictEqual(typeof linea.msProvisional, 'number',
      'la frase venía de una provisional: ese tiempo está medido')
    assert.ok(linea.msProvisional >= 0)
    m.cerrar()
  })

  test('una frase que nunca fue provisional no inventa msProvisional', async () => {
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: 'Sono arrivata.', msTranscribir: 300 })
    await hasta(() => m.guardadas().length === 1, 'la frase')

    const linea = m.guardadas()[0]
    assert.strictEqual(linea.msProvisional, null,
      'lo primero que se vio fue ya la definitiva, y ese tiempo es `ms`')
    assert.strictEqual(linea.arrastre, false)
    assert.strictEqual(linea.cierre, 'frase')
    m.cerrar()
  })

  test('acabaEnPuntuacion es del TEXTO guardado cuando la línea la componemos nosotros', async () => {
    // El transcriptor mide el turno, y desde F037 la línea ya no es el turno.
    // Los dos turnos llegan marcados `acabaEnPuntuacion: false` —los dos acaban
    // a media oración— y la frase que sale de unirlos acaba en interrogación:
    // guardar ahí un `false` heredado falsearía el «% a media frase» de la
    // prueba en Windows, que se cuenta justo sobre este campo.
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300, acabaEnPuntuacion: false })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    m.transcriptor.emit('frase', { texto: MALENA_2, msTranscribir: 280, acabaEnPuntuacion: false })
    await hasta(() => m.guardadas().length === 1, 'la definitiva')

    assert.strictEqual(m.guardadas()[0].acabaEnPuntuacion, true,
      'esta frase acaba en «internazionale?»')
    m.cerrar()
  })

  test('los campos del corte son los del ÚLTIMO turno que compone la frase', async () => {
    // Criterio elegido, no heredado: describen el corte con el que la línea se
    // cerró, que es el único que pudo partir una palabra suya.
    const m = conMarian()
    m.transcriptor.emit('frase', {
      texto: MALENA_1, msTranscribir: 300, forzado: true,
      msTurno: 6100, msHolgura: 200, motivoCorte: 'silencio',
    })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    m.transcriptor.emit('frase', {
      texto: MALENA_2, msTranscribir: 280, forzado: true,
      msTurno: 8000, msHolgura: 460, motivoCorte: 'tope-duro',
    })
    await hasta(() => m.guardadas().length === 1, 'la definitiva')

    const linea = m.guardadas()[0]
    assert.strictEqual(linea.msTurno, 8000)
    assert.strictEqual(linea.msHolgura, 460)
    assert.strictEqual(linea.motivoCorte, 'tope-duro')
    assert.strictEqual(linea.msTranscribir, 280)
    m.cerrar()
  })

  test('pasado el tope de arrastre la cola se cierra y queda marcada', async () => {
    // La única excepción admitida al criterio: arrastrar se paga por carácter
    // —Marian escala `56 + 6,34·caracteres` ms [medido]—, así que una cola que
    // crece sin freno acabaría retrasando la burbuja que la sustituye.
    const largo = 'e poi ha detto che non era vero e che nessuno gliel\'aveva chiesto '.repeat(6).trim()
    assert.ok(largo.length > 300, 'la cola de esta prueba tiene que pasar del tope')

    const m = conMarian()
    m.transcriptor.emit('frase', { texto: largo, msTranscribir: 300, acabaEnPuntuacion: false })
    await hasta(() => m.provisionales().length === 1, 'la provisional larga')
    m.transcriptor.emit('frase', { texto: 'Poi è uscito.', msTranscribir: 200, acabaEnPuntuacion: true })
    await hasta(() => m.guardadas().length === 2, 'las dos frases cerradas')

    const [cerradaPorTope, siguiente] = m.guardadas()
    assert.strictEqual(cerradaPorTope.it, largo)
    assert.strictEqual(cerradaPorTope.cierre, 'tope',
      'sin esta marca, el archivo no distingue esta frase de una que acabó bien')
    // El texto guardado es el del turno tal cual, así que aquí manda la medida
    // del transcriptor, que es la que hay.
    assert.strictEqual(cerradaPorTope.acabaEnPuntuacion, false)
    assert.strictEqual(siguiente.it, 'Poi è uscito.')
    assert.strictEqual(siguiente.arrastre, false, 'el turno nuevo va solo: la cola se soltó')
    // Y no se vuelve a llamar a Marian para cerrarla: esa traducción ya está
    // hecha y pagada.
    assert.strictEqual(m.pedidos.filter(t => t === largo).length, 1)
    m.cerrar()
  })

  test('al parar, la cola que quedaba en pantalla acaba en el archivo (§0.3)', async () => {
    // Es la última frase que dijo el interlocutor. Sin esto se perdería, que es
    // justo lo que el autoguardado promete que no pasa.
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: 'E quindi il film diventa', msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    assert.deepStrictEqual(m.guardadas(), [])

    const r = await m.pararSesion('prueba', 50)

    assert.strictEqual(m.guardadas().length, 1, 'la cola tiene que acabar en disco')
    assert.strictEqual(m.guardadas()[0].it, 'E quindi il film diventa')
    assert.strictEqual(m.guardadas()[0].cierre, 'parada')
    assert.strictEqual(r.frases, 1, 'y entrar en la cuenta que va a la base de datos')
    assert.strictEqual(m.cerradas[0].lineCount, 1)
    // Sin otra llamada a Marian: la traducción ya estaba hecha.
    assert.strictEqual(m.pedidos.length, 1)
    m.cerrar()
  })

  test('una frase que llega tarde tampoco deja su cola sin guardar', async () => {
    // La traducción vence la gracia de `pararSesion`: cuando termina, la
    // reunión ya está cerrada y nadie va a volver a pasar por la cola.
    const diferida1 = diferido()
    const m = conMarian({
      traducir: async texto => {
        await diferida1.promesa
        return { es: `[es] ${texto}`, ms: 5 }
      },
    })
    m.transcriptor.emit('frase', { texto: 'E quindi il film diventa', msTranscribir: 300 })
    const parada = m.pararSesion('prueba', 20)
    await hasta(() => m.traza.includes('socket cerrado'), 'que el socket se cierre')
    const r = await parada
    assert.strictEqual(r.enVuelo, 1, 'la gracia tenía que vencer para probar esto')

    diferida1.soltar()
    await hasta(() => m.guardadas().length === 1, 'que la cola tardía se guarde igual')
    assert.strictEqual(m.guardadas()[0].cierre, 'parada')
    m.cerrar()
  })

  test('los turnos se procesan en serie: la cola de uno no se la pisa el siguiente', async () => {
    // Dos turnos a la vez leerían la misma cola y la traducirían dos veces, por
    // la mitad. Se fuerza soltando la primera traducción DESPUÉS de que haya
    // llegado el segundo turno.
    const primera = diferido()
    let n = 0
    const m = montar({
      traducir: async texto => {
        n++
        if (n === 1) await primera.promesa
        return { es: `[es] ${texto}`, ms: 5 }
      },
    })
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300 })
    m.transcriptor.emit('frase', { texto: MALENA_2, msTranscribir: 280 })
    await esperar(20)
    assert.strictEqual(n, 1, 'el segundo turno tiene que esperar al primero')

    primera.soltar()
    await hasta(() => m.guardadas().length === 1, 'la frase cerrada')

    assert.strictEqual(m.guardadas()[0].it,
      'Tu pensi che questo ruolo di Malena ti darà la possibilità di fare il salto '
      + 'definitivo a livello internazionale?',
      'si el segundo turno no esperara, la pregunta se habría traducido partida')
    m.cerrar()
  })

  test('si Marian falla con la unión, la cola se cierra y no se inventa una frase', async () => {
    // El trato de siempre —una frase que no se puede traducir no se guarda— se
    // mantiene para el turno que falla. Lo que NO puede pasar es que la cola se
    // quede esperando: uniéndola a un turno con el que ya no es contigua
    // saldría una frase que no dijo nadie, y ésa sí acabaría en el archivo
    // como si fuera una transcripción.
    const m = montar({
      traducir: async texto => {
        if (texto.includes('internazionale')) throw new Error('modelo no cargado')
        return { es: `[es] ${texto}`, ms: 5 }
      },
    })
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    m.transcriptor.emit('frase', { texto: MALENA_2, msTranscribir: 280 })
    await hasta(() => m.estados().length === 1, 'el aviso de que no se pudo traducir')
    assert.match(m.estados()[0].texto, /no se pudo traducir: modelo no cargado/)

    // La cola sí se guarda: estaba traducida y pagada.
    await hasta(() => m.guardadas().length === 1, 'que la cola se cierre en el archivo')
    assert.strictEqual(m.guardadas()[0].it, MALENA_1)
    assert.strictEqual(m.guardadas()[0].cierre, 'fallo')

    m.transcriptor.emit('frase', { texto: 'Questo è un lavoro difficile.', msTranscribir: 200 })
    await hasta(() => m.guardadas().length === 2, 'la frase siguiente')

    assert.strictEqual(m.guardadas()[1].it, 'Questo è un lavoro difficile.')
    assert.strictEqual(m.guardadas()[1].arrastre, false,
      'la cola vieja no puede pegarse a un turno con el que ya no es contigua')
    assert.strictEqual(m.guardadas()[0].empiezaAMedias, false,
      'la cola que se cierra por el fallo empezaba donde empezaba su oración')
    assert.strictEqual(m.guardadas()[1].empiezaAMedias, true,
      'el turno que la continuaba se perdió: ESTA es la línea que se queda sin principio')
    for (const linea of m.guardadas()) {
      assert.ok(!(linea.it.includes('Malena') && linea.it.includes('lavoro difficile')),
        `frase inventada en el archivo: «${linea.it}»`)
    }
    m.cerrar()
  })

  test('al parar con la unión en vuelo, la cola no acaba dos veces en el archivo', async () => {
    // `procesarTurno` se lleva la cola, pero si la dejara puesta en `s.cola`
    // mientras espera a Marian, la gracia de `pararSesion` podía vencer con ese
    // turno en vuelo: `cerrarCola(s, 'parada')` escribía esa misma cola y al
    // volver la traducción se escribía la unión, que la contiene. El mismo
    // texto del hablante DOS veces en el `.jsonl` y DOS burbujas en pantalla
    // —el segundo reemplazo ya no encuentra el nodo y pinta otra—, o sea los
    // tres contadores de la barra contando la misma frase dos veces.
    //
    // `MALENA_2` recortado a su primera oración para que el segundo turno
    // cierre limpio y el archivo tenga exactamente una línea que contar.
    const MALENA_2_CIERRA = 'la possibilità di fare il salto definitivo a livello internazionale?'
    const union = diferido()
    const m = montar({
      traducir: async texto => {
        if (texto.length > MALENA_1.length) await union.promesa
        return { es: `[es] ${texto}`, ms: 5 }
      },
    })
    m.transcriptor.emit('frase', { texto: MALENA_1, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la burbuja provisional')
    const idProvisional = m.provisionales()[0].id

    m.transcriptor.emit('frase', { texto: MALENA_2_CIERRA, msTranscribir: 280 })
    const parada = m.pararSesion('prueba', 20)
    await hasta(() => m.traza.includes('socket cerrado'), 'que el socket se cierre')
    const r = await parada
    assert.strictEqual(r.enVuelo, 1, 'la gracia tenía que vencer con la unión a medio traducir')
    assert.deepStrictEqual(m.guardadas(), [],
      'la cola ya no está en la sesión: al parar no hay nada que cerrar por detrás')

    union.soltar()
    await hasta(() => m.reemplazos().length === 1, 'la definitiva que sustituye a la provisional')
    await esperar(20)

    const lineas = m.guardadas()
    assert.strictEqual(lineas.length, 1,
      `el archivo quedó con ${JSON.stringify(lineas.map(l => l.it))}`)
    assert.strictEqual(lineas[0].it, `${MALENA_1} ${MALENA_2_CIERRA}`)
    assert.strictEqual(lineas[0].cierre, 'frase')
    assert.strictEqual(m.sesion.frases, 1, 'y el lineCount cuenta una frase, no dos')
    assert.strictEqual(
      m.reemplazos().filter(x => x.idProvisional === idProvisional).length, 1,
      'dos reemplazos del mismo id dejan dos burbujas: el segundo ya no encuentra el nodo')
    m.cerrar()
  })

  test('y tampoco cuando la unión tampoco cierra ninguna oración', async () => {
    // La otra cara: lo que vuelve de Marian sigue sin cerrar oración, así que
    // se guarda con `cierre: 'parada'`. Sin la apropiación salían DOS líneas
    // marcadas así, y la segunda contenía entera a la primera.
    const union = diferido()
    const m = montar({
      traducir: async texto => {
        if (texto.includes('diventa')) await union.promesa
        return { es: `[es] ${texto}`, ms: 5 }
      },
    })
    m.transcriptor.emit('frase', { texto: 'E quindi il film', msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    m.transcriptor.emit('frase', { texto: 'diventa una storia diversa', msTranscribir: 280 })
    const parada = m.pararSesion('prueba', 20)
    await hasta(() => m.traza.includes('socket cerrado'), 'que el socket se cierre')
    assert.strictEqual((await parada).enVuelo, 1, 'la gracia tenía que vencer')

    union.soltar()
    await hasta(() => m.guardadas().length === 1, 'que la cola tardía se cierre')
    await esperar(20)

    const lineas = m.guardadas()
    assert.strictEqual(lineas.length, 1,
      `el archivo quedó con ${JSON.stringify(lineas.map(l => l.it))}`)
    assert.strictEqual(lineas[0].it, 'E quindi il film diventa una storia diversa')
    assert.strictEqual(lineas[0].cierre, 'parada')
    m.cerrar()
  })

  test('la marca de empezar a media oración va en la línea que empieza a medias', async () => {
    // La asimetría que hay que vigilar: la línea que se cierra por tope empieza
    // donde empezaba su oración —Marian la vio entera—, y la que se queda sin
    // principio es la SIGUIENTE. Marcar la primera haría contar justo al revés
    // en la prueba en Windows.
    const largo = 'e poi ha detto che non era vero e che nessuno gliel\'aveva chiesto '.repeat(6).trim()
    assert.ok(largo.length > 300, 'la cola de esta prueba tiene que pasar del tope')

    const m = conMarian()
    m.transcriptor.emit('frase', { texto: largo, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional larga')
    m.transcriptor.emit('frase', { texto: 'perché non voleva. Poi è uscito.', msTranscribir: 200 })
    await hasta(() => m.guardadas().length === 2, 'las dos líneas')

    const [porTope, aMedias] = m.guardadas()
    assert.strictEqual(porTope.cierre, 'tope')
    assert.strictEqual(porTope.empiezaAMedias, false,
      'la cola cerrada por tope empieza donde empezaba su oración')
    assert.strictEqual(aMedias.it, 'perché non voleva. Poi è uscito.')
    assert.strictEqual(aMedias.empiezaAMedias, true,
      'a ÉSTA se le mandó a Marian sin su principio')
    assert.strictEqual(aMedias.cierre, 'frase')

    m.transcriptor.emit('frase', { texto: 'Tutto chiaro.', msTranscribir: 100 })
    await hasta(() => m.guardadas().length === 3, 'la tercera línea')
    assert.strictEqual(m.guardadas()[2].empiezaAMedias, false,
      'la marca se consume: no se queda pegada al resto de la reunión')
    m.cerrar()
  })

  test('un fallo con una cola intermedia no borra el msProvisional de la frase', async () => {
    // La burbuja lleva en pantalla desde el PRIMER turno, así que la definitiva
    // que la sustituye no puede guardarse con `msProvisional: null`, cuyo
    // significado documentado es «lo primero que se vio fue ya la definitiva».
    // Un reemplazo con `null` ahí es una contradicción dentro del archivo.
    const T1 = 'Tu pensi che questo ruolo'
    const T2 = 'di Malena ti darà'
    const T3 = 'la possibilità di fare il salto definitivo a livello internazionale?'
    const UNION_2 = `${T1} ${T2}`
    const m = montar({
      traducir: async texto => {
        if (texto === UNION_2) throw new Error('modelo no cargado')
        return { es: `[es] ${texto}`, ms: 5 }
      },
    })
    m.transcriptor.emit('frase', { texto: T1, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional')
    const pv = m.provisionales()[0].id
    assert.strictEqual(typeof m.provisionales()[0].msProvisional, 'number')

    m.transcriptor.emit('frase', { texto: T2, msTranscribir: 200 })
    await hasta(() => m.estados().length === 1, 'el aviso de que no se pudo traducir')
    assert.deepStrictEqual(m.guardadas(), [], 'la cola que no se pudo traducir no se guarda')

    m.transcriptor.emit('frase', { texto: T3, msTranscribir: 150 })
    await hasta(() => m.guardadas().length === 1, 'la definitiva')

    const linea = m.guardadas()[0]
    assert.strictEqual(linea.it, `${UNION_2} ${T3}`)
    assert.strictEqual(m.reemplazos()[0].idProvisional, pv,
      'sustituye a la burbuja que lleva en pantalla desde el primer turno')
    assert.strictEqual(typeof linea.msProvisional, 'number',
      `un reemplazo no puede guardarse con msProvisional ${linea.msProvisional}`)
    m.cerrar()
  })

  test('la marca viaja con la burbuja provisional hasta la línea que se guarda', async () => {
    // El turno que se queda sin principio puede no cerrar ninguna oración: se
    // pinta provisional y no llega al archivo hasta que el turno siguiente lo
    // cierra. La línea que se guarda entonces empieza donde empezaba aquella
    // cola, así que sigue siendo la que se quedó sin principio.
    const largo = 'e poi ha detto che non era vero e che nessuno gliel\'aveva chiesto '.repeat(6).trim()
    const m = conMarian()
    m.transcriptor.emit('frase', { texto: largo, msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional larga')
    m.transcriptor.emit('frase', { texto: 'ma nessuno rispose', msTranscribir: 200 })
    await hasta(() => m.guardadas().length === 1, 'la cola cerrada por tope')
    await hasta(() => m.provisionales().length === 2, 'la provisional del turno suelto')
    m.transcriptor.emit('frase', { texto: 'e se ne andò.', msTranscribir: 150 })
    await hasta(() => m.guardadas().length === 2, 'la definitiva')

    const definitiva = m.guardadas()[1]
    assert.strictEqual(definitiva.it, 'ma nessuno rispose e se ne andò.')
    assert.strictEqual(definitiva.arrastre, true)
    assert.strictEqual(definitiva.empiezaAMedias, true,
      'la unión empieza donde empezaba la cola, y aquélla se quedó sin principio')
    m.cerrar()
  })

  test('la TERCERA puerta: al parar con un turno encolado detrás, el que se queda sin principio queda marcado', async () => {
    // La puerta que se escapó en la ronda 2. `procesarTurno` acaba con
    // `if (s.cerrada) cerrarCola(s, 'parada')`: esa cola se suelta sin que
    // nadie la continúe, exactamente igual que en el tope y en el fallo, pero
    // el turno que venía DETRÁS en `s.cadena` ya estaba encolado y se va solo a
    // Marian, sin su principio. Mientras la marca se ponía a mano en cada
    // puerta, aquí no la ponía nadie y esa línea quedaba `empiezaAMedias:
    // false`: en el `.jsonl` —el instrumento de la prueba en Windows—
    // indistinguible de una línea que Marian vio entera.
    //
    // Es alcanzable: `pararSesion` puede vencer su gracia con un turno en vuelo
    // y otro encolado, que es el caso que documenta el propio `pararSesion`
    // —el servidor suelta una última frase al recibir `Terminate`—.
    const union = diferido()
    const pedidos = []
    const m = montar({
      traducir: async texto => {
        pedidos.push(texto)
        if (texto.includes('diventa')) await union.promesa
        return { es: `[es] ${texto}`, ms: 5 }
      },
    })
    m.transcriptor.emit('frase', { texto: 'E quindi il film', msTranscribir: 300 })
    await hasta(() => m.provisionales().length === 1, 'la provisional del primer turno')

    // El segundo se queda en vuelo con Marian, y el tercero espera detrás en la
    // fila de `s.cadena`.
    m.transcriptor.emit('frase', { texto: 'diventa una storia', msTranscribir: 280 })
    m.transcriptor.emit('frase', { texto: 'molto diversa dal libro.', msTranscribir: 200 })
    const parada = m.pararSesion('prueba', 20)
    await hasta(() => m.traza.includes('socket cerrado'), 'que el socket se cierre')
    assert.strictEqual((await parada).enVuelo, 2,
      'la gracia tenía que vencer con uno en vuelo y otro encolado detrás')

    union.soltar()
    await hasta(() => m.guardadas().length === 2, 'las dos líneas tardías')
    await esperar(20)

    const lineas = m.guardadas()
    assert.strictEqual(lineas.length, 2,
      `el archivo quedó con ${JSON.stringify(lineas.map(l => l.it))}`)

    const [porParada, aMedias] = lineas
    assert.strictEqual(porParada.it, 'E quindi il film diventa una storia')
    assert.strictEqual(porParada.cierre, 'parada')
    assert.strictEqual(porParada.empiezaAMedias, false,
      'la cola que se cierra al parar empieza donde empezaba su oración')

    assert.strictEqual(aMedias.it, 'molto diversa dal libro.')
    assert.strictEqual(aMedias.arrastre, false, 'se fue sola a Marian: la cola ya estaba cerrada')
    assert.ok(pedidos.includes('molto diversa dal libro.'),
      `a Marian se le pidió ${JSON.stringify(pedidos)}`)
    assert.strictEqual(aMedias.empiezaAMedias, true,
      'a ÉSTA se le mandó a Marian sin su principio, y el archivo tiene que decirlo')
    m.cerrar()
  })

  test('un fallo sin cola previa también marca la línea siguiente', async () => {
    // El otro lado de la misma marca. Si Marian falla con las completas y NO
    // había cola que soltar, lo que se pierde es el texto de este turno entero
    // —las completas y la cola que venía detrás, que se va con el `return`—, y
    // el turno siguiente continúa una oración cuyo principio no quedó en
    // ningún sitio. Como no hay cola, `cerrarColaEnMano` no marca nada: la
    // marca tiene que ponerla la propia salida por fallo.
    const m = montar({
      traducir: async texto => {
        if (texto === 'Questo è vero.') throw new Error('modelo no cargado')
        return { es: `[es] ${texto}`, ms: 5 }
      },
    })
    m.transcriptor.emit('frase', { texto: 'Questo è vero. E poi', msTranscribir: 300 })
    await hasta(() => m.estados().length === 1, 'el aviso de que no se pudo traducir')
    assert.deepStrictEqual(m.guardadas(), [], 'no había cola: no hay nada que cerrar')

    m.transcriptor.emit('frase', { texto: 'non lo so.', msTranscribir: 200 })
    await hasta(() => m.guardadas().length === 1, 'la frase siguiente')

    const linea = m.guardadas()[0]
    assert.strictEqual(linea.it, 'non lo so.')
    assert.strictEqual(linea.arrastre, false)
    assert.strictEqual(linea.empiezaAMedias, true,
      'continúa el «E poi» que se perdió con el turno: llega a Marian sin principio')
    m.cerrar()
  })
})
