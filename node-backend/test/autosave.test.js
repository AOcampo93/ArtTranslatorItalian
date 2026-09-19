/**
 * Pruebas del autoguardado.
 *
 * La prueba que de verdad importa aquí es la última: **matar el proceso a
 * mitad de sesión y comprobar que lo guardado sigue leyéndose.** Todo lo demás
 * es plomería; eso es la razón de existir del módulo.
 */

'use strict'

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { Autosave } = require('../src/autosave')

let dir

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autosave-')) })
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

describe('escritura', () => {
  test('la frase está en disco en cuanto se escribe, sin cerrar nada', () => {
    // Es el punto del módulo: no esperar al final. Si hubiera que cerrar para
    // que se guardara, un crash seguiría perdiendo la reunión.
    const a = new Autosave({ directorio: dir, idSesion: 'prueba' })
    a.guardarFrase({ it: 'Buongiorno', es: 'Buenos días', msWhisper: 100, msMarian: 50, msTotal: 150 })

    const { entradas } = Autosave.leer(a.ruta)
    assert.strictEqual(entradas.length, 1)
    assert.strictEqual(entradas[0].it, 'Buongiorno')
    assert.ok(entradas[0].t, 'cada entrada lleva su marca de tiempo')
    a.cerrar()
  })

  test('mantiene el orden y distingue los tipos', () => {
    const a = new Autosave({ directorio: dir, idSesion: 'prueba' })
    a.guardarCabecera({ perfil: { nombre: 'Omar' }, contexto: { nombre: 'Negociación' } })
    a.guardarFrase({ it: 'uno', es: 'uno' })
    a.guardarPregunta({ it: 'Che ne pensi?', es: '¿Qué opinas?', respuesta: 'Penso che sì' })
    a.guardarFrase({ it: 'dos', es: 'dos' })
    a.cerrar()

    const { entradas } = Autosave.leer(a.ruta)
    assert.deepStrictEqual(entradas.map(e => e.tipo),
      ['cabecera', 'frase', 'pregunta', 'frase'])
    assert.strictEqual(entradas[0].perfil.nombre, 'Omar')
    assert.strictEqual(entradas[2].respuesta, 'Penso che sì')
  })

  test('reabrir la misma sesión añade, no reemplaza', () => {
    // Mismo `inicio` explícito en las dos: es el caso de una reanudación
    // deliberada de la MISMA sesión, así que las dos tienen que caer en el
    // mismo archivo a propósito. Sin fijarlo, el nombre (que ahora lleva
    // hasta los segundos, F030 ronda 2) dependería de en qué segundo corre
    // cada línea y la prueba sería intermitente sin que nada estuviera roto.
    const inicio = '2026-05-01T10:00:00'
    const a = new Autosave({ directorio: dir, idSesion: 'misma', inicio })
    a.guardarFrase({ it: 'primera', es: 'primera' })
    a.cerrar()

    const b = new Autosave({ directorio: dir, idSesion: 'misma', inicio })
    b.guardarFrase({ it: 'segunda', es: 'segunda' })
    b.cerrar()

    const { entradas } = Autosave.leer(b.ruta)
    assert.strictEqual(entradas.length, 2, 'la primera frase no debe perderse')
  })

  test('escribir después de cerrar reabre y añade, y `abierto` lo dice', () => {
    // Es la mitad del arreglo de F022: una frase que vuelve de traducir cuando
    // la reunión ya se cerró tiene que acabar en disco igual. Y quien la
    // escribe necesita saber si el archivo estaba cerrado, para volver a
    // cerrarlo: nadie más va a hacerlo y un descriptor por sesión terminada se
    // acumula.
    const a = new Autosave({ directorio: dir, idSesion: 'tardia' })
    assert.strictEqual(a.abierto, false, 'recién construido no abre nada')

    a.escribir({ tipo: 'frase', it: 'prima' })
    assert.strictEqual(a.abierto, true)
    a.cerrar()
    assert.strictEqual(a.abierto, false)

    a.escribir({ tipo: 'frase', it: 'tardia' })     // la frase que llega tarde
    assert.strictEqual(a.abierto, true, 'escribir tiene que reabrir el archivo')
    a.cerrar()

    const { entradas, truncadas } = Autosave.leer(a.ruta)
    assert.deepStrictEqual(entradas.map(e => e.it), ['prima', 'tardia'],
      'la frase tardía se añade al final: no reemplaza y no corrompe lo anterior')
    assert.strictEqual(truncadas, 0)
    assert.strictEqual(a.lineasEscritas, 2, 'y se cuenta como línea escrita')
  })
})

describe('tolerancia a una línea truncada', () => {
  test('una línea a medias no invalida lo anterior', () => {
    // Es exactamente lo que deja un cierre a media escritura.
    const a = new Autosave({ directorio: dir, idSesion: 'roto' })
    a.guardarFrase({ it: 'buena uno', es: 'buena uno' })
    a.guardarFrase({ it: 'buena dos', es: 'buena dos' })
    a.cerrar()
    fs.appendFileSync(a.ruta, '{"tipo":"frase","it":"a med')  // sin cerrar el JSON

    const { entradas, truncadas } = Autosave.leer(a.ruta)
    assert.strictEqual(entradas.length, 2, 'las dos buenas deben sobrevivir')
    assert.strictEqual(truncadas, 1, 'y la mala debe contarse, no ignorarse en silencio')
  })

  test('un archivo que no existe no revienta', () => {
    const r = Autosave.leer(path.join(dir, 'no-existe.jsonl'))
    assert.deepStrictEqual(r, { entradas: [], truncadas: 0 })
  })
})

describe('sobrevive a que maten el proceso', () => {
  test('lo escrito antes del kill se puede leer después', () => {
    // LA prueba del módulo. Se lanza un proceso hijo que escribe cinco frases
    // y se suicida SIN cerrar el archivo, como haría un crash real.
    // `inicio` fijo y explícito: el nombre del archivo ahora lleva la fecha y
    // hora de arranque (F030), y sin fijarla la prueba tendría que adivinar
    // el minuto exacto en que corrió el proceso hijo.
    const guion = `
      const { Autosave } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'autosave'))})
      const a = new Autosave({ directorio: ${JSON.stringify(dir)}, idSesion: 'matado', inicio: '2026-01-01T09:30:00' })
      for (let i = 1; i <= 5; i++) a.guardarFrase({ it: 'frase ' + i, es: 'frase ' + i })
      process.kill(process.pid, 'SIGKILL')   // sin cerrar: como un crash
    `
    try {
      execFileSync(process.execPath, ['-e', guion], { stdio: 'ignore' })
    } catch { /* el kill hace que salga con error, es lo esperado */ }

    const marca = new Date('2026-01-01T09:30:00')
    const p = n => String(n).padStart(2, '0')
    const nombre = `sesion-${marca.getFullYear()}${p(marca.getMonth() + 1)}${p(marca.getDate())}`
                 + `-${p(marca.getHours())}${p(marca.getMinutes())}${p(marca.getSeconds())}-matado.jsonl`
    const ruta = path.join(dir, nombre)
    assert.ok(fs.existsSync(ruta), 'el archivo debe existir aunque nadie lo cerrara')

    const { entradas } = Autosave.leer(ruta)
    assert.strictEqual(entradas.length, 5, `solo sobrevivieron ${entradas.length} de 5 frases`)
    assert.strictEqual(entradas[4].it, 'frase 5', 'hasta la última debe estar')
  })
})

describe('listado de sesiones', () => {
  test('las devuelve de la más reciente a la más antigua', () => {
    // `inicio` explícito y distinto para cada una: con F030 el nombre lleva
    // la hora de arranque, y sin fijarla las tres se construyen tan seguidas
    // que podrían compartir marca — el orden dependería entonces del `id`,
    // no de la fecha, y la prueba dejaría de probar lo que dice probar.
    for (const id of ['2026-01-01', '2026-06-15', '2026-03-10']) {
      const a = new Autosave({ directorio: dir, idSesion: id, inicio: `${id}T00:00:00` })
      a.guardarFrase({ it: 'x', es: 'x' })
      a.cerrar()
    }
    const lista = Autosave.listar(dir)
    assert.strictEqual(lista.length, 3)
    assert.match(lista[0].archivo, /2026-06-15/, 'la más reciente primero')
    assert.ok(lista.every(s => s.tamano > 0))
  })

  test('un directorio inexistente devuelve lista vacía', () => {
    assert.deepStrictEqual(Autosave.listar(path.join(dir, 'nada')), [])
  })
})

/**
 * F030 — MEDIDO en los archivos del cliente: `sesion-1.jsonl` fundió 21
 * frases del 16-09 (v0.2) con 6 del 17-09 (v0.4) porque el nombre era
 * `sesion-<idSesion>.jsonl` y `idSesion` (autoincremento de `db.js`) volvió a
 * empezar en 1. Estas pruebas reproducen exactamente esa condición: mismo
 * `idSesion`, dos arranques distintos.
 */
describe('F030 — dos reuniones no comparten archivo aunque el id se repita', () => {
  test('nombre nuevo: id repetido en dos arranques distintos → dos archivos, sin mezclar', () => {
    // El mismo `idSesion: '1'` que fundió las reuniones del cliente, pero con
    // horas de arranque distintas — que es justo lo que la base de datos NO
    // sabía distinguir y el nombre de archivo ahora sí.
    const a = new Autosave({ directorio: dir, idSesion: '1', inicio: '2026-09-16T10:00:00' })
    a.guardarFrase({ it: 'del dieciseis', es: 'del dieciseis' })
    a.cerrar()

    const b = new Autosave({ directorio: dir, idSesion: '1', inicio: '2026-09-17T09:00:00' })
    b.guardarFrase({ it: 'del diecisiete', es: 'del diecisiete' })
    b.cerrar()

    assert.notStrictEqual(a.ruta, b.ruta, 'con el id repetido, la ruta debe ser distinta')

    const dieciseis = Autosave.leer(a.ruta).entradas
    const diecisiete = Autosave.leer(b.ruta).entradas
    assert.deepStrictEqual(dieciseis.map(e => e.it), ['del dieciseis'],
      'la reunión del 16 no debe llevar frases de la del 17')
    assert.deepStrictEqual(diecisiete.map(e => e.it), ['del diecisiete'],
      'la reunión del 17 no debe llevar frases de la del 16')
  })

  test('así era el fallo: con el nombre de antes (sin marca de tiempo), el id repetido SÍ mezcla', () => {
    // Ronda 2: esta prueba NO es una mutación de `autosave.js` — no llama a
    // nada de producción, fabrica el archivo a mano con `fs` y solo ejerce
    // `Autosave.leer()`. El revisor lo verificó: con `this.ruta` revertido al
    // esquema viejo en una copia aislada, esta prueba sigue en verde (no cae
    // con la mutación), así que llamarla «mutación» era mentir sobre qué
    // protege. Lo que SÍ documenta, con datos reales: el esquema
    // `sesion-<id>.jsonl` (el de antes de F030) fusiona dos reuniones con el
    // mismo id — reproduce tal cual `sesion-1.jsonl` del cliente.
    // La mutación real del criterio 1 es la prueba de arriba («nombre nuevo:
    // id repetido…»): esa SÍ cae si se revierte `marcaLocal()` de
    // `autosave.js` (junto con otras tres, ver `impl_F030.md`, Ronda 2).
    const rutaVieja = path.join(dir, 'sesion-1.jsonl')
    fs.writeFileSync(rutaVieja, JSON.stringify({ t: '2026-09-16T10:00:00.000Z', tipo: 'frase', it: 'del dieciseis' }) + '\n')
    fs.appendFileSync(rutaVieja, JSON.stringify({ t: '2026-09-17T09:00:00.000Z', tipo: 'frase', it: 'del diecisiete' }) + '\n')

    const { entradas } = Autosave.leer(rutaVieja)
    assert.strictEqual(entradas.length, 2, 'con el nombre viejo, las dos reuniones caen en el mismo archivo')
  })

  test('el nombre nuevo trae la fecha y hora de arranque, legible sin abrir el archivo', () => {
    const a = new Autosave({ directorio: dir, idSesion: '42', inicio: '2026-09-19T08:05:07' })
    assert.match(path.basename(a.ruta), /^sesion-20260919-080507-42\.jsonl$/)
  })

  test('listar() encuentra tanto el nombre nuevo como el viejo sesion-<id>.jsonl', () => {
    const nuevo = new Autosave({ directorio: dir, idSesion: '9', inicio: '2026-09-19T08:05:07' })
    nuevo.guardarFrase({ it: 'x', es: 'x' })
    nuevo.cerrar()
    // El formato de antes de F030, simulado a mano: nadie lo va a volver a
    // producir, pero las reuniones ya grabadas con él siguen en disco.
    fs.writeFileSync(path.join(dir, 'sesion-8.jsonl'),
      JSON.stringify({ t: '2026-01-01T00:00:00.000Z', tipo: 'frase', it: 'vieja' }) + '\n')

    const archivos = Autosave.listar(dir).map(s => s.archivo)
    assert.ok(archivos.includes('sesion-8.jsonl'), 'el archivo con el nombre viejo sigue apareciendo')
    assert.ok(archivos.some(f => /^sesion-20260919-080507-9\.jsonl$/.test(f)), 'y el nuevo también')
  })
})

describe('F030 — cabecera: de qué reunión y versión es un archivo', () => {
  test('guardarCabecera lleva versión, inicio e id, y no cuenta como frase', () => {
    const a = new Autosave({ directorio: dir, idSesion: '3', inicio: '2026-09-19T08:00:00', version: '0.5.0' })
    a.guardarCabecera({ perfil: { nombre: 'Omar' }, contexto: null })
    a.guardarFrase({ it: 'uno', es: 'uno' })
    a.guardarFrase({ it: 'dos', es: 'dos' })
    a.cerrar()

    const { entradas } = Autosave.leer(a.ruta)
    assert.strictEqual(entradas[0].tipo, 'cabecera', 'la cabecera va primera')
    assert.strictEqual(entradas[0].version, '0.5.0')
    assert.strictEqual(entradas[0].id, '3')
    assert.strictEqual(entradas[0].inicio, new Date('2026-09-19T08:00:00').toISOString())

    // Mutación: si alguien contara las líneas del archivo como frases sin
    // filtrar por tipo, esta cuenta saldría en 3 en vez de 2.
    const frases = entradas.filter(e => e.tipo === 'frase')
    assert.strictEqual(frases.length, 2, 'la cabecera no debe contarse como frase')
  })
})

describe('F030 — detectarMezcla: saber si un archivo ya viene fundido', () => {
  test('un archivo limpio, con una sola cabecera, no se marca', () => {
    const a = new Autosave({ directorio: dir, idSesion: '1' })
    a.guardarCabecera({})
    a.guardarFrase({ it: 'x', es: 'x' })
    a.cerrar()

    assert.deepStrictEqual(Autosave.detectarMezcla(a.ruta), { mezclado: false, motivo: null })
  })

  test('cabecera + primera frase 45 min después → mezclado:false (la cabecera no cuenta para el hueco)', () => {
    // Ronda 3, motivo 1 de `review_F030_correccion.md` (ronda 2): el bucle
    // medía el hueco TAMBIÉN entre la cabecera —escrita al ABRIR la
    // sesión, antes de que nadie hable— y la primera frase. Una reunión
    // SANA donde el usuario abre la app 45 min antes de que arranque la
    // conversación (o la llamada arranca tarde) salía `mezclado: true` en
    // falso, de forma determinista: el revisor lo midió con un guion
    // desechable. La cabecera no es una pausa de la conversación, así que
    // no debe alimentar la señal del hueco.
    const ruta = path.join(dir, 'sesion-1.jsonl')
    fs.writeFileSync(ruta, JSON.stringify({ t: '2026-09-19T09:00:00.000Z', tipo: 'cabecera', id: '1' }) + '\n')
    fs.appendFileSync(ruta, JSON.stringify({ t: '2026-09-19T09:45:00.000Z', tipo: 'frase', it: 'primera frase' }) + '\n')

    assert.deepStrictEqual(Autosave.detectarMezcla(ruta), { mezclado: false, motivo: null })
  })

  test('dos cabeceras en el mismo archivo (Autosave de verdad) se detectan', () => {
    // Reproduce el fallo histórico con la clase real: dos sesiones —cada una
    // con su propia cabecera— forzadas a compartir la MISMA ruta, que es
    // justo lo que pasaba antes del arreglo cuando el id se repetía.
    const a = new Autosave({ directorio: dir, idSesion: '5', inicio: '2026-09-16T10:00:00' })
    a.guardarCabecera({ perfil: { nombre: 'sesión de antes' } })
    a.guardarFrase({ it: 'del dieciseis', es: 'del dieciseis' })
    a.cerrar()

    const b = new Autosave({ directorio: dir, idSesion: '5', inicio: '2026-09-16T10:00:00' })
    b.guardarCabecera({ perfil: { nombre: 'sesión de después' } })
    b.guardarFrase({ it: 'tambien del dieciseis', es: 'tambien del dieciseis' })
    b.cerrar()

    assert.strictEqual(a.ruta, b.ruta, 'la prueba solo vale si de verdad comparten archivo')
    const r = Autosave.detectarMezcla(a.ruta)
    assert.strictEqual(r.mezclado, true)
    assert.match(r.motivo, /2 cabeceras/)
  })

  test('un archivo viejo sin cabecera, con las líneas fuera de orden, se detecta', () => {
    // Ronda 2: esto NO es el caso medido en el cliente (ver la prueba de
    // abajo, «el archivo real del cliente…») — con escritura `append` el `t`
    // SIEMPRE avanza, nunca retrocede, así que esta señal no podía cazar esa
    // mezcla y el comentario que lo afirmaba estaba equivocado (motivo 1 de
    // la revisión de corrección). Lo que sí cubre esta señal es un archivo
    // que se escribió, o se corrompió, fuera de orden — líneas fuera de su
    // sitio cronológico —, que sigue siendo sospechoso aunque no sea EL
    // fallo de F030.
    const ruta = path.join(dir, 'sesion-1.jsonl')
    fs.writeFileSync(ruta, JSON.stringify({ t: '2026-09-17T09:00:00.000Z', tipo: 'frase', it: 'tarde' }) + '\n')
    fs.appendFileSync(ruta, JSON.stringify({ t: '2026-09-16T10:00:00.000Z', tipo: 'frase', it: 'temprano, pero escrito después' }) + '\n')

    const r = Autosave.detectarMezcla(ruta)
    assert.strictEqual(r.mezclado, true)
    assert.match(r.motivo, /retrocede/)
  })

  test('el archivo real del cliente (21 frases del 16-09 + 6 del 17-09, cronológico, sin cabecera) se detecta', () => {
    // Ronda 2, motivo 1 de la revisión de corrección: reproduce la FORMA
    // exacta de `sesion-1.jsonl` MEDIDA en el cliente — 21 frases del 16-09
    // (v0.2, sin `msTranscribir`) seguidas de 6 del 17-09 (v0.4, con
    // `msTranscribir`), escritas en el orden en que de verdad ocurrieron
    // (`t` avanza todo el rato, como deja `append`). Con solo la señal de
    // «el reloj retrocede» esto pasaba por limpio — el revisor lo verificó
    // con un guion desechable — porque esa condición nunca es cierta para
    // dos reuniones fundidas por `append`. La señal del hueco es la que
    // tiene que cazarlo.
    const ruta = path.join(dir, 'sesion-1.jsonl')
    const lineas = []
    for (let i = 0; i < 21; i++) {
      lineas.push(JSON.stringify({
        t: `2026-09-16T10:${String(i).padStart(2, '0')}:00.000Z`,
        tipo: 'frase', it: `frase del 16, número ${i}`,
      }))
    }
    for (let i = 0; i < 6; i++) {
      lineas.push(JSON.stringify({
        t: `2026-09-17T09:${String(i).padStart(2, '0')}:00.000Z`,
        tipo: 'frase', it: `frase del 17, número ${i}`, msTranscribir: 300,
      }))
    }
    fs.writeFileSync(ruta, lineas.join('\n') + '\n')

    const r = Autosave.detectarMezcla(ruta)
    assert.strictEqual(r.mezclado, true,
      'el ÚNICO archivo mezclado que existe de verdad tiene que detectarse')
    assert.match(r.motivo, /hueco/)
  })

  test('un hueco normal entre frases (unos minutos, dentro de una misma reunión) no se marca', () => {
    // El contrapunto de la prueba de arriba: no cualquier hueco es sospechoso.
    const ruta = path.join(dir, 'sesion-1.jsonl')
    fs.writeFileSync(ruta, JSON.stringify({ t: '2026-09-19T10:00:00.000Z', tipo: 'frase', it: 'uno' }) + '\n')
    fs.appendFileSync(ruta, JSON.stringify({ t: '2026-09-19T10:05:00.000Z', tipo: 'frase', it: 'dos' }) + '\n')

    assert.deepStrictEqual(Autosave.detectarMezcla(ruta), { mezclado: false, motivo: null })
  })

  test('mutación: quitar la comprobación de cabeceras deja pasar el archivo fundido', () => {
    // Fija el comportamiento que `detectarMezcla` debe tener: si se le quita
    // la rama de `cabeceras.length > 1`, este archivo (dos cabeceras, reloj
    // que SÍ avanza, huecos pequeños que no disparan la señal del hueco) deja
    // de detectarse y la prueba anterior con dos cabeceras es la que cae.
    // Ronda 2: los huecos se acortaron a minutos, todos dentro del mismo día
    // — antes llegaban a las 23 horas y la nueva señal del hueco los habría
    // cazado igual, sin ejercer de verdad la rama de las cabeceras que esta
    // prueba dice proteger.
    const ruta = path.join(dir, 'sesion-2.jsonl')
    fs.writeFileSync(ruta, JSON.stringify({ t: '2026-09-16T10:00:00.000Z', tipo: 'cabecera', id: '2' }) + '\n')
    fs.appendFileSync(ruta, JSON.stringify({ t: '2026-09-16T10:00:01.000Z', tipo: 'frase', it: 'a' }) + '\n')
    fs.appendFileSync(ruta, JSON.stringify({ t: '2026-09-16T10:05:00.000Z', tipo: 'cabecera', id: '2' }) + '\n')
    fs.appendFileSync(ruta, JSON.stringify({ t: '2026-09-16T10:05:01.000Z', tipo: 'frase', it: 'b' }) + '\n')

    assert.strictEqual(Autosave.detectarMezcla(ruta).mezclado, true)
  })
})
