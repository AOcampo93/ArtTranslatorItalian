#!/usr/bin/env bash
# Administra las licencias (F053) en el VPS, por ssh: crear, listar, liberar,
# revocar, tope. Igual que descargar.sh, no hay ninguna vía HTTP de
# administración a propósito: la herramienta corre dentro del contenedor, sobre
# el mismo almacén (/datos/licencias) que lee el servidor.
#
#   ./licencias.sh crear "Cliente" [maximo] [contacto]   # imprime el id de la licencia
#   ./licencias.sh listar
#   ./licencias.sh liberar <licencia> <prefijo-de-huella>
#   ./licencias.sh revocar <licencia>
#   ./licencias.sh tope <licencia> <n>
#
# `claves` NO se corre por aquí (escribiría la clave privada dentro del
# contenedor): se genera en local con `node licencias-cli.js claves <archivo>`.
set -euo pipefail

HOST="${INFORMES_HOST:-root@vmi}"
CONTENEDOR="${INFORMES_CONTENEDOR:-arttranslator-informes}"

if [[ "${1:-}" == "claves" ]]; then
  echo "claves se genera en tu máquina, no en el VPS: node licencias-cli.js claves <archivo-fuera-del-repo>" >&2
  exit 2
fi

# ssh une los argumentos con espacios y el shell remoto los vuelve a partir:
# «Cliente Uno» llegaría como dos argumentos. `printf %q` los protege, salvo un
# salto de línea u otro carácter de control: si el shell de login remoto es
# `dash` no lo cita bien y lo que viniera detrás se ejecutaría en el VPS
# (reproducido en la revisión de F053). Ni un cliente ni un contacto los
# necesitan, así que se rechazan.
remoto="docker exec $CONTENEDOR node licencias-cli.js"
for argumento in "$@"; do
  if [[ "$argumento" =~ [[:cntrl:]] ]]; then
    echo "error: los argumentos no pueden llevar saltos de línea ni otros caracteres de control" >&2
    exit 2
  fi
  remoto+=" $(printf '%q' "$argumento")"
done
ssh "$HOST" "$remoto"
