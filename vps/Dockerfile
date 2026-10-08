FROM node:20-alpine

# Sin dependencias de npm (ver servidor.js): no hace falta `npm install` en la
# imagen. Se copia package.json solo por si el equipo añade algo más adelante.
# F053: `licencias.js` es parte del servidor (sin él no arranca) y
# `licencias-cli.js` viaja porque `licencias.sh` lo ejecuta con `docker exec`.
WORKDIR /app
COPY package.json servidor.js licencias.js licencias-cli.js ./

# Usuario no root: si el receptor tiene un fallo, no corre como root dentro
# del contenedor. uid/gid fijos (100/101, no los que asigne `-S` por su
# cuenta) porque `desplegar.sh` necesita saberlos de antemano para hacer
# `chown` al directorio del bind mount ANTES de `docker compose up`: sin eso,
# Docker crea ese directorio en el VPS como `root:root` y el primer `POST`
# real revienta con `EACCES` (motivo de rechazo de la ronda 1, reproducido
# con un punto de montaje `root:root`).
RUN addgroup -g 101 -S informes \
    && adduser -u 100 -S informes -G informes \
    && mkdir -p /datos/informes /datos/licencias \
    && chown -R informes:informes /datos/informes /datos/licencias /app

USER informes

ENV PUERTO=3000
EXPOSE 3000
VOLUME ["/datos/informes", "/datos/licencias"]

CMD ["node", "servidor.js"]
