#!/usr/bin/env bash
# Push site/ and server/ to the VPS and restart VOYD. The server's .env stays on the VPS and is never synced.
set -euo pipefail
HOST=root@203.194.113.116
ROOT=/var/www/voydagent.com
cd "$(dirname "$0")/.."
rsync -az --delete -e "ssh -o BatchMode=yes" site/ "$HOST:$ROOT/site/"
rsync -az --delete --exclude node_modules/ --exclude .env -e "ssh -o BatchMode=yes" server/ "$HOST:$ROOT/server/"
ssh -o BatchMode=yes "$HOST" "export LC_ALL=C.UTF-8; cd $ROOT/server && npm ci --omit=dev --no-audit --no-fund && (pm2 restart voyd --update-env || pm2 start server.mjs --name voyd --node-args='--env-file=$ROOT/server/.env') && pm2 save"
