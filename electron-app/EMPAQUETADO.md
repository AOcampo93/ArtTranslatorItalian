# Empaquetado para Windows

`package.json` no admite comentarios y electron-builder valida el esquema, así
que el porqué de cada recurso vive aquí.

## Qué se incluye y por qué

| Recurso | Motivo |
|---|---|
| `node-backend/` completo | Sus `node_modules` traen `onnxruntime-node`, que **ya incluye los binarios de win32-x64 dentro del propio paquete**. No hay que reinstalar por plataforma. |
| `bin/` — 17 archivos | `whisper-server.exe` más sus DLL. Las **nueve `ggml-cpu-*` tienen que quedar junto a `ggml-base.dll`**: si el empaquetado las dispersa, el despacho por microarquitectura cae a la peor variante **sin dar ningún error**. |
| `bin/` — runtime de MSVC | `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` y `vcomp140.dll`, extraídas del redistribuible oficial. Ver abajo. |
| `models/ggml-small.bin` | Embebido, nunca descargado al arrancar. Una barra de descarga que falla por red deja la app muda sin que el usuario entienda por qué. |

## El runtime de MSVC va al lado del binario, no como instalador

El zip de whisper.cpp **no trae el runtime de MSVC**. Sin `VCRUNTIME140`,
`VCRUNTIME140_1`, `MSVCP140` y `VCOMP140`, ningún binario de whisper arranca en
un Windows limpio.

**Lo que se hacía antes y por qué falló.** Se incluía `vc_redist.x64.exe` en el
paquete y el LEEME pedía al cliente que lo ejecutara. Se envió así a la máquina
virtual, la lista de verificación salió **entera en verde**, y `whisper-server.exe`
murió con `0xC0000135`. Incluir un instalador no instala nada, y la comprobación
medía justo eso: que el archivo estuviera ahí.

**Lo que se hace ahora.** Las cuatro DLL viajan junto a `whisper-server.exe`
(*despliegue local*, documentado por Microsoft). Sale ganando en todo:

- **Cero pasos para el cliente.** La prioridad número uno del proyecto es
  "instalar, aceptar permisos y listo"; pedirle que ejecute un redistribuible
  que no sabe qué es la incumple.
- **Sin permisos de administrador**, a diferencia de instalarlo en `System32`.
- **Funciona igual en el zip portable que en el instalador.** El redistribuible
  no servía de nada en el zip, que es justo como se está probando ahora.
- **925 KB en lugar de 25 MB.**

`VCOMP140.DLL` es la del runtime de OpenMP y **la piden las diez variantes de
`ggml-cpu-*`**. Es la que más fácil se olvida, porque no sale en las listas
habituales de "las DLL de MSVC": no se dedujo, se leyó de la tabla de
importaciones de cada PE.

Las extrae `herramientas/extraer-runtime-msvc.py` del redistribuible oficial de
Microsoft, y verifica de cada una arquitectura, firma Authenticode, `CompanyName`
y `OriginalFilename` antes de escribirla. La procedencia importa: esto acaba en
el equipo del cliente, así que no vale bajarlas de un reempaquetado de terceros.

## Cómo se prepara bin-win/

`bin-win/` está en `.gitignore`. Para reconstruirla:

```
./herramientas/preparar-bin-win.sh
```

Descarga el zip anclado de whisper.cpp, comprueba su tamaño, se queda con los 13
archivos que se usan, extrae el runtime de MSVC y verifica que no falte ninguna
DLL. Verificado: reconstruir desde cero da un resultado **idéntico byte a byte**.

## El modelo de Marian no lo trae `npm ci`

`@huggingface/transformers` guarda los `.onnx` de `Xenova/opus-mt-it-es` en
`node_modules/.cache`, y esa carpeta **solo existe si alguien tradujo algo en
esa máquina**. Un clon limpio con `npm ci` no la tiene: el modelo se descarga
en el primer uso.

Consecuencia: una máquina de compilación nueva produce un paquete **sin modelo
de traducción**, y la app intentaría descargarlo en el equipo del cliente, en
medio de una reunión, sin explicar por qué no traduce. Antes de empaquetar hay
que traducir una vez (basta `npm test` en `node-backend`), y `verificar-paquete.sh`
lo comprueba.

## Qué se podó

El zip oficial de whisper.cpp trae **40 archivos**; se usan **13**. Fuera quedan
los binarios de test, `llama.dll`, `parakeet.*`, `wchess.exe` y un `SDL2.dll`
fechado en 2023.

## El tag está anclado

`whisper-bin-x64.zip` del tag **`b5130`**, 8.573.270 bytes. No se usa "latest
release": el tag `v1.9.4` **no tiene assets** y un instalador que apunte ahí no
descargaría nada. La regla tampoco es estable — `v1.9.2` sí los tiene — así que
se ancla el tag exacto y se verifica el tamaño.

## Verificación tras construir

Antes de enviar nada, comprobar en el paquete:

```
./verificar-paquete.sh
```

La comprobación que de verdad importa es la de dependencias: lee la tabla de
importaciones de cada PE del paquete y la compara con lo que hay al lado.
Sustituye a la que daba verde en falso. La misma comprobación corre en
`npm test` sobre `bin-win/`, así que el fallo se ve antes de empaquetar.

El script `npm run build:win` no comprueba nada de esto por sí solo.

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
