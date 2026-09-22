#!/bin/bash
set -e

echo "==> Starting Node.js (apiii) on port 3000..."
PORT=3000 node server.js &

echo "==> Starting wapi (Flask) on port 8085..."
cd /usr/src/app/wapi
python3 smart_router.py &
cd /usr/src/app

echo "==> Waiting for apps to start..."
sleep 3

echo "==> Starting nginx on port 8000..."
nginx -g 'daemon off;'
