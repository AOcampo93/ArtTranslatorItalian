/**
 * mainApp.js — proceso principal del traductor.
 *
 * Orquesta la cadena entera:
 *
 *   audio del sistema (renderer)  →  AssemblyAI  →  italiano
 *                                 →  Marian local →  español   → burbujas
 *                                 →  LLM          →  preguntas y respuestas
 *
 * Whisper local ya no viaja en esta versión. Con él se fueron el modelo de
 * 465 MB, el runtime de MSVC, las nueve DLL de microarquitectura, el número de
 * hilos y el veredicto de CPU que podía equivocarse.
 *
 * Tres no negociables de PLAN.md §0 que viven aquí:
 *
 *  - **§0.1 `setContentProtection(true)`.** Sin esto, al compartir pantalla en
 *    Teams la reunión entera lee las respuestas que le soplamos al usuario.
 *  - **§0.2 nada escucha en `0.0.0.0`.** Esta versión no abre ningún puerto
 *    local: la transcripción va por WebSocket saliente. Si algún día vuelve el
 *    modo local, ahí sí habrá que fijar `127.0.0.1` explícito.
 *  - **§0.3 autoguardado desde la primera frase.** Un cierre accidental en el
 *    minuto 58 no puede borrar la reunión.
 *
 * Y uno propio de este proveedor, que cuesta dinero si se olvida: **la sesión
 * de transcripción se cierra siempre**, también si la ventana se cierra o el
 * proceso muere. Una sesión huérfana factura 3 horas y ocupa una de las cinco
 * plazas de concurrencia, o sea que impide la SIGUIENTE reunión del cliente.
 */

'use strict'

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

const BACK = path.join(__dirname, '..', '..', 'node-backend', 'src')
const { AssemblyLiveTranscriber } = require(path.join(BACK, 'assemblyLive'))
const traductor = require(path.join(BACK, 'translator'))
const contexto = require(path.join(BACK, 'contexto'))
const db = require(path.join(BACK, 'db'))
const { Autosave } = require(path.join(BACK, 'autosave'))
const { MotorRespuestas, MotorResumen } = require(path.join(BACK, 'respuestas'))
const { crearLlamador } = require(path.join(BACK, 'llm'))

let ventana = null
let sesion = null          // { transcriptor, traductor, autosave, inicio, ... }

// ── Claves, cifradas con la protección del sistema ────────────────────
const RUTA_CLAVES = () => path.join(app.getPath('userData'), 'claves.dat')

/**
 * `safeStorage` ata el cifrado al usuario Y a la máquina (DPAPI en Windows).
 * Eso es lo que queremos: si el archivo se copia a otro equipo, no sirve. Por
 * eso el export de perfiles NUNCA incluye claves.
 */
function guardarClaves (claves) {
  const actual = leerClaves()
  const fusion = { ...actual, ...claves }
  for (const k of Object.keys(fusion)) if (!fusion[k]) delete fusion[k]

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('el sistema no ofrece cifrado para guardar las claves')
  }
  fs.writeFileSync(RUTA_CLAVES(), safeStorage.encryptString(JSON.stringify(fusion)), { mode: 0o600 })
  return Object.keys(fusion)
}

function leerClaves () {
  try {
    const bruto = fs.readFileSync(RUTA_CLAVES())
    return JSON.parse(safeStorage.decryptString(bruto))
  } catch { return {} }
}

// ── Ventana ───────────────────────────────────────────────────────────
function crearVentana () {
  ventana = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0B0F14',
    title: 'Traductor Italiano',
    webPreferences: {
      preload: path.join(__dirname, 'preloadApp.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // §0.1 — que la sala no vea las respuestas sugeridas al compartir pantalla.
  ventana.setContentProtection(true)

  // `audio: 'loopback'` entrega lo que SUENA en el equipo, no el micrófono.
  // Es solo-Windows y es lo que evita que el usuario configure nada.
  //
  // 'loopback' a secas y NO 'loopbackWithMute': con mute el usuario deja de
  // oír la reunión, que es exactamente lo contrario de lo que quiere.
  ventana.webContents.session.setDisplayMediaRequestHandler((peticion, callback) => {
    callback({ video: peticion.frame, audio: 'loopback' })
  }, { useSystemPicker: true })

  ventana.loadFile(path.join(__dirname, 'renderer', 'app.html'))

  // Cerrar la ventana tiene que cerrar la sesión de transcripción. Si no, se
  // queda facturando hasta 3 horas y bloquea la siguiente reunión.
  ventana.on('close', ev => {
    if (!sesion) return
    ev.preventDefault()
    pararSesion('ventana cerrada').finally(() => { ventana?.destroy() })
  })
  ventana.on('closed', () => { ventana = null })
}

const aRenderer = (canal, datos) => {
  if (ventana && !ventana.isDestroyed()) ventana.webContents.send(canal, datos)
}

// ── Preguntas, respuestas y contexto general ──────────────────────────
/**
 * Monta los dos motores que hablan con el LLM y los engancha a la interfaz.
 *
 * **Si no hay clave de LLM, la reunión sigue.** Las burbujas de traducción son
 * el producto; las respuestas sugeridas son el extra. Lo que no puede pasar es
 * que el panel se quede mudo sin decir por qué: se manda el motivo y ahí queda
 * escrito mientras dure la reunión.
 *
 * El proveedor sale del prefijo de la clave (ver `node-backend/src/llm.js`):
 * el usuario pega una sola clave en Ajustes y no elige nada más.
 */
function montarMotores ({ perfil, ctx, claveLlm }) {
  let llamar = null
  let motivo = 'Para ver aquí respuestas sugeridas, añade una clave en Ajustes.'

  if (claveLlm) {
    try {
      llamar = crearLlamador({ clave: claveLlm })
    } catch (err) {
      motivo = err.message
    }
  }
  if (!llamar) {
    aRenderer('app:avisoPreguntas', motivo)
    return { motor: null, resumen: null }
  }

  // El bloque se construye UNA vez y con el perfil y el contexto explícitos.
  // Sin pasarlos, `buildContextBlock()` leería el perfil ACTIVO de la base de
  // datos, y `crearPerfil` inserta con activo = 0: los prompts se quedarían sin
  // saber quién es el usuario justo en la parte donde más pesa.
  let bloque = ''
  try {
    bloque = contexto.buildContextBlock({ perfil, contexto: ctx }).bloque
  } catch (err) {
    console.error('[contexto] no se pudo construir el bloque:', err.message)
  }
  const bloqueContexto = () => bloque

  // Se limpia el aviso: si el usuario acaba de pegar la clave y ha vuelto a
  // empezar, el cartel de la reunión anterior ya no dice la verdad.
  aRenderer('app:avisoPreguntas', '')

  const motor = new MotorRespuestas({ llamar, bloqueContexto })
  motor.on('pregunta', p => aRenderer('app:pregunta', { id: p.id, it: p.it, es: p.es }))
  // La respuesta puede venir con `texto: null` y un error: se reenvía tal cual
  // para que la tarjeta lo diga en vez de quedarse en «Preparando…».
  motor.on('respuesta', r => aRenderer('app:respuesta', r))

  const resumen = new MotorResumen({ llamar, bloqueContexto })
  resumen.on('contexto', c => aRenderer('app:contexto', c.texto))

  return { motor, resumen }
}

/**
 * Cuánto se espera, como MÁXIMO, a las traducciones que están en vuelo al parar.
 *
 * Al pulsar Detener hay dos urgencias que no pueden competir entre sí:
 *
 *  - La sesión de transcripción **cuesta dinero mientras está abierta** y ocupa
 *    una de las cinco plazas de concurrencia del cliente. Se cierra YA, sin
 *    esperar a nadie.
 *  - Una frase ya traducida **está pagada** y tiene que acabar en disco (no
 *    negociable §0.3). Eso se puede esperar un momento, pero no para siempre:
 *    el usuario pulsó un botón y la app no se puede quedar colgada.
 *
 * De ahí el orden de `pararSesion`: primero el socket, después esta espera.
 *
 * **De dónde salen los 3.000 ms.** Entre las dos cifras que hay medidas de
 * Marian en la máquina lenta del cliente (HP Pavilion i5-10210U):
 *
 *  - p50 de 578 ms con 6 hilos y 707 ms con 3 `[medido]` (`PLAN.md` §5).
 *  - la peor traducción medida del proyecto, 5.601 ms, y era el bloque de 892
 *    caracteres de una sesión SIN trocear `[medido]` (`PLAN.md` §7bis). El
 *    tope de turno de 8 s de `assemblyLive.js` existe justo para que ese
 *    bloque no se vuelva a formar.
 *
 * Tres segundos son ~4 veces el p50 de la máquina lenta y se quedan por debajo
 * de aquel peor caso, que además ya no debería poder darse. Con varias frases
 * encoladas la gracia puede vencer igualmente, y para eso está la otra mitad
 * del arreglo: la frase que llega tarde se guarda igual, con la sesión ya
 * cerrada. El valor NO se ha contrastado contra una reunión real, ni se sabe
 * cuántas veces vence la gracia en una de verdad `[por medir]`.
 */
const GRACIA_EN_VUELO_MS = 3_000

/**
 * Espera a las frases que están a medio traducir, como mucho `topeMs`.
 *
 * Devuelve **cuántas seguían en vuelo** al vencer el tope; cero es lo normal.
 * Se mira el conjunto una sola vez a propósito: cuando se llama, el socket ya
 * está cerrado y no puede llegar ninguna frase nueva.
 */
async function esperarEnVuelo (s, topeMs = GRACIA_EN_VUELO_MS) {
  if (s.enVuelo.size === 0) return 0
  let reloj = null
  const tope = new Promise(res => { reloj = setTimeout(res, topeMs) })
  // `allSettled` y no `all`: una traducción que falla no puede impedir que se
  // espere a las demás.
  await Promise.race([Promise.allSettled([...s.enVuelo]), tope])
  clearTimeout(reloj)
  return s.enVuelo.size
}

// ── La reunión ────────────────────────────────────────────────────────
async function empezarSesion ({ perfil, contexto: ctx }) {
  if (sesion) return { ok: true, yaCorriendo: true }

  const claves = leerClaves()
  if (!claves.stt) {
    return { ok: false, motivo: 'Falta la clave de transcripción. Ponla en Ajustes.' }
  }

  // Se guardan para que el informe y los prompts los tengan.
  if (perfil?.nombre) contexto.crearPerfil(perfil)
  if (ctx?.nombre) contexto.crearContexto(ctx)

  const glosario = (ctx?.glosario || '').split(/[,\n·;]+/).map(s => s.trim()).filter(Boolean)

  const transcriptor = new AssemblyLiveTranscriber({
    apiKey: claves.stt,
    idioma: 'it',
    glosario,
    // El contexto va en italiano porque describe el audio que va a oír.
    contexto: [ctx?.tipo_proyecto && `Progetto: ${ctx.tipo_proyecto}.`,
               ctx?.contexto].filter(Boolean).join(' '),
  })

  // Marian se carga una vez y se queda en memoria. Tarda unos 500 ms la
  // primera vez, así que se hace ANTES de abrir la sesión de transcripción:
  // esa sí cuesta dinero mientras está abierta.
  await traductor.cargar()

  const idSesion = db.startSession('assemblyai/universal-3-5-pro')
  // `inicio` fija el nombre del archivo (F030): `idSesion` es un
  // autoincremento de `db.js` que vuelve a 1 si la base se reinicia, y dos
  // reuniones con el mismo id fundieron sus frases en un solo `.jsonl` —
  // MEDIDO en `sesion-1.jsonl` del cliente. La fecha y hora locales de
  // arranque distinguen el archivo aunque el id se repita.
  const inicio = new Date()
  const autosave = new Autosave({
    directorio: path.join(app.getPath('userData'), 'reuniones'),
    idSesion: String(idSesion),
    inicio,
    version: app.getVersion(),
  })
  autosave.abrir()
  // Primera línea del archivo: de qué reunión y versión es, sin tener que
  // mirar el nombre ni abrirlo entero. También es la señal que usa
  // `Autosave.detectarMezcla()` para saber si un archivo funde dos reuniones.
  // Sin `version`: el constructor ya la recibió arriba y `guardarCabecera`
  // cae en `this.version` si no se le pasa otra.
  autosave.guardarCabecera({ perfil, contexto: ctx, inicio, id: idSesion })

  const { motor, resumen } = montarMotores({ perfil, ctx, claveLlm: claves.llm })
  sesion = {
    transcriptor, autosave, idSesion, motor, resumen, inicio: Date.now(), frases: 0,
    // Las frases a medio traducir, para poder esperarlas al parar en vez de
    // perderlas. Y `cerrada`, para que las que vuelvan tarde sepan que la
    // reunión terminó: se guardan igual, pero no gastan llamadas al LLM.
    enVuelo: new Set(),
    cerrada: false,
  }

  // La sesión de ESTE transcriptor, capturada aquí a propósito. Los manejadores
  // de abajo NO deben mirar la variable `sesion` del módulo: `pararSesion` la
  // pone a null, y una frase que vuelve de traducir después de eso seguiría
  // siendo de esta sesión y tiene que acabar en su archivo.
  const s = sesion

  transcriptor.on('parcial', p => aRenderer('app:parcial', p.texto))

  // `msTranscribir` lo sella el transcriptor: es la pierna de OÍR, y sin ella
  // el cronómetro arrancaba con el texto YA en la mano, o sea que medía sólo
  // la traducción. Las 21 frases de la primera prueba real salieron con `ms`
  // idéntico a `msTraducir` y `msTranscribir: null` [medido]: lo que el usuario
  // leía como «retardo» era media cadena, y por tanto SUBESTIMABA lo que
  // sentía, que es la dirección peligrosa de equivocarse.
  //
  // Aquí vivía el fallo de F022, y merece quedar escrito porque se rompe solo.
  // El manejador leía `sesion.frases++` DESPUÉS del `await` de la traducción. Si
  // el usuario paraba mientras esa traducción estaba en vuelo —o si la frase era
  // la que el servidor suelta al recibir `Terminate`, que llega justo en esa
  // ventana— `sesion` ya era null y aquello lanzaba. Caía en el mismo `catch`
  // que la traducción y pasaban tres cosas, en orden de gravedad:
  //
  //  1. La frase NO llegaba al autoguardado (no negociable §0.3), que existe
  //     justo para que un cierre no se coma nada.
  //  2. El `.jsonl` de la sesión quedaba incompleto, y ese archivo es el
  //     instrumento con el que se mide la prueba en Windows.
  //  3. En pantalla salía «no se pudo traducir: Cannot read properties of
  //     null»: un error de programación disfrazado del único fallo que el
  //     usuario sí sabe interpretar, así que concluía que el traductor falla
  //     cuando había funcionado.
  //
  // Se arregla por dos lados a la vez: la frase es de `s` —la sesión capturada
  // arriba, que no se vuelve null— y su promesa se apunta en `s.enVuelo`, para
  // que `pararSesion` pueda esperarla un momento en vez de perderla.
  transcriptor.on('frase', ({
    texto, msTranscribir, forzado, msTurno, msHolgura, acabaEnPuntuacion, motivoCorte,
  }) => {
    const tarea = (async () => {
      const t0 = Date.now()
      let frase = null
      try {
        const tr = await traductor.traducir(texto)
        // Reloj de pared y no `tr.ms`: si una frase larga tiene ocupado a Marian,
        // la siguiente espera su turno, y esa espera la sufre el usuario aunque
        // el modelo no la cuente como suya.
        const msTraducir = Date.now() - t0
        frase = {
          it: texto, es: tr.es,
          ms: msTranscribir + msTraducir,   // el retardo es la cadena, no una pierna
          msTranscribir, msTraducir,
          // `forzado` dice que el turno lo cortamos nosotros por largo, así que
          // esta frase puede estar partida. Queda en el archivo para poder
          // contar en la próxima reunión real cuántas se parten de verdad.
          forzado: Boolean(forzado),
          // Las cuatro medidas de F031. La segunda prueba en Windows hubo que
          // contarla a mano sobre el `.jsonl` —y la cifra que más importaba,
          // los 2,6 s de exceso del turno, sólo se pudo estimar restando
          // marcas de tiempo—. Con esto la próxima se lee del archivo:
          //
          //  · `msTurno`: lo que duró el turno de verdad.
          //  · `msHolgura`: del corte pedido al turno cerrado; `null` si no se
          //    forzó, porque un cero ahí sería «obedeció al instante».
          //  · `acabaEnPuntuacion`: el «a media frase», ya contado.
          //  · `motivoCorte`: `'silencio'` o `'tope-duro'`; `null` si no se
          //    forzó. Es lo que separa «se cortó en una pausa» de «se cortó
          //    encima de la voz», y sin él el criterio «0 palabras partidas en
          //    trozos forzados con silencio detectado» vuelve a no poderse
          //    contar sobre el archivo.
          //
          // Los tres van con `?? null` por el mismo motivo, y el tercero es el
          // que más muerde: `Boolean(undefined)` es `false`, o sea «esta frase
          // acabó a media oración», que es una medida que nadie ha tomado. El
          // `.jsonl` es de donde va a salir el «% de trozos a media frase» de
          // la prueba en Windows, y un motor que no calcule el campo —hoy
          // ninguno de los enchufados, pero `pipeline.js` y `geminiLive.js`
          // emiten `frase` sin él— dejaría ese porcentaje en 100% sin que
          // nadie lo note. El renderer ya cuenta con `=== false` por esto
          // mismo; si aquí se rellena el hueco, esa defensa no sirve de nada.
          msTurno: msTurno ?? null,
          msHolgura: msHolgura ?? null,
          acabaEnPuntuacion: acabaEnPuntuacion ?? null,
          motivoCorte: motivoCorte ?? null,
        }
      } catch (err) {
        // Este `catch` abraza SOLO la traducción, que es el único fallo que este
        // texto sabe nombrar. Lo que venga después tiene su propio aviso: decir
        // «no se pudo traducir» de otra cosa manda a investigar al sitio
        // equivocado.
        aRenderer('app:estado', { clase: 'aviso', texto: `no se pudo traducir: ${err.message}` })
        return
      }

      // De aquí en adelante la frase ya está traducida y PAGADA. Lo único que
      // queda es ponerla a salvo, y eso se hace aunque la reunión ya se haya
      // cerrado mientras se traducía.
      // `escribir` reabre el archivo si hacía falta (se abre en modo append), así
      // que una frase que llega tarde se guarda igual. Si lo ha reabierto ella,
      // hay que volver a cerrarlo: nadie más va a hacerlo y un descriptor por
      // sesión terminada se acumula.
      //
      // Y va en un `finally`, no después de `escribir`: `escribir` hace `abrir()`
      // **y luego** `writeSync()`, así que un disco lleno (ENOSPC) o un EIO falla
      // con el archivo YA reabierto. Con el cierre dentro del `try`, esa
      // excepción se lo saltaba y dejaba el descriptor colgando para siempre.
      const estabaAbierto = s.autosave.abierto
      try {
        // §0.3 — al disco ANTES de pintar y antes de contar: si la app muere en
        // el repintado, la frase ya está a salvo.
        s.autosave.escribir(frase)
        // Se cuenta lo que ESTÁ en disco, no lo que se intentó escribir: este
        // número acaba en `lineCount` de la base de datos.
        s.frases++
      } catch (err) {
        // La traducción salió bien y lo que falló fue guardarla, que es justo lo
        // que §0.3 promete. Se dice con su nombre y con la clase de fallo grave.
        console.error('[autoguardado] no se pudo escribir la frase:', err.message)
        aRenderer('app:estado', { clase: 'mal', texto: `no se pudo guardar la frase: ${err.message}` })
      } finally {
        if (!estabaAbierto) s.autosave.cerrar()
      }
      aRenderer('app:frase', frase)

      // Y después de pintar, nunca antes: el triaje y el LLM no pueden
      // retrasar la burbuja, que es lo que el usuario está leyendo.
      //
      // Si la reunión ya terminó, aquí se para. Una respuesta sugerida que nadie
      // va a leer cuesta una llamada al LLM, y el panel donde se pintaría ya no
      // está en pantalla. La frase, en cambio, sí se ha guardado.
      if (s.cerrada) return
      // `considerar` no se espera a propósito —dentro decide si merece la
      // llamada y emite por su cuenta—, así que aquí solo se recoge el fallo.
      s.motor?.considerar(texto, frase.es)
        .catch(e => console.error('[preguntas]', e.message))
      s.resumen?.registrar(texto, frase.es)
    })()
      // Última red: si algo de arriba lanza fuera de sus dos `try`, la promesa
      // no puede quedar rechazada sin dueño. Node tumba el proceso por una
      // rechazada sin manejar, y eso sería perder la reunión entera por un
      // repintado. No se pinta nada: no es un fallo que el usuario pueda
      // interpretar, y desde luego no es «no se pudo traducir».
      .catch(err => console.error('[frase] fallo inesperado:', err.message))

    // Apuntarla ANTES de cualquier microtarea: `pararSesion` sólo puede esperar
    // lo que está en el conjunto.
    s.enVuelo.add(tarea)
    // `finally` y no `then`: una tarea que acaba mal también deja de estar en
    // vuelo, o la gracia de `pararSesion` esperaría a un fantasma.
    tarea.finally(() => s.enVuelo.delete(tarea))
  })

  transcriptor.on('estado', e => {
    const mapa = {
      conectando: ['aviso', 'Conectando'],
      escuchando: ['vivo', 'Escuchando'],
      reconectando: ['aviso', 'Reconectando'],
      'esperando-cupo': ['aviso', 'Esperando turno de conexión'],
      'sin-conexion': ['mal', 'Sin conexión'],
      parado: ['', 'Detenido'],
    }
    const [clase, texto] = mapa[e] || ['', e]
    aRenderer('app:estado', { clase, texto })
  })

  transcriptor.on('error', err =>
    aRenderer('app:estado', { clase: 'aviso', texto: err.message }))

  await transcriptor.start()
  return { ok: true }
}

/**
 * Cierra la reunión.
 *
 * El orden de estas cuatro líneas es el arreglo de F022, así que va explicado:
 *
 *  1. `sesion = null` y `cerrada = true`. Lo que llegue tarde ya sabe que la
 *    reunión terminó; el manejador de `frase` no mira esta variable, trabaja
 *    sobre la sesión que capturó al empezar.
 *  2. `stop()` **primero y sin esperar a nadie más**: mientras el socket está
 *    abierto factura, y una sesión huérfana ocupa una plaza de concurrencia, o
 *    sea que impide la SIGUIENTE reunión del cliente. El servidor puede soltar
 *    aquí una última frase al recibir `Terminate` —llega 1.067–1.224 ms después
 *    `[medido]`— y esa también entra en `enVuelo`.
 *  3. Con el dinero ya cortado, un momento —`GRACIA_EN_VUELO_MS`, con tope— para
 *    lo que esté a medio traducir. Así entra en la cuenta que va a la base de
 *    datos.
 *  4. Y sólo entonces se cierra el archivo y se cierra la fila de la sesión.
 *
 * `graciaMs` es un parámetro para poder ejercer el vencimiento de la gracia en
 * una prueba sin dormir tres segundos. En producción nadie lo pasa.
 */
async function pararSesion (motivo = 'el usuario paró', graciaMs = GRACIA_EN_VUELO_MS) {
  if (!sesion) return { ok: true }
  const s = sesion
  sesion = null
  s.cerrada = true
  let enVuelo = 0
  try {
    await s.transcriptor.stop()          // manda Terminate y espera el acuse
    enVuelo = await esperarEnVuelo(s, graciaMs)
    if (enVuelo > 0) {
      // No se pierden: la frase que vuelva después reabre el archivo y se
      // escribe igual. Lo que queda desfasado es `lineCount`, y por eso el
      // número sale también en el resultado.
      console.error(`[sesión] ${enVuelo} frase(s) seguían traduciéndose al cerrar; `
        + 'se guardarán en el archivo de la sesión cuando terminen')
    }
    s.autosave.cerrar()
    db.endSession(s.idSesion, {
      durationSeconds: Math.round((Date.now() - s.inicio) / 1000),
      lineCount: s.frases,
    })
    db.vaciar()
  } catch (err) {
    console.error('[sesión] al cerrar:', err.message)
  }
  return {
    ok: true, motivo,
    frases: s.frases,
    // Cuántas no llegaron a tiempo a la cuenta de arriba. Se guardan en el
    // `.jsonl` de todas formas; el número está para que no parezca que se
    // perdieron y para poder contarlo si algún día pasa a menudo.
    enVuelo,
    costeUsd: s.transcriptor.costeAproximadoUsd(0.45),
    stats: s.transcriptor.stats,
  }
}

// ── IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('app:empezar', (_e, datos) => empezarSesion(datos))
ipcMain.handle('app:parar', () => pararSesion())

/** El audio llega en bloques de 100 ms desde el renderer. */
ipcMain.on('app:audio', (_e, muestras) => {
  sesion?.transcriptor.alimentar(muestras)
})

/**
 * El botón «Otra» de una tarjeta de pregunta.
 *
 * Al pulsarlo el renderer ya ha puesto «Preparando…», así que **siempre tiene
 * que llegar algo de vuelta**. Cuando no hay motor —sin clave, o la reunión ya
 * terminó— se contesta por este mismo canal en vez de dejar la tarjeta colgada;
 * cuando sí lo hay, el propio motor emite la respuesta o el fallo.
 */
ipcMain.handle('app:otraRespuesta', (_e, id) => {
  if (!sesion?.motor) {
    aRenderer('app:respuesta', { id, texto: null, error: 'no hay reunión en marcha' })
    return { ok: false }
  }
  return { ok: sesion.motor.reintentar(id) }
})

ipcMain.handle('app:guardarClaves', (_e, claves) => {
  try { return { ok: true, guardadas: guardarClaves(claves) } }
  catch (err) { return { ok: false, motivo: err.message } }
})

/** Dice CUÁLES hay, nunca su valor. */
ipcMain.handle('app:estadoClaves', () => {
  const c = leerClaves()
  return { stt: !!c.stt, llm: !!c.llm, cifradoDisponible: safeStorage.isEncryptionAvailable() }
})

/**
 * La comprobación de la pantalla de preparación.
 *
 * Mide lo que decide si la app sirve en ESTE equipo, y nada más. No hay banco
 * de CPU ni veredicto de hardware: en la versión de nube el equipo sólo tiene
 * que capturar audio y tener red, así que un veredicto sobre su procesador
 * sería una cifra que no decide nada — y ya nos costó dos informes equivocados.
 *
 * El audio lo comprueba el renderer, que es donde vive esa API.
 */
ipcMain.handle('app:comprobar', async (_e, ctx) => {
  const r = {}

  // ── Protección de pantalla ──
  // `setContentProtection` necesita Windows 10 build 19041 o superior. En otros
  // sistemas se dice que no aplica, en vez de dar un falso verde.
  r.pantalla = process.platform === 'win32'
    ? { ok: true, valor: 'activa' }
    : { aviso: true, valor: 'solo Windows' }

  const claves = leerClaves()
  if (!claves.stt) {
    r.red = { mal: true, valor: 'falta la clave' }
    r.extremo = { mal: true, valor: 'falta la clave' }
    return r
  }

  // ── Red y cadena completa, con el audio de prueba ──
  // Se mide de punta a punta —oír, transcribir, traducir— porque es el número
  // que el usuario va a sentir. Medir una pieza sola no dice nada útil.
  try {
    const wav = fs.readFileSync(rutaFixture())
    const pcm = wav.subarray(44)
    const muestras = new Float32Array(pcm.length / 2)
    for (let i = 0; i < muestras.length; i++) muestras[i] = pcm.readInt16LE(i * 2) / 32768

    const glosario = (ctx?.glosario || '').split(/[,\n·;]+/).map(x => x.trim()).filter(Boolean)
    const t = new AssemblyLiveTranscriber({ apiKey: claves.stt, idioma: 'it', glosario })

    const tConexion = Date.now()
    await t.start()
    r.red = { ok: true, valor: `${Date.now() - tConexion} ms` }

    await traductor.cargar()

    // Las dos piernas salen de la misma fuente que en la reunión de verdad:
    // el transcriptor sella lo que costó oír y el traductor lo que costó
    // traducir. Antes se cronometraba aquí desde que se acababa de mandar el
    // audio, y si la frase llegaba antes de esa marca la comprobación acababa
    // diciendo «sin traducción» con la cadena funcionando.
    let italiano = null, msExtremo = null
    t.once('frase', async ({ texto, msTranscribir }) => {
      italiano = texto
      const tr = await traductor.traducir(texto)
      msExtremo = msTranscribir + tr.ms
    })

    const POR_BLOQUE = 1600
    for (let i = 0; i < muestras.length; i += POR_BLOQUE) {
      t.alimentar(muestras.subarray(i, i + POR_BLOQUE))
      await new Promise(x => setTimeout(x, 100))
    }

    for (let i = 0; i < 40 && msExtremo == null; i++) await new Promise(x => setTimeout(x, 100))
    await t.stop()

    r.extremo = msExtremo != null
      ? { ok: msExtremo < 2000, aviso: msExtremo >= 2000, valor: `${msExtremo} ms` }
      : { mal: true, valor: italiano ? 'sin traducción' : 'sin respuesta' }
    r.coste = { valor: `$${t.costeAproximadoUsd(0.45)}` }
  } catch (err) {
    r.red = r.red || { mal: true, valor: 'falló' }
    r.extremo = { mal: true, valor: err.message.slice(0, 60) }
  }
  return r
})

/** El audio de prueba, tanto en desarrollo como dentro del paquete. */
function rutaFixture () {
  const candidatos = [
    path.join(process.resourcesPath || '', 'node-backend', 'test', 'fixtures', 'italiano.wav'),
    path.join(__dirname, '..', '..', 'node-backend', 'test', 'fixtures', 'italiano.wav'),
  ]
  for (const c of candidatos) if (c && fs.existsSync(c)) return c
  throw new Error('no se encuentra el audio de prueba')
}

ipcMain.handle('app:listarPerfiles', () => contexto.listarPerfiles())
ipcMain.handle('app:guardarPerfil', (_e, p) => contexto.crearPerfil(p))
ipcMain.handle('app:listarContextos', () => contexto.listarContextos())
ipcMain.handle('app:guardarContexto', (_e, c) => contexto.crearContexto(c))

ipcMain.handle('app:exportarSesion', async () => {
  const r = await dialog.showSaveDialog(ventana, {
    title: 'Guardar la transcripción',
    defaultPath: `reunion-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Texto', extensions: ['txt'] }],
  })
  if (r.canceled || !r.filePath) return { ok: false }
  return { ok: true, ruta: r.filePath }
})

ipcMain.handle('app:abrirCarpeta', (_e, ruta) => shell.showItemInFolder(ruta))

// ── Arranque y cierre ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  await db.init()
  crearVentana()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana()
  })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// Última red: si el proceso se va por cualquier vía, la sesión se cierra.
// `assemblyLive` ya registra sus propias salidas, pero esto cubre el caso de
// que Electron termine sin pasar por ahí.
app.on('before-quit', ev => {
  if (!sesion) return
  ev.preventDefault()
  pararSesion('la aplicación se cerró').finally(() => app.exit(0))
})

module.exports = { _internos: { guardarClaves, leerClaves, empezarSesion, pararSesion } }
