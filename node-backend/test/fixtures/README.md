# Audio de prueba

`italiano.wav` — 6,5 s de italiano a 16 kHz mono, que es el formato que espera
Whisper. `italiano.txt` lleva la frase original para poder comparar.

`ingles.wav` — 5,7 s de inglés, mismo formato (16 kHz mono PCM16) y la misma
frase de reunión que el italiano, dicha con la voz Samantha. `ingles.txt` lleva
el texto original. Es la muestra de la comprobación previa del inglés
(`PLAN.md` §17.3) y lo que se manda a AssemblyAI para medir el idioma (§17.8).

`turnos-f056.json` — los mensajes `Turn` que AssemblyAI mandó de verdad a
`AssemblyLiveTranscriber` con `italiano.wav` a tiempo real (08-10-2026, F056), en
cuatro sesiones: dos en las que el servidor parte el turno en la pausa de 250 ms
entre las dos oraciones y el final de la segunda llega sin «Il»; una partida con
la pausa alargada a 700 ms, que llega entera; y una sin partir. Se conservan sólo
los de tipo `Turn`, en su orden y sin tocar, y `assemblyLive.test.js` los repite
sin red. No llevan claves ni identificadores de sesión. La pausa entre las dos
oraciones de `italiano.wav` mide 250 ms (de 2.450 a 2.700 ms) `[medido]`. No se
regenera con `say`: es una grabación del servicio, y se vuelve a medir con
`.arnes/medicion/medir_palabra_perdida.js`.

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
