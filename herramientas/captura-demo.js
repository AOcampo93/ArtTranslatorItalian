/**
 * captura-demo.js
 * Arranca la app en modo demo (sin audio ni red) y guarda un PNG por
 * pantalla en `capturas/` (gitignored).
 *
 * F032: el líder revisa las pantallas nuevas —panel de inicio, perfiles,
 * cada paso de "preparar" y "conversaciones"— por captura, no en persona:
 * este equipo es macOS y la app es Electron/Windows. Sin este guion, cada
 * tarea de interfaz volvía a repetir "no se pudo correr captura-demo.js: no
 * existe todavía" en su informe (ver F033).
 *
 * Se carga `app.html` DIRECTAMENTE, sin `preload`: así `window.app` no
 * existe, la página entra sola en modo DEMO (la misma vista de ejemplo que
 * se usa para enseñar la app sin gastar una sola llamada) y no hace falta
 * ninguna clave, base de datos ni permiso de audio.
 *
 * F051: la app abre ahora en la pantalla de idioma. Este guion la captura, elige
 * italiano y recorre las pantallas de siempre; después vuelve a «Cambiar
 * idioma», elige inglés y captura el panel de inicio y el en vivo en inglés.
 * Conversaciones se pinta con una reunión de antes de la V2 (sin idioma en la
 * cabecera: sale como IT) y otra en inglés.
 *
 * F057: al final empieza otra reunión desde la propia interfaz y captura la vista en
 * vivo, que tiene que salir limpia (sin las burbujas ni las preguntas de la anterior).
 *
 * La numeración cambia cada vez que se inserta una pantalla, y las capturas de
 * la pasada anterior se quedaban al lado con el mismo nombre: por eso al empezar
 * se borran los `NN-*.png` de `capturas/`.
 *
 * Uso:
 *   electron-app/node_modules/.bin/electron herramientas/captura-demo.js
 *
 * Si el entorno trae `ELECTRON_RUN_AS_NODE` (lo ponen algunos editores y
 * terminales), Electron arranca como Node y `require('electron')` falla: se
 * ejecuta con `env -u ELECTRON_RUN_AS_NODE`.
 */

'use strict'

const path = require('path')
const fs = require('fs')
// `require('electron')` a secas no resuelve desde `herramientas/`: Node
// busca `node_modules` subiendo desde este archivo, y el único que tiene el
// paquete `electron` es `electron-app/`, que no es un ancestro de esta
// carpeta. Y requerirlo por su RUTA absoluta tampoco vale: Electron
// intercepta el módulo `electron` mirando el nombre exacto de la petición
// ("electron"), no la ruta resuelta, así que una ruta absoluta cae en el
// paquete de npm de verdad — que solo exporta la ruta al binario, no la
// API—. Se usa `Module.createRequire` anclado dentro de `electron-app/` para
// que la petición siga siendo la cadena `'electron'`.
const { createRequire } = require('module')
const requireDesdeElectronApp = createRequire(path.join(__dirname, '..', 'electron-app', 'package.json'))
const { app, BrowserWindow } = requireDesdeElectronApp('electron')

const APP_HTML = path.join(__dirname, '..', 'electron-app', 'src', 'renderer', 'app.html')
const CAPTURAS_DIR = path.join(__dirname, '..', 'capturas')

const esperar = ms => new Promise(r => setTimeout(r, ms))

async function main () {
  fs.mkdirSync(CAPTURAS_DIR, { recursive: true })
  for (const f of fs.readdirSync(CAPTURAS_DIR)) {
    if (/^\d\d-.*\.png$/.test(f)) fs.unlinkSync(path.join(CAPTURAS_DIR, f))
  }

  // `offscreen: true` para que esto corra igual en una máquina sin sesión
  // gráfica (el caso normal de quien construye esto: macOS, en un
  // contenedor). `capturePage()` funciona igual sobre un `BrowserWindow`
  // offscreen.
  // F035: 440×900 y no 1120×780 — la app ya no es una ventana ancha de dos
  // columnas, es angosta y alta, pegada al borde de la pantalla. Las
  // capturas tienen que enseñar la app tal como el cliente la va a ver, no
  // la geometría vieja.
  const ventana = new BrowserWindow({
    width: 440,
    height: 900,
    show: false,
    backgroundColor: '#0B0F14',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  })

  await ventana.loadFile(APP_HTML)
  // Un respiro para que el primer pintado (fuentes, `revisarListo()`) asiente.
  await esperar(300)

  let n = 0
  async function capturar (nombre) {
    n += 1
    const imagen = await ventana.webContents.capturePage()
    const archivo = path.join(CAPTURAS_DIR, `${String(n).padStart(2, '0')}-${nombre}.png`)
    fs.writeFileSync(archivo, imagen.toPNG())
    console.log('[captura]', archivo)
  }

  const ejecutar = codigo => ventana.webContents.executeJavaScript(codigo, true)

  // 0) F051: lo primero que se ve al abrir la app es la pantalla de idioma, y solo ella.
  await capturar('idioma')

  // 1) Panel de inicio, con italiano elegido: «IT → ES» y «Cambiar idioma».
  await ejecutar(`document.getElementById('elegir-it').click()`)
  await esperar(150)
  await capturar('inicio')

  // 2) Perfiles: lista vacía (sin `api`, `listarPerfiles` no se llama).
  // F042: el formulario arranca OCULTO, detrás de «+ Agregar perfil».
  await ejecutar(`document.getElementById('irPerfiles').click()`)
  await esperar(150)
  await capturar('perfiles')
  await ejecutar(`document.getElementById('volverInicioPerfiles').click()`)

  // 3) Preparar, paso 1 — el perfil.
  await ejecutar(`document.getElementById('irNueva').click()`)
  await esperar(150)
  await capturar('preparar-paso1-perfil')

  // 4) Paso 2 — el contexto de la reunión.
  await ejecutar(`
    document.getElementById('pNombre').value = 'Omar Avila'
    document.getElementById('pNombre').dispatchEvent(new Event('input'))
    document.getElementById('btnSiguiente1').click()
  `)
  await esperar(150)
  await capturar('preparar-paso2-contexto')

  // 5) Paso 3 — la comprobación (se salta con "Sin contexto", que también avanza).
  await ejecutar(`document.getElementById('btnSinContexto').click()`)
  await esperar(150)
  await capturar('preparar-paso3-comprobacion')

  // 5b) F045: tras la primera comprobación, el destaque (verde) pasa de
  // «Comprobar» a «Siguiente», y «Comprobar otra vez» queda secundario.
  await ejecutar(`document.getElementById('btnProbar').click()`)
  await esperar(1100)
  await capturar('preparar-paso3-tras-comprobar')

  // 6) Paso final — "Escuchar" listo, tras Saltar la comprobación.
  await ejecutar(`
    document.getElementById('btnSaltar').click()
    document.getElementById('btnSiguiente3').click()
  `)
  await esperar(150)
  await capturar('preparar-paso4-listo')

  // 7) En vivo (modo demo): dispara la conversación de ejemplo con burbujas y preguntas.
  await ejecutar(`document.getElementById('btnEscuchar').click()`)
  await esperar(2200)
  await capturar('envivo-demo')

  // 7a) F045: «de qué se está hablando» solo aparece escuchando, dentro de
  // la conversación, como una tira plegada — y se expande al pulsarla,
  // mostrando el contenido completo hasta abajo. `pintarContexto()` se
  // llama directo (igual que `pintarListaConversaciones` más abajo): esperar
  // a que el guion de la demo llegue ahí solo tardaría bastante más.
  await ejecutar(`pintarContexto('Se negocia adelantar una entrega a la próxima semana. Hay dudas sobre '
    + 'los plazos de integración con el ERP y sobre si el presupuesto cubre el mantenimiento. Falta '
    + 'confirmar si el equipo de desarrollo ya fue avisado de los nuevos plazos y si el cliente acepta '
    + 'el cambio de alcance para la fase 2.')`)
  await esperar(150)
  await capturar('envivo-demo-contexto-plegado')
  await ejecutar(`document.getElementById('contexto').querySelector('summary').click()`)
  await esperar(150)
  await capturar('envivo-demo-contexto-expandido')

  // 7b) F042: la misma pantalla, ensanchada a 640 px — el umbral bajó de
  // 900 a 600, así que 640 es justo el ancho que antes se quedaba en una
  // sola columna y ahora ya tiene que verse en dos (traducción a la
  // izquierda, preguntas a la derecha). Se vuelve a 440 px después, porque
  // el resto del guion asume la ventana angosta de F035.
  ventana.setSize(640, 900)
  await esperar(200)
  await capturar('envivo-demo-ancho')
  ventana.setSize(440, 900)
  await esperar(200)

  // 8) Conversaciones (acceso a reuniones anteriores).
  await ejecutar(`document.getElementById('btnParar')?.click()`)
  await esperar(400)   // F032: vuelta automática al panel de inicio, tras el resumen
  await ejecutar(`document.getElementById('irConversaciones').click()`)
  await esperar(150)
  await capturar('conversaciones')

  // 8b) F038: sin `api` (modo demo) la lista está vacía, así que se pinta con
  // datos de ejemplo llamando a la función directamente — es lo único que
  // enseña la fila de coste/latencia y los botones «Ver»/«Borrar» sin tener
  // que grabar una reunión de verdad.
  // F051: dos reuniones —una de antes de la V2, SIN el campo `idioma` en la
  // cabecera (sale como IT), y una en inglés—, para ver las dos etiquetas.
  await ejecutar(`
    pintarListaConversaciones([{
      archivo: 'sesion-20260919-101500-3.jsonl', ruta: '/reuniones/sesion-3.jsonl',
      inicio: '2026-09-19T10:15:00.000Z', perfil: 'Omar Avila', contexto: 'Rossi Logistica',
      frases: 21, preguntas: 3, duracionMs: 1980000, latenciaP50: 640, latenciaP95: 1350,
      costeSttUsd: 0.02475, costeSttProcedencia: 'tarifa verificada, duración medida',
      costeLlmUsd: 0.00061, costeLlmProcedencia: 'tokens medidos; tarifa de lista sin contrastar contra factura',
    }, {
      archivo: 'sesion-20261008-091500-4.jsonl', ruta: '/reuniones/sesion-4.jsonl',
      inicio: '2026-10-08T09:15:00.000Z', perfil: 'Omar Avila', contexto: 'Acme — kickoff', idioma: 'en',
      frases: 34, preguntas: 5, duracionMs: 2640000, latenciaP50: 590, latenciaP95: 1210,
      costeSttUsd: 0.033, costeSttProcedencia: 'tarifa verificada, duración medida',
      costeLlmUsd: 0.00094, costeLlmProcedencia: 'tokens medidos; tarifa de lista sin contrastar contra factura',
    }])
  `)
  await esperar(150)
  await capturar('conversaciones-coste')

  // 8c) F038: «Ver» — transcripción y preguntas con su respuesta. F051: la de
  // inglés, que lleva su etiqueta EN al lado del título.
  await ejecutar(`
    pintarDetalleConversacion({
      contexto: 'Acme — kickoff', perfil: 'Omar Avila', idioma: 'en',
      frases: [
        { it: "Good morning everyone, let's get started.", es: 'Buenos días a todos, empecemos.' },
        { it: 'The client asked us to bring the delivery forward.', es: 'El cliente nos pidió adelantar la entrega.' },
      ],
      preguntas: [
        { it: 'How long will it take to finish the work?', es: '¿Cuánto tiempo te llevará terminar el trabajo?', respuesta: 'About two weeks, barring surprises.', manual: false },
        { it: 'Does the budget also cover maintenance?', es: '¿El presupuesto también cubre el mantenimiento?', respuesta: null, mensaje: 'Sin clave de IA: no habrá respuesta. Configúrala en Ajustes.' },
      ],
    })
  `)
  await esperar(150)
  await capturar('conversaciones-ver')

  await ejecutar(`document.getElementById('volverInicioConversaciones').click()`)

  // 9) Ajustes.
  await ejecutar(`document.getElementById('irAjustes').click()`)
  await esperar(150)
  await capturar('ajustes')
  await ejecutar(`document.getElementById('btnCerrarAjustes').click()`)

  // 10) F051: «Cambiar idioma» vuelve a la pantalla de idioma, con el último
  // elegido (italiano) marcado y «Último elegido» bajo su botón.
  await ejecutar(`document.getElementById('cambiarIdioma').click()`)
  await esperar(150)
  await capturar('idioma-marcado')

  // 11) Se elige inglés: el panel de inicio dice «EN → ES» y el subtítulo, «del inglés».
  await ejecutar(`document.getElementById('elegir-en').click()`)
  await esperar(150)
  await capturar('inicio-en')

  // 12) El en vivo en inglés, con `app.html#demo-en`: la página nueva y directa a
  // la vista en vivo, con la reunión de ejemplo en inglés. Se recarga porque el
  // `#hash` solo se lee al cargar la página (empezar otra reunión desde la propia
  // pantalla ya limpia la vista, F057). La demo tarda unos 13 s en llegar a la
  // primera pregunta con su respuesta sugerida, en inglés.
  // Pasar por `about:blank` es lo que obliga a recargar: cambiar solo el `#hash`
  // de la misma página es una navegación interna y el script no volvería a correr.
  await ventana.loadURL('about:blank')
  await ventana.loadFile(APP_HTML, { hash: 'demo-en' })
  await esperar(13500)
  await capturar('envivo-en')

  // 13) F057: otra reunión en la misma ejecución, desde la propia interfaz. La demo
  // de arriba sigue a medias y no tiene otra forma de pararse que dejar correr sus
  // temporizadores, así que se cancelan todos: sin eso pintaría sus burbujas en la
  // reunión nueva y la captura enseñaría la demo, no la vista. Al empezar, la vista
  // en vivo tiene que salir limpia: sin las burbujas ni la pregunta de la anterior.
  const pararTemporizadores = `for (let t = setTimeout(() => {}, 0); t >= 0; t--) { clearTimeout(t); clearInterval(t) }`
  await ejecutar(`${pararTemporizadores}; document.getElementById('btnParar').click()`)
  await esperar(500)   // la vuelta automática al panel de inicio, tras el resumen
  await ejecutar(`document.getElementById('irNueva').click()`)
  await esperar(150)
  await ejecutar(`document.getElementById('btnSaltar').click()`)
  await ejecutar(`document.getElementById('btnEscuchar').click(); ${pararTemporizadores}`)
  await esperar(150)
  await capturar('envivo-segunda-reunion')

  console.log(`[captura-demo] ${n} pantallas guardadas en ${CAPTURAS_DIR}`)
  app.quit()
}

app.whenReady().then(() => {
  main().catch(err => {
    console.error('[captura-demo] fallo:', err)
    app.exit(1)
  })
})
