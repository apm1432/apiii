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

# WebAI-to-API: ONE process per Gemini account (ports 6969, 6970, ...), all on 127.0.0.1 and reached only
# through /api/web/v1 in wapi, which spreads requests over the accounts (wapi/webai_pool.py).
# Accounts (cookies) live in MongoDB - add / remove them at /api/web/v1/ui/auth, no env vars and no restart needed.
# wapi/webai_supervisor.py starts/stops the instances, saves auto-refreshed cookies back to the DB and restarts
# a crashed one. Own restart loop and NOT part of `wait -n` below, so if it crashes it never takes the rest of
# the container down.
if [ -x /opt/webai-venv/bin/python ]; then
  echo "==> Starting WebAI pool supervisor (one WebAI-to-API per Gemini account)..."
  rm -f /tmp/webai-pool/stopping
  (cd /usr/src/app/wapi && while true; do
     python3 webai_supervisor.py
     [ -f /tmp/webai-pool/stopping ] && break      # clean shutdown requested -> do not restart
     echo "[webai-pool] supervisor exited, restarting in 5s"; sleep 5
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
  # ask the supervisor to save the latest refreshed cookies of every account to the DB and stop its WebAI processes
  if [ -f /tmp/webai-pool/supervisor.pid ]; then
    kill -TERM "$(cat /tmp/webai-pool/supervisor.pid)" 2>/dev/null
    for _ in $(seq 1 30); do [ -f /tmp/webai-pool/supervisor.pid ] || break; sleep 0.5; done
  fi
  timeout 10 python3 /usr/src/app/wapi/webai_cookies.py sync   # no-op when the supervisor already did it
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
