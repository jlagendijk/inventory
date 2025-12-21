#!/usr/bin/with-contenv sh
set -e

export NODE_ENV=production
node /app/server/index.js
