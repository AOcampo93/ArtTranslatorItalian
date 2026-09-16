#!/usr/bin/env bash
# Comprueba el paquete de Windows antes de enviarlo.
#
# La versión 1 transcribe en la nube, así que las comprobaciones de whisper
# local —las nueve DLL ggml-cpu, el runtime de MSVC, el modelo de 465 MB— ya
# no aplican: eso no viaja. Lo que sí tiene que viajar es Marian, onnxruntime
# de Windows, sharp de Windows y el audio de prueba.
# `electron-builder` no verifica nada de esto por su cuenta, y cada punto de la
# lista corresponde a un fallo que rompería la app en el equipo del cliente.
set -u
D="${1:-electron-app/dist/win-unpacked}"
[ -d "$D" ] || { echo "No existe $D — construye primero con: cd electron-app && npm run build:win"; exit 1; }

ok=0; mal=0
chk () { if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; ok=$((ok+1)); else echo "  ✗ $1"; mal=$((mal+1)); fi }

echo "Verificando $D"
echo
chk "onnxruntime de win32/x64 (si no, Marian no arranca)" \
   'find "'"$D"'/resources" -path "*win32/x64*" -name onnxruntime_binding.node | grep -q .'
chk "sharp de win32-x64 (transformers lo carga aunque no usemos imágenes)" \
   '[ -d "'"$D"'/resources/node-backend/node_modules/@img/sharp-win32-x64" ]'
chk "sin binarios de macOS sobrantes" \
   '[ ! -d "'"$D"'/resources/node-backend/node_modules/@img/sharp-darwin-arm64" ]'
# El modelo de Marian viaja dentro de node_modules/.cache, que solo existe si
# alguien tradujo algo en la máquina de compilación: `npm ci` en un clon limpio
# NO lo trae. Sin esta comprobación, una máquina de compilación nueva produciría
# un paquete sin modelo y la app intentaría descargarlo en casa del cliente —en
# medio de una reunión, y sin explicar por qué no traduce.
chk "modelo de Marian embebido (npm ci NO lo trae: hay que traducir una vez antes de empaquetar)" \
   'M="'"$D"'/resources/node-backend/node_modules/@huggingface/transformers/.cache/Xenova/opus-mt-it-es/onnx";
    [ -f "$M/encoder_model_quantized.onnx" ] && [ -f "$M/decoder_model_merged_quantized.onnx" ] &&
    [ $(cat "$M/encoder_model_quantized.onnx" "$M/decoder_model_merged_quantized.onnx" | wc -c) -gt 50000000 ]'
chk "ws, que es el WebSocket de la transcripción en vivo" \
   '[ -d "'"$D"'/resources/node-backend/node_modules/ws" ]'
chk "audio italiano de prueba" \
   '[ -f "'"$D"'/resources/node-backend/test/fixtures/italiano.wav" ]'
chk "instrucciones para el cliente" '[ -f "'"$D"'/resources/LEEME.txt" ]'
echo
echo "  $ok correctas · $mal fallidas"
[ "$mal" -eq 0 ] || exit 1
