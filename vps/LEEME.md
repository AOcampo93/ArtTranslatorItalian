# Receptor de informes (F039a)

Qué es: un servicio HTTP mínimo, sin dependencias de npm, que recibe el
`.jsonl` de cada reunión (o su versión solo-métricas) y lo guarda en disco en
el VPS del equipo. Nace del pedido del cliente (19-09-2026): la app es de
Windows y mandar el informe por WhatsApp a cada prueba no escala. La
**transcripción para el uso del cliente se queda siempre en su equipo**; lo
que sube aquí es el informe completo para que el equipo lo analice.

Esta pieza es solo el receptor. El cliente que sube el `.jsonl` desde la app
(reintentos, consentimiento en tres estados, etc.) es F039b, aparte.

## Contrato de subida

```
POST https://arttranslator.81.17.100.181.sslip.io/informes
Authorization: Bearer <INFORMES_TOKEN>      (nunca en la URL)
Content-Type: application/x-ndjson
X-Maquina: <máquina, solo [A-Za-z0-9._-], máx 64>
X-Version: <versión de la app, p.ej. 0.5.0>
X-Reunion: <AAAAMMDD-HHMM-id>

<cuerpo: el .jsonl tal cual, tope 20 MB>
```

| Respuesta | Motivo |
|---|---|
| `201 {"id":"..."}` | guardado; `id` es el nombre del archivo en disco |
| `401` | falta el token o no coincide |
| `413` | el cuerpo pasa de 20 MB |
| `415` | `Content-Type` distinto de `application/x-ndjson` |
| `400` | `X-Maquina`, `X-Version` o `X-Reunion` no cumplen el alfabeto cerrado |
| `429` | más de 30 subidas por minuto de la misma máquina (ver «Límite de subidas» abajo) |
| `500` | fallo real de disco al guardar (EACCES, sin espacio…); el receptor sigue vivo |
| `405` | cualquier método que no sea `POST /informes` o `GET /salud` |
| `404` | cualquier otra ruta |

`GET /salud` responde `200` con el cuerpo `ok` en texto plano.

**No hay listado ni descarga por HTTP, a propósito.** Los informes llevan
texto real de reuniones; la única vía de lectura es `ssh` (ver más abajo).

### Dónde queda cada informe

```
/datos/informes/<AAAA-MM-DD>/<X-Maquina>-<HHMMSS>-<X-Version>-<X-Reunion>.jsonl
```

`HHMMSS` lo pone el propio servidor (hora del recibo, UTC), no la cabecera.
Las tres cabeceras se sanean contra `^[A-Za-z0-9._-]{1,64}$` y se rechaza
cualquier valor que contenga `..`, así que no hay forma de que una cabecera
escriba fuera de su directorio de fecha.

### Límite de subidas: por máquina real, no por conexión TCP

El servicio no publica puertos: en el VPS solo Traefik llega directo a este
contenedor (red `coolify`, interna). Por eso el límite de 30/min se calcula
sobre la IP real del cliente, tomada de `X-Forwarded-For` — pero **solo**
cuando quien conecta directo es de confianza (Traefik, o cualquier otro par
en un rango privado de Docker); si algún día el par directo fuera una IP
pública, la cabecera se ignora y se usa esa IP tal cual, porque cualquiera
podría habérsela inventado. El freno se cobra **después** de comprobar el
token: los intentos con token inválido no gastan el cupo de nadie.

## Desplegar

```bash
./desplegar.sh
```

Hace `rsync` de este directorio (sin `informes/` ni `.env` locales) a
`root@vmi:/opt/arttranslator`, prepara `informes/` en el servidor con el
dueño correcto (`chown 100:101`, el uid/gid fijo del usuario del contenedor
— ver `Dockerfile`; el bind mount de `docker-compose.yml` necesita esto
*antes* de `up`, si no la primera subida real falla con `EACCES`), levanta
`docker compose up -d --build` y comprueba `/salud` con reintentos de hasta
30 s (el primer certificado de Let's Encrypt puede tardar). Necesita el
alias `vmi` en `~/.ssh/config` (o `INFORMES_HOST=usuario@host ./desplegar.sh`)
y que exista `/opt/arttranslator/.env` en el servidor con un `INFORMES_TOKEN`
real — este script no lo sube: se copia una vez a mano, o se pide
explícitamente.

**Quién lo ejecuta:** el líder, no el implementador de F039a — así lo pide la
tarea.

## Bajar los informes

```bash
./descargar.sh
```

Un solo comando: `rsync` de `/opt/arttranslator/informes/` en el VPS a
`./informes/` en local (que queda fuera de git). Sobrescribe con lo que haya
cambiado en el servidor; no borra nada local que ya no esté allí.

## Configuración

Copia `.env.ejemplo` a `.env` y pon un token real:

```bash
cp .env.ejemplo .env
# edita .env y pon INFORMES_TOKEN=<algo largo y aleatorio>
```

El receptor **se niega a arrancar** si `INFORMES_TOKEN` no está definido.

## El riesgo asumido: el token viaja dentro del paquete de la app

La app de Windows lleva el token incrustado para poder subir sin pedirle
nada al usuario (§10 del plan: cero fricción en la instalación). Cualquiera
que desempaquete el `.exe` puede sacarlo. El riesgo se acepta a propósito y
se acota por diseño:

- El token **solo sirve para subir** (`POST /informes`). No hay ningún
  endpoint que liste, lea ni borre con él.
- Límite de 30 subidas por minuto por máquina real (ver «Límite de
  subidas» arriba — no es la IP del socket TCP sin más, sería inútil detrás
  de Traefik), y 20 MB por subida: aunque el token se filtre, el daño
  posible es "puede escribir archivos", no "puede leer ni vaciar nada". Sí
  puede llenar disco a fuerza de insistir: no hay retención automática
  todavía (`[por medir]`, queda para cuando haya volumen real de reuniones).
- Si el token se compromete, se rota (`.env` en el servidor + reconstruir el
  contenedor) y se reempaqueta la app. No hay usuarios ni sesiones que
  migrar: es un token de servicio, no de persona.

## Pruebas

```bash
npm test
```

`node --test` sobre `test/servidor.test.js`. Arranca el servidor real en un
puerto efímero con un directorio temporal (nunca toca `/datos/informes`) y
cubre cada respuesta del contrato, más las funciones puras (saneado de
cabeceras, ventana de subidas, partición de fecha) por separado.

**Mutación documentada:** quitar el saneado de `saneaCabecera` (dejar pasar
cualquier valor no vacío) hace caer dos pruebas: la unitaria de
`saneaCabecera` y la de integración `400: X-Maquina con intento de
traversal se rechaza` — con la comprobación desactivada, una `X-Maquina:
../x` responde `201` en vez de `400`.

## Por qué no es un framework

Es un servicio de una sola ruta con lógica simple (auth, tamaño, saneado,
límite de tasa, escritura atómica). `http`, `fs`, `path` y `crypto` de Node
bastan; añadir Express o similar sería una dependencia más para mantener y
para auditar, a cambio de nada que este servicio necesite.
