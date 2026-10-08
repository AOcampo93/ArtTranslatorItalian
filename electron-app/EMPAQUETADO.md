# Empaquetado para Windows

`package.json` no admite comentarios y electron-builder valida el esquema, así
que el porqué de cada recurso vive aquí.

## Cómo se construye: un solo guion

```
bash herramientas/construir-v2.sh
```

Corre, en este orden, y **se para en el primer paso que falle**:

| # | Paso | Por qué |
|---|---|---|
| 1 | Comprueba `electron-app/src/licencia.json` e `informes.token.json`: existen, tienen forma válida (`licencia` de 32 hex, `clavePublica` Ed25519 en PEM, `url` https) y **ninguno está en git** | Sin `licencia.json` la app falla cerrada («Esta copia no tiene licencia») en todos los equipos. Sin el token, la subida de informes se apaga en silencio. Los dos son secretos: el `.gitignore` los tapa y el guion se niega a seguir si alguno está trackeado |
| 2 | Deja en la caché **un Marian cuantizado por idioma** y quita las variantes | Ver «Los Marian» |
| 3 | `node herramientas/manifiesto-backend.js` | Ver «El manifiesto» |
| 4 | Borra `dist/win-unpacked` y el zip anterior, y corre `npm run build:win` | electron-builder no limpia la carpeta: sin esto, el `Traductor Italiano.exe` de la v0.9 acabaría en el zip. Y `zip` **actualiza** un zip que ya existe en vez de reemplazarlo |
| 5 | `verificar-paquete.sh` | Ver «Verificación» |
| 6 | `electron-app/dist/ArtTranslatorV2-Windows.zip`, con la carpeta `win-unpacked/` dentro, y lo prueba (`unzip -t`) | La carpeta se llama como la de la v0.9 a propósito: así «extraer encima de la carpeta anterior» (`LEEME-WINDOWS.txt`) cae en los mismos sitios y la V2 encuentra la base de perfiles de la v0.9 (PLAN.md §17.7, F057) |
| 7 | Imprime el tamaño y los seis primeros caracteres de la licencia incrustada | Para comprobar de un vistazo que es la del cliente y no la de una prueba |

Hace falta antes `npm ci` en `electron-app/` y en `node-backend/`, y red la
primera vez (electron-builder baja el Electron de Windows; Marian, de Hugging
Face, si falta en la caché). `electron-builder` no comprueba nada de lo que
verifica el paso 5 por su cuenta.

**Una licencia de prueba no se nota en el zip.** El guion valida la forma, no de
quién es. Quien construya el definitivo mira la línea final.

## Qué lleva el paquete

| Recurso | Motivo |
|---|---|
| `resources/app.asar` | `electron-app/src/**` y `package.json`: `mainApp.js`, `licencia.js`, `integridad.js`, `modificada.js`, la interfaz, `licencia.json`, `informes.token.json` y `manifiesto-backend.json`. Es lo que protegen los fusibles |
| `resources/node-backend/src`, `resources/shared` | El backend, **fuera** del asar y en texto plano (`extraResources`). Lo cubre el manifiesto |
| `resources/node-backend/node_modules` | Sus `node_modules` traen `onnxruntime-node`, que **ya incluye los binarios de win32-x64 dentro del propio paquete**. No hay que reinstalar por plataforma. Incluye la caché de Marian |
| `resources/node-backend/test/fixtures` | `italiano.wav` e `ingles.wav`: el audio de la comprobación previa de cada idioma |
| `resources/LEEME.txt` | `LEEME-WINDOWS.txt` de la raíz |

## Los Marian: uno por idioma, cuantizado, sin variantes

PLAN.md §0.19: cada idioma que la app ofrece lleva **su Marian embebido**, y un
idioma sin su modelo no se ofrece. Hoy son dos: `Xenova/opus-mt-it-es` (107 MB)
y `Xenova/opus-mt-en-es` (113 MB) `[medido]`.

`@huggingface/transformers` guarda los `.onnx` en
`node-backend/node_modules/@huggingface/transformers/.cache/`, y esa carpeta
**solo existe si alguien tradujo algo en esa máquina**. Un clon limpio con
`npm ci` no la tiene: el modelo se descarga en el primer uso. Consecuencia: una
máquina de compilación nueva produciría un paquete **sin modelo de traducción**, y
la app intentaría descargarlo en el equipo del cliente, en medio de una reunión,
sin explicar por qué no traduce.

El paso 2 lo evita **sin una lista escrita a mano**: pide los modelos al registro
de idiomas (`node-backend/src/idiomas.js`, `modeloMarian` y
`calentamientoMarian`) y traduce una vez con cada uno. Eso baja a la caché el que
falte y prueba que carga. Un idioma nuevo entra solo. El verificador usa el mismo
registro, el que viaja empaquetado.

**Variantes.** La app carga solo el cuantizado (`dtype: 'q8'`:
`encoder_model_quantized.onnx` y `decoder_model_merged_quantized.onnx`). Todo lo
demás que haya en `onnx/` son cientos de MB de lastre: una medición que comparó el
modelo de precisión completa contra el cuantizado dejó **402 MB** en la caché y el
paquete se los llevó. El paso 2 borra los `.onnx` sin «quantized» en el nombre; el
verificador exige que no haya ninguno, y también que no haya un modelo entero que
ningún idioma use. Un modelo entero de más **no se borra solo** (es tu caché): el
guion se para y dice cuál.

## El manifiesto de integridad del backend

`node-backend/src` y `shared` viajan fuera del asar y se cargan en el mismo
proceso que `licencia.js`: una línea editada en cualquiera de ellos la apagaría.
`herramientas/manifiesto-backend.js` escribe `electron-app/src/manifiesto-backend.json`
con el SHA-256 de cada archivo de esas dos carpetas (se versiona el guion, no el
archivo generado). Va **dentro** del asar, y `mainApp.js` lo compara con las
carpetas de al lado **antes del primer `require`** de ellas. Si falta un archivo,
sobra uno o alguno no casa, no carga el backend y muestra «Esta copia está
modificada; descárgala de nuevo».

Tres consecuencias de construir:

- **Va antes de `electron-builder`** (paso 3) y después de tocar cualquier archivo
  de esas carpetas. Un manifiesto viejo bloquearía a todos los clientes. El guion lo
  regenera siempre.
- **Tiene que casar con lo que de verdad se empaqueta, no con el repositorio.**
  `extraResources` filtra (`src/**/*` en el backend, `**/*.js` en `shared`): un
  archivo que el manifiesto lista y el paquete no copia —un `.json` en `shared/`,
  por ejemplo— daría «copia modificada» a todos los clientes. Lo comprueba el
  verificador, con el mismo `integridad.js` y el mismo manifiesto que viajan en el
  asar.
- **No cubre `node-backend/node_modules`** (miles de archivos de terceros). Ver lo
  que el plan dice que no frena (PLAN.md §17.6).

`.DS_Store`, `Thumbs.db` y `desktop.ini` no cuentan; el zip tampoco lleva `.DS_Store`.

## Los fusibles de Electron

`build.electronFuses` en `package.json`. electron-builder 26 los aplica con
`@electron/fuses` al `.exe` justo antes de firmar, **también con `--win dir` desde
macOS**, y el verificador los lee del `.exe` construido:

| Fusible | Estado | Si no |
|---|---|---|
| `runAsNode` | apagado | `ELECTRON_RUN_AS_NODE=1` convierte el `.exe` en un Node y ejecuta código propio |
| `enableNodeOptionsEnvironmentVariable` | apagado | Con el binario renombrado, `NODE_OPTIONS=--require x.js` ejecuta código propio en el proceso principal, antes de `mainApp.js` |
| `enableNodeCliInspectArguments` | apagado | `--inspect` abre el proceso principal |
| `enableEmbeddedAsarIntegrityValidation` | **encendido** | Un `app.asar` editado arranca igual |
| `onlyLoadAppFromAsar` | **encendido** | Una carpeta `resources/app` sustituye al asar |

El fusible de integridad exige que el `.exe` lleve el hash de `app.asar` en el
recurso `ELECTRONASAR` (electron-builder lo escribe con `resedit`, sin Wine ni
Windows). Si el recurso falta o es de otro asar, **la app muere al arrancar en
todos los equipos**, y aquí no hay Windows donde probarlo: por eso el verificador
recalcula el SHA-256 de la cabecera de `app.asar` y lo compara con el del `.exe`.

**Lo que no frenan**, dicho claro (PLAN.md §17.6): a quien parchee el `.exe`, que
no está firmado (Authenticode, §10, se decidió no comprarlo).

Nada de la app depende de `runAsNode`: no hay `child_process.fork` ni
`ELECTRON_RUN_AS_NODE` en `electron-app/src`, `node-backend/src` ni `shared`. El
único `spawn` (`transcriber.js`, que la app de la v1 no carga) lanzaría
`whisper-server.exe`, que no viaja; los `execFile` de `licencia.js` lanzan
`reg.exe` y `powershell.exe`, no la propia app.

## Verificación tras construir

```
./verificar-paquete.sh [carpeta]     # por defecto, electron-app/dist/win-unpacked
```

Lo corre el paso 5, y se puede correr a mano sobre cualquier paquete. Comprueba:

- el nombre `ArtTranslatorV2.exe` (y que no queda otro `.exe` ni `resources/app`);
- `onnxruntime` y `sharp` de Windows, `ws`, y ningún binario de macOS;
- **por idioma, leído del registro empaquetado**: su Marian completo y cuantizado,
  sin variantes, y su WAV de prueba; y ningún modelo de más;
- `licencia.js`, `integridad.js`, `modificada.js`, `licencia.json`,
  `manifiesto-backend.json` e `informes.token.json` dentro de `app.asar`, y que
  `licencia.json` e `informes.token.json` **no están en git**;
- **el manifiesto casa con los archivos empaquetados** de `resources/node-backend/src`
  y `resources/shared`: ni falta ni sobra ninguno, mismo SHA-256;
- los cinco fusibles, y que el hash de `app.asar` viaja en el `.exe`;
- que `LEEME.txt` es el de esta versión.

La comprobación que de verdad importa es la que mira el paquete tal como quedó,
no la fuente: **el verificador de la v0.9 dio todo en verde con
`whisper-server.exe` muerto** (`0xC0000135`, falta el runtime de MSVC), porque
medía que un instalador estuviera incluido y no que sus DLL estuvieran donde se
cargan. Cada punto de la lista es un fallo ya visto, o que dejaría a todos los
clientes sin app.

## Dos trampas del empaquetado cruzado

**1. `electron-builder` ignora `node_modules` dentro del filtro de un recurso.**
Poner `"node_modules/**/*"` en el `filter` de una entrada de `extraResources`
**no copia nada** y no avisa. Hace falta una entrada propia apuntando
directamente a `node_modules`.

**2. `sharp` se carga aunque no usemos imágenes.** `@huggingface/transformers`
lo requiere al arrancar, y npm solo instala el binario de la plataforma actual.
Sin el de Windows, la traducción no arranca allí. npm además **bloquea**
instalarlo con `--os=win32` por las restricciones del propio paquete: hay que
bajarlo con `npm pack` y extraerlo a mano.

Lo comprobamos mirando `require.cache` tras una traducción real, no suponiendo.

## Qué se poda del `node_modules`

| Fuera | Motivo | Ahorro |
|---|---|---|
| `onnxruntime-node` darwin y linux | En Windows no sirven | ~141 MB |
| `onnxruntime-web` | Verificado: **no se carga** al traducir | ~91 MB |
| `@img/sharp-*darwin*` | Reemplazados por los de win32 | ~30 MB |

## Whisper local: no viaja en la v1

La versión 1 transcribe en la nube (AssemblyAI), así que `bin/`, el runtime de
MSVC y `models/ggml-small.bin` **no entran al paquete** (ya no están en
`extraResources`). Para el modo local (v2, PLAN.md §7ter) quedan los guiones:
`herramientas/preparar-bin-win.sh` (recrea `bin-win/`, que está en `.gitignore`),
`extraer-runtime-msvc.py` y `dependencias-windows.js`, y `npm test` sigue
comprobando `bin-win/` si existe. Tres lecciones que no hay que volver a pagar:

- **El runtime de MSVC va al lado del binario, no como instalador.** Un
  `vc_redist.x64.exe` incluido no instala nada: se envió así, la lista de
  verificación salió entera en verde y `whisper-server.exe` murió con
  `0xC0000135`. Hacen falta `VCRUNTIME140`, `VCRUNTIME140_1`, `MSVCP140` y
  **`VCOMP140`** (la de OpenMP, que piden las diez variantes de `ggml-cpu-*` y la
  que más fácil se olvida).
- **Las nueve `ggml-cpu-*` junto a `ggml-base.dll`.** Si se dispersan, el despacho
  por microarquitectura cae a la peor variante sin dar ningún error.
- **El tag de whisper.cpp está anclado a `b5130`** (`whisper-bin-x64.zip`,
  8.573.270 bytes). `v1.9.4` no tiene assets y un instalador que apunte ahí no
  descarga nada.
