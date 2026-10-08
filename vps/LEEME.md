# Receptor de informes (F039a) + vista privada y despliegue por Coolify (F039c)

Qué es: un servicio HTTP mínimo, sin dependencias de npm, que recibe el
`.jsonl` de cada reunión (o su versión solo-métricas) y lo guarda en disco en
el VPS del equipo. Nace del pedido del cliente (19-09-2026): la app es de
Windows y mandar el informe por WhatsApp a cada prueba no escala. La
**transcripción para el uso del cliente se queda siempre en su equipo**; lo
que sube aquí es el informe completo para que el equipo lo analice.

**Host definitivo: `https://arturoocampo.com/informes`** (F039c). El host
anterior, `arttranslator.81.17.100.181.sslip.io`, era el paso intermedio
mientras no había token de la API de Coolify (19-09-2026, ver la bitácora del
plan); ya no es el que usa la app.

Esta pieza es solo el receptor. El cliente que sube el `.jsonl` desde la app
(reintentos, consentimiento en tres estados, etc.) es F039b, aparte — ya hecho: `node-backend/src/informes.js` + `electron-app/src/informes.token.json`.

## Contrato de subida

```
POST https://arturoocampo.com/informes
Authorization: Bearer <INFORMES_TOKEN>      (nunca en la URL)
Content-Type: application/x-ndjson
X-Maquina: <máquina, solo [A-Za-z0-9._-], máx 64>
X-Version: <versión de la app, p.ej. 0.5.0>
X-Reunion: <AAAAMMDD-HHMMSS-id>

<cuerpo: el .jsonl tal cual, tope 20 MB>
```

El receptor acepta también la ruta **sin** el prefijo (`POST /` con el mismo
cuerpo y cabeceras) — según cómo quede montado el router de Traefik detrás de
Coolify, la petición puede llegarle con `/informes` delante o ya sin él; los
dos casos van al mismo manejador (`quitaPrefijo` en `servidor.js`). Lo mismo
vale para `GET /salud` / `GET /informes/salud`.

| Respuesta | Motivo |
|---|---|
| `201 {"id":"..."}` | guardado; `id` es el nombre del archivo en disco |
| `401` | falta el token o no coincide |
| `413` | el cuerpo pasa de 20 MB |
| `415` | `Content-Type` distinto de `application/x-ndjson` |
| `400` | `X-Maquina`, `X-Version` o `X-Reunion` no cumplen el alfabeto cerrado |
| `429` | más de 30 subidas por minuto de la misma máquina (ver «Límite de subidas» abajo) |
| `500` | fallo real de disco al guardar (EACCES, sin espacio…); el receptor sigue vivo |
| `405` | cualquier método que no sea `POST /` o `GET /salud` (con o sin prefijo) |
| `404` | cualquier otra ruta, o `GET /` si la vista privada no está configurada |

`GET /salud` responde `200` con el cuerpo `ok` en texto plano.

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

## Vista privada (F039c): `GET /informes/`

Lista por fecha y permite descargar, protegida con **HTTP Basic sobre
HTTPS** (el TLS lo sigue terminando Traefik delante del contenedor).
Existe **solo si** el entorno trae `INFORMES_USUARIO` e `INFORMES_CLAVE` —
si falta cualquiera de las dos, `GET /` e `GET /informes/` responden `404`
como si la ruta no existiera, y `POST /` (la subida) sigue funcionando
igual: la vista es un añadido opcional, nunca una condición para recibir
informes.

```
GET https://arturoocampo.com/informes/
Authorization: Basic <usuario:clave, en base64>
```

- Sin credenciales o con credenciales incorrectas: `401` con cabecera
  `WWW-Authenticate: Basic realm="Informes ArtTranslator"`.
- Con las correctas: `200`, HTML sencillo en castellano con una sección por
  fecha (más reciente primero) y, dentro, cada archivo con su nombre,
  tamaño legible y hora de escritura.
- La comparación de usuario y clave es la misma función HMAC en tiempo
  constante que ya usaba el token de subida (`comparaConstante`), y las dos
  partes de la credencial se comparan siempre las dos, aunque la primera ya
  haya fallado, para no dejar una diferencia de tiempo entre "usuario mal"
  y "clave mal".
- **Freno de fuerza bruta:** más de 10 fallos de autenticación por minuto y
  por IP → `429`, antes incluso de mirar las credenciales de esa petición.
  Mapa aparte del de la subida: agotar este freno no toca el cupo de 30/min
  de `POST /`, ni al revés.
- **Descarga:** `GET /informes/<fecha>/<archivo>` con el mismo Basic.
  `<fecha>` tiene que tener forma `AAAA-MM-DD` y `<archivo>` no puede llevar
  `/`, `\` ni `..` — después de esas dos comprobaciones, la ruta resuelta se
  verifica una tercera vez contra `/datos/informes` antes de leer el
  archivo, así que no hay combinación de cabeceras que saque una respuesta
  fuera de ese directorio.
- Todas las respuestas de la vista llevan `Cache-Control: no-store`: nada
  de lo que devuelve (ni el listado ni el `.jsonl`) debe quedar en una
  caché intermedia de Traefik ni del navegador.
- No hay sesión ni cookie: cada petición vuelve a mandar el Basic. Es
  intencional — un usuario y una clave de equipo, no de persona, para un
  puñado de personas que revisan informes de vez en cuando.

## Desplegar

**Definitivo: por la API de Coolify** (F039c), en un proyecto `ArtTranslator`
ya creado en el VPS del equipo:

```bash
./desplegar-coolify.sh
```

Lee `COOLIFY_TOKEN`, `COOLIFY_PROYECTO`, `COOLIFY_SERVIDOR` y
`COOLIFY_GITHUB_APP` del `.env` de la **raíz** del repo (nunca los
imprime), y `INFORMES_TOKEN`/`INFORMES_USUARIO`/`INFORMES_CLAVE` de
`vps/.env`. Es idempotente (busca la app `arttranslator-informes` por
nombre antes de crearla), fija `base_directory=/vps`,
`dockerfile_location=/Dockerfile`, `ports_exposes=3000` y el dominio
`https://arturoocampo.com/informes`, sube las tres variables como entorno
de la app, **se niega a desplegar si no hay almacenamiento persistente
para `/datos/informes`** (así el próximo redespliegue de Coolify no borra
los informes ya subidos) y termina comprobando `/informes/salud` en el
dominio real. Si la GitHub App de Coolify no ve el repositorio (es
privado), el guion lo dice y deja impresos los pasos exactos para la
alternativa de *deploy key*.

La API de Coolify solo escucha en `127.0.0.1:8000` del propio VPS, así que
el guion habla con ella por dentro de un `ssh` al alias `vmi` — necesita
ese alias en `~/.ssh/config` (o `INFORMES_HOST=usuario@host`).

**Quién lo ejecuta:** el líder, nunca como parte de implementar una tarea —
el guion no se corre contra el VPS real hasta que el líder decide desplegar
de verdad.

### Alternativa manual, sin Coolify (histórica, F039a)

`./desplegar.sh` sigue existiendo: hace `rsync` de este directorio a un
`docker compose up -d --build` propio, con las etiquetas de Traefik ya en
`docker-compose.yml` apuntando al host provisional
`arttranslator.81.17.100.181.sslip.io`. Era el camino mientras no había
token de la API de Coolify (19-09-2026); se conserva por si algún día hace
falta levantar el receptor fuera de Coolify, pero **no es el que sirve el
host actual**.

## Bajar los informes

```bash
./descargar.sh
```

Un solo comando: `rsync` de `/opt/arttranslator/informes/` en el VPS a
`./informes/` en local (que queda fuera de git). Sobrescribe con lo que haya
cambiado en el servidor; no borra nada local que ya no esté allí. (Con
Coolify, la ruta del bind mount en el host puede ser otra — ajustar
`INFORMES_DESTINO` si hace falta.)

## Configuración

Copia `.env.ejemplo` a `.env` y pon valores reales:

```bash
cp .env.ejemplo .env
# edita .env: INFORMES_TOKEN=<algo largo y aleatorio>
#             INFORMES_USUARIO=<usuario de la vista>
#             INFORMES_CLAVE=<clave larga y aleatoria>
```

El receptor **se niega a arrancar** si `INFORMES_TOKEN` no está definido.
`INFORMES_USUARIO`/`INFORMES_CLAVE` son aparte: sin ellas el receptor
arranca igual, solo que sin la vista privada (ver más arriba).

## El riesgo asumido: el token viaja dentro del paquete de la app

La app de Windows lleva el token incrustado para poder subir sin pedirle
nada al usuario (§10 del plan: cero fricción en la instalación). Cualquiera
que desempaquete el `.exe` puede sacarlo. El riesgo se acepta a propósito y
se acota por diseño:

- El token **solo sirve para subir** (`POST /`). No hay ningún endpoint que
  liste, lea ni borre con él — eso es lo que separa la vista privada
  (usuario/clave aparte, solo para quien la use a mano desde un navegador)
  de la subida (token, incrustado en la app).
- Límite de 30 subidas por minuto por máquina real (ver «Límite de
  subidas» arriba — no es la IP del socket TCP sin más, sería inútil detrás
  de Traefik), y 20 MB por subida: aunque el token se filtre, el daño
  posible es "puede escribir archivos", no "puede leer ni vaciar nada". Sí
  puede llenar disco a fuerza de insistir: no hay retención automática
  todavía (`[por medir]`, queda para cuando haya volumen real de reuniones).

### Rotación de credenciales

- **`INFORMES_TOKEN`** (subida): se genera uno nuevo, se sube como variable
  de entorno en Coolify (`./desplegar-coolify.sh`, o a mano en el panel) y
  se reempaqueta la app de Windows con el nuevo valor en
  `electron-app/src/informes.token.json`. No hay usuarios ni sesiones que
  migrar: es un token de servicio, no de persona, así que el anterior deja
  de servir en el momento en que se actualiza el entorno del contenedor.
- **`INFORMES_USUARIO`/`INFORMES_CLAVE`** (vista): igual, variable de
  entorno nueva en Coolify; no hace falta reempaquetar nada porque nadie
  fuera del equipo las lleva incrustadas. Rotarlas no interrumpe la
  subida — son entornos independientes del receptor.
- En los dos casos, el freno por IP (30/min subida, 10/min fallos de auth)
  sigue funcionando con las credenciales nuevas sin cambios de código.

## Licencias (F053)

La activación de ArtTranslatorV2 con tope de equipos (`PLAN.md` §17.6): un solo zip con la
licencia dentro, y el equipo que pase del tope no obtiene permiso. La ruta cuelga del router
de Traefik que ya existe (`PathPrefix(/informes)`), así que no hay nada que tocar en
Traefik; el servidor la acepta también sin el prefijo. El código es `licencias.js` (almacén,
activación y firma, compartido con la herramienta de administración) y la ruta, `servidor.js`.

```
POST https://arturoocampo.com/informes/licencias/activar
Content-Type: application/json

{ "licencia": "<32 hex>", "huellas": { "maquina": "<64 hex>", "placa": "<64 hex> o null" },
  "equipo": "<[A-Za-z0-9._-], máx 64>", "version": "1.0.0" }
```

| Respuesta | Motivo |
|---|---|
| `200 {"permiso","firma"}` | `permiso` es base64url del JSON `{licencia, huellas, emitido, caduca}` (milisegundos desde 1970; `caduca` = ahora + `LICENCIAS_DIAS`, 14 por defecto). `firma` es la de Ed25519 sobre esos mismos bytes, en base64url |
| `403 {"motivo":"tope","usados","maximo","contacto"}` | equipo nuevo y la licencia ya no tiene plazas |
| `403 {"motivo":"denegada","contacto"}` | licencia inexistente **o** revocada: la misma respuesta, byte a byte y con el contacto del servidor, para no revelar cuáles existen |
| `400` `413` `415` `405` | campo fuera de su alfabeto (`campo` dice cuál) / cuerpo de más de 4 KiB / no es `application/json` / no es `POST` |
| `429` | más de 10 activaciones por minuto desde la misma IP real (cupo propio, aparte del de las subidas) |
| `500` `503` | fallo de disco / sin `LICENCIAS_CLAVE_PRIVADA` válida. Transitorios: la app sigue con el permiso que tenga (PLAN §0.21) |

Todas las respuestas llevan `Cache-Control: no-store`.

**Qué es un equipo.** Es conocido si coincide la `placa`, o si coincide la `maquina` y la
placa no la contradice (es la misma, o alguna de las dos falta: `null` en la petición, o un
equipo que nunca tuvo placa). Reinstalar Windows en la misma computadora cambia la máquina y
no la placa, así que sigue siendo el mismo equipo y su huella nueva se guarda; un MachineGuid
copiado a otra computadora, o un Windows clonado en otra placa, cuenta como otro equipo (regla
corregida en la revisión de F053; PLAN §17.6). Solo se guardan las huellas de una petición
que coincidió. Un equipo conocido actualiza su última vez, su versión y su nombre. Cada
activación queda en el registro de su licencia (fecha, huellas, equipo, versión y resultado
`nuevo`, `conocido`, `tope` o `revocada`; las últimas 500, más un contador total), gaste
plaza o no. Una licencia que no existe no deja rastro.

**Administración**, por ssh y sobre el mismo almacén:

```bash
./licencias.sh crear "Cliente" [maximo] [contacto]   # imprime el id (128 bits); maximo 6 por defecto
./licencias.sh listar                                 # equipos por licencia: nombre, primera y última vez, versión, cuántas huellas de máquina y de placa; y activaciones
./licencias.sh liberar <licencia> <prefijo-huella>    # prefijo (6 hex o más) de la máquina o placa que muestra «listar»
./licencias.sh revocar <licencia>
./licencias.sh tope <licencia> <n>
```

**La clave.** Se genera **en local**, no en el VPS (`licencias.sh claves` se niega):
`node licencias-cli.js claves ~/fuera-del-repo/licencias.pem` (el archivo es obligatorio, y
fuera del repo) escribe la privada con permisos 600 (no pisa una existente) e imprime solo la
pública, que se incrusta en la app. Guarda ese `.pem` bien: es la copia de seguridad de la
clave que firma los permisos, y sin ella habría que generar otra y reempaquetar la app con la
pública nueva. En el `.env` del VPS la privada va en **una** línea, con los saltos escritos
como `\n`, y **sin pasar por la terminal**: la receta la manda directa al `.env` por ssh.

```bash
printf '\nLICENCIAS_CLAVE_PRIVADA=%s\n' "$(awk 'NF { sub(/\r/, ""); printf "%s\\n", $0 }' ~/fuera-del-repo/licencias.pem)" \
  | ssh "${INFORMES_HOST:-root@vmi}" "cat >> ${INFORMES_DESTINO:-/opt/arttranslator}/.env"
```

Se hace una sola vez (para cambiarla, se edita esa línea en el VPS); el `\n` del principio
cubre un `.env` que no acabe en salto de línea. Con `printf` y no con `echo`: el `echo` de
zsh, el shell de macOS, convierte esos `\n` en saltos reales y deja la variable partida.

Sin ella, o con una que no sea Ed25519 PKCS8, la ruta responde 503 y el resto del receptor
funciona igual. Al arrancar, el log dice `Licencias activas: … huella de la clave pública …`:
tiene que coincidir con la que imprime `claves`, porque es la que verifica la app. Para ver
que la ruta está viva sin gastar plaza, un `POST` con cuerpo `{}` da `400` (con clave) o `503`
(sin ella).

**Datos y despliegue.** El almacén es `/datos/licencias/licencias.json`, en el volumen
`./licencias`, aparte de los informes. Se escribe de forma atómica, se relee en cada petición
y la herramienta y el servidor comparten un candado, así que `liberar` o `revocar` valen desde
la siguiente activación sin reiniciar nada. **`desplegar.sh` no lo toca**
(`--exclude 'licencias/'`: sin eso, `--delete` borraría el registro entero en cada
despliegue), tampoco sube ningún `*.pem` (`rsync` no mira el `.gitignore`) y crea la carpeta
con dueño `100:101` y permisos 700. Se respalda como `informes/`.
`desplegar-coolify.sh` no monta ese volumen: las licencias solo están soportadas con `desplegar.sh`.

**Privacidad.** El almacén guarda la licencia, las huellas (hashes que calcula la app con la
licencia como sal: el servidor nunca ve el identificador original), el nombre del equipo, la
versión y las fechas. Nada de la reunión ni la IP. El log lleva 8 hex de la licencia, el
resultado y la versión.

## Pruebas

```bash
npm test
```

`node --test` sobre `test/servidor.test.js` (30 pruebas) y
`test/licencias.test.js` (13, F053: tope, placa, MachineGuid copiado, revocada, firma, `liberar`, 503, etc.). Arranca el
servidor real en un puerto efímero con un directorio temporal (nunca toca
`/datos/informes`) y cubre cada respuesta del contrato, más las funciones
puras (saneado de cabeceras, ventana de subidas, partición de fecha) por
separado.

**Mutación documentada (F039a):** quitar el saneado de `saneaCabecera`
(dejar pasar cualquier valor no vacío) hace caer dos pruebas: la unitaria
de `saneaCabecera` y la de integración `400: X-Maquina con intento de
traversal se rechaza` — con la comprobación desactivada, una `X-Maquina:
../x` responde `201` en vez de `400`.

**F039c (política del 20-09-2026, "lo esencial"):** una prueba por
criterio — prefijo, vista 401/200, traversal en la descarga, vista ausente
sin las credenciales — sin mutación aparte: el freno de la vista
(`fallosAuthRecientes`/`registraFalloAuth`) reutiliza el mismo mecanismo de
ventana que `permiteSubida`, ya probado con sus dos orillas más arriba.

**Mutación documentada (F053):** cambiar `lic.equipos.length < lic.maximo` por `<=` en
`activarEquipo` (el tope, el mecanismo central) hace caer cinco pruebas: el tope de 6, las
ocho activaciones simultáneas, la placa repetida, el MachineGuid copiado y `liberar`: el
equipo 7 recibe permiso. La regla de equipo conocido de la revisión no se mutó: su prueba
se escribió primero y cayó contra el código anterior, con «cualquiera de las dos».

## Por qué no es un framework

Es un servicio de una sola ruta con lógica simple (auth, tamaño, saneado,
límite de tasa, escritura atómica). `http`, `fs`, `path` y `crypto` de Node
bastan; añadir Express o similar sería una dependencia más para mantener y
para auditar, a cambio de nada que este servicio necesite.
