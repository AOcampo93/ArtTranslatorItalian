#!/usr/bin/env bash
# Crea o actualiza la app "arttranslator-informes" en Coolify (F039c), por su
# API, y la despliega bajo https://arturoocampo.com/informes.
#
# NO lo ejecuta el implementador de F039c ni este guion se corre como parte
# de la tarea: lo corre el líder, cuando decide que toca desplegar de verdad
# contra el VPS.
#
# Variables: COOLIFY_TOKEN, COOLIFY_PROYECTO, COOLIFY_SERVIDOR,
# COOLIFY_GITHUB_APP salen del .env de la RAÍZ del repo (nunca de vps/.env,
# y nunca se imprimen). INFORMES_TOKEN, INFORMES_USUARIO, INFORMES_CLAVE
# salen de vps/.env y se suben como variables de entorno de la app.
#
# La API de Coolify solo escucha en 127.0.0.1:8000 del propio VPS
# [verificado por el líder, 19-09-2026] — no hay puerto expuesto a Internet
# a propósito — así que cada llamada viaja dentro de un `ssh` al alias
# `vmi` (o $INFORMES_HOST). El secreto NUNCA es texto de un comando: se
# escribe en un archivo temporal remoto por `stdin` (un `here-string`, que
# viaja como datos, no como argumentos de shell) y las llamadas posteriores
# lo leen de ahí con `$(cat ese-archivo)`, ejecutado en el shell remoto. Así
# ninguna cadena que contenga el token pasa nunca por el analizador de
# comandos de ningún shell, local o remoto — el motivo: un `source .env`
# hecho a mano para diagnosticar esta tarea demostró que un token con
# caracteres especiales sin citar puede ejecutarse a medias como comando en
# vez de asignarse a una variable.
#
# Procedencia de las rutas de la API [por verificar]: este guion no se
# corrió contra el VPS (la tarea lo prohíbe expresamente), así que los
# nombres de endpoint que no vienen ya confirmados en la tarea —
# `POST /applications/private-github-app-dockerfile`, `PATCH /applications/
# {uuid}`, `POST /applications/{uuid}/storages`, `POST /applications/{uuid}/
# envs`, `POST /deploy?uuid=` y el nombre de los campos de
# `persistent_storages`— salen de la documentación pública de la API v1 de
# Coolify 4.x, no de una llamada real: un intento de `GET /projects` de solo
# lectura durante esta tarea falló por un problema de citado de `.env` (no
# por la ruta) y no se reintentó, para no arriesgar una segunda fuga del
# token en la salida de un comando — ver `impl_F039c.md`. Antes de la
# primera corrida real, un `422` en cualquier `POST`/`PATCH` dice qué campo
# espera la API con otro nombre — el guion imprime el cuerpo del error en
# esos casos (salvo el de subir las variables, que lo omite a propósito),
# precisamente para poder corregir el nombre del campo sin adivinar dos veces.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$DIR/.." && pwd)"
HOST="${INFORMES_HOST:-vmi}"
API="http://127.0.0.1:8000/api/v1"
NOMBRE_APP="arttranslator-informes"
DOMINIO="https://arturoocampo.com/informes"
RAMA="${INFORMES_RAMA:-main}"
# Ajustar si el nombre del repo en GitHub no coincide con el del checkout local.
REPO="${INFORMES_REPO:-AOcampo93/ArtTranslatorItalian}"
MONTAJE_DATOS="/datos/informes"
REMOTO_TOK="/tmp/.arttranslator-coolify-tok.$$"
REMOTO_CUERPO="/tmp/.arttranslator-coolify-body.$$"

limpiar () {
  ssh "$HOST" "rm -f '$REMOTO_TOK' '$REMOTO_CUERPO'" >/dev/null 2>&1 || true
}
trap limpiar EXIT

leer_var () {
  # $1 = nombre de la variable, $2 = archivo .env. No usa `source`/`eval`:
  # un valor con `$`, comillas o backticks se lee tal cual, sin que el shell
  # intente interpretarlo.
  local linea
  linea="$(grep -E "^$1=" "$2" 2>/dev/null | head -1)" || true
  printf '%s' "${linea#*=}"
}

exige () {
  # $1 = nombre de variable ya leída en el entorno de este script, $2 = de dónde debía salir.
  if [[ -z "${!1:-}" ]]; then
    echo "[FAIL] $1 vacío o ausente en $2" >&2
    exit 1
  fi
}

echo "== Leyendo variables (nunca se imprimen) =="
[[ -f "$RAIZ/.env" ]] || { echo "[FAIL] falta $RAIZ/.env con las variables de Coolify" >&2; exit 1; }
COOLIFY_TOKEN="$(leer_var COOLIFY_TOKEN "$RAIZ/.env")"
COOLIFY_PROYECTO="$(leer_var COOLIFY_PROYECTO "$RAIZ/.env")"
COOLIFY_SERVIDOR="$(leer_var COOLIFY_SERVIDOR "$RAIZ/.env")"
COOLIFY_GITHUB_APP="$(leer_var COOLIFY_GITHUB_APP "$RAIZ/.env")"
for v in COOLIFY_TOKEN COOLIFY_PROYECTO COOLIFY_SERVIDOR COOLIFY_GITHUB_APP; do exige "$v" "$RAIZ/.env"; done

[[ -f "$DIR/.env" ]] || { echo "[FAIL] falta vps/.env con INFORMES_TOKEN, INFORMES_USUARIO, INFORMES_CLAVE" >&2; exit 1; }
INFORMES_TOKEN="$(leer_var INFORMES_TOKEN "$DIR/.env")"
INFORMES_USUARIO="$(leer_var INFORMES_USUARIO "$DIR/.env")"
INFORMES_CLAVE="$(leer_var INFORMES_CLAVE "$DIR/.env")"
for v in INFORMES_TOKEN INFORMES_USUARIO INFORMES_CLAVE; do exige "$v" "$DIR/.env"; done

echo "== Subiendo el token de la API al VPS por stdin (no por la línea de comandos) =="
ssh "$HOST" "umask 077 && cat > '$REMOTO_TOK'" <<< "$COOLIFY_TOKEN"

# api METODO RUTA [ARCHIVO-JSON-LOCAL]
# Devuelve por stdout: el cuerpo de la respuesta, y dos líneas después "###"
# el código HTTP — separados así (no con `-w` pegado al JSON) porque el
# cuerpo puede ser JSON válido de varias líneas.
api () {
  local metodo="$1" ruta="$2" archivo_local="${3:-}"
  if [[ -n "$archivo_local" ]]; then
    ssh "$HOST" "cat > '$REMOTO_CUERPO'" < "$archivo_local"
    ssh "$HOST" "curl -s -X $metodo '$API$ruta' \
      -H \"Authorization: Bearer \$(cat '$REMOTO_TOK')\" \
      -H 'Content-Type: application/json' \
      --data @'$REMOTO_CUERPO' \
      -w '\n###%{http_code}'"
  else
    ssh "$HOST" "curl -s -X $metodo '$API$ruta' \
      -H \"Authorization: Bearer \$(cat '$REMOTO_TOK')\" \
      -w '\n###%{http_code}'"
  fi
}

# Separa el cuerpo (stdout de `api`) del código HTTP que le sigue tras "###".
codigo_de () { echo "$1" | grep -o '###[0-9]*$' | tr -d '#'; }
cuerpo_de () { echo "$1" | sed 's/###[0-9]*$//'; }

echo "== Buscando si la app ya existe (idempotente) =="
resp="$(api GET /applications)"
codigo="$(codigo_de "$resp")"
if [[ "$codigo" != "200" ]]; then
  echo "[FAIL] GET /applications -> $codigo. Respuesta:" >&2
  cuerpo_de "$resp" >&2
  exit 1
fi
UUID_APP="$(cuerpo_de "$resp" | python3 -c "
import json, sys
apps = json.load(sys.stdin)
for a in apps:
    if a.get('name') == '$NOMBRE_APP':
        print(a.get('uuid', ''))
        break
" 2>/dev/null || true)"

if [[ -z "$UUID_APP" ]]; then
  echo "== La app no existe: creándola (dockerfile, GitHub App) =="
  cuerpo_crear="$(mktemp)"
  python3 -c "
import json
print(json.dumps({
    'project_uuid': '$COOLIFY_PROYECTO',
    'server_uuid': '$COOLIFY_SERVIDOR',
    'environment_name': 'production',
    'github_app_uuid': '$COOLIFY_GITHUB_APP',
    'git_repository': '$REPO',
    'git_branch': '$RAMA',
    'build_pack': 'dockerfile',
    'base_directory': '/vps',
    'dockerfile_location': '/Dockerfile',
    'ports_exposes': '3000',
    'name': '$NOMBRE_APP',
    'instant_deploy': False
}))
" > "$cuerpo_crear"
  resp="$(api POST /applications/private-github-app-dockerfile "$cuerpo_crear")"
  rm -f "$cuerpo_crear"
  codigo="$(codigo_de "$resp")"

  if [[ "$codigo" == "4"* ]]; then
    echo "" >&2
    echo "[FAIL] Coolify rechazó la creación ($codigo). Cuerpo:" >&2
    cuerpo_de "$resp" >&2
    echo "" >&2
    echo "Si el motivo es que la GitHub App '$COOLIFY_GITHUB_APP' no ve el" >&2
    echo "repositorio '$REPO' (es privado), la alternativa es una deploy key" >&2
    echo "de solo lectura en vez de la GitHub App:" >&2
    echo "" >&2
    echo "  1) Generar un par de claves:  ssh-keygen -t ed25519 -f /tmp/dk_arttranslator -N ''" >&2
    echo "  2) Registrar la privada en Coolify:" >&2
    echo "       POST $API/security/keys" >&2
    echo "       { \"name\": \"$NOMBRE_APP-deploy-key\", \"private_key\": \"<contenido de /tmp/dk_arttranslator>\" }" >&2
    echo "  3) Añadir la pública al repo (con la CLI de GitHub, solo lectura):" >&2
    echo "       gh repo deploy-key add /tmp/dk_arttranslator.pub --repo $REPO --title '$NOMBRE_APP' --read-only" >&2
    echo "  4) Crear la app con esa clave en vez de con la GitHub App:" >&2
    echo "       POST $API/applications/private-deploy-key" >&2
    echo "       (mismos campos que arriba, cambiando github_app_uuid por private_key_uuid" >&2
    echo "        con el uuid que devolvió el paso 2)" >&2
    echo "" >&2
    echo "Este guion no hace esos cuatro pasos por sí solo: tocan gh/ssh-keygen" >&2
    echo "en la máquina del líder, no algo que la API resuelva sin ayuda." >&2
    exit 1
  fi
  if [[ "$codigo" != "201" ]]; then
    echo "[FAIL] POST /applications/private-github-app-dockerfile -> $codigo. Cuerpo:" >&2
    cuerpo_de "$resp" >&2
    exit 1
  fi
  UUID_APP="$(cuerpo_de "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uuid',''))" 2>/dev/null || true)"
  [[ -n "$UUID_APP" ]] || { echo "[FAIL] Coolify respondió 201 pero sin 'uuid' en el cuerpo" >&2; exit 1; }
  echo "Creada: $UUID_APP"
else
  echo "Ya existe: $UUID_APP (se actualiza en vez de duplicarla)"
  cuerpo_actualizar="$(mktemp)"
  python3 -c "
import json
print(json.dumps({
    'git_branch': '$RAMA',
    'base_directory': '/vps',
    'dockerfile_location': '/Dockerfile',
    'ports_exposes': '3000'
}))
" > "$cuerpo_actualizar"
  resp="$(api PATCH "/applications/$UUID_APP" "$cuerpo_actualizar")"
  rm -f "$cuerpo_actualizar"
  codigo="$(codigo_de "$resp")"
  if [[ "$codigo" != "200" ]]; then
    echo "[FAIL] PATCH /applications/$UUID_APP -> $codigo. Cuerpo:" >&2
    cuerpo_de "$resp" >&2
    exit 1
  fi
fi

echo "== Dominio: $DOMINIO =="
cuerpo_dominio="$(mktemp)"
python3 -c "import json; print(json.dumps({'domains': '$DOMINIO'}))" > "$cuerpo_dominio"
resp="$(api PATCH "/applications/$UUID_APP" "$cuerpo_dominio")"
rm -f "$cuerpo_dominio"
codigo="$(codigo_de "$resp")"
if [[ "$codigo" != "200" ]]; then
  echo "[FAIL] no se pudo fijar el dominio ($codigo). Cuerpo:" >&2
  cuerpo_de "$resp" >&2
  exit 1
fi

# --- Almacenamiento persistente: no negociable ---------------------------
# Si /datos/informes no sobrevive a un redespliegue, cada `docker compose
# up`/redeploy de Coolify borraría los informes ya subidos — justo lo que
# el bind mount de docker-compose.yml evitaba en el despliegue manual. Se
# comprueba SIEMPRE, y si la API no deja crearlo, el guion se niega a
# desplegar en vez de arriesgarse a perder datos en silencio.
echo "== Comprobando almacenamiento persistente para $MONTAJE_DATOS =="
resp="$(api GET "/applications/$UUID_APP")"
codigo="$(codigo_de "$resp")"
if [[ "$codigo" != "200" ]]; then
  echo "[FAIL] GET /applications/$UUID_APP -> $codigo" >&2
  exit 1
fi
TIENE_ALMACENAMIENTO="$(cuerpo_de "$resp" | python3 -c "
import json, sys
app = json.load(sys.stdin)
storages = app.get('persistent_storages') or app.get('persistentStorages') or []
print('si' if any(s.get('mount_path') == '$MONTAJE_DATOS' for s in storages) else 'no')
" 2>/dev/null || echo 'no')"

if [[ "$TIENE_ALMACENAMIENTO" != "si" ]]; then
  echo "No hay almacenamiento persistente todavía: intentando crearlo por la API."
  cuerpo_storage="$(mktemp)"
  python3 -c "
import json
print(json.dumps({
    'name': 'informes',
    'mount_path': '$MONTAJE_DATOS',
    'is_directory': True
}))
" > "$cuerpo_storage"
  resp="$(api POST "/applications/$UUID_APP/storages" "$cuerpo_storage")"
  rm -f "$cuerpo_storage"
  codigo="$(codigo_de "$resp")"

  if [[ "$codigo" != "200" && "$codigo" != "201" ]]; then
    cat >&2 <<EOF

[FAIL] La API no dejó crear el volumen persistente ($codigo). Cuerpo:
$(cuerpo_de "$resp")

Este guion se niega a desplegar sin él: sin almacenamiento persistente, el
próximo redespliegue de Coolify borraría /datos/informes. Hazlo a mano en
el panel antes de reintentar:

  Coolify -> proyecto ArtTranslator -> $NOMBRE_APP -> pestaña "Storages"
  -> Add -> tipo "Directory" (bind/volumen persistente)
    Nombre:          informes
    Ruta en el host: (la que asigne Coolify, o /opt/arttranslator/informes)
    Ruta en el contenedor: $MONTAJE_DATOS

Vuelve a correr este guion después: si ya existe, lo detecta y sigue.
EOF
    exit 1
  fi
  echo "Almacenamiento persistente creado."
else
  echo "Ya existe almacenamiento persistente en $MONTAJE_DATOS."
fi

echo "== Subiendo variables de entorno (INFORMES_TOKEN, INFORMES_USUARIO, INFORMES_CLAVE) =="
for nombre in INFORMES_TOKEN INFORMES_USUARIO INFORMES_CLAVE; do
  cuerpo_env="$(mktemp)"
  # El valor viaja por la variable de entorno V de python, nunca interpolado
  # en el código fuente del script: así una clave con comillas o backticks
  # no rompe el JSON ni se ejecuta como parte del propio python -c.
  V="${!nombre}" NOMBRE="$nombre" python3 -c "
import json, os
print(json.dumps({'key': os.environ['NOMBRE'], 'value': os.environ['V'], 'is_preview': False, 'is_build_time': False}))
" > "$cuerpo_env"
  resp="$(api POST "/applications/$UUID_APP/envs" "$cuerpo_env")"
  codigo="$(codigo_de "$resp")"
  if [[ "$codigo" != "200" && "$codigo" != "201" ]]; then
    # Segunda corrida: la clave ya existe y el POST responde con un
    # conflicto (código exacto [por verificar], el guion no se corrió contra
    # el VPS). Se trata como "ya existe" y se reintenta como actualización
    # sobre el mismo endpoint, con el mismo cuerpo — igual que la app misma
    # se actualiza con PATCH en vez de abortar cuando ya existe (arriba, al
    # buscarla por nombre). Sin esto, la segunda corrida creaba la app pero
    # nunca llegaba a desplegar (motivo de rechazo de la ronda 1).
    resp="$(api PATCH "/applications/$UUID_APP/envs" "$cuerpo_env")"
    codigo="$(codigo_de "$resp")"
  fi
  rm -f "$cuerpo_env"
  if [[ "$codigo" != "200" && "$codigo" != "201" ]]; then
    # Sin `cuerpo_de "$resp"` aquí a propósito: la respuesta de Coolify a un
    # POST/PATCH de variable de entorno puede incluir el propio valor que se
    # mandó, y $nombre es justo una de las tres claves. El código HTTP basta
    # para saber que falló.
    echo "[FAIL] no se pudo subir ni actualizar $nombre (POST y PATCH fallaron, último código $codigo)" >&2
    exit 1
  fi
done
ssh "$HOST" "rm -f '$REMOTO_TOK.informes_token'" >/dev/null 2>&1 || true

echo "== Desplegando =="
resp="$(api POST "/deploy?uuid=$UUID_APP")"
codigo="$(codigo_de "$resp")"
if [[ "$codigo" != "200" && "$codigo" != "201" ]]; then
  echo "[FAIL] POST /deploy -> $codigo. Cuerpo:" >&2
  cuerpo_de "$resp" >&2
  exit 1
fi

echo "== Esperando y comprobando $DOMINIO/salud (hasta 60 s) =="
listo=""
for _ in $(seq 1 12); do
  if curl -fsS "$DOMINIO/salud" >/dev/null 2>&1; then listo=1; break; fi
  sleep 5
done
if [[ -n "$listo" ]]; then
  curl -fsS "$DOMINIO/salud" && echo
  echo "[OK] $NOMBRE_APP desplegada en $DOMINIO"
else
  echo "[FAIL] $DOMINIO/salud no respondió en 60 s" >&2
  exit 1
fi
