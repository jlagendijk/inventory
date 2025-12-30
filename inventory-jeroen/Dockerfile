ARG BUILD_FROM
FROM ${BUILD_FROM}

WORKDIR /app
RUN apk add --no-cache nodejs npm

COPY run.sh /run.sh
RUN chmod a+x /run.sh

COPY server ./server
COPY web ./web

WORKDIR /app/server
RUN npm init -y \
 && npm i express mariadb

EXPOSE 8101
CMD [ "/run.sh" ]
