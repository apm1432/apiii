#!/bin/bash
set -e

echo "==> Starting Node.js (apiii) on port 3000..."
PORT=3000 node server.js &

echo "==> Starting wapi (Flask via gunicorn) on port 8085..."
cd /usr/src/app/wapi
# IMPORTANT: workers=1 on purpose. smart_router.py keeps ALL its state
# (RPM/RPD counters, sticky sessions, signature cache) in plain in-process
# dicts -- that state is NOT shared across separate OS processes, so >1
# gunicorn worker would silently multiply your real rate-limit usage and
# break sticky sessions randomly. Instead we use many THREADS in that one
# worker: threads DO share the same memory, and since this app is almost
# entirely waiting on network I/O (calls to Gemini), Python releases the
# GIL during that wait -- so 32 threads really do serve 32 users at once.
# --timeout 0 disables gunicorn's own worker timeout so a slow upstream
# (Gemini) call is never killed mid-flight, per your "no timeout" ask.
gunicorn --workers 1 --threads 32 --worker-class gthread \
  --timeout 0 --graceful-timeout 30 --keep-alive 75 \
  --bind 127.0.0.1:8085 smart_router:app &
cd /usr/src/app

echo "==> Waiting for apps to start..."
sleep 3

echo "==> Starting nginx on port 8000..."
nginx -g 'daemon off;'
