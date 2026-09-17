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
  const fabrica = new Function(
    'transcriptor', 'traductor', 'autosave', 'idSesion', 'motor', 'resumen',
    'aRenderer', 'db', 'console', 'sesion', codigo)
  const salida = fabrica(transcriptor, traductor, autosave, 7, motor, resumen,
    aRenderer, db, consola, null)

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
    estados: () => pintado.filter(x => x.canal === 'app:estado').map(x => x.datos),
    cerrar: () => { autosave.cerrar(); fs.rmSync(raiz, { recursive: true, force: true }) },
  }
}

describe('la frase que se guarda y se pinta', () => {
  before(() => { assert.ok(fs.existsSync(MAIN_APP)) })

  test('el .jsonl guarda las DOS piernas: nunca más un msTranscribir en null', async () => {
    const m = montar({ traducir: async () => ({ es: 'Tenía fiebre a 39.', ms: 7 }) })
    m.transcriptor.emit('frase', { texto: 'Avevo la febbre a 39.', msTranscribir: 412 })
    await hasta(() => m.guardadas().length === 1, 'que la frase llegue al disco')

    const e = m.guardadas()[0]
    assert.strictEqual(e.msTranscribir, 412, 'la pierna de oír se guarda tal cual')
    assert.strictEqual(typeof e.msTraducir, 'number')
    assert.strictEqual(e.forzado, false, 'hay que poder distinguir las frases troceadas')
    assert.ok(Object.values(e).every(v => v !== null), `hay un null en ${JSON.stringify(e)}`)
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
    await hasta(() => m.guardadas().length === 1, 'que la frase llegue al disco')
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
    const m = montar({ traducir: async () => ({ es: 'hola', ms: 1 }) })
    m.transcriptor.emit('frase', { texto: 'ciao', msTranscribir: 100 })
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
