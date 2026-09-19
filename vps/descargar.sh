#!/usr/bin/env bash
# Baja los informes ya subidos al VPS, en un solo comando.
#
# No hay listado ni descarga por HTTP (a propósito: los informes llevan
# texto de reuniones reales). La única vía de lectura es ssh + rsync.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${INFORMES_HOST:-root@vmi}"
ORIGEN="${INFORMES_ORIGEN:-/opt/arttranslator/informes/}"
DESTINO="$DIR/informes/"

mkdir -p "$DESTINO"
rsync -avz "$HOST:$ORIGEN" "$DESTINO"
echo "Informes en $DESTINO"
