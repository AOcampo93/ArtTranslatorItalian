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
 * Por eso este módulo vigila el turno y lo corta él con `ForceEndpoint`
 * (`_quizaForzarFin`). El efecto de arrastre es igual de importante: el tiempo
 * de Marian crece con la longitud —sobre esas mismas 21 frases, 6,34 ms por
 * carácter con R² 0,994 [medido]—, así que trocear el turno también mata la
 * cola de latencia de la traducción. Un arreglo, dos problemas.
 */

'use strict'

const { EventEmitter } = require('events')

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
 * Tope de duración de un turno antes de trocearlo con `ForceEndpoint`.
 *
 * De dónde salen los 8 s. Todo lo de abajo está simulado sobre la sesión real
 * de 21 frases, traduciendo de verdad con Marian los trozos que saldrían:
 *
 *  · **No muerde a los turnos normales.** Los turnos de esa sesión duraron
 *    4,5 s de mediana, y ninguno de los que no era monólogo pasó de 10,6 s
 *    [medido]. Con 8 s se trocearían 6 de los 21: los tres monólogos (47,7 s,
 *    30,7 s y 60,4 s) y tres turnos de 9-10,6 s.
 *  · **Es el tope más alto que aún cabe por debajo de 10 s, y cabe por 0,1 s.**
 *    Lo que el usuario espera por una frase es el tope MÁS el primer parcial
 *    (881–980 ms [medido]), MÁS el cierre del turno (201–257 ms [medido]), MÁS
 *    la traducción del trozo. Cronometrado con el Marian del propio HP —y no
 *    con el de la máquina de desarrollo, que da medio segundo de regalo—:
 *    **9,5 s** de hueco máximo frente a los 65,6 s medidos, y **9,9 s** hasta
 *    la primera burbuja frente a 51,5 s [simulado]. Con 10 s ya no cabe (11,6 s
 *    y 12,1 s); con 6 s sobra sitio (7,4 s y 7,8 s) pero se parte el doble de
 *    frases. No es una elección holgada: es la última que entra.
 *  · **Los trozos le caen a Marian del tamaño que sabe llevar.** A la
 *    velocidad medida en ese audio (11,9 caracteres/s [medido]), 8 s son 88
 *    caracteres de mediana y 156 como mucho [simulado]; el p95 de traducción
 *    pasaría de los 3.628 ms medidos a unos 962 ms, estimados con la regresión
 *    del propio equipo (ms = 56 + 6,34·caracteres, R² 0,994 [medido]).
 *
 * Y el precio, que también está medido: con 8 s, 14 de los 38 trozos acabarían
 * en mitad de una frase, y en 5 de ellos Marian cerró la frase por su cuenta
 * inventándose el final [simulado]. Bajar el tope a 6 s dobla ese daño (22
 * cortes) para ganar 2,1 s de hueco; subirlo a 12 s lo reduce a 9 cortes y
 * cuesta 4,3 s. El rendimiento marginal cae de 3,8 cortes por segundo (6→8) a
 * 1,4 (8→10): los 8 s son el codo de esa curva.
 *
 * Que 10 s sea el techo tolerable para quien lee es un juicio de producto, no
 * una medida.  [por medir]
 *
 * Se puede cambiar por sesión (`topeTurnoMs`); con 0 se apaga el troceo.
 */
const TOPE_TURNO_MS = 8000

/**
 * No se fuerza el fin de un turno cuyo texto lleve este rato sin crecer.
 *
 * Si el hablante ya calló, el turno se cierra solo: medido, el texto
 * definitivo llega 201–257 ms después del silencio [medido]. Por tanto 700 ms
 * sin texto nuevo y sin que haya llegado el definitivo significa que el
 * hablante SIGUE hablando y quien va con retraso es el decodificador. Forzar
 * un turno que ya se estaba cerrando no adelantaría nada y partiría la frase
 * por gusto.
 *
 * El ritmo real al que llegan los parciales mientras alguien habla no está
 * medido contra el servicio.  [por medir]
 */
const MARGEN_SILENCIO_MS = 700

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

/** Float32 [-1,1] a PCM16 little-endian. */
function aPcm16 (muestras) {
  const b = Buffer.alloc(muestras.length * 2)
  for (let i = 0; i < muestras.length; i++) {
    const v = Math.max(-1, Math.min(1, muestras[i]))
    b.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return b
}

/**
 * Construye la URL con sus parámetros.
 *
 * `keyterms_prompt` y `prompt` son la vía por la que el glosario y el contexto
 * de proyecto llegan al modelo, y es lo que hace que «il gestionale» o «Rossi
 * Logistica» se transcriban bien. Los topes son suyos: 100 términos y ~1500
 * caracteres.
 */
function construirUrl ({ idioma, glosario, contexto, modo }) {
  const p = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    encoding: 'pcm_s16le',
    speech_model: MODELO,
    mode: modo || 'balanced',
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
   */
  constructor ({
    apiKey, idioma = 'it', glosario = [], contexto = '', modo = 'balanced', crearSocket,
    topeTurnoMs = TOPE_TURNO_MS, margenSilencioMs = MARGEN_SILENCIO_MS,
    esperaAperturaMs = ESPERA_APERTURA_MS,
  } = {}) {
    super()
    if (!apiKey && !crearSocket) throw new Error('hace falta una API key de AssemblyAI')
    this.apiKey = apiKey
    this.opciones = { idioma, glosario, contexto, modo }
    this._crearSocket = crearSocket
    this._topeTurnoMs = topeTurnoMs
    this._margenSilencioMs = margenSilencioMs
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
    this._conexiones = []        // marcas de tiempo, para el freno de ritmo
    this._quitarSalidas = null
    this._turno = null           // turno en curso; ver _apuntarParcial()
    this._ultimoAudioEn = null   // cuándo se le dio al socket el último audio

    this.stats = {
      frases: 0, reconexiones: 0, segundosAudio: 0,
      segundosSesion: 0, sesiones: 0, relevos: 0, turnosForzados: 0,
    }
  }

  // ── Freno de ritmo de conexiones ────────────────────────────────────
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
      // el primero del relevo nada más abrir.
      this._turno = null
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
          this._turno = null
          if (!texto) return
          this.stats.frases++
          this.emit('frase', {
            texto, orden: m.turn_order, palabras: m.words, msTranscribir, forzado,
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
        // y suele significar que una sesión anterior quedó sin cerrar.
        this.emit('error', new Error(`AssemblyAI: ${m.error || 'error sin detalle'}`))
        return
    }
  }

  async _cerrado (ws, codigo, motivo) {
    if (ws !== this._ws) return                    // sesión ya reemplazada
    this._ws = null
    if (this._cerrandoAdrede || !this._corriendo) return

    const explicado = CIERRES[codigo] || motivo || 'sin motivo'
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
        this.emit('error', new Error(`reintento fallido: ${err.message}`))
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
   * habla, y si eso contara como señal de vida el vigilante trocearía
   * silencios.
   */
  _apuntarParcial (texto, ahora) {
    if (!this._turno) {
      this._turno = {
        abiertoEn: ahora,
        ultimoCrecimientoEn: ahora,
        audioDelUltimoCrecimiento: this._ultimoAudioEn,
        ultimoTexto: texto,
        ultimoIntentoEn: null,
      }
      return
    }
    const t = this._turno
    if (texto === t.ultimoTexto) return
    t.ultimoTexto = texto
    t.ultimoCrecimientoEn = ahora
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
   * Dos condiciones, y las dos importan:
   *
   *  · Que lleve abierto más que el tope. Se cuenta desde el primer parcial,
   *    que llega 881–980 ms después de que empiece a hablar [medido], así que
   *    el turno real es algo más largo que lo que se mide aquí.
   *  · Que el texto siga creciendo. Si lleva parado más de `margenSilencio`,
   *    el turno ya se está cerrando solo y forzarlo sólo partiría la frase.
   *
   * Si el servidor ignorara el mensaje, el turno volvería a pasarse del tope
   * y se reintentaría: `ultimoIntentoEn` es lo que evita mandarlo diez veces
   * por segundo mientras tanto.
   */
  _quizaForzarFin () {
    const t = this._turno
    if (!t || !this._topeTurnoMs) return
    if (this._ws?.readyState !== 1) return

    const ahora = Date.now()
    if (ahora - (t.ultimoIntentoEn ?? t.abiertoEn) < this._topeTurnoMs) return
    if (ahora - t.ultimoCrecimientoEn > this._margenSilencioMs) return

    t.ultimoIntentoEn = ahora
    this.stats.turnosForzados++
    this._ws.send(JSON.stringify({ type: 'ForceEndpoint' }))
    this.emit('troceo', { msAbierto: ahora - t.abiertoEn, caracteres: t.ultimoTexto.length })
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
      this._enviar(aPcm16(this._resto.splice(0, MUESTRAS_TROZO)))
    }
    // El audio llega en bloques de 100 ms, así que el vigilante mira diez
    // veces por segundo sin necesidad de un temporizador propio: uno más que
    // habría que acordarse de apagar al cerrar.
    this._quizaForzarFin()
    this._quizaRelevar()
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
      this.emit('error', new Error(`al cerrar la sesión: ${err.message}`))
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
  aPcm16, construirUrl, MUESTRAS_TROZO, MS_TROZO, MS_TROZO_MIN, MS_TROZO_MAX,
  MAX_CONEXIONES_MIN, ESPERAS_MS, MAX_BUFFER_S, RELEVAR_A_LOS_MS, TOPE_SESION_MS,
  TOPE_TURNO_MS, MARGEN_SILENCIO_MS, ESPERA_APERTURA_MS, ESPERA_TERMINATION_MS,
}
