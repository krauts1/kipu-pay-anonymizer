#!/usr/bin/env sh
set -eu
npm ci --include=dev --no-audit --no-fund
npm run build
npm start
