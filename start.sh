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

# WebAI-to-API on 127.0.0.1:6969 (reached only through /api/web/v1 in wapi).
# Own restart loop and NOT part of `wait -n` below, so if it crashes it never
# takes the rest of the container down.
if [ -x /opt/webai-venv/bin/python ]; then
  # Gemini web cookies live in MongoDB (paste them at /api/web/v1/ui/auth).
  # Before every (re)start webai_cookies.py saves the newest auto-refreshed cookies to the DB
  # and writes the DB cookies into WebAI's config.conf -> no env vars needed.
  echo "==> Starting WebAI-to-API on 127.0.0.1:6969..."
  (cd /opt/webai && while true; do
     timeout 30 python3 /usr/src/app/wapi/webai_cookies.py apply
     PYTHONPATH=src PYTHONUNBUFFERED=1 /opt/webai-venv/bin/python src/run.py --host 127.0.0.1 --port 6969
     echo "[webai] exited, restarting in 5s"; sleep 5
   done) &
else
  echo "==> WebAI-to-API not installed - /api/web/v1 disabled"
fi

echo "==> Waiting for apps to start..."
sleep 3

echo "==> Starting nginx on port 8000..."
nginx -g 'daemon off;' &
NGINX_PID=$!

# On redeploy (SIGTERM) forward the signal so Node can release the Telegram
# polling slot -> avoids "409 Conflict" in the new instance.
shutdown() {
  echo "==> Stopping services..."
  timeout 10 python3 /usr/src/app/wapi/webai_cookies.py sync   # save latest refreshed cookies to DB
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
