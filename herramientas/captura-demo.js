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
 * Uso:
 *   electron-app/node_modules/.bin/electron herramientas/captura-demo.js
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

  // 1) Panel de inicio: es lo primero que se ve al abrir la app (F032, criterio 1).
  await capturar('inicio')

  // 2) Perfiles: lista vacía (sin `api`, `listarPerfiles` no se llama).
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
  await ejecutar(`
    pintarListaConversaciones([{
      archivo: 'sesion-20260919-101500-3.jsonl', ruta: '/reuniones/sesion-3.jsonl',
      inicio: '2026-09-19T10:15:00.000Z', perfil: 'Omar Avila', contexto: 'Rossi Logistica',
      frases: 21, preguntas: 3, duracionMs: 1980000, latenciaP50: 640, latenciaP95: 1350,
      costeSttUsd: 0.02475, costeSttProcedencia: 'tarifa verificada, duración medida',
      costeLlmUsd: 0.00061, costeLlmProcedencia: 'tokens medidos; tarifa de lista sin contrastar contra factura',
    }])
  `)
  await esperar(150)
  await capturar('conversaciones-coste')

  // 8c) F038: «Ver» — transcripción y preguntas con su respuesta.
  await ejecutar(`
    pintarDetalleConversacion({
      contexto: 'Rossi Logistica', perfil: 'Omar Avila',
      frases: [
        { it: 'Buongiorno a tutti, iniziamo la riunione.', es: 'Buenos días a todos, empecemos la reunión.' },
        { it: 'Il cliente ha chiesto di anticipare la consegna.', es: 'El cliente pidió adelantar la entrega.' },
      ],
      preguntas: [
        { it: 'Quanto tempo ci vuole per completare il lavoro?', es: '¿Cuánto tiempo lleva terminar el trabajo?', respuesta: 'Circa due settimane, salvo imprevisti.', manual: false },
        { it: 'Il budget copre anche la manutenzione?', es: '¿El presupuesto cubre también el mantenimiento?', respuesta: null, mensaje: 'Sin clave de IA: no habrá respuesta. Configúrala en Ajustes.' },
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

  console.log(`[captura-demo] ${n} pantallas guardadas en ${CAPTURAS_DIR}`)
  app.quit()
}

app.whenReady().then(() => {
  main().catch(err => {
    console.error('[captura-demo] fallo:', err)
    app.exit(1)
  })
})
