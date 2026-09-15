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
    const a = new Autosave({ directorio: dir, idSesion: 'misma' })
    a.guardarFrase({ it: 'primera', es: 'primera' })
    a.cerrar()

    const b = new Autosave({ directorio: dir, idSesion: 'misma' })
    b.guardarFrase({ it: 'segunda', es: 'segunda' })
    b.cerrar()

    const { entradas } = Autosave.leer(b.ruta)
    assert.strictEqual(entradas.length, 2, 'la primera frase no debe perderse')
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
    const guion = `
      const { Autosave } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'autosave'))})
      const a = new Autosave({ directorio: ${JSON.stringify(dir)}, idSesion: 'matado' })
      for (let i = 1; i <= 5; i++) a.guardarFrase({ it: 'frase ' + i, es: 'frase ' + i })
      process.kill(process.pid, 'SIGKILL')   // sin cerrar: como un crash
    `
    try {
      execFileSync(process.execPath, ['-e', guion], { stdio: 'ignore' })
    } catch { /* el kill hace que salga con error, es lo esperado */ }

    const ruta = path.join(dir, 'sesion-matado.jsonl')
    assert.ok(fs.existsSync(ruta), 'el archivo debe existir aunque nadie lo cerrara')

    const { entradas } = Autosave.leer(ruta)
    assert.strictEqual(entradas.length, 5, `solo sobrevivieron ${entradas.length} de 5 frases`)
    assert.strictEqual(entradas[4].it, 'frase 5', 'hasta la última debe estar')
  })
})

describe('listado de sesiones', () => {
  test('las devuelve de la más reciente a la más antigua', () => {
    for (const id of ['2026-01-01', '2026-06-15', '2026-03-10']) {
      const a = new Autosave({ directorio: dir, idSesion: id })
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
