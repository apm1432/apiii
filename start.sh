#!/bin/bash
# Starts Node (3000), wapi/gunicorn (8085) and nginx (8000) in one container.

echo "==> Starting Node.js (apiii) on port 3000..."
PORT=3000 node server.js &
NODE_PID=$!

echo "==> Starting wapi (Flask via gunicorn) on port 8085..."
# workers=1 on purpose: smart_router.py keeps its state (RPM/RPD counters,
# sticky sessions) in process memory, so more workers would break rate limiting.
# Concurrency comes from threads. --timeout 0 so slow Gemini calls are never killed.
(cd /usr/src/app/wapi && exec gunicorn --workers 1 --threads 32 --worker-class gthread \
  --timeout 0 --graceful-timeout 30 --keep-alive 75 \
  --bind 127.0.0.1:8085 smart_router:app) &
PY_PID=$!

echo "==> Waiting for apps to start..."
sleep 3

echo "==> Starting nginx on port 8000..."
nginx -g 'daemon off;' &
NGINX_PID=$!

# On redeploy (SIGTERM) forward the signal so Node can release the Telegram
# polling slot -> avoids "409 Conflict" in the new instance.
shutdown() {
  echo "==> Stopping services..."
  kill -TERM "$NODE_PID" "$PY_PID" "$NGINX_PID" 2>/dev/null
  wait
  exit 0
}
trap shutdown TERM INT

# If any process dies, exit so the platform restarts the whole container.
wait -n
echo "==> A service exited. Stopping container so it restarts."
kill -TERM "$NODE_PID" "$PY_PID" "$NGINX_PID" 2>/dev/null
exit 1
