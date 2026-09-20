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

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const BACK = path.join(__dirname, '..', '..', 'node-backend', 'src')
const { AssemblyLiveTranscriber } = require(path.join(BACK, 'assemblyLive'))
const traductor = require(path.join(BACK, 'translator'))
const contexto = require(path.join(BACK, 'contexto'))
const db = require(path.join(BACK, 'db'))
const { Autosave } = require(path.join(BACK, 'autosave'))
const { partirTurno, arrastrar, acabaCerrada } = require(path.join(BACK, 'frases'))
const { MotorRespuestas, MotorResumen } = require(path.join(BACK, 'respuestas'))
const { crearLlamador, clasificarError, sanear, proveedorDeClave, MODELOS, NOMBRE_PROVEEDOR } = require(path.join(BACK, 'llm'))
const { ColaDeInformes } = require(path.join(BACK, 'informes'))
const { percentil, duracionMs, costeStt, costeLlm } = require(path.join(BACK, 'coste'))
const { calcularBounds, leerEstado, guardarEstado } = require(path.join(BACK, 'ventanaEstado'))

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

// ── Informes a la nube (F039b) ──────────────────────────────────────────
//
// El token de subida vive FUERA del repo, a propósito (§10 del plan): es un
// secreto de servicio que viaja incrustado en el paquete de Windows, no una
// clave del usuario que pase por `safeStorage`. `verificar-paquete.sh`
// comprueba que este archivo va en el paquete y que nunca entra a git.
const RUTA_TOKEN_INFORMES = () => path.join(__dirname, 'informes.token.json')

/** `null` si el archivo falta o está mal formado: la subida queda desactivada, no rota. */
function leerTokenInformes () {
  try {
    const cfg = JSON.parse(fs.readFileSync(RUTA_TOKEN_INFORMES(), 'utf8'))
    return cfg && cfg.token && cfg.url ? cfg : null
  } catch { return null }
}

/**
 * El nombre de máquina saneado al alfabeto que exige `X-Maquina` en el
 * contrato de subida (`vps/servidor.js`): sólo así el receptor no lo rechaza
 * con 400. `os.hostname()` puede traer espacios, acentos o un `.local` con
 * puntos de sobra; lo que no encaje en el alfabeto se convierte en `-`.
 */
function maquinaSaneada () {
  const cruda = os.hostname() || 'desconocida'
  const saneada = cruda.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)
  return saneada || 'desconocida'
}

let colaInformes = null
/**
 * Una sola cola para toda la vida del proceso: dos instancias leyendo y
 * escribiendo el mismo `cola-informes.json` a la vez sí podrían pisarse.
 */
function obtenerColaInformes () {
  if (colaInformes) return colaInformes
  const cfg = leerTokenInformes()
  colaInformes = new ColaDeInformes({
    directorioDatos: path.join(app.getPath('userData'), 'informes'),
    token: cfg?.token,
    url: cfg?.url,
    obtenerModo: () => leerClaves().informes || 'completo', // beta: por defecto "completo"
  })
  return colaInformes
}

// F035: dónde se guarda la posición/tamaño que el usuario deja al mover o
// redimensionar la ventana. En el directorio de datos, como las claves y las
// reuniones: sobrevive a una actualización de la app.
const RUTA_VENTANA = () => path.join(app.getPath('userData'), 'ventana.json')

/**
 * Cuánto se espera tras un `resize`/`move` antes de guardar (F035).
 *
 * Windows dispara estos eventos varias veces por segundo mientras se arrastra
 * el borde; escribir a disco en cada uno sería un `writeFileSync` por frame
 * de arrastre. 400 ms después del último evento es indistinguible para el
 * usuario y evita ese machaqueo.
 */
const GUARDAR_VENTANA_DEBOUNCE_MS = 400

// ── Ventana ───────────────────────────────────────────────────────────
function crearVentana () {
  // F035: angosta (440 px), del alto entero del área de trabajo, pegada al
  // borde derecho — o donde el usuario la haya dejado la última vez. El
  // cálculo vive en `ventanaEstado.js`, aparte de Electron, para poder
  // probarlo con un doble de `screen` sin abrir ninguna ventana.
  const workArea = screen.getPrimaryDisplay().workArea
  const guardado = leerEstado(RUTA_VENTANA())
  const bounds = calcularBounds({ workArea, guardado })

  ventana = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 480,
    backgroundColor: '#0B0F14',
    title: 'Traductor Italiano',
    webPreferences: {
      preload: path.join(__dirname, 'preloadApp.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Se guarda con el mismo criterio en las dos vías por las que la ventana
  // puede cambiar de sitio: `resize` (el borde) y `move` (arrastrar por la
  // cabecera). `getBounds()` y no los argumentos del evento: da la geometría
  // YA asentada, y es la misma forma que espera `calcularBounds` al releerla.
  let reloj = null
  const guardarMasTarde = () => {
    clearTimeout(reloj)
    reloj = setTimeout(() => {
      if (!ventana || ventana.isDestroyed()) return
      guardarEstado(RUTA_VENTANA(), ventana.getBounds())
    }, GUARDAR_VENTANA_DEBOUNCE_MS)
  }
  ventana.on('resize', guardarMasTarde)
  ventana.on('move', guardarMasTarde)

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
function montarMotores ({ perfil, ctx, claveLlm, autosave }) {
  let llamar = null
  let motivo = 'Para ver aquí respuestas sugeridas, añade una clave en Ajustes.'

  if (claveLlm) {
    try {
      llamar = crearLlamador({ clave: claveLlm })
    } catch (err) {
      // F021: `err.message` nunca cruza tal cual a la pantalla. Aquí en
      // concreto `crearLlamador` sólo lanza dos mensajes fijos —sin clave
      // configurada, o clave con un prefijo que no se reconoce—, ninguno con
      // la clave dentro, pero pasa igual por `clasificarError` porque este es
      // uno de los puntos de la auditoría y no puede haber un segundo criterio.
      motivo = clasificarError(err).mensaje
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

  // F038: para guardar la respuesta junto a su pregunta en el `.jsonl` hace
  // falta recordar `it`/`es`/`manual` entre el evento `pregunta` (que llega
  // sin respuesta, para pintar la tarjeta cuanto antes) y `respuesta` (que
  // llega después, del LLM). Vive aquí y no en `MotorRespuestas` porque es
  // sólo para el autoguardado — el motor ya tiene su propia `_vistas`.
  const preguntasEnCurso = new Map()

  const motor = new MotorRespuestas({ llamar, bloqueContexto })
  motor.on('pregunta', p => {
    preguntasEnCurso.set(p.id, { it: p.it, es: p.es, manual: Boolean(p.manual) })
    aRenderer('app:pregunta', { id: p.id, it: p.it, es: p.es })
  })
  // La respuesta puede venir con `texto: null` y `{ tipo, mensaje, detalle }`
  // (F021, `respuestas.js` ya lo clasifica y sanea): se reenvía tal cual para
  // que la tarjeta lo diga en vez de quedarse en «Preparando…».
  motor.on('respuesta', r => {
    aRenderer('app:respuesta', r)
    // F038: se guarda tanto si contestó como si falló (con `texto: null`),
    // para que «ver reunión» sepa que se preguntó aunque no haya respuesta.
    // Sin `datos` (la tarjeta es más vieja que `MEMORIA`, ver `respuestas.js`)
    // no hay `it`/`es` que guardar y se deja tal como estaba: sin esta línea,
    // no sin la reunión entera.
    const datos = preguntasEnCurso.get(r.id)
    if (datos && autosave) {
      autosave.guardarRespuestaLlm({
        it: datos.it, es: datos.es, manual: datos.manual,
        texto: r.texto, tokensEntrada: r.tokensEntrada, tokensSalida: r.tokensSalida,
        modelo: r.modelo, mensaje: r.mensaje || null,
      })
    }
  })

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

// ── La burbuja es la frase, no el turno (F037) ────────────────────────
/**
 * Por qué el turno no se traduce tal como llega, con el caso medido delante.
 *
 * Desde F031 el turno se corta por tope (6 s, tope duro 8 s), así que muchas
 * veces acaba a media oración: 10 de 13 trozos forzados en `sesion-2.jsonl`
 * `[medido]`. Y a Marian eso no le sale «a medias», le sale **inventado**:
 *
 *   «Tu pensi che questo ruolo di Malena ti darà» + «la possibilità di fare il
 *   salto definitivo a livello internazionale? …» → «¿Cómo se puede dar el
 *   salto definitivo a nivel internacional?» `[medido]`. El «Cómo» no lo dijo
 *   nadie: el modelo completó la oración que le faltaba.
 *
 * Desde aquí, la unidad que se traduce, se pinta y se guarda es la **oración**,
 * no el turno (`frases.js` parte y arrastra; aquí se orquesta):
 *
 *  1. Las oraciones completas del turno se traducen y se pintan como siempre.
 *  2. La cola sin cerrar se traduce y se pinta **provisional** (atenuada, con
 *     «…»). Así la pantalla sigue enseñando algo enseguida, que es lo que se
 *     perdería si esperásemos al turno siguiente.
 *  3. Cuando llega ese turno, se traduce `cola + turno` **junto** y la
 *     definitiva **sustituye** a la provisional en su sitio.
 *
 * Una llamada a Marian = una burbuja. No se alinea ni se pega nada: lo que
 * sustituye a la provisional es una traducción entera y nueva.
 *
 * Y dos reglas que no son de pantalla:
 *
 *  - **Los motores sólo ven texto definitivo.** Una pregunta detectada sobre
 *    media oración se contesta a medias, y la respuesta sugerida es lo que el
 *    usuario va a decir en voz alta.
 *  - **Al `.jsonl` sólo van líneas definitivas.** El archivo es el instrumento
 *    de medida de la prueba en Windows; una provisional y su definitiva serían
 *    la misma frase contada dos veces.
 */

/**
 * Identificadores de burbuja provisional. Sólo tienen que ser únicos dentro de
 * la ventana: el renderer los usa para encontrar el nodo que hay que sustituir.
 */
let nProvisional = 0
const nuevoIdProvisional = () => `pv${++nProvisional}`

/**
 * `acabaEnPuntuacion` de una línea, que no siempre es la del turno.
 *
 * Cuando la línea ES el turno tal cual, manda la medida del transcriptor, y su
 * ausencia se respeta como `null` (F031: un campo que no se midió no se
 * inventa, y `false` significa «acabó a media oración»). Cuando la línea la
 * componemos nosotros —partiendo o uniendo— el transcriptor no la ha medido:
 * la medida verdadera es la del texto que se guarda, y leerla de nuestra propia
 * cadena no es inventar nada.
 */
function acabaEnPuntuacionDeLinea (textoLinea, turno) {
  if (textoLinea === String(turno.texto ?? '').trim()) return turno.acabaEnPuntuacion ?? null
  return acabaCerrada(textoLinea)
}

/**
 * Traduce un texto y arma la línea. No guarda ni pinta: eso es `guardarYPintar`.
 *
 * Los cuatro campos de F031 (`forzado`, `msTurno`, `msHolgura`, `motivoCorte`)
 * se quedan con los del **último turno** que compone la línea, y el criterio
 * está elegido, no heredado: describen el corte con el que esa línea se cerró,
 * que es el único que pudo partir una palabra suya. `acabaEnPuntuacion` va
 * aparte porque es del texto, no del corte (ver arriba).
 */
async function traducirLinea (texto, turno, extra = {}) {
  const t0 = Date.now()
  const tr = await traductor.traducir(texto)
  // Reloj de pared y no `tr.ms`: si una frase larga tiene ocupado a Marian,
  // la siguiente espera su turno, y esa espera la sufre el usuario aunque
  // el modelo no la cuente como suya.
  const msTraducir = Date.now() - t0
  const msTranscribir = turno.msTranscribir
  return {
    it: texto, es: tr.es,
    ms: msTranscribir + msTraducir,   // el retardo es la cadena, no una pierna
    msTranscribir, msTraducir,
    forzado: Boolean(turno.forzado),
    msTurno: turno.msTurno ?? null,
    msHolgura: turno.msHolgura ?? null,
    acabaEnPuntuacion: acabaEnPuntuacionDeLinea(texto, turno),
    motivoCorte: turno.motivoCorte ?? null,
    // F037. `arrastre`: la línea lleva pegada delante la cola de un turno
    // anterior, o sea que Marian la vio entera. `msProvisional`: cuánto tardó
    // en verse ALGO de este texto en pantalla —la burbuja provisional—; `null`
    // si no hubo ninguna, y entonces lo primero que se vio fue ya la
    // definitiva, que es `ms`. `cierre` dice por qué acaba donde acaba:
    // `'frase'` (acabó una oración), `'tope'` (la cola pasó de los 300
    // caracteres de arrastre), `'parada'` (la reunión se detuvo con la cola en
    // pantalla) o `'fallo'` (Marian no pudo traducir el turno que la
    // continuaba). `empiezaAMedias`: a ESTA línea se le quitó el principio
    // antes de mandarla a Marian. Ojo con la asimetría, que es lo que se cuenta
    // en la prueba en Windows: la marca NO va en la línea que se cerró sin
    // acabar su oración —esa empezaba donde empezaba la suya, y Marian la vio
    // entera—, va en la SIGUIENTE, que es la que se queda sin principio. Las
    // puertas son tres, y las tres son el mismo gesto —soltar una cola sin que
    // nadie la continúe—: el tope de arrastre, un fallo de Marian y la parada
    // de la reunión. Por eso la marca la pone `cerrarColaEnMano`, que es por
    // donde pasan las tres.
    arrastre: false, msProvisional: null, cierre: 'frase', empiezaAMedias: false,
    ...extra,
  }
}

/**
 * Traduce avisando en pantalla si Marian falla, en vez de propagar.
 *
 * Devuelve `null` si no se pudo traducir. El aviso nombra SOLO la traducción,
 * que es el único fallo que este texto sabe nombrar: decir «no se pudo
 * traducir» de un fallo de disco manda a investigar al sitio equivocado.
 */
async function traducirOAvisar (texto, turno, extra) {
  try {
    return await traducirLinea(texto, turno, extra)
  } catch (err) {
    // F021: Marian corre en local y no tiene claves que filtrar, pero un
    // fallo suyo puede traer una ruta o un mensaje nativo de ONNX que tampoco
    // pinta nada en pantalla — mismo trato que el resto de esta auditoría.
    aRenderer('app:estado', { clase: 'aviso', texto: `no se pudo traducir: ${sanear(err.message)}` })
    return null
  }
}

/**
 * Pone la línea a salvo y la pinta. Con `idProvisional`, sustituye esa burbuja
 * en su sitio en vez de añadir una nueva.
 */
function guardarYPintar (s, frase, idProvisional = null) {
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
    // El log SÍ lleva el mensaje tal cual (F021 no le quita nada a lo que se
    // queda dentro del proceso); lo que cruza a la pantalla va saneado.
    console.error('[autoguardado] no se pudo escribir la frase:', err.message)
    aRenderer('app:estado', { clase: 'mal', texto: `no se pudo guardar la frase: ${sanear(err.message)}` })
  } finally {
    if (!estabaAbierto) s.autosave.cerrar()
  }
  if (idProvisional) aRenderer('app:frase:reemplazo', { idProvisional, ...frase })
  else aRenderer('app:frase', frase)
}

/**
 * Cierra la cola que hubiera en pantalla como línea definitiva.
 *
 * Su traducción ya está hecha y PAGADA, así que no se vuelve a llamar a Marian:
 * se guarda lo que ya se ve. Sin esto, la última cola de la reunión —que en el
 * archivo es la última frase que dijo el interlocutor— se perdería, y eso es
 * justo lo que §0.3 promete que no pasa.
 */
function cerrarCola (s, cierre) {
  const cola = s.cola
  s.cola = null
  cerrarColaEnMano(s, cola, cierre)
}

/**
 * Lo mismo, pero con la cola que un turno ya tiene EN LA MANO.
 *
 * `procesarTurno` se apropia de `s.cola` antes de su primer `await` (allí está
 * escrito por qué), así que desde ese momento la cola ya no está en la sesión y
 * `cerrarCola` no la encontraría. Las dos salidas que la cierran con la cola
 * ya en la mano —el tope de arrastre y un fallo de Marian— pasan por aquí, no
 * por `cerrarCola`.
 *
 * Y aquí se pone la marca del archivo, porque aquí pasan TODAS las puertas.
 */
function cerrarColaEnMano (s, cola, cierre) {
  if (!cola) return
  // Soltar una cola sin que nadie la continúe deja sin principio a la línea
  // siguiente: lo que venga después continúa una oración cuyo arranque ya se
  // cerró aparte, y a Marian le llegará sin él. Las tres puertas que sueltan
  // una cola —el tope de arrastre, un fallo de Marian y la parada de la
  // reunión— pasan por esta función, así que la marca se pone una sola vez y
  // en el único sitio donde no se puede olvidar. Marcar a mano en cada puerta
  // es justo lo que dejó la parada sin marcar: el tope y el fallo tenían su
  // copia, y la tercera puerta se quedó sin ninguna.
  //
  // La condición es «había cola», no «se escribió línea»: si Marian no pudo
  // traducir esa cola no se guarda nada, pero el turno de después se queda
  // igual de huérfano.
  s.empiezaAMedias = true
  // Sin traducción no hay nada que guardar: la cola volverá a intentarse con el
  // turno siguiente si aún queda reunión. Es el mismo trato que ya tenía una
  // frase que Marian no pudo traducir.
  if (!cola.frase) return
  guardarYPintar(s, { ...cola.frase, cierre }, cola.id)
}

/**
 * Un turno: arrastra lo que faltaba, traduce por oraciones y deja la cola.
 *
 * `llegada` es cuándo entró el turno, no cuándo le tocó: los turnos se procesan
 * en serie, así que la espera detrás del anterior también la sufre el usuario y
 * tiene que estar dentro de `msProvisional`.
 */
async function procesarTurno (s, turno, llegada) {
  const texto = String(turno.texto ?? '').trim()
  if (!texto) return

  // La cola se saca de la sesión AQUÍ, en el mismo tick y antes del primer
  // `await`: desde ahora la lleva este turno en la mano y nadie más puede
  // cerrarla. Sin esta apropiación, `pararSesion` podía vencer su gracia con la
  // unión todavía en vuelo, cerrar con `'parada'` esa MISMA cola, y al volver
  // la traducción se guardaba la unión, que la contiene: el mismo texto del
  // hablante dos veces en el `.jsonl` y dos burbujas en pantalla, con los tres
  // contadores de la barra contando esa frase dos veces.
  const colaPrevia = s.cola
  s.cola = null
  // La misma cola, mientras siga sin cerrar. Las dos salidas de abajo —el tope
  // y el fallo de Marian— la cierran, y ninguna puede cerrarla dos veces.
  let colaEnMano = colaPrevia
  const union = arrastrar(colaPrevia?.it, texto)

  // La cola pasó del tope de arrastre: se cierra con lo que ya tiene y el turno
  // nuevo empieza por donde empiece. Es una de las tres puertas por las que un
  // texto llega a Marian empezado por la mitad —las otras dos son un fallo de
  // Marian, más abajo, y la parada de la reunión, al final—. Y la línea que
  // empieza a medias es la de ESTE turno, no la que se cierra aquí: la cola
  // cerrada empieza donde empezaba su oración, y a Marian le llegó entera.
  //
  // La marca la pone `cerrarColaEnMano`, que es por donde pasan las tres. Aquí
  // la línea marcada es la de este mismo turno y no la del siguiente: cuando
  // el tope salta, `s.cola` ya es null, así que `union.arrastre` es false y el
  // `empiezaAMedias` de tres líneas más abajo la lee para ESTE turno.
  if (union.colaSuelta) {
    cerrarColaEnMano(s, colaEnMano, 'tope')
    colaEnMano = null
  }

  // Se consume ya con el tope aplicado. Si se arrastra, la línea empieza donde
  // empezaba la cola y hereda su marca; si no, empieza donde empiece el turno, y
  // eso es a media oración sólo si la cola anterior se soltó sin continuarla.
  const empiezaAMedias = union.arrastre
    ? colaPrevia.empiezaAMedias === true
    : s.empiezaAMedias === true
  s.empiezaAMedias = false

  const { completas, cola } = partirTurno(union.texto)
  // Si se arrastró, la burbuja que ya está en pantalla es la que hay que
  // sustituir: la definitiva ocupa SU sitio, no se añade otra debajo.
  let aSustituir = union.arrastre ? colaPrevia.id : null
  // Se lee de la cola y no de su `frase`: si Marian falló traduciendo la cola,
  // `frase` es `null` pero la burbuja que la enseña sigue en pantalla desde
  // antes, y esa medida es la que vale.
  const msProvisional = union.arrastre ? colaPrevia.msProvisional ?? null : null

  if (completas) {
    const frase = await traducirOAvisar(completas, turno,
      { arrastre: union.arrastre, msProvisional, empiezaAMedias })
    if (!frase) {
      // Marian no pudo con la unión. El turno se pierde, como cualquier otra
      // frase que no se puede traducir, pero la cola NO: ya estaba traducida y
      // en pantalla. Se cierra aquí con lo que tenía.
      //
      // Y sobre todo, se cierra para que no se quede esperando al turno
      // siguiente: uniéndola a un turno con el que ya no es contigua saldría
      // una frase que no dijo nadie —«Tu pensi che questo ruolo di Malena ti
      // darà» + «Questo è un lavoro difficile.»— y esa sí acabaría en el
      // archivo como si fuera una transcripción.
      cerrarColaEnMano(s, colaEnMano, 'fallo')
      // Si HABÍA cola, la marca ya la ha puesto ella. Esto cubre el otro caso:
      // sin cola previa, lo que se pierde es el texto de este turno entero
      // —las completas y la cola que venía detrás—, así que el turno siguiente
      // continúa una oración cuyo principio no quedó en ningún sitio y también
      // llega a Marian sin él.
      s.empiezaAMedias = true
      return
    }
    guardarYPintar(s, frase, aSustituir)
    aSustituir = null

    // Y después de pintar, nunca antes: el triaje y el LLM no pueden retrasar
    // la burbuja, que es lo que el usuario está leyendo.
    //
    // Si la reunión ya terminó, aquí se para. Una respuesta sugerida que nadie
    // va a leer cuesta una llamada al LLM, y el panel donde se pintaría ya no
    // está en pantalla. La frase, en cambio, sí se ha guardado.
    //
    // Sólo texto DEFINITIVO: la cola provisional no pasa por aquí ni cuando se
    // pinta ni cuando se sustituye, porque una pregunta leída a medias se
    // contesta a medias y esa respuesta la va a decir el usuario en voz alta.
    if (!s.cerrada) {
      // `considerar` no se espera a propósito —dentro decide si merece la
      // llamada y emite por su cuenta—, así que aquí solo se recoge el fallo.
      s.motor?.considerar(completas, frase.es)
        .catch(e => console.error('[preguntas]', e.message))
      s.resumen?.registrar(completas, frase.es)
    }
  }

  if (cola) {
    // La cola de este turno sólo puede empezar a media oración si no vino
    // ninguna completa delante: si vino, la cola arranca justo detrás de un
    // `.?!`, o sea desde el principio de su oración.
    const colaEmpiezaAMedias = completas ? false : empiezaAMedias
    // La primera vez que se ve algo de este texto es AHORA; si viene de una
    // cola anterior, ya se vio entonces y esa es la medida que vale.
    const msProvisionalAhora = msProvisional ?? (Date.now() - llegada)
    const frase = await traducirOAvisar(cola, turno, {
      arrastre: union.arrastre,
      empiezaAMedias: colaEmpiezaAMedias,
      msProvisional: msProvisionalAhora,
    })
    const id = aSustituir ?? nuevoIdProvisional()
    // Si Marian no pudo con la cola, el texto se guarda igual para reintentarlo
    // con el turno siguiente, y se conserva el id de la burbuja que hubiera en
    // pantalla: sin él esa burbuja se quedaría con un «…» que ya no va a cerrar
    // nadie, y la frase buena saldría debajo, repetida.
    // Las dos marcas viven en la cola y no sólo en su `frase`: si Marian falló
    // con esta cola, `frase` es `null` y las dos tienen que sobrevivir hasta el
    // turno que la continúe.
    //
    // `msProvisional`: si esta cola se tradujo, lo primero que se ve de ella es
    // ahora. Si falló pero había una burbuja anterior —que enseña parte del
    // mismo texto—, vale la medida de entonces; y si no había ninguna, no se ha
    // visto nada todavía y sigue siendo `null`, que es lo que ese campo
    // significa.
    s.cola = {
      id: frase ? id : aSustituir, it: cola, frase,
      empiezaAMedias: colaEmpiezaAMedias,
      msProvisional: frase ? msProvisionalAhora : (aSustituir ? msProvisional : null),
    }
    if (frase) {
      aRenderer(aSustituir ? 'app:frase:reemplazo' : 'app:frase',
        { ...(aSustituir ? { idProvisional: aSustituir } : {}), id, provisional: true, ...frase })
    }
  } else {
    s.cola = null
  }

  // Si la reunión se cerró mientras esto traducía, la cola ya no va a tener
  // quien la cierre: `pararSesion` pasó por su sitio antes de que existiera.
  if (s.cerrada) cerrarCola(s, 'parada')
}

// ── La reunión ────────────────────────────────────────────────────────
async function empezarSesion ({ perfil, contexto: ctx }) {
  if (sesion) return { ok: true, yaCorriendo: true }

  const claves = leerClaves()
  if (!claves.stt) {
    return { ok: false, motivo: 'Falta la clave de transcripción. Ponla en Ajustes.' }
  }

  // Se guardan para que el informe y los prompts los tengan.
  //
  // F032: un perfil que ya existe (llega con `id`, porque el asistente lo
  // tomó de la lista) se ACTUALIZA, nunca se vuelve a insertar. Antes de
  // esto, `empezarSesion` llamaba a `crearPerfil` en cada reunión sin mirar
  // si ya había uno: el cliente lo dijo tal cual — "estar poniendo los
  // perfiles a cada rato no es bueno" — y la causa era esta línea, no la
  // pantalla. El que se usa queda `activarPerfil`, que es lo que permite
  // preseleccionarlo la próxima vez sin que nadie vuelva a escribir nada.
  if (perfil?.nombre) {
    const id = perfil.id
      ? (contexto.actualizarPerfil(perfil.id, {
          nombre: perfil.nombre, edad: perfil.edad ?? null,
          ocupacion: perfil.ocupacion ?? null, contexto: perfil.contexto ?? null,
        }), perfil.id)
      : contexto.crearPerfil(perfil)
    contexto.activarPerfil(id)
    perfil = { ...perfil, id }
  }
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

  const { motor, resumen } = montarMotores({ perfil, ctx, claveLlm: claves.llm, autosave })
  sesion = {
    transcriptor, autosave, idSesion, motor, resumen, inicio: Date.now(), frases: 0,
    // Las frases a medio traducir, para poder esperarlas al parar en vez de
    // perderlas. Y `cerrada`, para que las que vuelvan tarde sepan que la
    // reunión terminó: se guardan igual, pero no gastan llamadas al LLM.
    enVuelo: new Set(),
    cerrada: false,
    // F037. `cola`: la oración a medias que está en pantalla como burbuja
    // provisional, con su id y su traducción ya pagada. `cadena`: los turnos se
    // procesan EN SERIE, porque la cola de uno se arrastra al siguiente y dos
    // turnos a la vez la pisarían — el segundo leería una cola que el primero
    // todavía no ha dejado, y esa oración se traduciría dos veces y por la
    // mitad. Lo que se pierde es solapar dos traducciones; lo que se gana es
    // que el arrastre signifique algo.
    cola: null,
    cadena: Promise.resolve(),
    // Se pone a `true` cuando una cola se suelta sin que nadie la continúe
    // —el tope, un fallo de Marian o la parada de la reunión—: la primera línea
    // que salga después es la que llega a Marian sin su principio, y es ella la
    // que queda marcada en el archivo.
    empiezaAMedias: false,
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
  transcriptor.on('frase', turno => {
    // Cuándo LLEGÓ, no cuándo le toque: los turnos se procesan en serie (ver
    // `s.cadena`), y la espera detrás del anterior también la sufre el usuario.
    const llegada = Date.now()
    // `s.cadena` es la fila: cada turno espera al anterior. `catch` aquí y no
    // fuera porque una fila rota no vuelve a andar, y con ella se quedaría sin
    // procesar el resto de la reunión. No se pinta nada: no es un fallo que el
    // usuario pueda interpretar, y desde luego no es «no se pudo traducir»
    // —eso ya lo dice `traducirOAvisar` cuando el que falla es Marian—.
    const tarea = s.cadena = s.cadena
      .then(() => procesarTurno(s, turno, llegada))
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

  // F021: `assemblyLive.js` ya traduce y sanea lo que sabe del servidor, pero
  // esta es la última puerta antes del renderer — el punto único por el que
  // pasan las tres capas de errores de ese módulo (protocolo, cierre,
  // reconexión), así que sanea otra vez, sin coste si ya venía limpio.
  transcriptor.on('error', err =>
    aRenderer('app:estado', { clase: 'aviso', texto: sanear(err.message) }))

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
    // La oración a medias que quedara en pantalla se cierra ANTES de cerrar el
    // archivo: su traducción ya está hecha y pagada, y es la última frase que
    // dijo el interlocutor. Va después de la gracia para que la cola sea ya la
    // definitiva, y antes del `lineCount` para que entre en la cuenta.
    cerrarCola(s, 'parada')
    s.autosave.cerrar()
    db.endSession(s.idSesion, {
      durationSeconds: Math.round((Date.now() - s.inicio) / 1000),
      lineCount: s.frases,
    })
    db.vaciar()

    // F039b: sólo se encola si hay a quién mandarle algo (`informes.token.json`
    // presente). `encolar` es una escritura pequeña, síncrona, como el propio
    // autoguardado; `enviarPendientes` se lanza SIN `await` a propósito: un
    // VPS lento o caído no puede retrasar ni el resumen de la reunión ni el
    // cierre de la ventana. Errores de red los traga `enviarPendientes` por su
    // cuenta (queda en cola para el siguiente intento); lo único que se
    // atrapa aquí es un fallo al leer el token o al escribir la cola misma.
    try {
      if (leerTokenInformes()) {
        const reunion = path.basename(s.autosave.ruta, '.jsonl').replace(/^sesion-/, '')
        const cola = obtenerColaInformes()
        cola.encolar(s.autosave.ruta, { maquina: maquinaSaneada(), version: app.getVersion(), reunion })
        cola.enviarPendientes().catch(() => {})
      }
    } catch (err) {
      console.error('[informes] no se pudo encolar la subida:', err.message)
    }
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
    // F033: cuántas preguntas puso el usuario a mano con «→ Pregunta». Es el
    // dato que dice cuántas se le escapan al detector; vive en `s`, no en
    // `s.motor.stats`, porque también cuenta las que se pulsaron sin clave de
    // LLM configurada, cuando `s.motor` ni siquiera existe.
    preguntasManuales: s.preguntasManuales || 0,
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
    aRenderer('app:respuesta', {
      id, texto: null, tipo: 'desconocido',
      mensaje: 'La reunión ya no está en marcha; vuelve a empezarla para pedir otra respuesta.',
      detalle: '',
    })
    return { ok: false }
  }
  return { ok: sesion.motor.reintentar(id) }
})

/**
 * El botón «→ Pregunta» de una burbuja (F033).
 *
 * Pedido por el cliente: el detector se le escapa alguna pregunta clara en
 * habla real, así que el usuario decide y la app obedece, saltándose
 * `questionDetector` — `MotorRespuestas.forzar()` es quien salta el detector
 * de verdad; aquí sólo se decide QUÉ decir cuando no hay a quién preguntarle.
 *
 * El botón ya ha dejado la burbuja «enviada» al pulsarlo (eso lo hace el
 * renderer, sin esperar a esto), así que este manejador SIEMPRE tiene que
 * abrir una tarjeta y decir algo en ella — quedarse callado dejaría al
 * usuario sin saber si el clic sirvió de algo, que es el mismo fallo que
 * F021 ya arregló para «Otra».
 */
let nPreguntaManual = 0
ipcMain.handle('app:preguntar', (_e, { it, es } = {}) => {
  const texto = String(it || '').trim()
  if (!texto) return { ok: false }

  // Sin reunión no hay dónde registrarlo ni con qué contestar, pero la
  // tarjeta se pinta igual: mismo criterio que `app:otraRespuesta`.
  if (!sesion) {
    const id = `m${++nPreguntaManual}`
    aRenderer('app:pregunta', { id, it: texto, es: es || '' })
    aRenderer('app:respuesta', {
      id, texto: null, tipo: 'desconocido',
      mensaje: 'La reunión ya no está en marcha; vuelve a empezarla para pedir una respuesta.',
      detalle: '',
    })
    return { ok: false, id }
  }

  const s = sesion
  s.preguntasManuales = (s.preguntasManuales || 0) + 1
  // Se registra el intento, haya o no motor: es el dato que dice cuántas
  // preguntas se le escapan al detector, y contarlo depende de que quede
  // escrito ANTES de saber si hay quien la conteste.
  s.autosave.guardarPregunta({ it: texto, es: es || '', manual: true })

  if (!s.motor) {
    // F021: mismo contrato que cualquier otro fallo del panel de respuestas
    // — `texto: null` con `{ tipo, mensaje, detalle }` — para que la tarjeta
    // lo diga en vez de quedarse en «Preparando…».
    const id = `m${++nPreguntaManual}`
    aRenderer('app:pregunta', { id, it: texto, es: es || '' })
    aRenderer('app:respuesta', {
      id, texto: null, tipo: 'clave_invalida',
      mensaje: 'Sin clave de IA: no habrá respuesta. Configúrala en Ajustes.',
      detalle: '',
    })
    return { ok: true, id }
  }

  // Aquí sí puede volver `null`: es el dedupe de `forzar()`, la misma
  // pregunta ya está en el panel. La burbuja ya quedó «enviada» igualmente.
  const id = s.motor.forzar(texto, es)
  return { ok: Boolean(id), id: id || null }
})

ipcMain.handle('app:guardarClaves', (_e, claves) => {
  // F021: `err` aquí sale de `safeStorage`/`fs`, no de un proveedor, pero
  // pasa por `sanear()` igual — es la misma frontera proceso-principal →
  // renderer que las demás, y no puede haber una excepción sin motivo.
  try { return { ok: true, guardadas: guardarClaves(claves) } }
  catch (err) { return { ok: false, motivo: sanear(err.message) } }
})

/**
 * Dice CUÁLES claves hay, nunca su valor. El ajuste de informes (F039b) no es
 * un secreto —es una elección de consentimiento— así que este sí viaja tal
 * cual, con su valor por defecto ("completo", en beta) si el usuario nunca lo
 * tocó. `informesDisponibles` dice si HAY a quién subir algo: sin
 * `informes.token.json` la subida está desactivada pase lo que pase el
 * usuario elija, y Ajustes tiene que poder decirlo.
 */
ipcMain.handle('app:estadoClaves', () => {
  const c = leerClaves()
  return {
    stt: !!c.stt,
    llm: !!c.llm,
    cifradoDisponible: safeStorage.isEncryptionAvailable(),
    informes: c.informes || 'completo',
    informesDisponibles: Boolean(leerTokenInformes()),
  }
})

/**
 * F036 — el botón «Probar» de cada clave en Ajustes.
 *
 * La clave que se prueba es la que el usuario acaba de escribir, tal cual
 * llega del renderer: no pasa por `guardarClaves` ni por `leerClaves`, así
 * que se puede probar una clave sin guardarla y sin pisar la que ya
 * funcionaba. Lo que vuelve al renderer nunca lleva la clave — sólo el
 * mensaje de `clasificarError` (F021), que ya sale saneado, o el proveedor y
 * el modelo, que tampoco son la clave.
 *
 * La prueba de AssemblyAI reutiliza `start()`/`stop()` tal cual: es la misma
 * disciplina de sesión de `assemblyLive.js` (freno de ritmo, `Terminate` en
 * toda salida) descrita ahí arriba, y abrir un socket de prueba consume
 * igual una de las cuatro conexiones por minuto del plan — no hay un camino
 * aparte que la esquive.
 */
async function probarClaveStt (clave) {
  if (!clave) return { ok: false, mensaje: 'Falta la clave de transcripción.' }
  const t = new AssemblyLiveTranscriber({ apiKey: clave })
  const inicio = Date.now()
  try {
    await t.start()
    await t.stop()
    return { ok: true, mensaje: `Clave válida: conectó en ${Date.now() - inicio} ms.` }
  } catch (err) {
    // Si algo llegó a abrirse a medias, `t.stop()` lo cierra con `Terminate`
    // igual que en cualquier otra salida (ver `_registrarSalidas()` en
    // `assemblyLive.js`); si nunca hubo socket, no hace nada.
    try { await t.stop() } catch { /* ya está cerrado, o nunca se abrió */ }
    return { ok: false, mensaje: clasificarError(err).mensaje }
  }
}

/** La prueba del LLM: una llamada mínima, sólo para confirmar clave y modelo. */
async function probarClaveLlm (clave) {
  if (!clave) return { ok: false, mensaje: 'Falta la clave del modelo de lenguaje.' }
  try {
    const proveedor = proveedorDeClave(clave)
    const llamar = crearLlamador({ clave })
    await llamar('Responde solo con la palabra ok, en minúsculas y sin puntuación.', 'ok', { maxTokens: 5 })
    const modelo = MODELOS[proveedor]
    return { ok: true, mensaje: `Clave válida: ${NOMBRE_PROVEEDOR[proveedor]}, se usará ${modelo}.` }
  } catch (err) {
    return { ok: false, mensaje: clasificarError(err).mensaje }
  }
}

ipcMain.handle('app:probarClaveStt', (_e, clave) => probarClaveStt(clave))
ipcMain.handle('app:probarClaveLlm', (_e, clave) => probarClaveLlm(clave))

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
    // F021: se sanea ANTES de recortar — recortar primero podría partir una
    // clave a la mitad y dejar fuera del patrón lo que sobrevive al `slice`.
    r.extremo = { mal: true, valor: sanear(err.message).slice(0, 60) }
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

// F032: panel de Perfiles (lista, crear, editar, borrar, activar). Las
// funciones ya existían en `contexto.js`; solo faltaba este cableado y la
// pantalla que las pinta.
ipcMain.handle('app:listarPerfiles', () => contexto.listarPerfiles())
ipcMain.handle('app:guardarPerfil', (_e, p) => contexto.crearPerfil(p))
ipcMain.handle('app:actualizarPerfil', (_e, { id, campos }) => contexto.actualizarPerfil(id, campos))
ipcMain.handle('app:borrarPerfil', (_e, id) => { contexto.borrarPerfil(id); return { ok: true } })
ipcMain.handle('app:activarPerfil', (_e, id) => { contexto.activarPerfil(id); return { ok: true } })

ipcMain.handle('app:listarContextos', () => contexto.listarContextos())
ipcMain.handle('app:guardarContexto', (_e, c) => contexto.crearContexto(c))
ipcMain.handle('app:actualizarContexto', (_e, { id, campos }) => contexto.actualizarContexto(id, campos))
ipcMain.handle('app:borrarContexto', (_e, id) => { contexto.borrarContexto(id); return { ok: true } })
ipcMain.handle('app:activarContexto', (_e, id) => { contexto.activarContexto(id); return { ok: true } })

/**
 * F032/F038 — la lista de «Conversaciones» del panel de inicio.
 *
 * Lee `.jsonl` de disco (`Autosave.listar`/`Autosave.leer`) y no la tabla
 * `sessions`: es la fuente que el no negociable §0.3 garantiza completa.
 * Se comprobó (F038) que `sessions` sólo guarda metadatos de la sesión —ni
 * transcripción ni preguntas, `db.js` avisa en su propio código que
 * `saveTranscript` está obsoleto desde que las frases van al `.jsonl`—, así
 * que no hay nada ahí que valga la pena leer para esta lista.
 *
 * `preguntas` cuenta las líneas `pregunta` (F033, cada pulsación de
 * «→ Pregunta», tenga o no motor) más las `respuestaLlm` que NO son manuales
 * —las que detectó el motor solo, que hasta F038 no dejaban ningún rastro en
 * el archivo—. Sumar las dos evita contar dos veces una pregunta manual, que
 * ya tiene su línea `pregunta`.
 */
function listarConversaciones () {
  const dir = path.join(app.getPath('userData'), 'reuniones')
  return Autosave.listar(dir).map(f => {
    let cabecera = null, frases = 0, preguntas = 0, duracion = 0
    let latenciaP50 = null, latenciaP95 = null
    let stt = { usd: 0, procedencia: 'no se pudo leer el archivo' }
    let llm = { usd: 0, procedencia: 'no se pudo leer el archivo' }
    try {
      const { entradas } = Autosave.leer(f.ruta)
      cabecera = entradas.find(e => e.tipo === 'cabecera') || null
      const lineasFrase = entradas.filter(e => e.tipo === 'frase')
      frases = lineasFrase.length
      preguntas = entradas.filter(e => e.tipo === 'pregunta').length
        + entradas.filter(e => e.tipo === 'respuestaLlm' && !e.manual).length
      duracion = duracionMs(entradas)
      const latencias = lineasFrase.map(e => e.ms)
      latenciaP50 = percentil(latencias, 50)
      latenciaP95 = percentil(latencias, 95)
      stt = costeStt(duracion)
      llm = costeLlm(entradas)
    } catch (err) {
      console.error('[conversaciones] no se pudo leer', f.archivo, err.message)
    }
    return {
      archivo: f.archivo, ruta: f.ruta, tamano: f.tamano,
      inicio: cabecera?.inicio || null,
      perfil: cabecera?.perfil?.nombre || null,
      contexto: cabecera?.contexto?.nombre || null,
      idSesion: cabecera?.id ?? null,
      frases, preguntas, duracionMs: duracion,
      latenciaP50, latenciaP95,
      costeSttUsd: stt.usd, costeSttProcedencia: stt.procedencia,
      costeLlmUsd: llm.usd, costeLlmProcedencia: llm.procedencia,
    }
  })
}
ipcMain.handle('app:listarConversaciones', () => listarConversaciones())

/**
 * F038 — empareja cada pregunta con su respuesta para «ver reunión».
 *
 * Las líneas `pregunta` (F033) se pintan en cuanto se abre la tarjeta, sin
 * respuesta todavía; las `respuestaLlm` (F038) llegan después, cuando el LLM
 * contesta o falla. Se emparejan por texto porque las `pregunta` manuales no
 * llevan el id del motor (ver `montarMotores`) — el texto de una pregunta ya
 * deduplicado (`MotorRespuestas.sonLaMisma`) es suficientemente único dentro
 * de una misma reunión. Una `respuestaLlm` que no encuentra pareja —la
 * pregunta la detectó el motor solo, y hasta F038 esas no dejaban línea
 * propia— se enseña de todos modos, con su propio texto.
 */
function ensamblarPreguntas (entradas) {
  const preguntas = entradas
    .filter(e => e.tipo === 'pregunta')
    .map(e => ({ it: e.it, es: e.es || '', manual: Boolean(e.manual), respuesta: e.respuesta || null, mensaje: null }))

  for (const r of entradas.filter(e => e.tipo === 'respuestaLlm')) {
    const pendiente = preguntas.find(p => p.it === r.it && !p.respuesta && !p.mensaje)
    if (pendiente) {
      pendiente.respuesta = r.texto || null
      pendiente.mensaje = r.mensaje || null
    } else {
      preguntas.push({ it: r.it, es: r.es || '', manual: Boolean(r.manual), respuesta: r.texto || null, mensaje: r.mensaje || null })
    }
  }
  return preguntas
}

/**
 * F038 — «ver reunión»: transcripción entera y preguntas con sus respuestas.
 */
function leerConversacion (ruta) {
  const { entradas } = Autosave.leer(ruta)
  const cabecera = entradas.find(e => e.tipo === 'cabecera') || null
  const frases = entradas.filter(e => e.tipo === 'frase').map(e => ({ it: e.it, es: e.es, t: e.t }))
  return {
    inicio: cabecera?.inicio || null,
    perfil: cabecera?.perfil?.nombre || null,
    contexto: cabecera?.contexto?.nombre || null,
    frases,
    preguntas: ensamblarPreguntas(entradas),
  }
}
ipcMain.handle('app:leerConversacion', (_e, ruta) => leerConversacion(ruta))

/**
 * F038 — «Borrar»: quita el `.jsonl` Y la fila de `sessions` si la hay.
 *
 * La ruta tiene que caer DENTRO de la carpeta de reuniones del propio
 * usuario: el renderer manda la ruta que él mismo le entregó
 * `listarConversaciones()`, pero nunca hay que confiar en una ruta que
 * cruza el puente de IPC sin comprobarla, y menos una que se va a borrar.
 */
function borrarConversacion (ruta) {
  const dir = path.join(app.getPath('userData'), 'reuniones')
  const rutaResuelta = path.resolve(ruta || '')
  if (path.dirname(rutaResuelta) !== path.resolve(dir)) {
    return { ok: false, motivo: 'esa ruta no es una reunión guardada por la app' }
  }
  let idSesion = null
  try {
    const { entradas } = Autosave.leer(rutaResuelta)
    idSesion = entradas.find(e => e.tipo === 'cabecera')?.id ?? null
  } catch { /* si no se puede leer la cabecera, se borra igual el archivo */ }

  if (idSesion !== null && idSesion !== undefined) {
    try { db.deleteSession(idSesion) } catch (err) { console.error('[conversaciones] no se pudo borrar de la base:', err.message) }
  }
  try {
    fs.unlinkSync(rutaResuelta)
  } catch (err) {
    return { ok: false, motivo: `no se pudo borrar el archivo: ${err.message}` }
  }
  return { ok: true }
}
ipcMain.handle('app:borrarConversacion', (_e, ruta) => borrarConversacion(ruta))

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
  // F039b: cualquier informe que se quedara pendiente de una reunión anterior
  // (sin red, VPS caído) se reintenta aquí. Sin `await`: el arranque de la
  // ventana no puede esperar a una subida.
  obtenerColaInformes().enviarPendientes().catch(() => {})
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

module.exports = {
  _internos: {
    guardarClaves, leerClaves, empezarSesion, pararSesion,
    leerTokenInformes, maquinaSaneada, obtenerColaInformes, listarConversaciones,
    leerConversacion, borrarConversacion, ensamblarPreguntas,
  },
}
