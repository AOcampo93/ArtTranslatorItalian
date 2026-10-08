#!/usr/bin/env bash
# Comprueba el paquete de Windows antes de enviarlo.
#
# La versión 1 transcribe en la nube, así que las comprobaciones de whisper
# local —las nueve DLL ggml-cpu, el runtime de MSVC, el modelo de 465 MB— ya
# no aplican: eso no viaja. Lo que sí tiene que viajar es un Marian por cada
# idioma que la app ofrece, onnxruntime de Windows, sharp de Windows, el audio
# de prueba de cada idioma, la licencia y el manifiesto de integridad del backend.
# `electron-builder` no verifica nada de esto por su cuenta, y cada punto de la
# lista corresponde a un fallo que rompería la app en el equipo del cliente.
#
# Uso: ./verificar-paquete.sh [carpeta]     (por defecto, electron-app/dist/win-unpacked)
set -u
RAIZ="$(cd "$(dirname "$0")" && pwd)"
D="${1:-$RAIZ/electron-app/dist/win-unpacked}"
[ -d "$D" ] || { echo "No existe $D — construye primero con: bash herramientas/construir-v2.sh"; exit 1; }
D="$(cd "$D" && pwd)"
cd "$RAIZ" || exit 1

RES="$D/resources"
EXE="$D/ArtTranslatorV2.exe"
CACHE="$RES/node-backend/node_modules/@huggingface/transformers/.cache"
ELECTRON_APP="$RAIZ/electron-app"
# `asar` es el mismo que usa `electron-builder` por debajo (viene con él en `node_modules`).
ASAR="$ELECTRON_APP/node_modules/.bin/asar"

ok=0; mal=0
# Lo que el comando imprima solo se enseña si falla: un ✗ sin el porqué obliga a repetirlo a mano.
chk () {
  local salida
  if salida=$(eval "$2" 2>&1); then
    echo "  ✓ $1"; ok=$((ok+1))
  else
    echo "  ✗ $1"; mal=$((mal+1))
    [ -n "$salida" ] && printf '%s\n' "$salida" | head -6 | sed 's/^/      /'
  fi
}

# ── Lo que el propio paquete dice que ofrece ──────────────────────────
# Idioma, modelo de Marian y audio de prueba salen del registro de idiomas EMPAQUETADO
# (`idiomas.js`), no de una lista escrita aquí: un idioma nuevo queda comprobado solo, y
# uno que se ofrezca sin su modelo no pasa (PLAN.md §0.19). `idiomas.js` solo carga
# módulos propios, así que se puede leer sin `node_modules`.
IDIOMAS=$(node -e '
  for (const i of require(process.argv[1]).listarIdiomas()) console.log([i.codigo, i.modeloMarian, i.muestra].join(" "))
' "$RES/node-backend/src/idiomas" 2>/dev/null)
MODELOS=$(printf '%s\n' "$IDIOMAS" | awk 'NF { print $2 }')

# ── Funciones de las comprobaciones que no caben en una línea ─────────

# Un Marian completo y cuantizado en la caché del paquete. El modelo viaja dentro de
# node_modules/.cache, que solo existe si alguien tradujo algo en la máquina de compilación:
# `npm ci` en un clon limpio NO lo trae. Sin esta comprobación, una máquina de compilación
# nueva produciría un paquete sin modelo y la app intentaría descargarlo en casa del
# cliente —en medio de una reunión, y sin explicar por qué no traduce—.
marian_completo () {
  local m="$CACHE/$1" o="$CACHE/$1/onnx" f
  for f in "$m/config.json" "$m/tokenizer.json" "$o/encoder_model_quantized.onnx" "$o/decoder_model_merged_quantized.onnx"; do
    [ -f "$f" ] || { echo "falta $f"; return 1; }
  done
  # Los dos .onnx pesan ~107 MB (it→es) y ~113 MB (en→es) `[medido]`: por debajo de 50 MB
  # la descarga se cortó a medias.
  local bytes=$(( $(wc -c < "$o/encoder_model_quantized.onnx") + $(wc -c < "$o/decoder_model_merged_quantized.onnx") ))
  [ "$bytes" -gt 50000000 ] || { echo "los .onnx suman solo $bytes bytes: descarga cortada"; return 1; }
}

# Lo que hay en node_modules/.cache es lo que había en la máquina de compilación, así que
# ahí se cuela cualquier cosa. Pasó: una medición del líder comparando el modelo de precisión
# completa contra el cuantizado dejó 402 MB en la caché y el paquete se los llevó, aunque la
# app solo carga el cuantizado (dtype: 'q8'). Comprobar que el modelo está no basta: hay que
# comprobar que NO está lo que no se usa.
marian_sin_variantes () {
  local lastre
  lastre=$(ls "$CACHE/$1/onnx/"*.onnx 2>/dev/null | grep -v quantized)
  [ -z "$lastre" ] || { echo "sobran variantes que la app no carga:"; echo "$lastre"; return 1; }
}

# Los dos idiomas de la versión 1.0.0 están en el registro empaquetado. Si el registro no se pudo
# leer, `IDIOMAS` queda vacío y los bucles de abajo no comprobarían nada: aquí se avisa de por qué.
ofrece_italiano_e_ingles () {
  [ -n "$IDIOMAS" ] || { echo "no se pudo leer resources/node-backend/src/idiomas.js del paquete"; return 1; }
  printf '%s\n' "$IDIOMAS" | grep -q '^it Xenova/opus-mt-it-es ' || { echo "falta italiano; el registro dice:"; echo "$IDIOMAS"; return 1; }
  printf '%s\n' "$IDIOMAS" | grep -q '^en Xenova/opus-mt-en-es ' || { echo "falta inglés; el registro dice:"; echo "$IDIOMAS"; return 1; }
}

# Y lo mismo con modelos enteros: el de un idioma que ya no se ofrece, o uno de una medición.
sin_modelos_de_mas () {
  local sobran
  sobran=$(cd "$CACHE" 2>/dev/null && find . -mindepth 2 -maxdepth 2 -type d | sed 's|^\./||' | grep -vxF -f <(printf '%s\n' "$MODELOS"))
  [ -z "$sobran" ] || { echo "modelos que ningún idioma usa:"; echo "$sobran"; return 1; }
}

# `app.asar` extraído una vez en una carpeta temporal: de ahí salen la comprobación de que cada
# archivo está dentro y la del manifiesto. Extraer también prueba que el asar se abre.
ASAR_DIR=$(mktemp -d "${TMPDIR:-/tmp}/verificar-paquete.XXXXXX") || exit 1
trap 'rm -rf "$ASAR_DIR"' EXIT

# F054 (ronda 2) / F055 — OBLIGATORIA. `mainApp.js` compara, ANTES de cargar nada, el SHA-256 de
# cada archivo de `resources/node-backend/src` y `resources/shared` con `manifiesto-backend.json`
# (que va dentro del asar). Si falta uno, sobra uno o alguno no casa, el backend no se carga y
# TODOS los clientes ven «Esta copia está modificada»: ni siquiera arranca una reunión. Aquí se
# corre esa misma comprobación —con el `integridad.js` y el manifiesto que viajan en el asar—
# contra los archivos tal como quedaron empaquetados (con electron-builder, `extraResources`
# filtra: un archivo del manifiesto que el paquete no copia, p. ej. un `.json` en `shared/`,
# bloquearía a todos).
manifiesto_casa_con_el_paquete () {
  node -e '
    const raiz = process.argv[1], asar = process.argv[2]
    const { verificarBackend } = require(asar + "/src/integridad.js")
    const manifiesto = require(asar + "/src/manifiesto-backend.json")
    const n = Object.keys(manifiesto.archivos).length
    if (n === 0) { console.error("el manifiesto no lista ningún archivo"); process.exit(1) }
    const r = verificarBackend({ raiz, ruta: asar + "/src/manifiesto-backend.json" })
    if (!r.ok) { console.error("el manifiesto no casa con el paquete: " + r.motivo); process.exit(1) }
    console.log(n + " archivos, todos con su SHA-256")
  ' "$RES" "$ASAR_DIR"
}

# Los fusibles, leídos del .exe ya construido con `@electron/fuses` (lo mismo que
# `npx @electron/fuses read --app <exe>`, pero en una línea `Nombre on|off` por fusible).
FUSIBLES=$(cd "$ELECTRON_APP" && node -e '
  const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses")
  const estado = { 48: "off", 49: "on", 114: "quitado", 144: "heredado" }
  getCurrentFuseWire(process.argv[1]).then(cable => {
    for (const [nombre, indice] of Object.entries(FuseV1Options)) {
      if (typeof indice === "number") console.log(nombre + " " + (estado[cable[indice]] ?? cable[indice]))
    }
  }).catch(error => { console.error(error.message); process.exit(1) })
' "$EXE" 2>&1)
fusible () {
  printf '%s\n' "$FUSIBLES" | grep -qx "$1 $2" || { echo "se esperaba $1 $2; el .exe tiene: $(printf '%s\n' "$FUSIBLES" | grep "^$1 " || echo "$FUSIBLES")"; return 1; }
}

# Con `enableEmbeddedAsarIntegrityValidation` encendido, Electron compara al arrancar el SHA-256
# de la cabecera de `app.asar` con el que lleva el .exe en su recurso ELECTRONASAR. Si el recurso
# falta o es de otro asar, la app muere al arrancar en TODOS los equipos, y aquí no hay Windows
# donde probarlo: se comprueba que lo que viaja en el .exe es el hash del asar que viaja. Y que la
# cabecera lleva, además, el hash de cada archivo: sin él, el fusible daría por bueno un
# `licencia.js` editado, que es justo lo que F054 le pide (PLAN.md §17.6).
integridad_del_exe_casa_con_el_asar () {
  (cd "$ELECTRON_APP" && node -e '
    const fs = require("fs"), path = require("path"), crypto = require("crypto")
    const { NtExecutable, NtExecutableResource } = require("resedit")
    const asar = require("@electron/asar")
    const [exe, archivo] = process.argv.slice(1)
    const recursos = NtExecutableResource.from(NtExecutable.from(fs.readFileSync(exe)))
    const entrada = recursos.entries.find(e => String(e.type).toUpperCase() === "INTEGRITY" && String(e.id).toUpperCase() === "ELECTRONASAR")
    if (!entrada) { console.error("el .exe no lleva el recurso ELECTRONASAR"); process.exit(1) }
    const lista = JSON.parse(Buffer.from(entrada.bin).toString("utf8"))
    const fila = lista.find(x => path.win32.normalize(x.file).toLowerCase() === "resources\\app.asar")
    if (!fila) { console.error("el recurso no nombra resources\\app.asar: " + JSON.stringify(lista.map(x => x.file))); process.exit(1) }
    const hash = crypto.createHash("sha256").update(asar.getRawHeader(archivo).headerString).digest("hex")
    if (String(fila.alg).toUpperCase() !== "SHA256" || fila.value !== hash) {
      console.error("el hash del .exe (" + fila.alg + " " + fila.value + ") no es el de la cabecera de app.asar (" + hash + ")"); process.exit(1)
    }
    const sinHash = []
    const recorrer = (nodo, ruta) => {
      for (const [nombre, hijo] of Object.entries(nodo.files || {})) {
        if (hijo.files) recorrer(hijo, ruta + "/" + nombre)
        else if (!hijo.integrity && !hijo.unpacked && !hijo.link) sinHash.push(ruta + "/" + nombre)
      }
    }
    recorrer(asar.getRawHeader(archivo).header, "")
    if (sinHash.length) { console.error("archivos del asar sin hash propio: " + sinHash.slice(0, 5).join(", ")); process.exit(1) }
  ' "$EXE" "$RES/app.asar")
}

echo "Verificando $D"
echo

echo "Nombre y estructura"
chk "el ejecutable es ArtTranslatorV2.exe y es el único .exe de la raíz (el de la v0.9 se llamaba «Traductor Italiano.exe»)" \
   '[ -f "$EXE" ] && [ "$(ls "$D"/*.exe | wc -l | tr -d " ")" = 1 ]'
chk "el código solo va dentro de app.asar (sin resources/app)" \
   '[ -f "$RES/app.asar" ] && [ ! -e "$RES/app" ]'

echo
echo "Dependencias de la traducción"
chk "onnxruntime de win32/x64 (si no, Marian no arranca)" \
   'find "$RES" -path "*win32/x64*" -name onnxruntime_binding.node | grep -q .'
chk "sharp de win32-x64 (transformers lo carga aunque no usemos imágenes)" \
   '[ -d "$RES/node-backend/node_modules/@img/sharp-win32-x64" ]'
chk "sin binarios de macOS sobrantes" \
   '[ ! -d "$RES/node-backend/node_modules/@img/sharp-darwin-arm64" ]'
chk "ws, que es el WebSocket de la transcripción en vivo" \
   '[ -d "$RES/node-backend/node_modules/ws" ]'

echo
echo "Idiomas: un Marian cuantizado y un audio de prueba por cada uno (PLAN.md §0.19)"
chk "el paquete ofrece italiano e inglés (registro de idiomas empaquetado)" 'ofrece_italiano_e_ingles'
while read -r codigo modelo muestra; do
  [ -n "$codigo" ] || continue
  chk "[$codigo] modelo $modelo completo y cuantizado" "marian_completo '$modelo'"
  chk "[$codigo] sin variantes del modelo que la app no carga (cientos de MB de lastre)" "marian_sin_variantes '$modelo'"
  chk "[$codigo] audio de prueba $muestra" "[ -s '$RES/node-backend/test/fixtures/$muestra' ]"
done <<EOF
$IDIOMAS
EOF
chk "sin modelos de Marian que ningún idioma use" 'sin_modelos_de_mas'

echo
echo "Licencia, integridad e informes (dentro de app.asar)"
chk "app.asar se abre y se extrae" '"$ASAR" extract "$RES/app.asar" "$ASAR_DIR"'
chk "licencia.js dentro de app.asar (sin él la app no pide licencia a nadie)" '[ -f "$ASAR_DIR/src/licencia.js" ]'
chk "integridad.js dentro de app.asar (mainApp.js lo carga el primero: sin él no arranca)" '[ -f "$ASAR_DIR/src/integridad.js" ]'
chk "modificada.js dentro de app.asar (la pantalla «copia modificada»)" '[ -f "$ASAR_DIR/src/modificada.js" ]'
chk "licencia.json dentro de app.asar (sin él: «Esta copia no tiene licencia» en todos los equipos)" '[ -f "$ASAR_DIR/src/licencia.json" ]'
chk "manifiesto-backend.json dentro de app.asar (sin él: «Esta copia está modificada» en todos los equipos)" '[ -f "$ASAR_DIR/src/manifiesto-backend.json" ]'
# F039b: sin este archivo (fuera del repo, gitignored) la app arranca igual, pero sin subir
# ningún informe — y eso solo se nota semanas después, cuando el equipo pregunta por qué no
# llegó nada de una prueba.
chk "informes.token.json dentro de app.asar (si no, la subida queda desactivada en silencio)" '[ -f "$ASAR_DIR/src/informes.token.json" ]'
chk "licencia.json NO está en git (trae la licencia del cliente)" \
   '! git ls-files --error-unmatch electron-app/src/licencia.json'
chk "informes.token.json NO está en git (es un secreto de servicio, no de usuario)" \
   '! git ls-files --error-unmatch electron-app/src/informes.token.json'
chk "el manifiesto casa con los archivos EMPAQUETADOS de node-backend/src y shared (si no, todos verían «copia modificada»)" \
   'manifiesto_casa_con_el_paquete'

echo
echo "Fusibles de Electron, leídos del .exe (PLAN.md §17.6)"
chk "runAsNode apagado (si no, ELECTRON_RUN_AS_NODE convierte el .exe en un Node)" 'fusible RunAsNode off'
chk "enableNodeOptionsEnvironmentVariable apagado (NODE_OPTIONS=--require ejecutaría código propio antes de mainApp.js)" 'fusible EnableNodeOptionsEnvironmentVariable off'
chk "enableNodeCliInspectArguments apagado (--inspect abriría el proceso principal)" 'fusible EnableNodeCliInspectArguments off'
chk "enableEmbeddedAsarIntegrityValidation encendido (un app.asar editado no arranca)" 'fusible EnableEmbeddedAsarIntegrityValidation on'
chk "onlyLoadAppFromAsar encendido (una carpeta resources/app no sustituye al asar)" 'fusible OnlyLoadAppFromAsar on'
chk "el .exe lleva el hash de app.asar que Electron comprobará al arrancar, y cada archivo del asar lleva el suyo (si no, no arranca en ningún equipo, o el fusible no vigila el contenido)" \
   'integridad_del_exe_casa_con_el_asar'

echo
echo "Instrucciones"
chk "instrucciones para el cliente, de esta versión" \
   '[ -f "$RES/LEEME.txt" ] && grep -q "ArtTranslatorV2.exe" "$RES/LEEME.txt"'

echo
echo "  $ok correctas · $mal fallidas"
[ "$mal" -eq 0 ] || exit 1
