#!/usr/bin/env bash
# Comprueba el paquete de Windows antes de enviarlo.
# `electron-builder` no verifica nada de esto por su cuenta, y cada punto de la
# lista corresponde a un fallo que rompería la app en el equipo del cliente.
set -u
D="${1:-electron-app/dist/win-unpacked}"
[ -d "$D" ] || { echo "No existe $D — construye primero con: cd electron-app && npm run build:win"; exit 1; }

ok=0; mal=0
chk () { if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; ok=$((ok+1)); else echo "  ✗ $1"; mal=$((mal+1)); fi }

echo "Verificando $D"
echo
chk "las 9 DLL ggml-cpu junto a ggml-base.dll (si no, el despacho falla en silencio)" \
   '[ -f "'"$D"'/resources/bin/ggml-base.dll" ] && [ $(ls "'"$D"'"/resources/bin/ggml-cpu-*.dll | wc -l) -eq 9 ]'
chk "onnxruntime de win32/x64 (si no, Marian no arranca)" \
   'find "'"$D"'/resources" -path "*win32/x64*" -name onnxruntime_binding.node | grep -q .'
chk "sharp de win32-x64 (transformers lo carga aunque no usemos imágenes)" \
   '[ -d "'"$D"'/resources/node-backend/node_modules/@img/sharp-win32-x64" ]'
chk "sin binarios de macOS sobrantes" \
   '[ ! -d "'"$D"'/resources/node-backend/node_modules/@img/sharp-darwin-arm64" ]'
chk "modelo multilingüe embebido, no descargado al arrancar" \
   '[ $(stat -f%z "'"$D"'/resources/models/ggml-small.bin" 2>/dev/null || stat -c%s "'"$D"'/resources/models/ggml-small.bin") -gt 400000000 ]'
chk "runtime de MSVC incluido (el zip de whisper.cpp NO lo trae)" \
   '[ -f "'"$D"'/resources/vc_redist.x64.exe" ]'
chk "whisper-server.exe" '[ -f "'"$D"'/resources/bin/whisper-server.exe" ]'
chk "audio italiano de prueba" \
   '[ -f "'"$D"'/resources/node-backend/test/fixtures/italiano.wav" ]'
chk "instrucciones para el cliente" '[ -f "'"$D"'/resources/LEEME.txt" ]'
echo
echo "  $ok correctas · $mal fallidas"
[ "$mal" -eq 0 ] || exit 1
