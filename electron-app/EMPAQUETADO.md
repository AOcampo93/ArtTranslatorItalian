# Empaquetado para Windows

`package.json` no admite comentarios y electron-builder valida el esquema, así
que el porqué de cada recurso vive aquí.

## Qué se incluye y por qué

| Recurso | Motivo |
|---|---|
| `node-backend/` completo | Sus `node_modules` traen `onnxruntime-node`, que **ya incluye los binarios de win32-x64 dentro del propio paquete**. No hay que reinstalar por plataforma. |
| `bin/` — 13 archivos | `whisper-server.exe` más sus DLL. Las **nueve `ggml-cpu-*` tienen que quedar junto a `ggml-base.dll`**: si el empaquetado las dispersa, el despacho por microarquitectura cae a la peor variante **sin dar ningún error**. |
| `models/ggml-small.bin` | Embebido, nunca descargado al arrancar. Una barra de descarga que falla por red deja la app muda sin que el usuario entienda por qué. |
| `vc_redist.x64.exe` | El zip de whisper.cpp **no trae el runtime de MSVC**. Sin `VCRUNTIME140`, `VCRUNTIME140_1`, `MSVCP140` y `VCOMP140`, `whisper-server.exe` no arranca en un Windows limpio. |

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

1. Las nueve `ggml-cpu-*.dll` están junto a `ggml-base.dll`.
2. `onnxruntime_binding.node` de `win32/x64` está presente.
3. El modelo pesa lo que debe (~465 MB).
4. `vc_redist.x64.exe` está incluido.

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
