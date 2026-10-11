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
  # Gemini web cookies come from env vars WEBAI_PSID (+ optional WEBAI_PSIDTS)
  # -> written into WebAI's config.conf [Gemini] section on every start
  # (the dashboard has no cookie form and the container disk is not persistent).
  if [ -n "$WEBAI_PSID" ]; then
    python3 - <<'PY'
import os, re
p = '/opt/webai/config.conf'
s = open(p, encoding='utf-8').read()
for key, env in (('__Secure-1PSID', 'WEBAI_PSID'), ('__Secure-1PSIDTS', 'WEBAI_PSIDTS')):
    v = os.environ.get(env, '').strip().strip('"').strip("'")
    if v:
        s = re.sub(r'(?m)^' + re.escape(key) + r'[ \t]*=.*$', lambda m: key + ' = ' + v, s, count=1)
open(p, 'w', encoding='utf-8').write(s)
print('==> WebAI cookies loaded from env')
PY
  else
    echo "==> WEBAI_PSID not set - WebAI will start without Gemini cookies"
  fi
  echo "==> Starting WebAI-to-API on 127.0.0.1:6969..."
  (cd /opt/webai && while true; do
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
