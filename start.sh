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
HEALTH="http://127.0.0.1:${PORT}/api/health"

open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  else
    echo "Open $URL in your browser."
  fi
}

# Open the browser once the app reports READY.
#
# A fixed delay cannot do this job: the first start after setup or an
# update takes far longer than a warm one, so any delay is either too
# short for the slow case or too long for every other. The app's health
# endpoint says when it is actually ready, so ask that instead.
#
# Runs in the background while npm run dev holds the foreground. It stops
# on its own if the launcher shell goes away, so a start that fails does
# not leave it polling until the cap.
wait_then_open() {
  parent="$1"
  cap=180
  waited=0
  last_phase=""
  if ! command -v curl >/dev/null 2>&1; then
    # Nothing to ask with; fall back to a plain delay.
    sleep 8
    open_url
    return 0
  fi
  echo "Waiting for the app to finish starting…"
  while [ "$waited" -lt "$cap" ]; do
    kill -0 "$parent" 2>/dev/null || return 0
    body="$(curl -s -m 2 "$HEALTH" 2>/dev/null || true)"
    case "$body" in
      *'"ready":true'*)
        echo "The app is READY — opening $URL"
        open_url
        return 0
        ;;
    esac
    phase="$(printf '%s' "$body" | sed -n 's/.*"phase":"\([a-z]*\)".*/\1/p')"
    if [ -n "$phase" ] && [ "$phase" != "$last_phase" ]; then
      case "$phase" in
        binding) label="binding the port" ;;
        addons) label="loading add-ons" ;;
        lore) label="reading the lore folder" ;;
        vite) label="preparing the interface (takes longer after an update)" ;;
        *) label="$phase" ;;
      esac
      echo "  … still starting: $label"
      last_phase="$phase"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "The app has not reported READY after ${cap}s, so the browser was not opened."
  echo "If the lines above show an error, that is the reason. Otherwise open $URL yourself once READY appears."
  return 1
}
wait_then_open "$$" &

echo "WHAT THIS WINDOW IS"
echo
echo "  This window IS Tusk's Tomes. The app runs on your own computer and"
echo "  shows its display in your web browser. A browser tab opens by itself"
echo "  as soon as the app says READY below."
echo
echo "  The first start after setup or an update can take 15–30 seconds"
echo "  while the app prepares its files. Later starts take a few seconds."
echo
echo "  The first lines below are the app's own numbered start-up steps."
echo "  After that, text keeps scrolling past: that is the app telling you"
echo "  what it is doing, and it does not mean anything is wrong."
echo
echo "--------------------------------------------"
echo
echo "Starting on $URL"
echo "Press Ctrl+C to stop."
echo
npm run dev
