# Audio de prueba

`italiano.wav` — 6,5 s de italiano a 16 kHz mono, que es el formato que espera
Whisper. `italiano.txt` lleva la frase original para poder comparar.

`ingles.wav` — 5,7 s de inglés, mismo formato (16 kHz mono PCM16) y la misma
frase de reunión que el italiano, dicha con la voz Samantha. `ingles.txt` lleva
el texto original. Es la muestra de la comprobación previa del inglés
(`PLAN.md` §17.3) y lo que se manda a AssemblyAI para medir el idioma (§17.8).

## Cómo regenerarlo

Se generan con las voces de macOS (Alice para el italiano, Samantha para el
inglés), así que es reproducible y no depende de ninguna descarga:

```bash
say -v Alice -o /tmp/it.aiff "$(cat italiano.txt)"
ffmpeg -y -i /tmp/it.aiff -ar 16000 -ac 1 -c:a pcm_s16le italiano.wav

say -v Samantha -o /tmp/en.aiff "$(cat ingles.txt)"
ffmpeg -y -i /tmp/en.aiff -ar 16000 -ac 1 -c:a pcm_s16le ingles.wav
```

Comprobación del formato (debe decir `pcm_s16le`, 16000 Hz, 1 canal):

```bash
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of default=nw=1 ingles.wav
```

## Lo que este audio NO prueba

Es voz sintética limpia: sin eco de sala, sin solapamiento, sin compresión de
VoIP y sin acento regional. El WER real sobre audio de reunión es entre dos y
tres veces peor — ver `PLAN.md` §3. Sirve para verificar que el pipeline
funciona, **no** para estimar la calidad que verá el cliente.

Para eso hacen falta los 20-30 minutos de audio real de una reunión suya que
pide `PLAN.md` §15.
