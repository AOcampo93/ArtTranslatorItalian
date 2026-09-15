# ArtTranslator Italian — Plan de proyecto

Traductor en vivo **Italiano → Español** para reuniones, con perfil de quien escucha,
contexto de proyecto por llamada y respuestas sugeridas en italiano.

Derivado de `ArtTranslator` (Electron/Node, EN→ES) y de los diseños de
`ArtTranslatorNative` (Swift/macOS).

**Este documento es la base de construcción del proyecto.** No es una propuesta ni un
resumen: es la referencia contra la que se implementa. Si al construir se decide algo
distinto de lo que dice aquí, **se cambia aquí primero** y se anota por qué — un plan que
se desvía en silencio deja de servir a la segunda semana.

**Cómo leer las cifras.** Cada número lleva su procedencia: `[medido]` lo ejecutamos
nosotros · `[verificado]` leído en fuente primaria y auditado · `[por medir]` hay que
comprobarlo en los equipos del cliente antes de apoyarse en él. Lo que no lleva marca es
criterio, no dato.

**Por dónde se empieza:** §16 (spikes) → fase −1 (build de diagnóstico, §13) → fase 0.
No por la fase 0 directamente.

---

## 0. No negociables

Decisiones que **no deben revertirse en silencio**. Cada una existe porque su ausencia
produce un fallo que o no se detecta, o se detecta en el peor momento. Si alguna estorba,
se discute y se cambia el documento; no se salta.

| | Regla | Si no se hace |
|---|---|---|
| 1 | `win.setContentProtection(true)` en la ventana del modo en vivo | Al compartir pantalla en Teams, **la sala entera lee las respuestas sugeridas del cliente** |
| 2 | `wsServer` y `whisper-server` escuchan en **`127.0.0.1` explícito** y puerto efímero | El Firewall pregunta en el primer arranque, el usuario cancela, y **la app queda rota para siempre sin mensaje** |
| 3 | **Autoguardado** append-only a `.jsonl` desde la primera frase confirmada | Un crash en el minuto 58 **borra la reunión entera** |
| 4 | El modelo de Whisper va **embebido en el instalador**, nunca se descarga al arrancar | Barra de descarga que puede fallar por red y deja la app muda sin explicación |
| 5 | Embarcar `VCRUNTIME140`, `VCRUNTIME140_1`, `MSVCP140` y **`VCOMP140`** | En un Windows limpio sin VC++ Redistributable, **el binario no arranca** |
| 6 | Las nueve DLL `ggml-cpu-*` junto a `ggml-base.dll`, **y loguear cuál se cargó** | El despacho cae a la peor variante **sin dar error** |
| 7 | Anclar el tag **`b5130`** con su hash, nunca "latest release" | El release `v1.9.4` **no tiene assets**: el instalador no descarga nada |
| 8 | Job Object con `KILL_ON_JOB_CLOSE` para los procesos hijo | `whisper-server` huérfano comiendo 700 MB y ocupando el puerto |
| 9 | Hilos **conscientes de núcleos híbridos**, nunca `núcleos − 2` | En el i9-13900HX serían 22 hilos y rendiría **peor** que usando 8 |
| 10 | **VAD + `-ac 512` + paso adaptativo**, siempre | La ventana de 30 s del encoder hunde los dos equipos |
| 11 | Leer `audioContext.sampleRate`, **nunca asumir 48 kHz** | Remuestreo erróneo: todo "funciona" y el WER se dispara sin que nadie lo note |
| 12 | Ventana de silencio de **20-30 s**, aviso no modal en el medidor | Falsos positivos cada pocos minutos; el usuario aprende a ignorar el aviso |
| 13 | Llamadas de red con el módulo **`net` de Electron**, no el `https` de Node | Un proxy corporativo con inspección TLS rompe la app de forma indepurable a distancia |
| 14 | API keys por **`safeStorage`**, jamás en `.env` ni en `electron-store` en claro | Las credenciales del cliente en texto plano en su disco |
| 15 | Marian en un **`utilityProcess`** aparte, con `intraOpNumThreads` acotado | Un fallo nativo de ONNX se lleva la app entera a mitad de reunión, y compite por hilos con Whisper |
| 16 | **La app traduce sin ninguna API key**; la pantalla de la key es salteable | Un muro de configuración antes de que el usuario vea que funciona |
| 17 | **Un solo veredicto** en la comprobación previa, con el detalle plegado | Cuatro semáforos en ámbar y un usuario no técnico que no sabe si seguir |
| 18 | Las respuestas sugeridas van **solo en italiano** | No es lo que pidió el cliente |

---

## 1. Las tres prioridades que ordenan todo el plan

Declaradas por el cliente, en este orden. Cuando dos decisiones se contradicen, gana la
de arriba:

1. **Instalación trivial.** Instalar, aceptar permisos y listo. Nada de configurar audio
   interno, instalar Ollama, elegir backends o modelos.
2. **Que funcione y sea rápido.** Traducir italiano → español lo antes posible y generar
   las mejores respuestas posibles.
3. **Que construirlo no sea caro.** Hay mucho camino andado en `ArtTranslator`; reutilizar
   antes que reescribir.

Estas prioridades no son una nota de intenciones: resuelven empates concretos a lo largo
del documento, y cada vez que lo hacen se dice.

---

## 2. Plataforma: escritorio Windows, no web

El cliente usa Windows 11 y **sí puede instalar software** (confirmado). Eso cierra la
duda, y la razón es la prioridad nº 1:

| | Escritorio (Electron) | Web (navegador) |
|---|---|---|
| Audio del sistema | `audio: 'loopback'`, sin diálogo ni driver | `getDisplayMedia()` obliga a elegir pantalla **en cada sesión** |
| Teams/Zoom nativos | Se captura igual | Compartir pantalla completa con audio marcado |
| Flotar sobre la llamada | `alwaysOnTop` | Imposible desde una pestaña |
| Modelos locales | En la máquina | Exigen subir el audio a un servidor |
| Privacidad | Solo sale el texto que va al LLM | Sale todo el audio de la reunión |
| Coste por minuto | 0 | Servidor + STT de pago |

> *"Specifying a loopback device will capture system audio, and is currently only supported
> on Windows."* — [Electron, `session.setDisplayMediaRequestHandler`](https://www.electronjs.org/docs/latest/api/session) `[verificado]`

La plataforma que el cliente ya tiene resulta ser la única donde el requisito de "un
botón, cero configuración" se cumple de forma nativa.

---

## 3. Requisitos mínimos de hardware

En lugar de adaptarse a hardware desconocido, la app **declara requisitos** y se construye
para ellos. Es más barato de hacer (prioridad nº 3) y más predecible de soportar.

### Mínimo (la app funciona)

| | Requisito | Por qué ese umbral |
|---|---|---|
| SO | Windows 11 (x64) | `loopback` es solo-Windows; en 10 debería ir pero no se soporta |
| CPU | 8 núcleos físicos con **AVX2** | AVX2 selecciona la DLL `haswell` o mejor; por debajo cae a `sse42` y no llega a tiempo real `[verificado]` |
| RAM | 16 GB | `small` ocupa ~600-700 MB, pero Win11 + Teams en llamada + navegador ya consumen 8-9 GB |
| Disco | 2 GB libres | Modelo embebido en el instalador |
| Red | Solo para las respuestas | Sin red sigue traduciendo |

Con el mínimo, el techo de calidad es `small`: **9,8% de error en italiano con audio limpio
y 22,9% con audio tipo reunión** `[verificado]`. Es usable, no es excelente, y esa cifra
hay que decirla antes de entregar (§13).

### Recomendado — y fuera del alcance de la v1

Una **GPU NVIDIA dedicada con 8 GB de VRAM** y driver con CUDA 12.8+ habilitaría
`large-v3-turbo`, que subiría la calidad del italiano de forma notable. Los dos equipos
del cliente son PC gamer y probablemente la tienen.

**Aun así, la ruta GPU no entra en la v1, y el motivo no es el coste: es que no podemos
ejecutarla ni una vez.** No hay GPU NVIDIA en el equipo de desarrollo, así que enviaríamos
código que nunca ha corrido. A eso se suma que los únicos builds CUDA para x64 son cuBLAS
11.8 y 12.4, ambos anteriores a Blackwell `[verificado]`, de modo que además habría que
compilar y mantener un binario propio.

**La salida, cuando se quiera:** los dos tests son independientes — **la prueba de GPU no
necesita audio y la prueba de audio no necesita GPU**. Validar Whisper con CUDA es meterle
un WAV y medir, sin captura de ningún tipo, así que se puede hacer en una VM Windows con
GPU en la nube por unos dólares la hora. No hace falta comprar hardware.

### El equipo confirmado del cliente

**Machenike L16S**: Intel **Core i9-13900HX** (24 núcleos — **8 P y 16 E** — 32 hilos,
turbo 5,4 GHz, 36 MB de caché), **32 GB DDR5**, **RTX 5060 Laptop**, SSD de 1 TB,
Windows 11 Pro. Con 8 P-cores y 32 GB, `small` va a ir sobrado ahí.

Tres cosas que se derivan y que el plan tenía mal:

- **Es un portátil, no un sobremesa.** El sufijo HX es móvil. Hay batería, hay throttling
  térmico sostenido y hay tapa que se cierra. El test de admisión mide una máquina fría y
  enchufada, y dictaminaba para siempre: tiene que **re-evaluarse** ante
  `powerMonitor.on('on-battery')` y medir **3-5 minutos**, no 30 segundos, reportando el
  **p95**. El minuto 0 y el minuto 40 no son la misma máquina.
- **La topología es híbrida**, y eso rompe la heurística de hilos (§7).
- **La RTX 5060 es Blackwell**, lo que confirma que los cuBLAS precompilados no le sirven.

El listado también menciona **"modo de sonido Nahimic"**, una capa de DSP que se inserta en
la cadena de salida. No hay evidencia de que rompa el loopback, pero sí de que **procesa el
audio antes de que llegue a la ruta de grabación**, así que podríamos estar transcribiendo
audio con realce de voz y virtualización aplicados. Va como comprobación explícita a la
build de diagnóstico.

### El dato que aún falta

El modelo exacto del Ryzen 7 del segundo equipo. Entre un Zen 2 y un Zen 4 hay **1,8x de
diferencia en el encoder** `[verificado]`. Y ojo con el orden intuitivo: **AVX-512 está
presente en Zen 4 pero fusionado y desactivado en Raptor Lake**, así que el Ryzen podría
cargar una variante DLL mejor que el i9 y ser más rápido de lo que sugiere el nombre.

---

## 4. Qué se hereda y qué se reemplaza

`ArtTranslator` aporta el código; `ArtTranslatorNative` aporta el diseño (su código es
Swift y no es portable, pero resolvió problemas que la versión Electron arrastra).

### Se hereda casi tal cual

| Pieza | Cambio |
|---|---|
| `node-backend/src/wsServer.js` | Protocolo WS + HTTP. Se le añaden rutas de perfil y contexto |
| `node-backend/src/aiOrchestrator.js` | Enrutado por modelo y modelos por tarea. Intacto |
| clientes LLM ×4 (Claude, OpenAI, Gemini, Ollama) | Solo cambian los prompts que consumen |
| `node-backend/src/db.js` | sql.js. +2 tablas: `profiles`, `project_contexts` |
| `electron-app/src/main.js` | Ventana flotante, electron-store, IPC, guardado de sesión |
| UI React: Toolbar, SaveModal, DebugConsole, Toast, SettingsPanel | Base del rediseño (§11) |

### Se reemplaza

| Pieza actual | Reemplazo | Por qué |
|---|---|---|
| `scripts/audio_capture.swift` | `loopback` + AudioWorklet | ScreenCaptureKit no existe en Windows |
| `scripts/translate_server.swift` | Marian ONNX en proceso | Apple Translation no existe en Windows |
| `nativePipeline.js` (spawn por chunk) | `whisper-server` HTTP | Hoy recarga 465 MB de disco **cada 2 s** |
| `shared/prompts.js` | Reescrito | Italiano, y con perfil y contexto inyectados |
| **Electron 28** | **Electron ≥ 43.4.0** | Ver abajo: no es opcional |

### El coste oculto que no estaba en la primera estimación

El proyecto base está en **Electron ^28.3.3**, y `loopback` llegó en la **30**. Además hay
una regresión documentada que lo rompió entre la 35 y la 40, y el arreglo de
`restrictOwnAudio` llegó en la **43.4.0**. Hay que saltar 15 versiones mayores, con sus
cambios incompatibles. Es trabajo real y va en la estimación, no en la letra pequeña.

### Se descarta

`python-backend/` (ya obsoleto en el original), `scripts/toggle_aggregate.swift`,
`ggml-small.en.bin` (es solo-inglés; el italiano exige modelo multilingüe).

### Se porta del nativo como diseño, no como código

Transcripción por **streaming** (ring buffer, hipótesis en vivo, confirmación al
estabilizarse) en lugar de cortes fijos; **VAD con watchdog de inanición** — si el umbral
de silencio queda sobre el nivel de voz, la app escucha y no transcribe nada sin mostrar
error, y el watchdog fuerza un decode a los 6 s; **respuestas bajo demanda**, nunca en
segundo plano; **consola de rendimiento** con p50/p95, que aquí vale doble porque hay que
diagnosticar a distancia en casa del cliente.

Y un arreglo de seguridad que se arrastra: las API keys hoy se guardan en claro en
`electron-store` y en `.env`. Tienen que ir por `safeStorage` (§10).

---

## 5. Arquitectura: dos vías y tres niveles

### Las dos vías de traducción

```
audio del sistema  ──loopback──►  48→16 kHz mono Float32
         │
         ▼
   whisper-server  -l it          ← modelo cargado UNA vez, no por chunk
         │
   frase italiana confirmada
         │
         ├──►  Marian it→es local        131 ms   →  pinta YA
         │     101 MB · offline · 0 $
         │
         └──►  LLM + perfil + contexto   ~600 ms  →  corrige si mejora
               refina término · detecta pregunta
```

Marian: **p50 67 ms, rango 56-139 ms, 101 MB quantizado, BLEU 61.2 it→es** `[medido]`.
El rango tiene dos extremos por un motivo: 120-139 ms fue la primera medición con
carga en frío y frases largas; 56-74 ms es lo que da ya integrado, con el modelo
caliente y reutilizado entre llamadas — que es como funcionará en producción.
La latencia **crece con la longitud de la frase**, no es constante.
Sin internet la app sigue traduciendo; se pierden el refinado y las respuestas, no la
función principal.

Ejemplo de para qué sirve la segunda vía, de la propia medición: *"Quanto tempo ci vuole
per completare l'integrazione con il gestionale?"* → Marian da *"…con la gestión"*, y
*il gestionale* es el ERP. Con el glosario del contexto cargado, el LLM lo corrige medio
segundo después.

### Los tres niveles, y cómo se elige solo

| Nivel | Qué hace | Coste/hora |
|---|---|---|
| **A — Local** (por defecto) | whisper local + Marian local; LLM solo para preguntas y respuestas | **0,008–0,137 $** `[verificado]` |
| **B — Refinado** (opt-in) | Lo anterior + refinar cada frase con LLM | 0,350 $ con Haiku |
| **C — Nube** (escalado) | STT en la nube + **Marian sigue local** | +0,15 $ |

**La escalada va de A a C, nunca a "todo en la nube".** Si whisper local no cumple, se
sustituye **solo el STT** y Marian se queda donde está. Mandar también la traducción a la
nube es peor en las dos dimensiones a la vez: más lento (400-800 ms con red, frente a 131
ms) y de pago, sin tocar el cuello de botella real.

El hecho económico que ordena esto: **el coste está en la transcripción, no en el LLM.**
Todo el bloque de preguntas y respuestas con Haiku cuesta menos que el STT en nube más
barato que existe. A 40 h de reunión al mes, el nivel A sale a unos **5,50 $/mes**. A ese
precio, elegir modelo por coste es falsa economía: se elige por calidad, porque la
respuesta en italiano es lo único que el usuario va a decir en voz alta.

### Test de admisión al instalar

La tensión "si tu equipo no da, vete a la nube" no se resuelve preguntándole al usuario
—prioridad nº 1— sino midiendo. El instalador ejecuta `whisper-bench` con el modelo
embebido, **con una videollamada activa**, y fija el modo de esa máquina:

| Encode de una ventana de 30 s | Modo que queda fijado |
|---|---|
| ≤ 1.500 ms | Local cómodo, paso de 1,5 s |
| 1.500–3.000 ms | Local con `-ac 512` y paso ≥ 2,5 s |
| > 3.000 ms | Nube por defecto (nivel C) |

Los umbrales son `[por medir]`: vienen de benchmarks publicados en máquinas en reposo, la
mayoría en Linux, ninguna con una videollamada robando núcleos. El único número honesto
será el de sus equipos.

**Qué se le enseña al usuario.** No un porcentaje sacado del modelo de CPU — el nombre no
contiene el límite de potencia, el canal de memoria, la topología híbrida, el estado
térmico ni lo que más pesa, que es la carga competidora. Se muestran tres cosas, en este
orden:

1. **La consecuencia, en segundos:** *"La traducción aparecerá unos 2 segundos después de
   que hablen."* Es lo único que el usuario experimenta.
2. **Un veredicto de tres estados, con su acción:** *va sobrado* (nada que hacer) ·
   *justo* ("cierra el navegador antes de reuniones largas") · *no llega* ("se usará
   transcripción en la nube, 0,15 $/hora").
3. **El contexto medido, plegado:** *"Medido en tu equipo el 14/09, con videollamada activa
   y enchufado: i9-13900HX, 32 GB. Ventana de 30 s procesada en 1,2 s (p95)."*

El nombre de la CPU aparece ahí **como identificación, no como predicción** — para que el
usuario reconozca su máquina y para poder depurar a distancia.

### Lo que se descartó, y por qué

**Audio italiano → español en una sola llamada.** Existe y funciona
(`gpt-realtime-translate`, `gemini-3.5-live-translate-preview`), pero queda como opción
secundaria detrás de un interruptor, no como capa por defecto. Cuatro razones: cuesta
**3–7x más** (1,45–2,04 $/h frente a 0,27–0,54 $/h) porque son modelos *speech-to-speech*
y se paga una voz sintética que la app tira; se lleva por delante Marian, el glosario y la
transcripción italiana que hace falta para sugerir respuestas **en italiano**; los dos son
*preview*, con paradas silenciosas medidas de 8 a 51 segundos y sesiones de ~10 minutos; y
el riesgo de alucinación está documentado y es cualitativamente peor que el de un STT — un
STT se equivoca en una palabra que chirría, un modelo audio→texto **fabrica una frase
plausible en español** que el cliente leerá como si fuera lo que dijo su interlocutor.

**Claude en esta capa.** Su Messages API solo acepta bloques `text`, `image` y `document`:
no hay bloque de audio `[verificado]`. Claude sigue siendo válido para la capa de texto,
que es donde el plan lo pone.

**Google Cloud STT como opción de nube.** Su streaming es gRPC-only y exige credenciales de
service account, incompatible con "el cliente pega su API key" `[verificado]`.

**Trampa a evitar en el código:** el endpoint `/v1/audio/translations` de OpenAI **no
sirve** — traduce solo a inglés y solo con `whisper-1`.

---

## 6. Captura de audio: A automático, B con selector

Es la parte delicada del proyecto y la única que no se puede simular en Mac. Por eso el
plan lleva una **escalera de degradación**, no un solo camino.

### A — automático, cero clics

`setDisplayMediaRequestHandler` con `audio: 'loopback'`. Es el camino por defecto y el que
cumple el requisito del botón único. Puede fallar, y lo peligroso es que **falla en
silencio**:

- el audio de la reunión sale por un dispositivo que no es el predeterminado (auriculares
  USB mientras el predeterminado son los altavoces);
- la app de videollamada usa WASAPI en modo exclusivo;
- el usuario cambia de dispositivo a media reunión, y Electron no lo refleja.

### Dónde se descubre el fallo

**Antes de la reunión, no durante.** La comprobación previa del flujo (§11) reproduce un
tono y trata de oírse por el loopback; si no se oye, A ha fallado y se ofrece B ahí mismo,
con la llamada todavía sin empezar. Ese es el momento correcto para resolverlo.

Queda una segunda línea para lo que solo puede pasar en vivo — el usuario enchufa
auriculares a mitad de reunión. **Ojo con cómo se especifica**, porque la primera versión
de este plan lo tenía mal: WASAPI loopback entrega **buffers a cero cuando ninguna app
reproduce**, así que una pausa normal de la conversación produce exactamente la misma señal
que una captura rota. Con una ventana de 5 segundos la app daría falsos positivos cada
pocos minutos y el usuario aprendería a ignorar el aviso.

Corregido: **ventana de 20-30 segundos, aviso no modal en el propio medidor, y nunca un
diálogo encima de una llamada.** Y el disparador fiable es el nivel, no `devicechange` —
el issue de Electron trata de dispositivos de *salida* y puede no emitir nada útil para una
captura loopback, así que es una pista, no la señal principal.

### B — selector de origen, dos clics y fiable

| Vía | Cómo | Qué capta | Nota |
|---|---|---|---|
| **B1 · dispositivo de grabación** | `enumerateDevices()` → `audioinput`, con nuestra lista etiquetada y ordenada | **Mezcla estéreo** si el driver la expone, que *es* el audio del sistema; o un micrófono real | **La más fiable: no pasa por `getDisplayMedia` en absoluto.** Windows la trae deshabilitada por defecto y la app guía a activarla |
| **B2 · elegir pantalla** | `desktopCapturer.getSources({types:['screen']})` y nuestro propio selector, luego `getUserMedia` con `chromeMediaSourceId` | El audio del sistema de esa pantalla | Camino intermedio si B1 no encuentra nada servible |
| **C · micrófono con altavoz abierto** | Micrófono normal | La sala | Siempre funciona, peor calidad y se oye al propio usuario. Último recurso |

**Descartado `useSystemPicker`.** Existe, pero está documentado como **experimental** y,
cuando el selector del sistema está disponible, **nuestro handler no se invoca**
`[verificado]` — perderíamos `audio: 'loopback'` justo en el camino A. B se construye con
selector propio.

**Mezcla estéreo tiene una reserva honesta:** depende del driver. Realtek suele traerla,
muchos drivers Intel SST y USB no `[por medir]`. Los dos equipos del cliente son PC gamer,
así que es probable que esté, pero la app tiene que **detectar si existe antes de
ofrecerla** en lugar de prometerla.

**Lo que B nunca será:** instalar un cable virtual (VB-CABLE, VoiceMeeter). Es software
adicional y la prioridad nº 1 lo prohíbe. Solo si el cliente lo pide explícitamente.

### La elección se recuerda

Si el usuario tuvo que llegar a B una vez, la app **guarda ese origen** y las siguientes
sesiones arrancan directamente ahí, sin volver a preguntar. Los pasos extra de B se pagan
una sola vez, no en cada reunión — que es lo que la convierte en una opción fiable en vez
de en una molestia recurrente.

---

## 7. Transcripción del italiano: empaquetado y trampas

### Un solo paquete, nada que elegir — verificado sobre el binario

El asset `whisper-bin-x64.zip` del tag **`b5130`** (8.573.270 bytes) contiene nueve DLL
`ggml-cpu-*` — `sse42`, `x64`, `sandybridge`, `haswell`, `alderlake`, `skylakex`,
`icelake`, `cascadelake`, `cannonlake` — y `ggml_backend_load_best()` las carga todas,
pregunta a cada una su `ggml_backend_score` y se queda con la mejor. **El score puntúa por
features de CPUID, no por fabricante** `[verificado]`: el i9 Raptor Lake carga `alderlake`
y el Ryzen carga `haswell` o mejor. El pilar de la instalación trivial se sostiene y no
hay que preguntar nada al usuario.

### Cuatro cosas que lo rompen, y ninguna es el despacho

1. **El zip no trae el runtime de MSVC.** Sus DLL importan `VCRUNTIME140.dll`,
   `VCRUNTIME140_1.dll`, `MSVCP140.dll` y **`VCOMP140.DLL`** (OpenMP), y ninguna viene
   dentro `[verificado]`. En un Windows 11 limpio sin el VC++ Redistributable 2015-2022
   x64, el binario **no arranca**. `VCOMP140` es la que siempre se olvida porque no forma
   parte de Windows. El instalador encadena el redist o embarca las cuatro DLL. **Esto es
   riesgo directo de la prioridad nº 1.**
2. **Hay que anclar el tag exacto y su hash.** El release `v1.9.4` **no tiene assets**, y
   la regla no es estable: `v1.9.3` tampoco, pero `v1.9.2` sí. El flag `prerelease`
   tampoco filtra. Un instalador apuntado a "latest release" no descarga nada
   `[verificado]`.
3. **El despacho falla en silencio si el empaquetado dispersa las DLL.** Las nueve tienen
   que quedar junto a `ggml-base.dll`. Si electron-builder las separa,
   `ggml_backend_load_best` no encuentra candidatos y cae a la peor variante sin dar
   error. **Loguear al arrancar qué variante se cargó, y tratarlo como health check.**
4. **El zip es un volcado de desarrollo**, no un distribuible: 40 archivos y 21,8 MB
   descomprimido, con nueve binarios de test, `llama.dll`, `wchess.exe` y un `SDL2.dll`
   fechado en 2023. Se poda a los ~12 archivos que hacen falta.

### La ventana de 30 segundos

El encoder de Whisper procesa **siempre** una ventana de 30 s, aunque el chunk sea de 2 s.
Una ventana deslizante ingenua multiplica el coste por el número de pasos y hunde
cualquiera de los dos equipos. **Obligatorio: VAD Silero + `-ac 512` + paso adaptativo.**
Sin esto, ninguna cifra de latencia de este plan se cumple. La ganancia concreta de
`-ac 512` es `[por medir]`: el README la afirma sin publicar números.

### Modelo

`small` multilingüe es el techo en CPU (los `.en` no sirven para italiano). Parámetros de
arranque: `-l it -ac 512 --vad -fa -t N`.

**El número de hilos no es "núcleos físicos menos 2", y esa heurística habría sido un error
grave en el equipo del cliente.** El i9-13900HX tiene 8 P-cores y 16 E-cores: la fórmula
antigua daría **22 hilos**, y como whisper.cpp reparte el trabajo por igual, los P rápidos
acabarían esperando a los E lentos y rendiría *peor* que usando solo los 8 P. Lo correcto
en esa CPU es **`-t 8` anclado a P-cores**. Está medido que sobresuscribir degrada 2x
`[verificado]`.

**Y el dato que decide esto no se puede leer.** Distinguir P de E requiere
`GetSystemCpuSetInformation`, que no es accesible desde Node sin un addon nativo. Sin él, la
heurística práctica es: si el nombre de la CPU es de una familia híbrida conocida (Intel 12ª
en adelante), usar `min(8, núcleos_físicos / 3)`; si no, `núcleos_físicos - 2`. Y dejar que
el test de admisión valide el número elegido probando dos o tres valores — medir gana a
deducir.

**Sobre `large-v3-turbo`:** su encoder es idéntico al de `large-v3` y solo recorta el
decoder de 32 a 4 capas `[verificado]`, así que su ahorro escala con los tokens generados
y no con el audio. En **GPU es la elección correcta**; en CPU hay que medirlo contra
`medium` antes de decidir `[por medir]` — las cifras que circulan diciendo que es más
lento vienen de un Core i5 de 2010 sin AVX sobre un clip de 11 segundos, y no transfieren.

**Sobre la GPU.** whisper.cpp **no publica ningún binario CUDA x64 moderno**: el único
CUDA 13 es `arm64` (inservible) y para x64 solo hay cuBLAS 11.8 (273 MB) y cuBLAS 12.4
(674 MB) `[verificado]`. Una RTX 5060 es Blackwell (`sm_120`) y necesita CUDA 12.8+; hay
reportes de `cuBLAS NOT_SUPPORTED` en RTX 50 con toolkits anteriores. Usar la GPU exige
**compilar nuestro propio binario y mantenerlo**. Si se confirma NVIDIA en los dos
equipos, ese coste se reparte entre ambos y se justifica; con uno solo, no.

**Sobre Vulkan en gráficos integrados:** fuera de la v1, pero no por lo que se suele decir.
El "12x" que se publicitó es un PR de 5 líneas sin metodología que se contradice a sí
mismo (título 12x, cuerpo 3-4x) `[verificado]`. No hay binario Vulkan oficial para Windows
— aunque el issue que lo pedía lo cerró un **bot de inactividad**, no un maintainer, y el
PR para añadirlos sigue abierto, así que no es una puerta cerrada. Queda fuera porque
montar CI propia con matriz de drivers AMD/Intel para un usuario no se paga.

### Una apuesta a evaluar, no a asumir

**Parakeet-TDT-0.6b-v3**, ya incluido en whisper.cpp: **3,00% de WER en italiano**, mejor
que `large-v3` de whisper, con 600M de parámetros. Dos peros duros: `whisper-server` no lo
sirve (haría falta un addon nativo de Node), y **autodetecta entre 25 idiomas sin poder
forzar italiano** — en una reunión con hispanohablantes transcribiría español y Marian
IT→ES produciría basura. Spike de 2-3 días si sobra presupuesto; no está en la ruta
crítica.

---

## 8. Perfil y contexto de proyecto

Dos entidades separadas a propósito: el perfil cambia casi nunca, el contexto cambia en
cada llamada.

```sql
CREATE TABLE profiles (
  id        INTEGER PRIMARY KEY,
  nombre    TEXT NOT NULL,
  edad      INTEGER,
  ocupacion TEXT,
  contexto  TEXT,            -- contexto breve de la persona
  activo    INTEGER DEFAULT 0
);

CREATE TABLE project_contexts (
  id            INTEGER PRIMARY KEY,
  nombre        TEXT NOT NULL,   -- "Kickoff cliente Rossi"
  tipo_reunion  TEXT,            -- entrevista · daily · demo · negociación · soporte
  tipo_proyecto TEXT,            -- "ERP logística, migración a SAP"
  contexto      TEXT,            -- de qué va a ir esta conversación
  glosario      TEXT,            -- términos y nombres propios
  activo        INTEGER DEFAULT 0
);
```

Varios guardados, uno activo de cada. El contexto se elige **desde la barra superior antes
de pulsar Escuchar**: es la acción que se repite en cada llamada y no puede estar enterrada
en Ajustes. Cada sesión guarda con qué perfil y contexto se grabó.

Un solo constructor, `buildContextBlock()`, produce el bloque que alimenta los cuatro
prompts, para que el contexto no se escriba cuatro veces ni se desincronice.

| Prompt | Qué hace con el contexto |
|---|---|
| Refinado de traducción | Corrige terminología: *il gestionale* → el ERP, no "la gestión" |
| Escáner de preguntas | Distingue una pregunta dirigida al usuario de una retórica, sabiendo su rol |
| Redacción de respuesta | **Donde más pesa:** responde como quien es el usuario, sobre su proyecto |
| Resumen en vivo | Resume contra el tema declarado en vez de deducirlo |
| `--prompt` de Whisper | **Extra gratis:** el glosario mejora la transcripción de siglas y nombres |

**Export/import entre los dos equipos.** `safeStorage` cifra con DPAPI y el blob está atado
al usuario **y a la máquina**: *"only a user with the same logon credential as the user who
encrypted the data can typically decrypt the data"* `[verificado]`. Así que el export lleva
perfiles y contextos —lo laborioso de reescribir— y la API key se pega una vez en cada
equipo.

---

## 9. Preguntas y respuestas

### Detectarlas en italiano es más difícil que en inglés

En italiano la interrogación es muy a menudo **solo prosódica**: la afirmación y la
pregunta son idénticas por escrito. Y Whisper omite muchos signos. Probando sobre texto
italiano sin `?`, que es como llegará de verdad `[medido]`:

| Italiano sin signo | Español que sale | ¿Detectada por "¿"? |
|---|---|---|
| Quanto tempo ci vuole per completare l'integrazione | ¿Cuánto tiempo se tarda…? | ✓ |
| Che ne pensi della proposta | ¿Qué opinas de la propuesta? | ✓ |
| Puoi spiegarmi come funziona il sistema | Puedes explicarme cómo funciona… | ✗ |
| Hai finito il report | Has terminado el informe. | ✗ |
| Avete già parlato con il fornitore | Ya ha hablado con el proveedor. | ✗ |
| Il budget copre anche la manutenzione | El presupuesto cubre también… | ✗ |

**2 de 6.** Buscar "¿" no basta, y el último caso es genuinamente ambiguo: ni una persona
leyendo solo ese texto sabría si es pregunta. Tres capas:

| Capa | Coste | Qué atrapa |
|---|---|---|
| Palabras de apertura italianas | gratis | `che · cosa · come · quando · perché · quale · quanto · c'è` y, clave, el **verbo en 2ª persona al inicio** — `hai · avete · puoi · potete · sai · sapete · vuoi · riesci` — que es el patrón interrogativo sin palabra interrogativa, justo el que se perdía arriba. Corre sobre la hipótesis en vivo, así que el aviso aparece *antes* de que la frase termine |
| `--prompt` con ejemplos puntuados | gratis | Induce a Whisper a escribir `?`. Ayuda, no resuelve |
| Escáner LLM periódico | ~1 llamada / 40 s | La red que atrapa lo que solo el contexto delata |

**El escáner va a 40 s, no a 25.** Bajarlo de 25 a 40 s recorta **~34% del coste** del
nivel A, porque con 144 llamadas/hora el 66% de los tokens de entrada es el bloque de
contexto repetido. Y el *prompt caching* **no es una palanca disponible**: el mínimo
cacheable de Haiku son 4.096 tokens y nuestro prefijo son ~400 `[verificado]`. No contar
con el "ahorro por caché" que aparece en todas las guías.

Aun con las tres capas quedarán falsos negativos en preguntas puramente entonativas. Es un
límite del texto, no del modelo.

### Respuestas: solo en italiano

Sin glosa. Son para decirlas en voz alta: 2-3 frases, máximo 500 caracteres, generadas
**al abrir la pregunta** y nunca en segundo plano, para que el panel no pueda frenar la
transcripción. Las fórmulas sociales (`come stai`, `mi sentite`) se marcan en gris y no
gastan llamada.

---

## 10. Instalación, claves y coste visible

Todo este apartado existe por la prioridad nº 1.

### Primer arranque

**La app traduce sin ninguna API key.** Marian y la detección de preguntas por aperturas
son locales, así que recién instalada ya traduce; solo las *respuestas sugeridas* y el
refinado necesitan LLM. Eso convierte la pantalla de la key en **opcional y salteable**
("puedes añadirla después") en lugar de un muro antes de la primera frase.

**Una key, una pantalla, detectada sola.** Hoy el original pide tres keys en campos
separados, más el endpoint de Ollama, más cuatro selectores de modelo por tarea. Se reduce
a un campo: se pega la key, la app deduce el proveedor por el prefijo (`sk-ant-` →
Anthropic, `AIza` → Gemini, `sk-` → OpenAI), la valida con una llamada de un token y
confirma en pantalla. Los cuatro selectores se van a "Avanzado", cerrado. Esa validación
es la misma que la comprobación de IA del test previo (§11): una sola pieza.

**Ollama sale de la ruta por defecto.** No es solo esconderlo de la UI: el `main.js` actual
**arranca `ollama serve` y descarga modelos solo**. Eso se desactiva. Queda como modo
explícito "sin API keys", y con `qwen3:4b`, **no 8B** — en el equipo de 16 GB el problema
no es la RAM sino que Ollama competiría por los mismos núcleos que whisper, que es el
componente crítico. Un 4B responde en 6-8 s (tolerable bajo demanda); un 8B en 12-19 s
(inutilizable).

**El modelo va dentro del instalador.** El `.exe` se va a ~600 MB. Un instalador grande no
confunde a nadie; una barra de descarga al primer arranque sí, y puede fallar por red y
dejar la app muda sin que el usuario entienda por qué.

### Una key para todo, y qué proveedor conviene

**STT** (*speech-to-text*) y **LLM** son servicios distintos: el primero convierte audio en
texto —es lo que hace Whisper en local— y el segundo solo trabaja con texto. El LLM nunca
oye nada: recibe lo que Whisper ya transcribió y hace las tres tareas de texto (detectar
preguntas, redactar respuestas en italiano, refinar la traducción).

El plan tenía una contradicción: el escalado a nube (§5, nivel C) mandaba el audio a un
servicio de transcripción, y eso **no lo hacen Claude, ChatGPT ni Gemini en su modo
normal** — lo hacen AssemblyAI o Deepgram, que son otra empresa y otra key. Pero esta
sección promete "una sola key".

**Se resuelve eligiendo proveedor**, porque Gemini y OpenAI **sí transcriben audio con la
misma key** que usan para el texto. Anthropic no: su Messages API solo acepta bloques
`text`, `image` y `document` `[verificado]`.

| Key del cliente | Tareas de texto | ¿Transcripción en nube con la misma key? |
|---|---|---|
| **Gemini** | sí | **sí** |
| **OpenAI** | sí | **sí** |
| **Claude** | sí | **no** — se queda sin nivel C |

**Recomendación: Gemini u OpenAI por defecto.** Una sola cuenta, una sola key, y no hay
que pedir consentimiento aparte para subir audio a un tercero distinto. Claude sigue siendo
válido para el texto —es fuerte controlando tono, que es justo lo que pide la respuesta
hablada en italiano— pero quien lo elija renuncia al escalado a nube.

**Con el equipo confirmado del cliente (§3) ese plan B probablemente no se active nunca.**
Existe para el caso "cualquier Windows con requisitos mínimos", no para un i9-13900HX.

**Qué modelo es el mejor para redactar en italiano: no hay dato.** No existe un benchmark
público de calidad redactando una respuesta hablada en italiano, así que cualquier ranking
sería intuición. Se mide en los spikes (§15), comparando los tres con 20 preguntas reales.
Mientras tanto, el `aiOrchestrator` heredado **ya soporta modelo distinto por tarea**: el
rápido y barato para el escaneo de 40 s, el bueno para redactar.

### Claves

`safeStorage` (DPAPI) en vez de `electron-store` en claro y `.env`. No requiere que la app
esté firmada en Windows `[verificado]`. La key vive en el **proceso main**, que es Node, y
nunca viaja al contexto web del renderer.

### Contador de coste — obligación de producto

Como paga el cliente, un coste invisible es un coste que genera desconfianza. La app lleva
**coste acumulado por sesión y por mes**, y cuando escala a la nube **dice en pantalla los
$/hora que acaba de activar**. Sin eso, la primera factura es una sorpresa y el proyecto
pierde credibilidad por 6 $.

### Dos bombas de facturación

1. **AssemblyAI factura por duración del socket WebSocket abierto, no por audio enviado, y
   el tiempo inactivo cuenta.** Textual: *"A WebSocket open for 60 minutes with 30 minutes
   of audio sent is billed for 60 minutes"* / *"Always close the WebSocket immediately when
   a call ends to avoid runaway billing"* `[verificado]`. Un socket que se queda abierto por
   un bug o una ventana cerrada sin limpiar factura horas de silencio. Hace falta cierre por
   VAD, cierre explícito en Stop y en `window-close`, y un watchdog. Precio: **0,15 $/h**
   tanto el tier inglés como el multilingüe (sin recargo), 0,45 $/h el Pro `[verificado]`.
2. **Gemini 3.6/3.7/3.8 Flash doblan su precio el 1 de enero de 2027** (0,75 → 1,50 $
   entrada; 3,75 → 7,50 $ salida) `[verificado]`. Flash-Lite no sube. Y cuidado con el
   nombre: **Gemini 3.5 Flash ya está en 1,50/9,00 $**, o sea más caro que el precio
   *post*-subida de los otros. Si se fija un modelo por defecto, nombrar la versión exacta.

### Instalador y firma

NSIS con electron-builder. Sin firmar, Windows 11 muestra SmartScreen ("Windows protegió su
PC" → *Más información* → *Ejecutar de todas formas"). Para **un usuario en dos equipos son
dos clics en la vida de la app**, así que no se recomienda comprar certificado: desde 2023
las claves OV exigen hardware FIPS y el precio anual no se justifica aquí. Pedir presupuesto
solo si el cliente decide distribuirla.

### El problema de los auriculares

Electron [no refleja los cambios de dispositivo de salida del sistema](https://github.com/electron/electron/issues/12365),
así que enchufar auriculares a media reunión puede dejar la captura **muda sin dar error**.
Se trata en §6: vigilante de `devicechange`, medidor de nivel visible y caída a B1 si el
reinicio no recupera señal. Se menciona aquí porque es un fallo de *runtime* en casa del
cliente, no de instalación, y es el que más probablemente genere un "no funciona".

---

## 11. El flujo de una reunión, y la interfaz que lo sirve

La app tiene **dos modos**, no uno. Eso resuelve la tensión entre "hay que configurar
perfil, contexto y comprobar el audio" y "la ventana tiene que ser pequeña y no tapar la
videollamada": son dos momentos distintos y no tienen por qué compartir tamaño.

```
   ┌── MODO PREPARACIÓN ────────────┐        ┌── MODO EN VIVO ───────┐
   │ ventana normal, redimensionable│        │ 580 px · always-on-top │
   │                                │        │                        │
   │ 1 · Perfil de la reunión       │        │ traducción en burbujas │
   │ 2 · Contexto de la conversación│  ──►   │ preguntas y respuestas │
   │ 3 · Comprobación previa        │Escuchar│ medidor · coste        │
   │     audio · modelos · IA       │        │                        │
   └────────────────────────────────┘        └───────────┬────────────┘
              ▲                                          │ Detener
              │ mientras el usuario escribe,              ▼
              │ los modelos se cargan de fondo    ┌──────────────────┐
              └───────────────────────────────────│ Guardar          │
                                                  │ txt·json·csv·md  │
                                                  └──────────────────┘
```

### Los modelos se precargan durante la preparación

Confirmado: se cargan al abrir la app, no al pulsar *Escuchar*. Y el flujo lo hace
elegante — **mientras el usuario elige perfil y escribe el contexto, Whisper y Marian se
cargan de fondo**. El tiempo de carga se esconde detrás de un trabajo que el usuario
estaba haciendo de todas formas, así que cuando llega a *Escuchar* todo está caliente y el
botón responde al instante. Sin esto, el arranque de Electron más los dos modelos se
notarían justo en el peor momento.

### La comprobación previa

Es el paso que convierte el mayor riesgo del proyecto en un problema que se descubre **con
la reunión todavía sin empezar**, en calma, en lugar de en mitad de una llamada. Cuatro
comprobaciones con su semáforo:

| Comprobación | Cómo | Si falla |
|---|---|---|
| **Audio** | La app **reproduce un tono corto y trata de oírse a sí misma** por el loopback. Si lo capta, el loopback funciona | Ofrece la ruta B con su selector (§6) |
| **Transcripción** | Pasa una muestra de italiano embebida por `whisper-server` | Cae al nivel C, nube (§5) |
| **Traducción** | Marian traduce esa misma muestra | Error duro: la app no puede funcionar |
| **IA** | Llamada de un token para validar la API key | Avisa de que no habrá respuestas, pero sí traducción |

**El detalle técnico que hace viable el test de audio:** para oírse a sí misma, la captura
de la prueba **no puede excluir el audio del propio proceso**. Hay que usar `loopback` a
secas y no `loopbackWithoutChrome` ni `restrictOwnAudio` durante la comprobación, o el test
fallaría precisamente cuando todo está bien. Es un error fácil de cometer y difícil de
diagnosticar.

**Un veredicto, no cuatro semáforos.** Si una de las comprobaciones queda en ámbar, el
usuario no técnico no sabe si seguir. La pantalla da **un veredicto y una acción**, con el
detalle plegado debajo. Y la lista real es más larga que cuatro: permiso de micrófono de
Windows, qué variante DLL cargó whisper, hash del modelo, puerto local libre, prueba de
escritura en la carpeta de exportación, memoria disponible, estado de energía, y el
endpoint del STT de nube si esa vía existe. Todo eso alimenta un solo semáforo.

**Y se re-verifica en silencio al pulsar Escuchar.** Entre la preparación y el botón pasan
diez minutos en los que el usuario enchufa auriculares y conecta la VPN. El tono son 200 ms.

**Una consolidación:** este test de latencia y el test de admisión de §5 son el mismo
mecanismo — muestra de italiano embebida → pipeline completo → números. Se ejecuta una vez
al instalar para fijar el modo de la máquina, y se puede volver a lanzar desde Ajustes
cuando el usuario quiera. Una sola pieza de código sirve a las dos cosas.

### Ajustes

Entrada de audio (§6), modelo de IA por tarea —el selector de chips del original ya lo
hace—, API keys, test de latencia, formato y carpeta de guardado, y los presets de afinado.
Todo cerrado por defecto: el usuario que no lo abra nunca debe poder usar la app entera.

### Tres cosas del modo en vivo que no son opcionales

**1 · La ventana tiene que ser invisible para los capturadores.** Si el cliente comparte
pantalla en Teams, su interlocutor vería las respuestas sugeridas que la app le está
soplando. No es una avería, es un incidente profesional, y **no hay forma de detectarlo**:
o se previene o no. Una línea, `win.setContentProtection(true)`, que en Windows se traduce
a `WDA_EXCLUDEFROMCAPTURE`. Va desde el primer prototipo, no al final.

**2 · Autoguardado desde la primera frase.** El flujo dice "al terminar, exporta", y eso
significa que un cierre accidental, un crash del renderer o un reinicio por Windows Update
en el minuto 58 **borra la reunión entera**. Es el fallo que más rápido destruye la
confianza en un producto así. Append-only a un `.jsonl` desde la primera frase confirmada;
el export del final se limita a leer ese archivo.

**3 · Una línea de estado siempre visible.** Cuando nadie habla no pasa nada en pantalla, y
una pantalla en blanco es indistinguible de una app rota — es el fallo de percepción más
probable y el más barato de resolver. Cuatro estados y la hora de la última frase:
*Escuchando · Oigo audio · Transcribiendo · Traduciendo*.

### Al terminar

Lo mismo que ya hace el proyecto actual, y se hereda tal cual: `SaveModal` más el
`saveSession` de `main.js`, con exportación a **txt, json, csv y md** en la carpeta que
elija. Con una salvedad nueva: **hay que probar que se puede escribir ahí en la
comprobación previa**, porque el Controlled Folder Access de Defender y OneDrive pueden
bloquear la carpeta, y eso se descubriría justo al acabar la reunión.

### Interfaz del modo en vivo

```
┌──────────────────────────────────────────────────────┐
│ ● 12:34  ▁▃▅▂  0,04 $   Arturo · Negociación      ⚙ ▣│ 40 px
├──────────────────────────────────────────────────────┤
│ ▾ Contexto general            (colapsable, 0/90 px)  │
├───────────────────────────┬──────────────────────────┤
│ TRADUCCIÓN                │ PREGUNTAS                │
│   ┌──────────────────┐    │  ┌────────────────────┐  │
│   │ Buongiorno a...  │    │  │ ¿Cuánto tiempo...? │  │
│   └──────────────────┘    │  │ 12:31              │  │
│   Buenos días a todos     │  └────────────────────┘  │
│                           │    ▸ toca para respuesta │
│   ┌──────────────────┐    │  ┌────────────────────┐  │
│   │ Puoi spiegarmi…  │    │  │ ¿Qué opinas de...? │  │
│   └──────────────────┘    │  │ ▾ Penso che la...  │  │
│   ¿Puedes explicarme…  ▌  │  └────────────────────┘  │
└───────────────────────────┴──────────────────────────┘
  580 × 520 por defecto · always-on-top · sin marco
```

**La burbuja lleva el italiano; el español va debajo, suelto y más grande.** Invertido
respecto de lo intuitivo y a propósito: la burbuja es *lo que dijo el otro*, el español es
la lectura del usuario. Es lo que hace la versión nativa y funciona.

**Una sola columna a la izquierda**, no dos hablantes: la app no hace diarización, todo lo
que oye viene del otro lado. El **contexto general va colapsado** y recuerda el estado —
cerrado, la ventana baja a ~430 px. El **panel de preguntas también se cierra** y la
ventana se estrecha a ~340 px: el modo "solo traducción", que será el de la mayor parte
del tiempo. Frente a los 1100 px del original, 580 px caben al lado de la videollamada sin
taparla.

En la barra van dos cosas que el original no tiene y este proyecto necesita: el
**medidor de nivel** (§6) y el **contador de coste** (§10). El perfil y el contexto ya se
eligieron en la preparación, así que aquí solo aparecen como recordatorio de qué está
cargado — no como selectores que se puedan tocar por error en mitad de la reunión.

---

## 12. Fallos, planes B, y lo que no debe tener plan B

Auditado contra la matriz inicial. El detalle completo está en
`docs/auditoria-fallos.md`; aquí va lo que cambia decisiones.

### La regla que decide si algo merece un plan B

Un plan B solo se justifica si cumple **las tres**:

1. el fallo es un evento de *runtime*, no un fallo de build que afecta al 100% de las
   instalaciones;
2. hay un disparador automático que alguien va a implementar de verdad;
3. se activa en menos tiempo del que dura la paciencia en una reunión.

Un fallback que casi nunca se usa es código que se pudre y una ruta que nadie prueba.

### Lo que se recorta de la matriz original

| Se quita | Por qué |
|---|---|
| **Descargar el modelo si falta** | Contradice la decisión de embeberlo, y el disparador no es aleatorio: es un fallo de build. Se sustituye por hash al primer arranque y "reinstala la aplicación" |
| **Que el LLM traduzca si Marian falla** | Marian es determinista: o carga siempre o no carga nunca. §11 ya lo llama error duro. Mantener una segunda ruta de traducción con su cola y su coste es código muerto |
| **Mostrar solo el italiano** | No es un plan: el usuario no habla italiano, por eso existe la app |
| **Escalera de RAM (`small` → `base` → nube)** | Con 16-32 GB y un modelo de 600 MB la RAM no es el recurso escaso; lo es la CPU. Se sustituye por una comprobación previa: "tienes poca memoria libre, cierra el navegador" |
| **B2, el selector de pantalla** | Reintroduce el subsistema que acaba de fallar (ver abajo). Con A + B + C hay cobertura real |
| **Ollama** | Competiría por los mismos núcleos que whisper. Fuera de la v1 del todo, no "escondido" |
| **Auto-actualización** | Dos máquinas. Reinstalar es un `.exe` |

### La escalera de audio, corregida

El error de la versión anterior: **B2 compartía causa raíz con A.** Elegir pantalla usa el
mismo subsistema (`getDisplayMedia` / `desktopCapturer`) que el loopback automático, así
que si A falla por esa capa, B2 falla igual.

| | Vía | ¿Mecanismo distinto de A? |
|---|---|---|
| **A** | `loopback` de Electron | — |
| **B** | **Binario nativo de WASAPI loopback** (`AUDCLNT_STREAMFLAGS_LOOPBACK`), PCM a stdout | **Sí.** Es el patrón que el proyecto original ya usa en macOS con `audio_capture.swift` |
| **C** | Selector de dispositivo: Mezcla estéreo si existe, si no micrófono | Sí, pero degradado |

**Y una corrección incómoda sobre Mezcla estéreo:** los fabricantes dejaron de habilitarla
en portátiles alrededor de 2018, así que en el L16S del cliente **probablemente no está**.
Además se expone como `audioinput`, o sea que depende del permiso de micrófono de Windows;
si la política corporativa lo desactiva, `enumerateDevices()` devuelve entradas **sin
etiqueta** y la lista sale en blanco. Por eso el binario nativo sube a plan B.

**El modo micrófono capta la voz del propio usuario**, así que el detector de preguntas
puede "detectarle" preguntas que hizo él. Si se mantiene, va marcado como modo degradado.

### Los que faltaban, por daño esperado

| | Fallo | Respuesta |
|---|---|---|
| 1 | **La ventana se ve cuando el cliente comparte pantalla en Teams** — toda la sala lee sus respuestas sugeridas | `win.setContentProtection(true)` → `WDA_EXCLUDEFROMCAPTURE`. **Una línea, y sin ella el producto es peligroso.** No hay detección posible: es prevención o nada |
| 2 | **No hay autoguardado.** Un cierre accidental en el minuto 58 borra la reunión entera | Append-only a `.jsonl` desde la primera frase confirmada; el export al final lee ese archivo |
| 3 | **Diálogo del Firewall en el primer arranque.** El usuario pulsa "Cancelar", Windows crea una regla de bloqueo permanente y la app queda rota para siempre, sin mensaje | `wsServer` y `whisper-server` escuchan en `127.0.0.1` explícito y puerto efímero. **Prevenir, no detectar** |
| 4 | **`whisper-server` huérfano.** Node no mata el árbol de procesos en Windows: sobrevive comiendo 700 MB y ocupando el puerto | Job Object con `KILL_ON_JOB_CLOSE`, o PID guardado y limpieza al arrancar |
| 5 | **Proxy corporativo con inspección TLS.** El `https` de Node no usa el almacén de certificados de Windows | Hacer las llamadas con el módulo `net` de Electron, que sí usa la pila de Chromium (certificados del sistema y PAC). Elimina una clase entera de fallos indepurables a distancia |
| 6 | **El plan B de transcripción necesitaba una segunda credencial** | Resuelto: ver §10, *Una key para todo* |
| 7 | **Errores de API sin tratar**: 401 key mala, 402 sin crédito, 429 límite, 5xx transitorio | Cada uno con su mensaje y su respuesta. Backoff y circuit breaker; sin red, cortar tras 2 fallos en vez de acumular reintentos |
| 8 | **El contador de coste solo mira.** Si hay un bucle, lo muestra pero no lo para | Tope de gasto duro por sesión |

### Detección: los que no se descubrirían nunca

Un plan B que nadie dispara no existe. Estos no tienen señal y salen como texto bien
formado:

- **Frecuencia de muestreo mal asumida.** "48→16 kHz" está escrito como constante; si el
  endpoint va a 44,1 o 96 kHz el remuestreo entrega audio a velocidad equivocada, **todo
  "funciona" y el WER simplemente se dispara**. Leer siempre `audioContext.sampleRate`
- **Alguien habla español o inglés.** Con `-l it` forzado, Whisper transcribe el español
  como italiano fonético y Marian lo traduce a basura. En una reunión ítalo-española va a
  pasar constantemente
- **Alucinaciones de Whisper en silencio.** En italiano el patrón documentado son créditos
  de subtítulos (*"Sottotitoli e revisione a cura di…"*, *"Amara.org"*). Lista negra más
  `no_speech_prob`
- **Repetición degenerada** de Whisper o de Marian. Detector de n-gramas repetidos, trivial
  y muy rentable
- **Throttling térmico o batería.** p95 del tiempo de encode en ventana móvil; si se
  degrada 1,5x respecto al valor de admisión, cambiar de modo y decirlo
- **La variante DLL equivocada** (`sse42` en vez de `alderlake`). Ya se loguea; convertirla
  en semáforo de la comprobación previa
- **Exportación bloqueada** por Controlled Folder Access de Defender o por OneDrive. Se
  descubre en el peor momento: prueba de escritura en la comprobación previa
- **DPAPI que deja de descifrar** tras un cambio de contraseña. Hoy reventaría en la
  primera llamada al LLM, a mitad de reunión: comprobarlo al arrancar

### Dos correcciones a diseños que ya había escrito

**El watchdog de silencio estaba mal especificado.** WASAPI loopback entrega **buffers a
cero cuando ninguna app reproduce**, así que una pausa normal de la reunión produce
exactamente la misma señal que una captura rota. Con la ventana de 5 s que había escrito,
la app daría falsos positivos cada pocos minutos, el usuario aprendería a ignorar el aviso
y el día que fuese real tampoco haría caso. Corregido: **ventana de 20-30 s, aviso no modal
en el medidor, y nunca un modal encima de una llamada.**

**Y el watchdog de whisper puede empeorar el fallo.** Forzar un decode a los 6 s cuando la
causa era el umbral de VAD es forzar un decode sobre silencio, o sea **una alucinación
garantizada** que el usuario leerá como una frase real. Antes de forzar, comprobar que hay
energía de audio entrando; si el nivel es cero, el problema es de captura y la respuesta es
otra.

**Tampoco aguanta mi argumento de no pregenerar respuestas.** Escribí que no se pregeneran
"para que el panel no frene la transcripción", pero el LLM es de nube: **no gasta CPU
local.** El coste real es económico y es acotable. Tal como estaba, el usuario pulsa,
espera 3-5 s y la conversación ya pasó de largo. Corregido: pregenerar para las preguntas
de alta confianza, con presupuesto por sesión.

---

## 13. Fases

Reordenadas por la prioridad nº 3: primero lo que da más resultado por menos trabajo.

| # | Fase | Entregable | Riesgo |
|---|---|---|---|
| −1 | **Build de diagnóstico** — Electron mínimo que solo mide y escribe un informe, enviado al cliente | Datos reales de sus dos equipos antes de construir nada | bajo |
| 0 | **Andamiaje** — copiar base, quitar Python y Swift, **subir Electron 28 → 43.4.0+** | Arranca en limpio sobre Electron moderno | medio |
| 1 | **Vía rápida** — Marian ONNX en proceso + `whisper-server -l it` con VAD y `-ac 512` | Traduce IT→ES; la mayor ganancia de latencia por unidad de trabajo | bajo |
| 2 | **Audio en Windows** — ruta A (`loopback`) + AudioWorklet 48→16 kHz + vigilante de `devicechange` + medidor de nivel, **la ruta B completa con su selector**, y el **auto-test de tono** de la comprobación previa | **Un botón, cero configuración** — y el fallo descubierto antes de la reunión, no durante | **el más alto** |
| 3 | **Empaquetado** — NSIS, VC++ redist encadenado, modelo embebido, tag `b5130` anclado, health check del backend | `.exe` que instala y arranca en un Windows limpio | medio |
| 4 | **Perfil y contexto** — tablas, CRUD, selector en barra, `buildContextBlock()`, glosario a Whisper | Las dos secciones que pide el cliente | bajo |
| 5 | **Preguntas y respuestas** — detector italiano de tres capas, respuestas en italiano bajo demanda | Panel funcionando con el contexto cargado | medio |
| 6 | **UI y flujo** — los dos modos, comprobación previa con sus cuatro semáforos, burbujas del modo en vivo, medidor y contador de coste | El flujo completo de una reunión, de preparar a guardar | medio |
| 7 | **Test de admisión y escalado** — `whisper-bench` al instalar, nivel C con cierre de socket por VAD | "Si tu equipo no da, a la nube", automático | medio |
| 8 | **Medición en su hardware** — consola de rendimiento, informe, ajuste de umbrales | Cifras reales en vez de estimaciones | — |

Las fases 0, 1, 4, 5 y 6 se desarrollan en macOS. **Las fases 2 y 3 necesitan una máquina
Windows real** y conviene adelantarlas en cuanto haya acceso: es el único riesgo que no se
puede simular. La reescritura completa a streaming del proyecto nativo **queda fuera de la
v1 y condicionada** a que `whisper-server` con VAD no baste — es la fase más cara y puede
no hacer falta.

---

## 14. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **No tenemos su entorno**: ni Windows nativo, ni GPU NVIDIA, ni un driver con Mezcla estéreo | **alto** | La build de diagnóstico (§14) mide en sus equipos antes de construir. La ruta GPU sale de la v1 por no poder ejecutarla |
| El `loopback` no capta la app de videollamada concreta del cliente, y **falla en silencio** | **alto** | La ruta B con selector de origen se construye en la fase 2, no se deja como contingencia (§6). El medidor de nivel detecta el fallo a los 5 s y la app ofrece B con un clic; la elección se recuerda |
| Falta el VC++ Redistributable y el binario no arranca | **alto** | Encadenar el redist en el instalador; embarcar las 4 DLL como respaldo |
| El salto de Electron 28 → 43 rompe cosas del original | medio | Es la fase 0 a propósito: que falle al principio y no al final |
| El despacho de DLL falla en silencio por el empaquetado | medio | Loguear la variante cargada al arrancar como health check |
| Auriculares a media reunión dejan la captura muda | medio | Vigilante de `devicechange` que reinicia la captura, medidor de nivel visible, y caída a B1 si el reinicio no recupera señal |
| Socket de nube abierto facturando silencio | medio | Cierre por VAD, en Stop y en `window-close`, más watchdog |
| **El cliente juzga la calidad con audio de reunión** (22,9% WER) y no con audio limpio (9,8%) | medio | **Gestionar la expectativa antes de entregar**, con una demo sobre su propio audio |
| Preguntas puramente entonativas | medio | Tres capas; plantear el límite desde el principio |
| El Ryzen 7 resulta ser Zen 2 y `small` va al límite | medio | Test de admisión; escalado a nivel C |
| Precios de LLM que cambian por fecha | bajo | Flash-Lite en vez de Flash; nombrar versión exacta |

---

## 15. Pendientes

### Qué se puede probar, y dónde

El equipo de desarrollo es un MacBook Pro M5 y un Ubuntu con Intel Core i7; no hay GPU
NVIDIA y no hay una máquina Windows nativa. Casi todo el plan se puede validar igualmente:

| Qué | M5 | Ubuntu i7 + VM Windows | Solo sus equipos |
|---|---|---|---|
| Marian it→es | ✅ ya medido | ✅ | — |
| Detector de aperturas italianas | ✅ | ✅ | — |
| Calidad de la respuesta en italiano | ✅ | ✅ | — |
| Migración Electron 28 → 43 | ✅ | ✅ | — |
| Velocidad de `small` en CPU | ⚠️ es ARM, no transfiere | ✅ **el banco correcto**: x86_64 con AVX2 | ideal |
| Ganancia real de `-ac 512` | ⚠️ | ✅ la ganancia *relativa* sí transfiere | — |
| El loopback capta otra app | ❌ | ⚠️ **da un "sí" fiable, un "no" ambiguo** | ✅ definitivo |
| **Mezcla estéreo / ruta B1** | ❌ | ❌ **imposible: una VM no tiene driver de audio real** | ✅ **único sitio** |
| Ruta CUDA / GPU | ❌ | ❌ | VM con GPU en la nube |

Dos consecuencias que conviene tener claras:

- **La VM valida en positivo, no en negativo.** Si reproduces audio dentro del invitado y
  Electron lo capta, la API funciona y es una señal que vale. Si falla, no sabrás si es la
  API o la emulación de audio.
- **B1 no se puede probar sin sus equipos**, porque Mezcla estéreo es una función del
  driver de audio físico. Es nuestra vía de respaldo más fiable y es justo la que queda a
  ciegas.

### La build de diagnóstico va primero

Antes de construir nada, se les envía una app Electron mínima que **no traduce**: ejecuta
las cuatro comprobaciones previas (§11), lanza `whisper-bench` con `small` e italiano, lee
la GPU y el modelo de CPU, y escribe un informe que devuelven por correo. Es la consola de
rendimiento que ya está en el plan, extraída y enviada antes que el producto.

Cuesta alrededor de un día y contesta **las únicas tres cosas que solo sus máquinas pueden
contestar**: si el loopback capta su videollamada, si existe Mezcla estéreo, y si `small`
aguanta con una reunión en marcha. Con eso en la mano, el resto del plan deja de apoyarse
en supuestos.

**Del cliente, y son rápidos:**
1. **Modelo exacto de GPU de cada equipo** (`dxdiag` → pestaña Pantalla). Si hay NVIDIA en
   los dos, la ruta GPU pasa a por defecto y la calidad del italiano sube bastante.
2. **Modelo exacto del Ryzen 7** del segundo equipo. Decide `small` cómodo o al límite.
   Con PowerShell, porque **`wmic` está deprecado y ya no viene en builds recientes de
   Windows 11**: `Get-CimInstance Win32_Processor | Select Name,NumberOfCores,NumberOfLogicalProcessors`
3. **20-30 minutos de audio real** de una de sus reuniones. Todas las cifras de calidad de
   este plan son de audio leído de laboratorio (FLEURS, Common Voice). Sin su audio no hay
   forma de prometer nada sobre la calidad real.

**Nuestros, antes de cerrar el presupuesto:**
4. Medir `-ac 512` de verdad, en lugar de asumir la mejora.
5. Medir `turbo` contra `medium` en CPU con audio italiano de varios minutos.
6. Contar tokens reales de italiano/español con `count_tokens` — el ratio de 2,0
   tokens/palabra es el supuesto más frágil de toda la tabla de costes.

---

## 16. Spikes: lo que se hace antes de comprometerse

Tres días y medio que convierten la mayor parte del riesgo del plan en conocimiento. Sirven
a la prioridad nº 3: la forma cara de fallar es construir tres semanas sobre un supuesto
falso.

| # | Spike | Tiempo | Qué responde | Dónde |
|---|---|---|---|---|
| 1 | **Electron 43 + `loopback` en Windows → escribir un WAV** | 1 día | **Si el producto es viable.** Unas 50 líneas | VM Windows sobre el Ubuntu i7 |
| 2 | `whisper-bench` y `whisper-server` con `small` e italiano, con una videollamada abierta | ½ día | Si la capa local existe, y **qué da `-ac 512` de verdad** | Ubuntu i7 (x86_64 con AVX2) |
| 3 | La lista de aperturas italianas contra 50 preguntas reales | 1 hora | Si el detector funciona | Cualquiera |
| 4 | El prompt de respuesta en italiano, iterado contra 20 preguntas con perfil y contexto, comparando los tres proveedores | 1 día | Si la calidad está ahí, **y qué modelo elegir** (§10) | Cualquiera |
| 5 | Migración 28 → 43 en una rama, solo para ver qué se rompe | ½ día | Para poder estimar en serio | Cualquiera |

**El spike 1 es el que manda.** Si el loopback no funciona en Windows, todo lo demás es
irrelevante y conviene saberlo el primer día. Y recuerda su límite (§15): la VM da un "sí"
fiable y un "no" ambiguo, y **no puede probar la ruta B en absoluto**.

---

## Referencias

- [Electron — `setDisplayMediaRequestHandler`](https://www.electronjs.org/docs/latest/api/session) · [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) · [issue #12365, cambio de dispositivo de salida](https://github.com/electron/electron/issues/12365)
- [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) — anclar `b5130`
- [Helsinki-NLP/opus-mt-it-es](https://huggingface.co/Helsinki-NLP/opus-mt-it-es) · [Xenova/opus-mt-it-es](https://huggingface.co/Xenova/opus-mt-it-es) (ONNX)
- [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) — *"the exact same model, except that the number of decoding layers have reduced from 32 to 4"*
- [AssemblyAI pricing](https://www.assemblyai.com/pricing) · [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- `ArtTranslator/CLAUDE.md` · `ArtTranslatorNative/README.md`
