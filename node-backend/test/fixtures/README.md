# Audio de prueba

`italiano.wav` — 6,5 s de italiano a 16 kHz mono, que es el formato que espera
Whisper. `italiano.txt` lleva la frase original para poder comparar.

## Cómo regenerarlo

Se genera con la voz italiana de macOS, así que es reproducible y no depende de
ninguna descarga:

```bash
say -v Alice -o /tmp/it.aiff "$(cat italiano.txt)"
ffmpeg -y -i /tmp/it.aiff -ar 16000 -ac 1 -c:a pcm_s16le italiano.wav
```

## Lo que este audio NO prueba

Es voz sintética limpia: sin eco de sala, sin solapamiento, sin compresión de
VoIP y sin acento regional. El WER real sobre audio de reunión es entre dos y
tres veces peor — ver `PLAN.md` §3. Sirve para verificar que el pipeline
funciona, **no** para estimar la calidad que verá el cliente.

Para eso hacen falta los 20-30 minutos de audio real de una reunión suya que
pide `PLAN.md` §15.
