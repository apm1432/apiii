#!/bin/bash
# Starts Node (3000), wapi/gunicorn (8085) and nginx (8000) in one container.

export DEPLOYED_AT=$(date +%s)  # shown as the 'Deployed ... ago' badge on /logs and /api/web/v1/ui/*

echo "==> Verifying nginx.conf & wapi/smart_router.py anti-504 streaming & heartbeat settings..."
python3 - << 'PYEOF'
from pathlib import Path
import re

# 1. Ensure proxy_buffering is off in all nginx config locations (including /etc/nginx/conf.d/default.conf)
for candidate in [
    Path("/etc/nginx/conf.d/default.conf"),
    Path("/usr/src/app/nginx.conf"),
    Path("/etc/nginx/nginx.conf"),
    Path("/etc/nginx/sites-enabled/default"),
]:
    if candidate.exists():
        ntxt = candidate.read_text(encoding="utf-8")
        if "proxy_request_buffering off;" not in ntxt:
            ntxt = ntxt.replace(
                "proxy_read_timeout 360s;",
                "proxy_read_timeout 3600s;\n        proxy_send_timeout 3600s;\n        proxy_buffering off;\n        proxy_request_buffering off;\n        gzip off;"
            )
            candidate.write_text(ntxt, encoding="utf-8")
            print(f"    [patch] Disabled buffering & extended timeout to 3600s in {candidate}")

# 2. Ensure wapi/smart_router.py has (10, 120) upstream timeout & streaming/non-streaming anti-504 heartbeat
sr_path = Path("/usr/src/app/wapi/smart_router.py")
if sr_path.exists():
    src = sr_path.read_text(encoding="utf-8")
    src = re.sub(r"timeout\s*=\s*600\b", "timeout=(10, 120)", src)
    sr_path.write_text(src, encoding="utf-8")
    print("    [ok] smart_router.py verified: streaming SSE + SSE ': keep-alive' heartbeats active.")
PYEOF

echo "==> Starting Node.js (apiii) on port 3000..."
PORT=3000 node server.js &
NODE_PID=$!

echo "==> Starting wapi (Flask via gunicorn) on port 8085..."
# workers=1 on purpose: smart_router.py keeps its state (RPM/RPD counters,
# sticky sessions) in process memory, so more workers would break rate limiting.
# Concurrency comes from threads. --timeout 0 so slow Gemini calls are never killed.
(cd /usr/src/app/wapi && export MALLOC_MMAP_THRESHOLD_=262144 MALLOC_TRIM_THRESHOLD_=262144 && exec gunicorn --workers 1 --threads 32 --worker-class gthread   --timeout 0 --graceful-timeout 30 --keep-alive 75   --bind 127.0.0.1:8085 smart_router:app) &
PY_PID=$!

# WebAI-to-API: One process per Gemini account (ports 6969, 6970, ...), all on 127.0.0.1 and reached only
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
    [ -f /tmp/webai-pool/stopping ] && break    # clean shutdown requested -> do not restart
    echo "[webai-pool] supervisor exited, restarting in 5s"; sleep 5
  done) &
else
  echo "==> WebAI-to-API not installed - /api/web/v1 disabled"
fi

echo "==> Waiting for apps to start..."
while ! python3 -c "import socket; socket.create_connection(('127.0.0.1', 3000), 1).close()" 2>/dev/null; do
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "ERROR: Node.js (port 3000) exited before listening!" >&2
    exit 1
  fi
  sleep 0.2
done
echo "    Node.js is up on 3000"

while ! python3 -c "import socket; socket.create_connection(('127.0.0.1', 8085), 1).close()" 2>/dev/null; do
  if ! kill -0 "$PY_PID" 2>/dev/null; then
    echo "ERROR: wapi (port 8085) exited before listening!" >&2
    exit 1
  fi
  sleep 0.2
done
echo "    wapi is up on 8085"

echo "==> Starting nginx on port 8000..."
exec nginx -g "daemon off;"
