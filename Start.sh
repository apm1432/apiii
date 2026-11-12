#!/bin/bash
# Starts Node (3000), wapi/gunicorn (8085) and nginx (8000) in one container.

export DEPLOYED_AT=$(date +%s)  # shown as the 'Deployed ... ago' badge on /logs and /api/web/v1/ui/*

echo "==> Patching wapi/smart_router.py for 600s timeout & 504 anti-timeout heartbeat..."
python3 - << 'PYEOF'
from pathlib import Path
import re

sr_path = Path("/usr/src/app/wapi/smart_router.py")
if sr_path.exists():
    src = sr_path.read_text(encoding="utf-8")
    # 1. Upgrade internal 120s HTTP POST timeout in _heal_signature to 600s
    src = re.sub(r"timeout\s*=\s*120\b", "timeout=600", src)

    # 2. Inject WSGI Keep-Alive Heartbeat wrapper (prevents Cloudflare/Koyeb 100s HTTP 504 on stream=False)
    marker = "# --- ANTI_504_HEARTBEAT_PATCH ---"
    if marker not in src:
        patch_code = '''

# --- ANTI_504_HEARTBEAT_PATCH ---
import io as _hb_io
import json as _hb_json
import queue as _hb_queue
import threading as _hb_threading

class _Anti504HeartbeatMiddleware:
    """Prevents Cloudflare / Koyeb Edge 100s Gateway Timeout (error code: 504)
    on long-running non-streaming (/v1/chat/completions, /v1/responses, /api/web/v1/chat/completions)
    POST requests by sending periodic whitespace bytes after 15s while upstream generates."""

    def __init__(self, wsgi_app, first_byte_delay=15.0, heartbeat_interval=15.0):
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

        # Read and restore request body so we can inspect "stream" flag safely
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

        # If client explicitly asked for SSE streaming, pass through untouched
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

        # Wait up to first_byte_delay (15s). If fast response or fast 4xx/5xx error, return natively!
        if done_evt.wait(timeout=self.first_byte_delay):
            if captured["exc"] is not None:
                raise captured["exc"]
            start_response(captured["status"], captured["headers"])
            return captured["body_chunks"]

        # Long-running request (>15s): flush 200 OK + periodic whitespace so Cloudflare/Koyeb never 504s
        stream_headers = [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Cache-Control", "no-cache, no-transform"),
            ("X-Accel-Buffering", "no"),
        ]
        start_response("200 OK", stream_headers)

        def _heartbeat_stream():
            yield b" "
            while not done_evt.wait(timeout=self.heartbeat_interval):
                yield b" "
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
    print("    [patch] smart_router.py patched successfully (timeout=600 + anti-504 heartbeat).")
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
while ! nc -z 127.0.0.1 3000 2>/dev/null; do sleep 0.2; done
echo "    Node.js is up on 3000"

while ! nc -z 127.0.0.1 8085 2>/dev/null; do sleep 0.2; done
echo "    wapi is up on 8085"

echo "==> Starting nginx on port 8000..."
exec nginx -g "daemon off;"