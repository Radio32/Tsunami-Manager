#!/bin/bash
# Double-click to run Nutella Tsunami Manager locally (macOS).
# Serves this folder on http://127.0.0.1:8765 and opens it in Chrome.
# Keep the port the same: the browser stores your project per address.
cd "$(dirname "$0")"
PORT=8765
URL="http://127.0.0.1:$PORT/app/"
if ! lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT
  sleep 1
fi
open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
echo "Nutella Tsunami Manager is running at $URL"
echo "Close this window to stop the server."
wait
