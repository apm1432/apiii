#!/bin/bash
# Starts Node (3000), wapi/gunicorn (8085) and nginx (8000) in one container.

export DEPLOYED_AT=$(date +%s)  # shown as the 'Deployed ... ago' badge on /logs and /api/web/v1/ui/*

# WebAI-to-API (/api/web/v1) is OFF by default: each Gemini account runs its own heavy Python process (RAM -> OOM on small instances).
# Set env WEBAI_ENABLED=1 in Koyeb to turn it back on. While off, the smart_router WebAI fallback is disabled too.
WEBAI_ENABLED="${WEBAI_ENABLED:-0}"
if [ "$WEBAI_ENABLED" != "1" ]; then export WEBAI_FALLBACK=0; fi

echo "==> Patching nginx.conf & wapi/smart_router.py to eliminate Koyeb 100s 504 timeouts..."
python3 - << 'PYEOF'
from pathlib import Path
import re

# 1. Disable proxy_buffering in nginx.conf across all locations so 200 OK headers
#    and heartbeat chunks flush immediately through Node.js (3000) and Nginx (8000) to Koyeb Edge.
ng_path = Path("/usr/src/app/nginx.conf")
if not ng_path.exists():
    ng_path = Path("/etc/nginx/nginx.conf")
for candidate in [Path("/usr/src/app/nginx.conf"), Path("/etc/nginx/nginx.conf"), Path("/etc/nginx/sites-enabled/default")]:
    if candidate.exists():
        ntxt = candidate.read_text(encoding="utf-8")
        if "proxy_request_buffering off;" not in ntxt:
            ntxt = ntxt.replace(
                "proxy_read_timeout 360s;",
                "proxy_read_timeout 3600s;\n            proxy_send_timeout 3600s;\n            proxy_buffering off;\n            proxy_request_buffering off;\n            gzip off;"
            )
            candidate.write_text(ntxt, encoding="utf-8")
            print(f"    [patch] Disabled buffering & extended timeout to 3600s in {candidate}")

# 2. Patch wapi/smart_router.py
sr_path = Path("/usr/src/app/wapi/smart_router.py")
if sr_path.exists():
    src = sr_path.read_text(encoding="utf-8")

    # Prevent any single Gemini upstream HTTP call from hanging in 'Pending...' for 600s!
    # A (10s connect, 75s read) timeout guarantees that if one Gemini key/model hangs,
    # smart_router catches requests.Timeout at 75s (well before Koyeb's 100s limit)
    # and immediately retries on the next key/model or WebAI fallback!
    src = re.sub(r"timeout\s*=\s*600\b", "timeout=(10, 75)", src)
    src = re.sub(r"timeout\s*=\s*120\b", "timeout=(10, 75)", src)

    # Inject WSGI Keep-Alive Heartbeat wrapper with 4KB immediate flush
    marker = "# --- ANTI_504_HEARTBEAT_PATCH ---"
    if marker not in src:
        patch_code = '''

# --- ANTI_504_HEARTBEAT_PATCH ---
import io as _hb_io
import json as _hb_json
import threading as _hb_threading

class _Anti504HeartbeatMiddleware:
    """Prevents Koyeb Edge / Cloudflare 100s Gateway Timeout (error code: 504)
    on non-streaming (/v1/chat/completions, /v1/responses, /api/web/v1/chat/completions)
    POST requests by flushing HTTP 200 OK + 4KB whitespace padding when upstream takes >10s,
    followed by 1KB whitespace heartbeats every 10s so Node.js/Nginx/Koyeb buffers flush immediately."""

    def __init__(self, wsgi_app, first_byte_delay=10.0, heartbeat_interval=10.0):
        self.wsgi_app = wsgi_app
        self.first_byte_delay = first_byte_delay
        self.heartbeat_interval = heartbeat_interval

    def _is_target_request(self, environ):
        if environ.get("REQUEST_METHOD") != "POST":
            return False
        path = (environ.get("PATH_INFO") or "").rstrip("/")
        return path.endswith("/chat/completions") or path.endswith("/responses")

    def __call__(self, environ, start_response):
        if not self._is_target_request(environ):
            return self.wsgi_app(environ, start_response)

        try:
            content_length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            content_length = 0

        body_bytes = b""
        if content_length > 0 and environ.get("wsgi.input") is not None:
            body_bytes = environ["wsgi.input"].read(content_length)
            environ["wsgi.input"] = _hb_io.BytesIO(body_bytes)

        try:
            payload = _hb_json.loads(body_bytes.decode("utf-8", "replace")) if body_bytes else {}
        except Exception:
            payload = {}

        if isinstance(payload, dict) and bool(payload.get("stream")):
            return self.wsgi_app(environ, start_response)

        done_evt = _hb_threading.Event()
        captured = {"status": "200 OK", "headers": [], "body_chunks": [], "exc": None}

        def _capture_start_response(status, headers, exc_info=None):
            captured["status"] = status
            captured["headers"] = list(headers or [])
            return lambda chunk: captured["body_chunks"].append(chunk)

        def _worker():
            try:
                app_iter = self.wsgi_app(environ, _capture_start_response)
                try:
                    for chunk in app_iter:
                        if chunk:
                            captured["body_chunks"].append(chunk)
                finally:
                    if hasattr(app_iter, "close"):
                        app_iter.close()
            except Exception as e:
                captured["exc"] = e
            finally:
                done_evt.set()

        t = _hb_threading.Thread(target=_worker, daemon=True)
        t.start()

        # If upstream finishes within 10s, return native status & headers untouched
        if done_evt.wait(timeout=self.first_byte_delay):
            if captured["exc"] is not None:
                raise captured["exc"]
            start_response(captured["status"], captured["headers"])
            return captured["body_chunks"]

        # Upstream is taking >10s: commit 200 OK + 4KB whitespace immediately to defeat proxy buffers
        stream_headers = [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Cache-Control", "no-cache, no-store, no-transform"),
            ("X-Accel-Buffering", "no"),
        ]
        start_response("200 OK", stream_headers)

        def _heartbeat_stream():
            yield (b" " * 4096) + b"\\n"
            while not done_evt.wait(timeout=self.heartbeat_interval):
                yield (b" " * 1024) + b"\\n"
            if captured["exc"] is not None:
                err_json = _hb_json.dumps({
                    "error": {"message": str(captured["exc"]), "type": "server_error", "code": 500}
                }).encode("utf-8")
                yield err_json
            else:
                for chunk in captured["body_chunks"]:
                    if chunk:
                        yield chunk

        return _heartbeat_stream()

app.wsgi_app = _Anti504HeartbeatMiddleware(app.wsgi_app)
'''
        if "if __name__ ==" in src:
            idx = src.rfind("if __name__ ==")
            src = src[:idx] + patch_code + "\n" + src[idx:]
        else:
            src = src + "\n" + patch_code

    sr_path.write_text(src, encoding="utf-8")
    print("    [patch] smart_router.py patched: upstream timeout=(10, 75) + 4KB anti-504 heartbeat.")
PYEOF

echo "==> Starting Node.js (apiii) on port 3000..."
PORT=3000 node server.js &
NODE_PID=$!

echo "==> Starting wapi (Flask via gunicorn) on port 8085..."
# workers=1 on purpose: smart_router.py keeps its state (RPM/RPD counters,
# sticky sessions) in process memory, so more workers would break rate limiting.
# Concurrency comes from threads. --timeout 0 so slow Gemini calls are never killed.
(cd /usr/src/app/wapi && export MALLOC_MMAP_THRESHOLD_=262144 MALLOC_TRIM_THRESHOLD_=262144 && exec gunicorn --workers 1 --threads 32 --worker-class gthread \
  --timeout 0 --graceful-timeout 30 --keep-alive 75 \
  --bind 127.0.0.1:8085 smart_router:app) &
PY_PID=$!

# WebAI-to-API: One process per Gemini account (ports 6969, 6970, ...), all on 127.0.0.1 and reached only
# through /api/web/v1 in wapi, which spreads requests over the accounts (wapi/webai_pool.py).
# Accounts (cookies) live in MongoDB - add / remove them at /api/web/v1/ui/auth, no env vars and no restart needed.
# wapi/webai_supervisor.py starts/stops the instances, saves auto-refreshed cookies back to the DB and restarts
# a crashed one. Own restart loop and NOT part of `wait -n` below, so if it crashes it never takes the rest of
# the container down.
if [ "$WEBAI_ENABLED" != "1" ]; then
  echo "==> WebAI pool DISABLED (WEBAI_ENABLED!=1) - /api/web/v1 off, WebAI fallback off, no extra RAM used"
elif [ -x /opt/webai-venv/bin/python ]; then
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
# Port check in pure bash (/dev/tcp): node:20-slim has no `nc`, so the old `nc -z` loop never succeeded,
# nginx (8000) never started and Koyeb's TCP health check failed. Gives up after 120 s and starts nginx anyway,
# so port 8000 is always opened (a dead backend then returns 502 instead of failing the health check).
wait_port() {  # $1 = port, $2 = name
  local i=0
  while ! (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; do
    i=$((i+1))
    if [ "$i" -ge 600 ]; then echo "    WARNING: $2 not up on $1 after 120s - starting nginx anyway"; return 1; fi
    sleep 0.2
  done
  echo "    $2 is up on $1"
}
wait_port 3000 "Node.js"
wait_port 8085 "wapi"

echo "==> Starting nginx on port 8000..."
exec nginx -g "daemon off;"