#!/usr/bin/env bash
# Despliega el receptor de informes en el VPS del equipo.
#
# NO lo ejecuta el implementador de F039a: lo corre el líder, cuando decide
# que toca desplegar. Necesita el alias `vmi` ya configurado en ~/.ssh/config
# (o exporta INFORMES_HOST con otro destino) y un vps/.env real en el
# servidor (no lo sube este script — se copia a mano una vez, o se pide).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${INFORMES_HOST:-root@vmi}"
DESTINO="${INFORMES_DESTINO:-/opt/arttranslator}"
DOMINIO="${INFORMES_DOMINIO:-arttranslator.81.17.100.181.sslip.io}"

echo "== Sincronizando $DIR/ -> $HOST:$DESTINO/ (sin informes/ ni .env local) =="
rsync -avz --delete \
  --exclude 'informes/' \
  --exclude '.env' \
  "$DIR/" "$HOST:$DESTINO/"

# El bind mount `./informes:/datos/informes` de docker-compose.yml necesita
# que el directorio de origen exista y sea del usuario del contenedor (uid
# 100 / gid 101, fijados en el Dockerfile) ANTES de `up`. Si no, Docker lo
# crea como `root:root` al levantar el servicio y la primera subida real
# revienta con EACCES (motivo de rechazo de la ronda 1: reproducido con un
# punto de montaje root:root en un contenedor real). `chown` sin `mkdir -p`
# fallaría en el primer despliegue, cuando el directorio todavía no existe.
echo "== Preparando el directorio de datos ($DESTINO/informes, dueño 100:101) =="
ssh "$HOST" "mkdir -p $DESTINO/informes && chown 100:101 $DESTINO/informes"

echo "== docker compose up -d --build =="
ssh "$HOST" "cd $DESTINO && docker compose up -d --build"

# El primer despliegue puede tardar unos segundos en tener el certificado de
# Let's Encrypt listo; un solo curl -f justo después daría una falsa alarma.
echo "== Comprobando /salud (hasta 30 s, por si el certificado tarda) =="
listo=""
for _ in 1 2 3 4 5 6; do
  if curl -fsS "https://$DOMINIO/salud" >/dev/null 2>&1; then listo=1; break; fi
  sleep 5
done
if [[ -n "$listo" ]]; then
  curl -fsS "https://$DOMINIO/salud" && echo
else
  echo "[FAIL] /salud no respondió en 30 s" >&2
  exit 1
fi
