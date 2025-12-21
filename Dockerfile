ARG BUILD_FROM
FROM $BUILD_FROM

WORKDIR /app

RUN apk add --no-cache nodejs npm

COPY package.json package-lock.json* /app/
RUN npm ci --omit=dev || npm install --omit=dev

COPY server /app/server
COPY web /app/web
COPY run.sh /app/run.sh
RUN chmod +x /app/run.sh

EXPOSE 8099
CMD ["/app/run.sh"]
