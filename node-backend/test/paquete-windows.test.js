/**
 * El paquete de Windows no puede depender de DLL que no lleva.
 *
 * Esto sale de un fallo ya pagado: el paquete se envió a la máquina virtual con
 * la lista de verificación entera en verde y `whisper-server.exe` murió con
 * `0xC0000135` (STATUS_DLL_NOT_FOUND). La comprobación de entonces miraba que
 * `vc_redist.x64.exe` estuviera **incluido** — pero incluir un instalador no
 * instala nada, y nadie lo ejecutó.
 *
 * La lección no es "acordarse de ejecutarlo": es que la comprobación medía lo
 * que era fácil de medir en vez de lo que importaba. Aquí se lee la tabla de
 * importaciones de cada binario y se compara con lo que hay al lado, que es la
 * pregunta de verdad.
 *
 * Se salta si no hay `bin-win/`: está en .gitignore y un clon limpio no la
 * tiene hasta ejecutar `herramientas/preparar-bin-win.sh`.
 */

'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const dep = require('../../herramientas/dependencias-windows')
const BIN = path.join(__dirname, '..', '..', 'bin-win')
const hayBinarios = fs.existsSync(path.join(BIN, 'whisper-server.exe'))

describe('dependencias del paquete de Windows', { skip: hayBinarios ? false : 'no hay bin-win/' }, () => {
  test('ninguna DLL queda sin resolver', () => {
    const r = dep.revisarCarpeta(BIN)
    assert.ok(r.completo,
      `faltan ${r.faltan.length} DLL: ${r.faltan.join(', ')}\n` +
      'Ejecuta: herramientas/preparar-bin-win.sh')
  })

  test('el runtime de MSVC viaja junto al binario, no como instalador', () => {
    // Las cuatro se despliegan en local, sin permisos de administrador y sin
    // ningún paso que el cliente tenga que entender. VCOMP140 es la de OpenMP
    // y la piden las diez variantes de ggml-cpu-*: es la que más fácil se
    // olvida, porque no aparece en las listas típicas de "las DLL de MSVC".
    for (const n of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll']) {
      assert.ok(fs.existsSync(path.join(BIN, n)), `falta ${n}`)
    }
  })

  test('siguen las nueve variantes de ggml-cpu junto a ggml-base', () => {
    // Si el empaquetado las dispersa, el despacho por microarquitectura cae a
    // la peor variante SIN dar ningún error: la app va lenta y nadie sabe por qué.
    const cpu = fs.readdirSync(BIN).filter(n => /^ggml-cpu-.*\.dll$/i.test(n))
    assert.strictEqual(cpu.length, 9, `hay ${cpu.length} variantes ggml-cpu-*, deben ser 9`)
    assert.ok(fs.existsSync(path.join(BIN, 'ggml-base.dll')))
  })
})

describe('el lector de PE', () => {
  test('rechaza un archivo que no es un ejecutable de Windows', () => {
    assert.throws(() => dep.importaciones(__filename), /no es un ejecutable de Windows/)
  })

  test('los API sets no se buscan en disco', () => {
    // api-ms-win-* no son archivos: el cargador de Windows los redirige a la
    // DLL que toque. Buscarlos al lado del binario daría un falso negativo.
    assert.ok(dep.esDelSistema('api-ms-win-crt-runtime-l1-1-0.dll'))
    assert.ok(dep.esDelSistema('KERNEL32.dll'))
    assert.ok(!dep.esDelSistema('VCOMP140.DLL'), 'VCOMP140 sí hay que llevarla')
    assert.ok(!dep.esDelSistema('whisper.dll'))
  })
})

/**
 * El mismo fallo de arriba, pero con módulos de JavaScript en vez de DLL: el
 * paquete no puede cargar lo que no lleva.
 *
 * `electron-builder` copia `node-backend/` a `resources/node-backend/`, así que
 * un `require('../../shared/prompts')` desde `src/` apunta a `resources/shared/`.
 * Si esa carpeta no está en `extraResources`, en la máquina de desarrollo todo
 * funciona —ahí sí existe— y en Windows la app muere al arrancar con
 * «Cannot find module». Es exactamente la forma del fallo de `0xC0000135`:
 * verde en local, muerto en el cliente.
 */
describe('el paquete lleva los módulos que el backend carga', () => {
  const RAIZ = path.join(__dirname, '..', '..')
  const SRC = path.join(__dirname, '..', 'src')
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'electron-app', 'package.json'), 'utf8'))
  const enviadas = new Set(pkg.build.extraResources.map(r => r.to.split('/')[0]))

  test('ningún módulo sale a una carpeta que el paquete no copia', () => {
    const fallos = []
    for (const archivo of fs.readdirSync(SRC).filter(n => n.endsWith('.js'))) {
      const codigo = fs.readFileSync(path.join(SRC, archivo), 'utf8')
      for (const m of codigo.matchAll(/require\(['"]\.\.\/\.\.\/([^'"/]+)\/([^'"]+)['"]\)/g)) {
        const [, carpeta, resto] = m
        if (!enviadas.has(carpeta)) fallos.push(`${archivo} pide ../../${carpeta}/${resto}`)
        else if (!fs.existsSync(path.join(RAIZ, carpeta, `${resto}.js`))) {
          fallos.push(`${archivo} pide ../../${carpeta}/${resto}, que no existe`)
        }
      }
    }
    assert.deepStrictEqual(fallos, [],
      'añade la carpeta a extraResources en electron-app/package.json:\n' + fallos.join('\n'))
  })

  test('shared/ viaja con el paquete: respuestas.js carga los prompts de ahí', () => {
    assert.ok(enviadas.has('shared'))
    assert.match(fs.readFileSync(path.join(SRC, 'respuestas.js'), 'utf8'), /require\('\.\.\/\.\.\/shared\/prompts'\)/)
  })
})
