#!/usr/bin/env bash
# ===========================================================================
# Tusk's Tomes — first-time setup (macOS / Linux)
#
# Run with:   bash setup.sh
#
# Safe to inspect first. This script does ONLY the following:
#
#   1. Checks whether Node.js >= 20 is installed. If not, prints the
#      brew / apt / dnf / pacman command to install it and exits.
#   2. If Node is present, hands control to
#      `node scripts/setup/check-deps.mjs` — plain readable JavaScript
#      you can audit before running.
#
# Nothing is silent. We never install system packages on your behalf,
# never use sudo, and never touch anything outside this folder.
# ===========================================================================

set -eu

cd "$(dirname "$0")"

GREEN=$'\e[32m'
YELLOW=$'\e[33m'
RED=$'\e[31m'
BOLD=$'\e[1m'
DIM=$'\e[2m'
RESET=$'\e[0m'

# Honor NO_COLOR.
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
  GREEN=""; YELLOW=""; RED=""; BOLD=""; DIM=""; RESET=""
fi

echo
echo "  ${BOLD}=========================================="
echo "    Tusk's Tomes — first-time setup"
echo "  ==========================================${RESET}"
echo

# ---- Pre-flight: refuse to run as root / under sudo ----
# A sudo install leaves node_modules root-owned and breaks every later
# non-sudo update (including the in-app updater). Fail loudly upfront.
if [ "${SUDO_USER:-}" != "" ] || [ "$(id -u)" = "0" ]; then
  echo "  ${RED}[refuse]${RESET} Don't run setup as root / under sudo."
  echo
  echo "  ${BOLD}Why:${RESET} npm install under sudo leaves node_modules owned by root,"
  echo "  which then breaks every later install / update you run as your own"
  echo "  user (including the in-app updater)."
  echo
  echo "  If a previous sudo install already corrupted ownership, recover with:"
  echo "      ${YELLOW}sudo chown -R \$USER:\$(id -gn) .${RESET}"
  echo
  echo "  Then re-run this script ${BOLD}without${RESET} sudo:"
  echo "      ${YELLOW}bash setup.sh${RESET}"
  echo
  exit 1
fi

# ---- Pre-flight: confirm we can actually write to this folder ----
WRITE_PROBE=".write-probe-$$"
if ! ( : > "$WRITE_PROBE" ) 2>/dev/null; then
  echo "  ${RED}[error]${RESET} This folder isn't writable: $(pwd)"
  echo
  echo "  Move the repo to a writable location (your home folder, Documents)"
  echo "  and re-run setup. Don't fix it with chmod 777 — the cleanest path"
  echo "  is just to keep the repo somewhere your user owns."
  echo
  exit 1
fi
rm -f "$WRITE_PROBE"

# ---- Check Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "  ${RED}[missing]${RESET} Node.js was not found on PATH."
  echo
  echo "  Install Node.js 20 LTS or newer, then re-run this script:"
  echo
  case "$(uname -s)" in
    Darwin)
      echo "      brew install node@20"
      ;;
    Linux)
      echo "      sudo apt install nodejs npm        # Debian / Ubuntu"
      echo "      sudo dnf install nodejs npm        # Fedora / RHEL"
      echo "      sudo pacman -S nodejs npm          # Arch"
      ;;
    *)
      echo "      (install Node.js 20+ via your OS package manager)"
      ;;
  esac
  echo
  echo "  Or use nvm:   ${DIM}https://github.com/nvm-sh/nvm${RESET}"
  echo "  Or download:  ${DIM}https://nodejs.org/${RESET}"
  echo
  echo "  After installing, open a new terminal so PATH refreshes."
  echo
  exit 1
fi

NODE_VERSION="$(node --version)"
echo "  ${GREEN}[ok]${RESET} Node.js $NODE_VERSION"
echo

# ---- Hand off to the cross-platform Node script ----
echo "  Running dependency check (scripts/setup/check-deps.mjs)…"
echo
if node scripts/setup/check-deps.mjs; then
  echo
  echo "  ${GREEN}Setup complete.${RESET} You can close this window."
  exit 0
else
  rc=$?
  echo
  echo "  ${YELLOW}Setup did not complete cleanly.${RESET} Scroll up for details."
  exit "$rc"
fi
