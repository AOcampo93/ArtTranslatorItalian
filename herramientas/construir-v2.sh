#!/usr/bin/env bash
# Construye el paquete de Windows de ArtTranslatorV2, de principio a fin y en orden:
#
#   1. comprueba la licencia y el token de informes (existen, tienen forma, no están en git);
#   2. deja en la caché un Marian cuantizado por idioma, sin variantes de más;
#   3. escribe el manifiesto de integridad del backend;
#   4. electron-builder (npm run build:win), con los fusibles de package.json;
#   5. verificar-paquete.sh;
#   6. ArtTranslatorV2-Windows.zip en electron-app/dist/;
#   7. imprime el tamaño.
#
# Si un paso falla, se para: no hay zip a medias. Se corre desde cualquier carpeta:
#
#   bash herramientas/construir-v2.sh
#
# Hace falta, antes: `npm ci` en electron-app/ y en node-backend/, y red la primera vez
# (electron-builder baja el Electron de Windows; Marian se baja de Hugging Face si falta).
#
# El zip lleva la carpeta `win-unpacked/` dentro, igual que el de la v0.9: así «extraer encima
# de la carpeta anterior» (LEEME-WINDOWS.txt) cae en los mismos sitios y la V2 encuentra la base
# de perfiles de la v0.9 (PLAN.md §17.7, F057).
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"

APP=electron-app
CARPETA=win-unpacked
ZIP="$APP/dist/ArtTranslatorV2-Windows.zip"
LICENCIA="$APP/src/licencia.json"
TOKEN="$APP/src/informes.token.json"
CACHE=node-backend/node_modules/@huggingface/transformers/.cache

paso () { PASO="$*"; printf '\n== %s ==\n' "$PASO"; }
fallar () { printf 'ERROR en «%s»: %s\n' "${PASO:-?}" "$*" >&2; exit 1; }
trap 'printf "\nLa construcción se detuvo en el paso: %s\n" "${PASO:-?}" >&2' ERR

# ── 1. La licencia y el token ─────────────────────────────────────────
paso "1/7 Licencia e informes.token.json"
for f in "$LICENCIA" "$TOKEN"; do
  [ -f "$f" ] || fallar "falta $f (el ejemplo está en ${f%.json}.ejemplo.json)"
  # Los dos viajan dentro del paquete y NO entran a git nunca: uno es la licencia del cliente
  # y el otro un secreto de servicio.
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then fallar "$f está en git: sácalo con «git rm --cached» antes de construir"; fi
  git check-ignore -q "$f" || fallar "$f no está en .gitignore: un «git add -A» lo subiría"
done
node - "$LICENCIA" "$TOKEN" <<'JS'
const fs = require('fs')
const crypto = require('crypto')
const [rutaLicencia, rutaToken] = process.argv.slice(2)
const errores = []
const leer = ruta => {
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')) } catch (error) { errores.push(`${ruta} no es un JSON válido (${error.message})`); return {} }
}
const https = valor => typeof valor === 'string' && /^https:\/\//i.test(valor)

const licencia = leer(rutaLicencia)
if (!/^[0-9a-f]{32}$/.test(licencia.licencia)) errores.push('licencia.json: «licencia» son 32 caracteres hexadecimales en minúscula (los que imprime «licencias.sh crear»)')
try {
  if (crypto.createPublicKey(licencia.clavePublica).asymmetricKeyType !== 'ed25519') errores.push('licencia.json: «clavePublica» no es una clave Ed25519')
} catch {
  errores.push('licencia.json: «clavePublica» no es un PEM de clave pública (lo que imprime «node vps/licencias-cli.js claves <archivo>»)')
}
// La app acepta http solo hacia 127.0.0.1 (para las pruebas); un paquete para clientes, nunca.
if (!https(licencia.url)) errores.push('licencia.json: «url» tiene que empezar por https://')

const token = leer(rutaToken)
if (typeof token.token !== 'string' || !token.token.trim() || token.token === 'cámbiame') errores.push('informes.token.json: «token» sin rellenar')
if (!https(token.url)) errores.push('informes.token.json: «url» tiene que empezar por https://')

if (errores.length) {
  console.error(errores.map(e => `  - ${e}`).join('\n'))
  process.exit(1)
}
// Solo el principio: la licencia es la credencial de activación, pero así se ve de un vistazo si es la de prueba.
console.log(`  licencia ${licencia.licencia.slice(0, 6)}… · ${licencia.url}`)
console.log('  informes.token.json con forma válida')
JS

# ── 2. Los Marian ─────────────────────────────────────────────────────
paso "2/7 Un Marian cuantizado por idioma, en la caché"
# `npm ci` no trae los modelos: viven en node_modules/.cache y solo existen si alguien tradujo algo
# en esta máquina. Se piden al mismo registro de idiomas que usa la app (PLAN.md §0.19), así que un
# idioma nuevo entra solo. Traducir una vez con cada uno los baja si faltan y, de paso, prueba que
# cargan: es mejor enterarse ahora que a los cinco minutos de empaquetar.
MODELOS=$(node -e 'for (const i of require("./node-backend/src/idiomas").listarIdiomas()) console.log(i.modeloMarian + " " + i.calentamientoMarian)')
[ -n "$MODELOS" ] || fallar "el registro de idiomas no devolvió ningún modelo"
while read -r modelo palabra; do
  echo "  $modelo: traduciendo «${palabra}»"
  node -e 'require("./node-backend/src/translator").traducir(process.argv[2], process.argv[1]).then(r => console.log("    ->", r.es || "(vacío)"))' "$modelo" "$palabra"
  # Una medición con el modelo de precisión completa dejó 402 MB de variantes en la caché y el
  # paquete se los llevó: la app solo carga el cuantizado (dtype q8).
  find "$CACHE/$modelo/onnx" -name '*.onnx' ! -name '*quantized*' -print -delete | sed 's/^/    quito la variante /'
  for f in encoder_model_quantized.onnx decoder_model_merged_quantized.onnx; do
    [ -f "$CACHE/$modelo/onnx/$f" ] || fallar "a $modelo le falta $f en la caché"
  done
done <<< "$MODELOS"
# Un modelo entero que ningún idioma usa también se iría en el paquete. No se borra solo: es tu caché.
SOBRAN=$(cd "$CACHE" && find . -mindepth 2 -maxdepth 2 -type d | sed 's|^\./||' | grep -vxF -f <(printf '%s\n' "$MODELOS" | awk '{ print $1 }') || true)
[ -z "$SOBRAN" ] || fallar "la caché lleva modelos que ningún idioma usa; bórralos de $CACHE y vuelve a correr:
$SOBRAN"

# ── 3. El manifiesto de integridad ────────────────────────────────────
paso "3/7 Manifiesto de integridad del backend"
# Después de tocar cualquier archivo de node-backend/src o shared y antes de electron-builder:
# uno viejo bloquearía a todos los clientes con «Esta copia está modificada».
node herramientas/manifiesto-backend.js

# ── 4. electron-builder ───────────────────────────────────────────────
paso "4/7 electron-builder (npm run build:win)"
# Se borra lo anterior: electron-builder no limpia la carpeta, y el «Traductor Italiano.exe» de la
# v0.9 acabaría en el zip. El zip también: `zip` actualiza uno que ya existe en vez de reemplazarlo.
rm -rf "$APP/dist/$CARPETA" "$ZIP"
(cd "$APP" && npm run build:win)

# ── 5. El verificador ─────────────────────────────────────────────────
paso "5/7 verificar-paquete.sh"
bash verificar-paquete.sh "$APP/dist/$CARPETA"

# ── 6. El zip ─────────────────────────────────────────────────────────
paso "6/7 $ZIP"
# -X: sin los atributos extra de macOS. Sin -y, `zip` guarda el contenido de lo que apunta un enlace
# simbólico (node_modules/.bin/semver) y no el enlace, que es lo que Windows necesita: no sabe
# crear enlaces al extraer.
(cd "$APP/dist" && zip -r -X -q "$(basename "$ZIP")" "$CARPETA" -x '*.DS_Store')
unzip -tq "$ZIP" >/dev/null || fallar "el zip salió dañado"
# Sin tubería con `grep -q`: con pipefail, un grep que sale al primer acierto le da SIGPIPE a unzip y
# el paso fallaría de vez en cuando sin motivo.
ENTRADAS=$(unzip -Z1 "$ZIP")
grep -qx "$CARPETA/ArtTranslatorV2.exe" <<< "$ENTRADAS" || fallar "el zip no lleva $CARPETA/ArtTranslatorV2.exe"

# ── 7. El tamaño ──────────────────────────────────────────────────────
paso "7/7 Resultado"
BYTES=$(wc -c < "$ZIP" | tr -d ' ')
VERSION=$(node -p 'require("./electron-app/package.json").version')
echo "  $RAIZ/$ZIP"
echo "  versión $VERSION · $BYTES bytes · $((BYTES / 1000000)) MB ($((BYTES / 1048576)) MiB)"
echo "  la licencia incrustada empieza por $(node -p 'require("./electron-app/src/licencia.json").licencia.slice(0, 6)')…: comprueba que es la del cliente antes de publicar."
