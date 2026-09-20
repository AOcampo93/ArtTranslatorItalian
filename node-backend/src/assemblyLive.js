/**
 * assemblyLive.js
 * Transcripción de italiano en vivo con AssemblyAI Universal-3.5 Pro Realtime.
 *
 * Es el motor de la versión 1. Sustituye a whisper local, y se eligió frente a
 * Gemini Live con medidas propias sobre el mismo audio y el mismo instrumento:
 *
 * |                        | Gemini Live | AssemblyAI U-3.5 Pro |
 * |------------------------|------------:|---------------------:|
 * | WER con audio limpio   |  0,0% (n=1) |      0,0% p50 (n=25) |
 * | Primer parcial         |    1.478 ms |         881–980 ms   |
 * | **Tras dejar de hablar** |    298 ms |       **201–257 ms** |
 * | **Tope de sesión**     | **9,84 min** |          **3 horas** |
 *
 * El tope es lo que decidió la elección, no la latencia: una reunión de 90
 * minutos es **una sola conexión** en lugar de seis a nueve relevos, y cada
 * relevo era una costura por la que se podía perder una frase.
 *
 * ## La disciplina de sesión NO es opcional
 *
 * AssemblyAI **factura por tiempo de socket abierto, no por audio enviado**, y
 * una sesión que no se cierra con `Terminate` se cierra sola **a las 3 horas y
 * se facturan las 3 horas completas**. Peor aún: ocupa una de las cinco plazas
 * de concurrencia, así que una sesión huérfana **impide la siguiente reunión**.
 *
 * Esto está medido, y me costó dinero descubrirlo: una prueba mía abrió veinte
 * conexiones en diez segundos sin mandar `Terminate`, y el servidor empezó a
 * responder `Unauthorized Connection: Too many concurrent sessions`.
 *
 * De ahí salen tres invariantes de este módulo:
 *
 *  1. **Como mucho una sesión viva.** Nada de solapar como hacía el módulo de
 *     Gemini: con sesiones de 3 horas no hace falta, y solapar quemaría el
 *     límite de concurrencia.
 *  2. **`Terminate` siempre**, y en todas las salidas: al parar, al cerrar la
 *     ventana, al morir el proceso, **y también si se para mientras se está
 *     conectando** — ese socket todavía no es `this._ws`, así que hay que
 *     cerrarlo donde se abrió. Ver `registrarSalidas()` y `_abrir()`.
 *  3. **Nunca más de cuatro conexiones nuevas por minuto.** El límite del plan
 *     gratuito son cinco; se deja una de margen. Sin este freno, una racha de
 *     reconexiones deja al usuario sin servicio justo cuando más lo necesita.
 *
 * ## El turno no puede durar lo que quiera el hablante
 *
 * AssemblyAI cierra el turno por **silencio**, no por longitud. Quien narra
 * sin pausas lo mantiene abierto indefinidamente, y hasta que no se cierra no
 * hay texto definitivo que traducir: la pantalla se queda en blanco.
 *
 * Medido en la primera prueba real (HP Pavilion, 21 frases, 3,1 min): el hueco
 * entre frases fue de 4,8 s de mediana, pero **dos veces llegó a 33,6 s y a
 * 65,6 s**, y después cayeron 436 y 892 caracteres de golpe.  [medido]
 *
 * El efecto de arrastre es igual de importante: el tiempo de Marian crece con
 * la longitud —sobre esas mismas 21 frases, 6,34 ms por carácter con R² 0,994
 * [medido]—, así que trocear el turno también mata la cola de latencia de la
 * traducción. Un arreglo, dos problemas.
 *
 * Desde F031 el troceo va en tres capas, y el orden importa porque cada una
 * hace más daño que la anterior:
 *
 *  1. **El servidor cierra en la pausa.** Se le mandan `max_turn_silence` y
 *     `end_of_turn_confidence_threshold` al conectar (`construirUrl`). Un
 *     corte suyo caería donde el hablante paró. **Hoy no corta nada:** medido
 *     el 19-09-2026 contra el servicio real, con 1.536 ms, con 700 ms y con
 *     300 ms el servidor cerró exactamente los mismos turnos [simulado]. Se
 *     mandan porque la referencia de la API los documenta y no cuestan nada,
 *     pero quien acota el hueco es la capa 2. Ver `MAX_SILENCIO_TURNO_MS`.
 *  2. **`ForceEndpoint` como red de seguridad** (`_quizaForzarFin`): sólo si
 *     el turno se pasó del tope Y el audio que estamos enviando lleva ≥ 300 ms
 *     en silencio. La segunda prueba real enseñó por qué hace falta la segunda
 *     condición: cortando por reloj, 10 de 13 trozos acabaron a media oración
 *     [medido, sesion-2.jsonl].
 *  3. **Tope duro**, que corta aunque haya voz. El caso del monólogo sin
 *     pausas no lo resuelve nada más.
 */

'use strict'

const { EventEmitter } = require('events')
const { sanear } = require('./llm')

const HOST = 'wss://streaming.assemblyai.com/v3/ws'
const MODELO = 'universal-3-5-pro'

/** Lo que exige el protocolo: PCM16 LE, mono, 16 kHz, en frames binarios. */
const SAMPLE_RATE = 16000
const MS_TROZO = 100
const MUESTRAS_TROZO = SAMPLE_RATE * MS_TROZO / 1000

/**
 * Trozos fuera de 50–1000 ms hacen que el servidor cierre con 3007. Los 100 ms
 * están dentro con margen por los dos lados.
 */
const MS_TROZO_MIN = 50
const MS_TROZO_MAX = 1000

/** Tope real de sesión del servidor. */
const TOPE_SESION_MS = 3 * 60 * 60 * 1000
/** Se releva antes, para que el corte no caiga en mitad de una reunión larga. */
const RELEVAR_A_LOS_MS = 2.75 * 60 * 60 * 1000

/**
 * Esperas de reconexión, espaciadas para respetar el límite de conexiones
 * nuevas por minuto. La primera es rápida porque un corte de red suele durar
 * poco; a partir de ahí se separan.
 */
const ESPERAS_MS = [1500, 6000, 20000, 40000]

/** Conexiones nuevas permitidas en una ventana móvil de 60 s. El plan da 5. */
const MAX_CONEXIONES_MIN = 4

/**
 * Silencio que se le pide al servidor para que cierre el turno **él**.
 *
 * Es la primera de las tres capas del troceo (F031): un corte que hace el
 * servidor cae donde el hablante paró; uno que hacemos nosotros cae donde
 * marca el reloj. El valor por defecto del servicio son 1.536 ms en U-3.5 Pro
 * [verificado en la referencia de la API de streaming, 19-09-2026], y con eso
 * hay que callarse siglo y medio para que el turno se dé por acabado: en la
 * segunda prueba real, 13 de 20 frases las tuvimos que cortar nosotros
 * [medido, sesion-2.jsonl].
 *
 * Los 700 ms son una pausa de conversación normal.
 *
 * **Ojo, y está medido:** contra el servicio real, el 19-09-2026, este
 * parámetro no cambió nada. Con 1.536 ms, con 700 ms y con 300 ms salieron los
 * mismos turnos sobre un audio con veinte pausas de 700-1.100 ms [simulado,
 * voz sintética; ver PLAN.md §7bis]. Se manda porque la referencia de la API
 * lo documenta así y no cuesta nada, pero **quien acota el hueco es
 * `_quizaForzarFin()`**, no esto. Por qué lo ignora está [por medir].
 */
const MAX_SILENCIO_TURNO_MS = 700

/**
 * Cuánta certeza le basta al servidor para dar el turno por acabado.
 *
 * Por defecto 0,4 [verificado en la referencia de la API de streaming,
 * 19-09-2026]. Se baja para que cierre también en las pausas que no son
 * limpias —que son casi todas las de una reunión—, porque cada turno que
 * cierra el servidor es un `ForceEndpoint` que no hace falta.
 *
 * Con la misma advertencia que el de arriba: bajarlo a 0,25 —y en la sonda a
 * 0,1— no cambió ningún turno contra el servicio [simulado, 19-09-2026].
 */
const UMBRAL_CONFIANZA_FIN_TURNO = 0.25

/**
 * Tope a partir del cual se BUSCA una pausa para trocear el turno.
 *
 * No es el instante del corte: es el instante en que la red de seguridad
 * empieza a mirar si el audio que enviamos está en silencio. El corte cae en
 * la primera pausa a partir de aquí, o de golpe en `TOPE_DURO_TURNO_MS`.
 *
 * **Por qué 6 s, y no los 8 s que tuvo hasta ahora.** Lo medido no cambia de
 * valor; cambia lo que se lee en ello:
 *
 *  · **No muerde a los turnos normales.** Los turnos de la primera sesión real
 *    duraron 4,5 s de mediana, y ninguno de los que no era monólogo pasó de
 *    10,6 s [medido].
 *  · **Lo que el usuario espera por una frase** es el tope MÁS el primer
 *    parcial (881–980 ms [medido]), MÁS el cierre del turno (201–257 ms
 *    [medido]), MÁS la traducción del trozo. Cronometrado con el Marian del
 *    propio HP: con 8 s de tope salían 9,5 s de hueco máximo frente a los
 *    65,6 s medidos; con 6 s, 7,4 s [simulado].
 *  · **Los trozos le caen a Marian del tamaño que sabe llevar.** A la
 *    velocidad medida en ese audio (11,9 caracteres/s [medido]), 6 s son unos
 *    71 caracteres, o sea ~510 ms de traducción con la regresión del propio
 *    equipo (ms = 56 + 6,34·caracteres, R² 0,994 [medido])  [estimado].
 *
 * Y el precio, que también está medido: con 8 s, 14 de los 38 trozos acabarían
 * en mitad de una frase; con 6 s son 22 [simulado]. Contando sólo cortes, 8 s
 * era el codo de la curva —el rendimiento marginal cae de 3,8 cortes por
 * segundo (6→8) a 1,4 (8→10)—, y por eso el tope estuvo ahí hasta esta ronda.
 *
 * **Lo que deshizo ese argumento** es la medición del 19-09-2026 contra el
 * servicio real: con el tope en 8 s y el tope duro en 9 s, **15 de los 17
 * cortes salieron por tope duro y sólo 2 por silencio** [simulado]. Entre los
 * dos topes cabía 1 s de ventana, así que la pausa casi nunca llegaba a
 * tiempo y la capa 2 acababa comportándose como la capa 3 —cortar por reloj—,
 * que es justo lo que F031 existe para no hacer. Con 6 s y 8 s la ventana es
 * de 2 s: el doble de sitio para que el corte caiga en una pausa. Cuánto sube
 * de verdad la proporción de cortes por silencio está [por medir]; la sonda
 * contra el servicio no se repitió al cambiar los topes.
 *
 * El daño conocido de bajar el tope —más trozos que empiezan a media oración—
 * es lo que trata F037, que va en la misma entrega.
 *
 * Que 10 s sea el techo tolerable para quien lee es un juicio de producto, no
 * una medida.  [por medir]
 *
 * Se puede cambiar por sesión (`topeTurnoMs`); con 0 se apaga el troceo.
 */
const TOPE_TURNO_MS = 6000

/**
 * Pasado esto se corta el turno aunque siga habiendo voz.
 *
 * El troceo por silencio (abajo) depende de que el hablante haga una pausa, y
 * el monólogo de la primera prueba demostró que puede no hacerla en 65,6 s
 * [medido]. Sin este tope duro, la red de seguridad se convierte en una
 * promesa que el peor caso no cumple, que es justo el caso para el que existe.
 *
 * Una palabra partida es mejor que un minuto de pantalla en blanco: ése es el
 * cambio que se acepta aquí, y sólo le toca a quien no hace ninguna pausa en
 * ocho segundos.
 *
 * **Dos palabras que en este módulo NO son sinónimas**, porque la confusión ya
 * costó una ronda de revisión:
 *
 *  · **holgura** es `msHolgura` y nada más: lo que tarda el servidor en
 *    obedecer un `ForceEndpoint`. Medida por primera vez el 19-09-2026, 328 ms
 *    de media y 506 ms como máximo [simulado].
 *  · **exceso del turno** es todo lo que va del tope hasta que el usuario ve
 *    la burbuja. La holgura es una de sus piezas, no su total.
 *
 * **Cuánto vale el exceso del turno, que es lo que decide el hueco.** En
 * `sesion-2` el hueco máximo fue de 10,577 s con el tope en 8 s [medido], o
 * sea **2,6 s de exceso**. Recontado sobre ese mismo archivo, ese peor caso se
 * reparte en 1,260 s de la cadena que ya estaba en el `.jsonl`
 * (`msTranscribir` + `msTraducir`) y 1,317 s de lo que no estaba —arrancar el
 * turno hasta el primer parcial, más obedecer el corte— [medido, sesion-2].
 * Por eso F031 añade `msTurno` y `msHolgura`: para no volver a repartirlo por
 * diferencia.
 *
 * El exceso no escala con el tope, así que con el tope duro en 8 s el hueco
 * esperado es **≈ 10,6 s** [estimado a partir de lo medido]: la misma cifra y
 * el mismo desglose que están en PLAN.md §7bis. Sigue por encima del techo de
 * 10 s, y eso está dicho allí con todas las letras. Lo que baja de verdad el
 * hueco es que el corte caiga en una pausa antes del tope duro: un corte por
 * silencio a los 6-7 s deja el hueco en ≈ 9 s [estimado a partir de lo medido].
 *
 * **Y este tope acota el PRIMER corte, no los reintentos.** El freno de
 * `_quizaForzarFin()` cuenta `topeTurnoMs` desde el último intento, no desde
 * el tope duro: si el servidor ignora ese primer `ForceEndpoint`, el siguiente
 * no sale hasta 6 s después —14 s de turno, o sea ≈ 16,6 s de hueco
 * [estimado a partir de lo medido]—. La escalera está fijada por la prueba
 * «el tope duro acota el PRIMER corte, no el reintento»; contra el servicio
 * real el servidor obedeció los 17 cortes que se le pidieron [simulado], así
 * que ese peor caso no se ha visto nunca todavía.
 */
const TOPE_DURO_TURNO_MS = 8000

/**
 * Cuánto silencio propio hay que haber enviado para que el corte sea limpio.
 *
 * La versión anterior usaba «700 ms sin que crezca el parcial» como sustituto
 * de pausa, y ahí estaba el fallo: los parciales llegan a ráfagas, así que el
 * texto puede estar quieto con el hablante hablando. Se usaba el reloj del
 * decodificador como si fuera el del hablante, y salieron 10 de 13 trozos a
 * media oración [medido, sesion-2.jsonl].
 *
 * El audio lo enviamos nosotros, así que el silencio se puede mirar donde se
 * convierte a PCM16 y sale gratis. Tres frames de 100 ms es lo mínimo que
 * distingue una pausa de un hueco entre dos sílabas; cuánto dura una pausa
 * real en una reunión del cliente no está medido.  [por medir]
 */
const MS_SILENCIO_PARA_FORZAR = 300

/**
 * Por debajo de esta energía (RMS sobre muestras en [-1,1]) el frame es
 * silencio.
 *
 * No puede ser cero: el audio de sistema de una videollamada no baja a cero
 * digital ni cuando nadie habla —ruido de línea, respiración, el propio
 * códec—. 0,01 son unos −40 dBFS, muy por encima de un suelo de ruido y muy
 * por debajo de cualquier voz. El suelo real de los equipos del cliente no
 * está medido.  [por medir]
 */
const UMBRAL_SILENCIO_RMS = 0.01

/** Tras `Terminate`, el acuse tardó 1.067–1.224 ms medidos. Se espera de sobra. */
const ESPERA_TERMINATION_MS = 4000

/**
 * Plazo para que un socket nuevo llegue a abrirse.
 *
 * Es un tope, no una medida: lo medido es que la sesión está lista muy por
 * debajo —el primer parcial, que ya necesita el saludo hecho y audio enviado,
 * llegó a los 881–980 ms [medido]—. Cuánto tarda el saludo por sí solo no está
 * medido contra el servicio.  [por medir]
 *
 * Se puede acortar por sesión (`esperaAperturaMs`). En producción nadie lo
 * pasa: existe para poder ejercer el vencimiento en una prueba sin esperar
 * quince segundos.
 */
const ESPERA_APERTURA_MS = 15000

/** Cuánto audio se guarda sin conexión antes de empezar a tirarlo. */
const MAX_BUFFER_S = 60

/** Códigos de cierre que significan algo concreto. */
const CIERRES = {
  1008: 'credenciales rechazadas o demasiadas sesiones abiertas a la vez',
  3005: 'el servidor canceló la sesión',
  3006: 'mensaje mal formado',
  3007: 'trozo de audio fuera del tamaño permitido',
  3008: 'la sesión llegó al tope de 3 horas',
  3009: 'demasiadas sesiones simultáneas',
}

/**
 * F021: lo que manda el servidor en un `Error` del protocolo, o el motivo
 * de un cierre sin código conocido, no está pensado para pantalla — puede
 * traer cabeceras de la petición o texto que no dice nada a quien no conoce
 * la API. Los casos que SÍ se han visto se traducen a algo accionable; el
 * resto, cuando menos, pasa por `sanear()` antes de salir de este módulo.
 * Es el mismo trato que F021 le da a los cuerpos de error del LLM.
 */
function traducirErrorServidor (bruto) {
  const texto = String(bruto || '').trim()
  if (!texto) return 'error sin detalle'
  if (/too many concurrent sessions/i.test(texto)) {
    return 'demasiadas sesiones de transcripción abiertas a la vez; espera un momento y reintenta'
  }
  if (/unauthorized/i.test(texto)) {
    return 'credenciales rechazadas'
  }
  return sanear(texto)
}

/** Float32 [-1,1] a PCM16 little-endian. */
function aPcm16 (muestras) {
  const b = Buffer.alloc(muestras.length * 2)
  for (let i = 0; i < muestras.length; i++) {
    const v = Math.max(-1, Math.min(1, muestras[i]))
    b.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return b
}

/** Energía de un frame, para saber si lo que estamos enviando es silencio. */
function rmsDe (muestras) {
  if (!muestras?.length) return 0
  let suma = 0
  for (let i = 0; i < muestras.length; i++) suma += muestras[i] * muestras[i]
  return Math.sqrt(suma / muestras.length)
}

/**
 * Si el texto del trozo termina una oración.
 *
 * Se mira el ORIGINAL en italiano y no la traducción: es lo que el servidor
 * decidió cerrar, y por tanto lo que dice si el corte cayó en un sitio
 * razonable. Las comillas y los paréntesis van después del punto, así que se
 * saltan; un trozo que acaba en coma o en conjunción no cuenta, que es
 * exactamente el caso que hay que contar en la próxima prueba.
 */
function acabaEnPuntuacion (texto) {
  return /[.!?…]["»'’)\]]*$/.test(String(texto || '').trim())
}

/**
 * Construye la URL con sus parámetros.
 *
 * `keyterms_prompt` y `prompt` son la vía por la que el glosario y el contexto
 * de proyecto llegan al modelo, y es lo que hace que «il gestionale» o «Rossi
 * Logistica» se transcriban bien. Los topes son suyos: 100 términos y ~1500
 * caracteres.
 *
 * Y aquí viaja la primera capa del troceo: los dos parámetros de fin de turno.
 * Hasta F031 no se mandaba ninguno, así que el servidor trabajaba con sus
 * valores por defecto —1.536 ms de silencio— y todo el troceo recaía en
 * nuestro `ForceEndpoint`, que corta por reloj y no por pausa. El servicio
 * también los admite en caliente con `UpdateConfiguration`; aquí no hace falta
 * porque no cambian durante la reunión.
 */
function construirUrl ({ idioma, glosario, contexto, modo }) {
  const p = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    encoding: 'pcm_s16le',
    speech_model: MODELO,
    mode: modo || 'balanced',
    max_turn_silence: String(MAX_SILENCIO_TURNO_MS),
    end_of_turn_confidence_threshold: String(UMBRAL_CONFIANZA_FIN_TURNO),
  })
  // Sin `language_code` el modelo alterna idiomas por su cuenta. Se fija el
  // italiano porque la reunión es en italiano; si el cliente mezcla inglés
  // técnico, quitarlo permite el cambio de idioma dentro de la frase.
  if (idioma) p.set('language_code', idioma)

  const terminos = (glosario || []).map(t => String(t).trim()).filter(Boolean).slice(0, 100)
  if (terminos.length) p.set('keyterms_prompt', JSON.stringify(terminos))

  if (contexto) p.set('prompt', String(contexto).slice(0, 1500))
  return `${HOST}?${p}`
}

class AssemblyLiveTranscriber extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.idioma]     por defecto 'it'
   * @param {string[]} [opts.glosario] términos del contexto de proyecto
   * @param {string} [opts.contexto]   descripción de la reunión, en italiano
   * @param {Function} [opts.crearSocket] inyectable, para probar sin red
   * @param {{marcas: number[]}} [opts.registroConexiones] el freno de ritmo
   *   (F036, corrección): por defecto cada instancia trae el suyo propio,
   *   vacío, que es lo que quiere cualquier prueba aislada. Quien SÍ necesita
   *   compartirlo —el botón «Probar» de Ajustes y la sesión real de la
   *   reunión, en `mainApp.js`— pasa el MISMO objeto a las dos instancias:
   *   son la misma cuenta de AssemblyAI y el mismo cupo de cuatro conexiones
   *   por minuto, así que tienen que verse la una a la otra. Sin esto, cada
   *   `new AssemblyLiveTranscriber()` empezaba con la ventana vacía y pulsar
   *   «Probar» varias veces abría sockets sin freno y agotaba el cupo justo
   *   antes de la reunión.
   */
  constructor ({
    apiKey, idioma = 'it', glosario = [], contexto = '', modo = 'balanced', crearSocket,
    topeTurnoMs = TOPE_TURNO_MS, topeDuroTurnoMs = TOPE_DURO_TURNO_MS,
    msSilencioParaForzar = MS_SILENCIO_PARA_FORZAR,
    umbralSilencioRms = UMBRAL_SILENCIO_RMS,
    esperaAperturaMs = ESPERA_APERTURA_MS,
    registroConexiones = { marcas: [] },
  } = {}) {
    super()
    if (!apiKey && !crearSocket) throw new Error('hace falta una API key de AssemblyAI')
    this.apiKey = apiKey
    this.opciones = { idioma, glosario, contexto, modo }
    this._crearSocket = crearSocket
    this._topeTurnoMs = topeTurnoMs
    this._topeDuroTurnoMs = topeDuroTurnoMs
    this._msSilencioParaForzar = msSilencioParaForzar
    this._umbralSilencioRms = umbralSilencioRms
    this._esperaAperturaMs = esperaAperturaMs

    this._ws = null
    // El socket de la apertura en curso y la promesa de esa apertura. Los dos
    // existen por lo mismo: entre el `new WebSocket` y el evento `open` hay un
    // socket que ya puede estar facturando y que todavía no es `this._ws`, así
    // que `_cerrarSesion()` no lo ve. Ver `_abrir()` y `stop()`.
    this._wsAbriendo = null
    this._abriendo = null
    this._avisoParada = null
    this._corriendo = false
    this._cerrandoAdrede = false
    this._reconectando = false
    this._abiertaEn = null
    this._resto = []
    this._pendiente = []
    this._descartadosS = 0
    this._avisadoDelHueco = false
    // El freno de ritmo vive en `registroConexiones`, no en esta instancia:
    // ver el porqué en el JSDoc del constructor. `_conexiones` sigue
    // existiendo como acceso directo a sus marcas (las pruebas ya lo usan
    // así) pero es un espejo del registro, no su propio almacén.
    this._registroConexiones = registroConexiones
    this._quitarSalidas = null
    this._turno = null           // turno en curso; ver _apuntarParcial()
    this._ultimoAudioEn = null   // cuándo se le dio al socket el último audio
    // Milisegundos seguidos de silencio en el audio que NOSOTROS enviamos. Es
    // la señal que autoriza a cortar el turno; ver `_apuntarSilencio()`.
    this._msSilencioEnviado = 0

    this.stats = {
      frases: 0, reconexiones: 0, segundosAudio: 0,
      segundosSesion: 0, sesiones: 0, relevos: 0, turnosForzados: 0,
    }
  }

  // ── Freno de ritmo de conexiones ────────────────────────────────────
  /**
   * Acceso directo a las marcas del registro compartido (ver el JSDoc de
   * `registroConexiones` en el constructor). Reasignar aquí —como hace
   * `_esperaPorRitmo()`— actualiza el registro, no sólo esta instancia, así
   * que cualquier otra instancia que comparta el mismo `registroConexiones`
   * ve el cambio.
   */
  get _conexiones () { return this._registroConexiones.marcas }
  set _conexiones (marcas) { this._registroConexiones.marcas = marcas }

  /** Milisegundos que hay que esperar para no pasarse del límite. */
  _esperaPorRitmo () {
    const ahora = Date.now()
    this._conexiones = this._conexiones.filter(t => ahora - t < 60000)
    if (this._conexiones.length < MAX_CONEXIONES_MIN) return 0
    return 60000 - (ahora - this._conexiones[0]) + 200
  }

  // ── Ciclo de vida ───────────────────────────────────────────────────
  async start () {
    if (this._corriendo) return
    this._corriendo = true
    // Una parada anterior no puede cortar las esperas de esta sesión: sin este
    // reseteo, el aviso ya cumplido haría que `_abrir()` se diera por abierto
    // sin haber recibido el `open`.
    this._avisoParada = null
    this._registrarSalidas()
    this.emit('estado', 'conectando')
    // Si se paró mientras conectaba, `_abrir()` ya cerró lo que hubiera abierto
    // y quien paró anunció el estado: decir 'escuchando' aquí sería mentir
    // sobre un socket que acaba de cerrarse.
    const abierta = await this._abrir()
    if (!abierta) return
    this.emit('estado', 'escuchando')
  }

  // ── Parar sin aguardar los plazos ───────────────────────────────────
  /**
   * Promesa que se cumple en cuanto alguien pare.
   *
   * Las dos esperas de `_abrir()` corren contra ella. Sin esto, parar mientras
   * se conecta obligaría a aguardar el plazo entero de la espera —hasta 15 s la
   * de la apertura, hasta un minuto la del freno de ritmo— antes de poder
   * cerrar el socket, y `stop()` no podría prometer que al volver no queda nada
   * abierto. Lo que queda abierto es lo que factura.
   */
  _esperarParada () {
    if (!this._avisoParada) {
      let avisar
      const promesa = new Promise(res => { avisar = res })
      this._avisoParada = { promesa, avisar }
    }
    return this._avisoParada.promesa
  }

  /** Duerme `ms`, o menos si alguien para. Sin dejar el temporizador colgando. */
  _dormir (ms) {
    return new Promise(res => {
      const t = setTimeout(res, ms)
      this._esperarParada().then(() => { clearTimeout(t); res() })
    })
  }

  /**
   * Abre una sesión nueva y la deja instalada en `this._ws`.
   *
   * @returns {Promise<boolean>} `true` si la sesión queda viva. `false` si se
   *   paró mientras conectaba, y entonces **no queda ningún socket abierto**.
   *   Lanza si la conexión falla, y tampoco deja nada abierto.
   *
   * ## El hueco que facturaba tres horas
   *
   * Mientras se espera aquí, `this._ws` sigue siendo `null`. Un `stop()` en ese
   * momento pasa por `_cerrarSesion()` y su `if (!ws) return` **sin cerrar
   * nada**: la versión anterior asignaba `this._ws` al terminar la espera y no
   * volvía a mirar `_corriendo`, así que dejaba un socket vivo que ninguna
   * sesión poseía. Un socket huérfano factura hasta 3 horas —se cierra solo al
   * llegar al tope y se facturan completas— y ocupa una de las cinco plazas de
   * concurrencia, o sea que **impide la siguiente reunión del cliente**. Y el
   * caso de usuario es de lo más normal: pulsar Escuchar y arrepentirse en el
   * primer segundo.
   *
   * De ahí la regla: **el socket es de quien lo abre hasta que queda instalado
   * en `this._ws`**. Por eso se comprueba `_corriendo` después de cada espera y
   * se cierra aquí mismo, con `Terminate`, lo que se haya abierto. Cerrar sin
   * `Terminate` no vale: eso es justo lo que deja la sesión viva en el servidor
   * hasta el tope.
   */
  async _abrir () {
    let terminado
    const mia = new Promise(res => { terminado = res })
    this._abriendo = mia          // `stop()` espera esto antes de volver
    try {
      // Se puede haber parado mientras se esperaba para llegar hasta aquí —la
      // espera de reconexión, o el relevo de las 3 horas—. Abrir ahora sería
      // abrir para nadie.
      if (!this._corriendo) return false

      const espera = this._esperaPorRitmo()
      if (espera > 0) {
        this.emit('estado', 'esperando-cupo')
        await this._dormir(espera)
        // Primera espera. Aquí todavía no hay socket, así que la reparación es
        // la más barata de las dos: no abrirlo.
        if (!this._corriendo) return false
      }

      const url = construirUrl(this.opciones)
      const ws = this._crearSocket
        ? this._crearSocket(url, this.apiKey)
        : new (require('ws'))(url, { headers: { authorization: this.apiKey } })

      this._conexiones.push(Date.now())
      this.stats.sesiones++
      // Desde esta línea hay un socket que puede estar facturando sin que
      // `this._ws` lo delate. `_registrarSalidas()` también lo mira, porque un
      // proceso que muere aquí no puede esperar a que esta función lo cierre.
      this._wsAbriendo = ws

      ws.on('message', d => this._mensaje(d))
      ws.on('close', (codigo, motivo) => this._cerrado(ws, codigo, String(motivo || '')))
      ws.on('error', e => {
        // Abortar el saludo hace que `ws` emita un error («closed before the
        // connection was established»). Si ya se paró, eso no es un fallo que
        // pintarle al usuario: es el cierre que él pidió.
        if (!this._corriendo) return
        this.emit('error', new Error(`socket: ${e.message}`))
      })

      try {
        await new Promise((res, rej) => {
          const t = setTimeout(
            () => rej(new Error(`${this._esperaAperturaMs} ms sin conectar`)),
            this._esperaAperturaMs)
          ws.once('open', () => { clearTimeout(t); res() })
          ws.once('close', (c, m) => {
            clearTimeout(t)
            rej(new Error(`cerró al abrir: ${c} ${CIERRES[c] || String(m || '')}`))
          })
          // Segunda espera, la del hueco. Si se para, no se aguarda el plazo:
          // se sale ya, y quien decide qué hacer con el socket que hay en la
          // mano es la comprobación de `_corriendo` de abajo.
          this._esperarParada().then(() => { clearTimeout(t); res() })
        })
      } catch (err) {
        // El socket puede seguir vivo aunque la apertura haya fallado: el plazo
        // vencido no cierra nada por sí solo y el saludo puede completarse
        // después, ya sin nadie que lo reclame. Cerrarlo es lo único que impide
        // que se quede facturando en un reintento que ya nadie mira.
        await this._terminarSocket(ws)
        throw err
      } finally {
        this._wsAbriendo = null
      }

      if (!this._corriendo) {
        // Se paró mientras conectaba: `_cerrarSesion()` no pudo cerrar este
        // socket porque `this._ws` todavía era null. Lo cierra quien lo abrió.
        await this._terminarSocket(ws)
        return false
      }

      this._ws = ws
      this._abiertaEn = Date.now()
      // Sesión nueva, turnos nuevos: arrastrar el turno de la anterior forzaría
      // el primero del relevo nada más abrir. Y con el turno se suelta el
      // silencio acumulado: el del socket anterior no dice nada del turno que
      // este servidor está a punto de abrir.
      this._turno = null
      this._msSilencioEnviado = 0
      this._vaciarPendiente()
      return true
    } finally {
      // La comparación evita que una apertura que termina tarde borre el
      // registro de otra más nueva.
      if (this._abriendo === mia) this._abriendo = null
      terminado()
    }
  }

  _mensaje (datos) {
    let m
    try { m = JSON.parse(datos.toString()) } catch { return }

    switch (m.type) {
      case 'Begin':
        this.emit('sesion', { id: m.id, expiraEn: m.expires_at })
        return

      case 'Turn': {
        const texto = (m.transcript || '').trim()
        const ahora = Date.now()
        if (m.end_of_turn) {
          // El turno se cierra pase lo que pase con el texto: si no se soltara
          // aquí, el vigilante seguiría contando sobre un turno que ya murió y
          // forzaría el siguiente antes de tiempo.
          const msTranscribir = this._msTranscribir(ahora)
          // Si este turno lo cortamos nosotros, la frase puede venir partida
          // por la mitad. Va dicho en la frase para poder CONTARLAS en la
          // próxima reunión de verdad: es el precio del troceo, y hasta ahora
          // sólo está medido en simulación.
          const forzado = Boolean(this._turno?.ultimoIntentoEn)
          // Las cuatro medidas de F031, que se escriben en el `.jsonl`:
          //
          //  · `msTurno` es lo que duró el turno, del primer parcial al fin.
          //    Es `null` si el fin llegó sin ningún parcial antes —pasa con las
          //    frases muy cortas—: no se sabe cuándo empezó, y un cero ahí
          //    mentiría en la dirección buena para nosotros.
          //  · `msHolgura` se cuenta desde el PRIMER `ForceEndpoint`, no desde
          //    el último: lo que hay que medir es lo que el usuario espera
          //    desde que decidimos cortar, y un reintento es parte de esa
          //    espera, no un cronómetro nuevo.
          //  · `acabaEnPuntuacion` es el «a media frase» que hasta ahora había
          //    que contar a mano sobre el archivo.
          //  · `motivoCorte` dice POR QUÉ se cortó: `'silencio'` si el audio
          //    que enviábamos llevaba la pausa pedida, `'tope-duro'` si se
          //    cortó encima de la voz. `null` si nadie forzó el turno. Es la
          //    única forma de leer del archivo el criterio «0 palabras
          //    partidas en trozos forzados CON silencio detectado»: `msTurno`
          //    no lo distingue —un corte por silencio a 7,9 s y uno por tope
          //    duro a 8,0 s dan turnos casi iguales—, y hasta esta ronda el
          //    motivo sólo salía en el evento `troceo`, que en producción no
          //    escucha nadie.
          //
          //    Al contrario que `msHolgura`, se queda con el ÚLTIMO intento y
          //    no con el primero, y la diferencia importa: si el primer corte
          //    salió en una pausa pero el servidor lo ignoró, y el segundo
          //    salió por tope duro encima de la voz, la palabra que se parta
          //    la parte el segundo. Guardar aquí «silencio» contaría esa
          //    palabra partida como corte limpio, o sea mentiría justo en la
          //    dirección que nos conviene.
          const msTurno = this._turno ? ahora - this._turno.abiertoEn : null
          const msHolgura = this._turno?.forzadoEn ? ahora - this._turno.forzadoEn : null
          const motivoCorte = this._turno?.motivoCorte ?? null
          this._turno = null
          if (!texto) return
          this.stats.frases++
          this.emit('frase', {
            texto, orden: m.turn_order, palabras: m.words, msTranscribir, forzado,
            msTurno, msHolgura, acabaEnPuntuacion: acabaEnPuntuacion(texto), motivoCorte,
          })
        } else {
          if (!texto) return
          this._apuntarParcial(texto, ahora)
          this.emit('parcial', { texto })
        }
        return
      }

      case 'Termination':
        this.stats.segundosSesion += m.session_duration_seconds || 0
        this.emit('terminada', {
          segundosAudio: m.audio_duration_seconds,
          segundosSesion: m.session_duration_seconds,
        })
        return

      case 'Error':
        // El caso que de verdad muerde: sin plaza libre no hay transcripción,
        // y suele significar que una sesión anterior quedó sin cerrar. F021:
        // `m.error` es texto del servidor sin pensar en pantalla — se
        // traduce lo que se conoce y se sanea el resto antes de emitirlo.
        this.emit('error', new Error(`AssemblyAI: ${traducirErrorServidor(m.error)}`))
        return
    }
  }

  async _cerrado (ws, codigo, motivo) {
    if (ws !== this._ws) return                    // sesión ya reemplazada
    this._ws = null
    if (this._cerrandoAdrede || !this._corriendo) return

    // F021: el `motivo` de un código NO catalogado en `CIERRES` es texto
    // crudo del servidor, así que pasa por `traducirErrorServidor()` igual
    // que el `Error` del protocolo — es la misma clase de fuga.
    const explicado = CIERRES[codigo] || (motivo ? traducirErrorServidor(motivo) : 'sin motivo')
    this.emit('error', new Error(`la conexión se cortó (${codigo}: ${explicado})`))
    await this._reconectar()
  }

  async _reconectar () {
    if (this._reconectando || !this._corriendo) return
    this._reconectando = true
    this.emit('estado', 'reconectando')
    this.stats.reconexiones++

    for (const espera of ESPERAS_MS) {
      if (!this._corriendo) break
      // Se duerme con `_dormir`, no con un `setTimeout` a secas: si el usuario
      // para durante la espera, esto tiene que soltarla y no seguir dormido
      // hasta 40 s con una reconexión pendiente de alguien que ya se fue.
      await this._dormir(espera)
      try {
        // `false` significa que se paró —mientras se esperaba o mientras se
        // conectaba— y que `_abrir()` ya cerró lo que hubiera abierto: no hay
        // nada que escuchar, y quien paró ya anuncia el estado.
        const abierta = await this._abrir()
        this._reconectando = false
        if (abierta) this.emit('estado', 'escuchando')
        return
      } catch (err) {
        // F021: `err.message` puede traer texto del servidor sin sanear —
        // por eso pasa por la misma función que el resto de este módulo.
        this.emit('error', new Error(`reintento fallido: ${sanear(err.message)}`))
      }
    }
    this._reconectando = false
    this.emit('estado', 'sin-conexion')
    this.emit('error', new Error(
      'no se pudo reconectar. La transcripción está parada; el audio de este rato se ha perdido.'))
  }

  // ── El turno: cuánto lleva abierto y desde cuándo se espera ─────────
  /**
   * Apunta un parcial del turno en curso, y abre el turno si es el primero.
   *
   * Lo que se guarda no es «ha llegado un parcial», es **el texto ha
   * crecido**: el servidor puede repetir el mismo parcial mientras nadie
   * habla, y entonces el audio que lo produjo no es el último que oyó, que es
   * lo que mide `_msTranscribir()`.
   *
   * Hasta F031 esto también alimentaba al vigilante del troceo —«el texto
   * lleva 700 ms sin crecer» hacía de pausa—, y ahí estaba el fallo: los
   * parciales llegan a ráfagas y eso no es silencio. El silencio ahora se
   * mide en el audio que enviamos (`_apuntarSilencio()`), así que de aquí
   * salió la marca de tiempo del crecimiento, que ya no la usaba nadie.
   */
  _apuntarParcial (texto, ahora) {
    if (!this._turno) {
      this._turno = {
        abiertoEn: ahora,
        audioDelUltimoCrecimiento: this._ultimoAudioEn,
        ultimoTexto: texto,
        ultimoIntentoEn: null,
        // El primero de los intentos, que es desde donde se mide `msHolgura`.
        forzadoEn: null,
        // El motivo del ÚLTIMO corte pedido, que es el que llega a la frase.
        motivoCorte: null,
      }
      return
    }
    const t = this._turno
    if (texto === t.ultimoTexto) return
    t.ultimoTexto = texto
    t.audioDelUltimoCrecimiento = this._ultimoAudioEn
  }

  /**
   * Cuánto se tardó en OÍR esta frase: desde que se le entregó al socket el
   * último audio que llegó a verse en el texto, hasta que llegó el definitivo.
   *
   * Por qué ese punto de partida y no «el último audio enviado»: el audio del
   * sistema fluye sin parar, también durante el silencio, así que el último
   * trozo enviado es siempre de hace 100 ms y mediría cero. El último trozo
   * que hizo CRECER el texto es lo último que sabemos que el servidor oyó.
   *
   * Qué se queda fuera, y en qué dirección: la latencia del propio parcial
   * (lo que tardó en llegar el texto que usamos como marca). Por tanto esta
   * cifra es un **suelo**, no un techo. Cuánto vale ese hueco sólo se puede
   * medir contra el servicio real.  [por medir]
   */
  _msTranscribir (ahora) {
    const desde = this._turno?.audioDelUltimoCrecimiento ?? this._ultimoAudioEn
    if (!desde) return 0            // aún no se le había dado audio: no se sabe
    return Math.max(0, ahora - desde)
  }

  /**
   * Trocea el monólogo: si el turno lleva demasiado abierto y el hablante
   * sigue, se le pide al servidor que lo cierre ya.
   *
   * Se corta el TURNO, no el audio: el audio sigue saliendo sin un hueco, y
   * las palabras que vengan después entran en el turno siguiente. Recortar el
   * audio en vez de esto perdería lo que se dijera en el corte.
   *
   * Desde F031 es una RED DE SEGURIDAD, no el mecanismo: quien debe cerrar el
   * turno es el servidor, en la pausa del hablante, y para eso se le mandan
   * `max_turn_silence` y `end_of_turn_confidence_threshold` al conectar. Esto
   * sólo entra cuando el turno ya se pasó de largo.
   *
   * Tres condiciones, en este orden:
   *
   *  · Que lleve abierto más que el tope. Se cuenta desde el primer parcial,
   *    que llega 881–980 ms después de que empiece a hablar [medido], así que
   *    el turno real es algo más largo que lo que se mide aquí.
   *  · Que los últimos `msSilencioParaForzar` del audio que hemos enviado sean
   *    silencio. Esto es lo que sustituye al «el texto lleva un rato sin
   *    crecer» de la versión anterior, que no era silencio sino el ritmo del
   *    decodificador: el servidor cierra el turno con TODO el audio recibido,
   *    así que un corte con voz en curso parte la palabra que suene.
   *  · O, si no hay pausa ninguna, que se haya pasado del tope duro. El
   *    monólogo de 65,6 s demostró que la pausa puede no llegar nunca
   *    [medido], y una red de seguridad que sólo funciona con el caso fácil no
   *    es una red de seguridad.
   *
   * Si el servidor ignorara el mensaje, el turno volvería a pasarse del tope
   * y se reintentaría: `ultimoIntentoEn` es lo que evita mandarlo diez veces
   * por segundo mientras tanto. Ese mismo freno es el que decide cuándo puede
   * actuar el tope duro, y a propósito: un reintento inmediato «porque ahora
   * sí toca el duro» sería la ráfaga que el freno existe para impedir.
   *
   * La consecuencia hay que decirla entera, porque es la que se paga: el tope
   * duro acota **el primer corte**, no los siguientes. Con los valores de
   * producción, un `ForceEndpoint` que el servidor ignore no se repite hasta
   * 6 s después —turno de 14 s—, no a los 8 s. Prueba: «el tope duro acota el
   * PRIMER corte, no el reintento».
   */
  _quizaForzarFin () {
    const t = this._turno
    if (!t || !this._topeTurnoMs) return
    if (this._ws?.readyState !== 1) return

    const ahora = Date.now()
    if (ahora - (t.ultimoIntentoEn ?? t.abiertoEn) < this._topeTurnoMs) return

    const msAbierto = ahora - t.abiertoEn
    const enSilencio = this._msSilencioEnviado >= this._msSilencioParaForzar
    const porTopeDuro = this._topeDuroTurnoMs > 0 && msAbierto >= this._topeDuroTurnoMs
    if (!enSilencio && !porTopeDuro) return

    // El motivo distingue el corte limpio del corte a la fuerza, que es la
    // diferencia entre «el troceo funciona» y «el troceo funciona a costa de
    // partir palabras». Sin él, los dos se cuentan igual en `turnosForzados`.
    //
    // `enSilencio` manda sobre `porTopeDuro` cuando se cumplen los dos: si
    // había la pausa pedida, el corte es limpio aunque además se hubiera
    // pasado del tope duro.
    const motivo = enSilencio ? 'silencio' : 'tope-duro'

    t.ultimoIntentoEn = ahora
    if (t.forzadoEn == null) t.forzadoEn = ahora
    // Se queda el último y no el primero: es el corte que estaba en vuelo
    // cuando el servidor cerró, o sea el que pudo partir la palabra.
    t.motivoCorte = motivo
    this.stats.turnosForzados++
    this._ws.send(JSON.stringify({ type: 'ForceEndpoint' }))
    this.emit('troceo', {
      msAbierto,
      caracteres: t.ultimoTexto.length,
      motivo,
    })
  }

  // ── Audio ───────────────────────────────────────────────────────────
  /**
   * @param {Float32Array|number[]} muestras  16 kHz mono, rango [-1,1]
   */
  alimentar (muestras) {
    if (!this._corriendo || !muestras?.length) return
    this.stats.segundosAudio += muestras.length / SAMPLE_RATE

    for (let i = 0; i < muestras.length; i++) this._resto.push(muestras[i])
    while (this._resto.length >= MUESTRAS_TROZO) {
      const frame = this._resto.splice(0, MUESTRAS_TROZO)
      // Se mira la energía AQUÍ, donde el frame ya está formado y todavía en
      // coma flotante: es el único punto en el que sabemos qué audio estamos
      // mandando, y recorrer 1.600 muestras cada 100 ms no cuesta nada.
      this._apuntarSilencio(frame)
      this._enviar(aPcm16(frame))
    }
    // El audio llega en bloques de 100 ms, así que el vigilante mira diez
    // veces por segundo sin necesidad de un temporizador propio: uno más que
    // habría que acordarse de apagar al cerrar.
    this._quizaForzarFin()
    this._quizaRelevar()
  }

  /**
   * Lleva la cuenta del silencio seguido que hemos enviado.
   *
   * Es una racha, no una media: un solo frame con voz la pone a cero. Si se
   * promediara, una pausa de 200 ms entre dos palabras sonaría igual que una
   * pausa de verdad y volveríamos a cortar en mitad de la frase, que es el
   * fallo que F031 arregla.
   */
  _apuntarSilencio (frame) {
    if (rmsDe(frame) < this._umbralSilencioRms) this._msSilencioEnviado += MS_TROZO
    else this._msSilencioEnviado = 0
  }

  _enviar (pcm) {
    if (this._ws?.readyState === 1) { this._ws.send(pcm); this._ultimoAudioEn = Date.now(); return }
    this._pendiente.push(pcm)
    const tope = MAX_BUFFER_S * 1000 / MS_TROZO
    while (this._pendiente.length > tope) {
      this._pendiente.shift()
      this._descartadosS += MS_TROZO / 1000
      if (!this._avisadoDelHueco) {
        this._avisadoDelHueco = true
        this.emit('error', new Error(
          `llevamos ${MAX_BUFFER_S} s sin conexión: se está perdiendo audio`))
      }
    }
  }

  /**
   * Vuelca lo guardado, pero **no de golpe**: el servidor cierra con 3007 si
   * el audio llega más rápido que el tiempo real. Se manda al ritmo del audio.
   */
  _vaciarPendiente () {
    if (!this._pendiente.length) return
    const cola = this._pendiente
    this._pendiente = []
    let i = 0
    const siguiente = () => {
      if (!this._corriendo || this._ws?.readyState !== 1) {
        this._pendiente.unshift(...cola.slice(i))
        return
      }
      if (i >= cola.length) {
        if (this._descartadosS > 0) {
          this.emit('error', new Error(
            `se perdieron ${this._descartadosS.toFixed(1)} s de audio sin conexión`))
          this._descartadosS = 0
          this._avisadoDelHueco = false
        }
        return
      }
      this._ws.send(cola[i++])
      this._ultimoAudioEn = Date.now()
      setTimeout(siguiente, MS_TROZO)
    }
    siguiente()
  }

  /** Releva antes del tope de 3 horas, para no cortar en mitad de la reunión. */
  _quizaRelevar () {
    if (!this._abiertaEn || this._reconectando) return
    if (Date.now() - this._abiertaEn < RELEVAR_A_LOS_MS) return
    this._abiertaEn = Date.now()
    this.stats.relevos++
    this.emit('rotacion', { motivo: 'cerca del tope de 3 horas' })
    this._reiniciar()
  }

  async _reiniciar () {
    await this._cerrarSesion()
    if (this._corriendo) {
      try { await this._abrir() } catch { await this._reconectar() }
    }
  }

  // ── Cierre, que es lo que cuesta dinero si se olvida ────────────────
  /**
   * Cierra UN socket **como manda el protocolo**: `Terminate`, esperar el
   * acuse, y sólo entonces cerrar. Cerrar sin esto deja la sesión viva hasta 3
   * horas, facturando y ocupando una plaza de concurrencia.
   *
   * Está separado de `_cerrarSesion()` porque hay un socket que **no** es
   * `this._ws` y hay que cerrarlo igual de bien: el que `_abrir()` tiene en la
   * mano cuando se para mientras conecta. El protocolo es el mismo para los
   * dos, y escribirlo dos veces sería tener una de las dos copias mal.
   */
  async _terminarSocket (ws) {
    this._cerrandoAdrede = true
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'Terminate' }))
        await new Promise(res => {
          const t = setTimeout(res, ESPERA_TERMINATION_MS)
          const alMensaje = d => {
            try {
              if (JSON.parse(d.toString()).type === 'Termination') { clearTimeout(t); res() }
            } catch { /* no era JSON */ }
          }
          ws.on('message', alMensaje)
          ws.once('close', () => { clearTimeout(t); res() })
        })
      }
    } catch (err) {
      // F021: mismo trato — este `err` puede venir de un `close` con motivo
      // del servidor.
      this.emit('error', new Error(`al cerrar la sesión: ${sanear(err.message)}`))
    } finally {
      try { ws.close() } catch { /* ya estaba */ }
      this._cerrandoAdrede = false
    }
  }

  /**
   * Cierra la sesión viva, si hay una.
   *
   * Lo que **no** cierra es el socket de una apertura en curso: ése todavía no
   * es `this._ws`, y su dueño es `_abrir()`, que lo cierra al ver `_corriendo`
   * en false. `stop()` espera esa apertura precisamente para que al volver no
   * quede nada abierto por ninguno de los dos caminos.
   */
  async _cerrarSesion () {
    const ws = this._ws
    if (!ws) return
    this._ws = null
    try {
      await this._terminarSocket(ws)
    } finally {
      // Sin esto, el coste seguiría creciendo con el reloj aunque no haya
      // ninguna sesión abierta, y el número que se le enseña al cliente
      // dejaría de significar nada.
      this._abiertaEn = null
    }
  }

  async stop () {
    this._corriendo = false
    this._turno = null
    // Saca a `_abrir()` de sus esperas: si hay un socket a medio abrir hay que
    // cerrarlo ahora, no cuando venza el plazo de la apertura.
    this._avisoParada?.avisar()
    if (this._resto.length) {
      // El resto puede ser el final de la última frase.
      this._enviar(aPcm16(this._resto))
      this._resto = []
    }
    await this._cerrarSesion()
    // El socket de una apertura en curso no es `this._ws`, así que
    // `_cerrarSesion()` no lo ha cerrado: lo cierra `_abrir()` al ver
    // `_corriendo` en false. Se espera aquí porque `stop()` tiene que volver
    // con todo cerrado —`before-quit` hace `app.exit(0)` justo después, y un
    // proceso que muere dejando el socket a medio abrir deja la sesión viva en
    // el servidor, facturando hasta 3 horas y ocupando una plaza.
    await this._abriendo
    this._quitarSalidas?.()
    this._pendiente = []
    this.emit('estado', 'parado')
  }

  /**
   * Cierra la sesión también cuando el proceso se va por donde no debe.
   *
   * Sin esto, un cierre brusco deja la sesión facturando 3 horas y ocupando
   * una plaza — y entonces la SIGUIENTE reunión del cliente no conecta. Es el
   * fallo que no se ve al probar y aparece el día que importa.
   */
  _registrarSalidas () {
    if (this._quitarSalidas) return
    const cerrarYa = () => {
      // Los dos sockets: la sesión viva y la que se esté abriendo. `cerrarYa`
      // es síncrono y el proceso se está muriendo, así que no puede esperar a
      // que `_abrir()` cierre lo suyo, como sí hace `stop()`.
      for (const ws of [this._ws, this._wsAbriendo]) {
        if (ws?.readyState === 1) {
          try { ws.send(JSON.stringify({ type: 'Terminate' })); ws.close() } catch { /* nada que hacer */ }
        }
      }
    }
    const sucesos = ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']
    for (const s of sucesos) process.on(s, cerrarYa)
    this._quitarSalidas = () => {
      for (const s of sucesos) process.removeListener(s, cerrarYa)
      this._quitarSalidas = null
    }
  }

  /** Coste aproximado de lo consumido, para enseñárselo al usuario. */
  costeAproximadoUsd (usdPorHora = 0.45) {
    const seg = this.stats.segundosSesion
      + (this._abiertaEn ? (Date.now() - this._abiertaEn) / 1000 : 0)
    return +(seg / 3600 * usdPorHora).toFixed(4)
  }
}

module.exports = { AssemblyLiveTranscriber, SAMPLE_RATE, MODELO, CIERRES }
module.exports._internos = {
  aPcm16, rmsDe, acabaEnPuntuacion, construirUrl, traducirErrorServidor,
  MUESTRAS_TROZO, MS_TROZO, MS_TROZO_MIN, MS_TROZO_MAX,
  MAX_CONEXIONES_MIN, ESPERAS_MS, MAX_BUFFER_S, RELEVAR_A_LOS_MS, TOPE_SESION_MS,
  TOPE_TURNO_MS, TOPE_DURO_TURNO_MS, MS_SILENCIO_PARA_FORZAR, UMBRAL_SILENCIO_RMS,
  MAX_SILENCIO_TURNO_MS, UMBRAL_CONFIANZA_FIN_TURNO,
  ESPERA_APERTURA_MS, ESPERA_TERMINATION_MS,
}
