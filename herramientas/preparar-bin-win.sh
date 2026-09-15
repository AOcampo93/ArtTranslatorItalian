#!/usr/bin/env bash
#
# Deja bin-win/ listo para empaquetar: los binarios de whisper.cpp más el
# runtime de MSVC.
#
# bin-win/ está en .gitignore —son 12 MB de binarios que no deben vivir en el
# repositorio— así que un clon limpio no la tiene. Este script la reconstruye
# sin pasos manuales, que es lo que permite que el empaquetado sea reproducible
# en otra máquina y no dependa de lo que alguien copió a mano una tarde.
#
#   ./herramientas/preparar-bin-win.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

# El tag va anclado a propósito. No se usa "latest release": el tag v1.9.4 NO
# tiene assets, y un script que apunte ahí no descargaría nada y fallaría sin
# explicar por qué. La regla tampoco es estable (v1.9.2 sí los tiene), así que
# se fija el tag exacto y se verifica el tamaño.
TAG=b5130
ZIP_BYTES=8573270
URL="https://github.com/ggml-org/whisper.cpp/releases/download/$TAG/whisper-bin-x64.zip"

# Los 13 que se usan. El zip trae 40: fuera quedan los binarios de test,
# llama.dll, parakeet.*, wchess.exe y un SDL2.dll fechado en 2023.
NECESARIOS=(
  whisper-server.exe whisper.dll ggml.dll ggml-base.dll
  ggml-cpu-alderlake.dll ggml-cpu-cannonlake.dll ggml-cpu-cascadelake.dll
  ggml-cpu-haswell.dll ggml-cpu-icelake.dll ggml-cpu-sandybridge.dll
  ggml-cpu-skylakex.dll ggml-cpu-sse42.dll ggml-cpu-x64.dll
)

DESTINO="${1:-bin-win}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DESTINO"

echo "whisper.cpp $TAG"
curl -sLf --max-time 300 -o "$TMP/w.zip" "$URL"
REAL=$(stat -f%z "$TMP/w.zip" 2>/dev/null || stat -c%s "$TMP/w.zip")
if [ "$REAL" != "$ZIP_BYTES" ]; then
  echo "  El zip mide $REAL bytes y se esperaban $ZIP_BYTES." >&2
  echo "  El asset del tag $TAG ha cambiado: revísalo antes de seguir." >&2
  exit 1
fi
echo "  $REAL bytes, como se esperaba"

unzip -qo "$TMP/w.zip" -d "$TMP/z"
for f in "${NECESARIOS[@]}"; do
  origen=$(find "$TMP/z" -name "$f" -type f | head -1)
  [ -n "$origen" ] || { echo "  El zip no trae $f" >&2; exit 1; }
  cp "$origen" "$DESTINO/$f"
done
echo "  ${#NECESARIOS[@]} archivos copiados (de 40 que trae el zip)"
echo

# El runtime de MSVC va aparte: el zip de whisper.cpp no lo trae, y sin él
# whisper-server.exe muere con 0xC0000135 en un Windows limpio.
python3 herramientas/extraer-runtime-msvc.py "$DESTINO"
echo

# Y la comprobación que de verdad cierra el asunto.
node herramientas/dependencias-windows.js "$DESTINO" | tail -3
