#!/usr/bin/env bash
# ===========================================================================
# Tusk's Tomes — start the local app (macOS / Linux)
# ===========================================================================

set -eu
cd "$(dirname "$0")"

# Refuse sudo — same reason as setup.sh. Running the dev server as root
# means any file the app writes (sessions, config) ends up root-owned and
# unreadable to your normal user later.
if [ "${SUDO_USER:-}" != "" ] || [ "$(id -u)" = "0" ]; then
  echo "Don't run start.sh as root / under sudo — it'll leave runtime files root-owned."
  echo "Run as your normal user: bash start.sh"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run ./setup.sh first."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "node_modules is missing — running first-time setup…"
  bash setup.sh
fi

PORT="${PORT:-5173}"
URL="http://localhost:${PORT}/"

# Try to open the browser after the server starts.
open_browser() {
  sleep 4
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  fi
}
open_browser &

echo "Starting on $URL"
echo "Press Ctrl+C to stop."
echo
npm run dev
