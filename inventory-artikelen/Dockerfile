ARG BUILD_FROM
FROM ${BUILD_FROM}

WORKDIR /app
RUN apk add --no-cache nodejs npm

COPY run.sh /run.sh
RUN chmod a+x /run.sh

# deps eerst (cache)
COPY server/package.json ./server/package.json
COPY server/package-lock.json* ./server/
RUN cd /app/server && npm install --omit=dev

# app code
COPY server ./server
COPY web ./web

EXPOSE 8099
CMD [ "/run.sh" ]
