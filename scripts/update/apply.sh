#!/usr/bin/env bash
# ===========================================================================
# Tusk's Tomes — apply updates (macOS / Linux)
#
# Runs from the repo root:
#   bash scripts/update/apply.sh
#
# Steps:
#   1. Confirm we're inside a git checkout (not a ZIP install).
#   2. Confirm we're on the main branch.
#   3. Confirm the working tree is clean (refuses to clobber local edits).
#   4. git fetch origin main
#   5. git pull --ff-only origin main  (refuses non-fast-forward, prevents
#      surprise merge commits on the user's machine)
#   6. npm install --no-audit --no-fund (ONLY if package.json or
#      package-lock.json changed between PRE_HEAD and POST_HEAD —
#      skipped otherwise so the running dev server's node_modules file
#      handles don't collide with npm's writes)
#
# Prints a one-line summary at the end. Exit code 0 on success, non-zero
# otherwise. Designed to be invoked by the in-app Updater UI (which calls
# /api/updater/apply) or run by hand from a terminal.
# ===========================================================================

set -eu

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

# Remote override: the server passes TUSKS_TOMES_UPDATE_REMOTE=dev when
# updaterRemote has been flipped in /api/settings. Default is
# "origin", which on a normal user install is the public Tusks-Tomes repo.
# The security gate is GitHub auth — without dev-repo credentials,
# git pull from "dev" just 404s.
REMOTE="${TUSKS_TOMES_UPDATE_REMOTE:-origin}"

GREEN=$'\e[32m'
YELLOW=$'\e[33m'
RED=$'\e[31m'
BOLD=$'\e[1m'
RESET=$'\e[0m'

if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
  GREEN=""; YELLOW=""; RED=""; BOLD=""; RESET=""
fi

fail() {
  echo "${RED}[update] ${1}${RESET}" >&2
  exit 1
}

info() {
  echo "${BOLD}[update]${RESET} ${1}"
}

# Step 1 — git checkout?
if [ ! -d ".git" ]; then
  fail "Not a git checkout (no .git directory at ${REPO_ROOT}). If you installed Tusk's Tomes by downloading a ZIP from GitHub, the in-app updater can't help — re-download the latest ZIP or clone with git instead."
fi

# Step 2 — on main?
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  fail "Currently on branch '${CURRENT_BRANCH}', not 'main'. The updater only updates the main branch — switch with: git checkout main"
fi

# Step 3 — working tree clean?
if [ -n "$(git status --porcelain)" ]; then
  echo "${YELLOW}[update] Working tree has uncommitted changes:${RESET}" >&2
  git status --short >&2
  fail "Refusing to update — commit or stash these changes first so they're not lost."
fi

# Step 4 — fetch
info "Fetching latest from ${REMOTE}/main…"
git fetch "${REMOTE}" main || fail "git fetch failed pulling from '${REMOTE}' (network problem? '${REMOTE}' remote misconfigured? credentials missing for a private remote?)."

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "${REMOTE}/main")"
if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  info "${GREEN}Already up to date${RESET} (HEAD is at ${LOCAL_HEAD:0:7})."
  exit 0
fi

# Step 5 — fast-forward pull
info "Pulling new commits from ${REMOTE}/main…"
PRE_HEAD="$LOCAL_HEAD"
if ! git pull --ff-only "${REMOTE}" main; then
  fail "git pull failed — your local main has diverged from ${REMOTE}/main. Resolve manually with: git status, git log --oneline main..${REMOTE}/main"
fi
POST_HEAD="$(git rev-parse HEAD)"

# Step 6 — DO NOT run npm install in-process when dependencies changed.
#
# The dev server (the same process that just invoked this script via the
# in-app updater) holds file handles inside node_modules via Vite's
# chokidar watcher. Running npm install while those handles are held can
# corrupt node_modules — clean on POSIX is friendlier than Windows but
# the policy is the same for predictability.
#
# Our policy: the in-app updater handles the git pull only. If dependency
# files changed, we print the exact command the user needs to run after
# stopping the dev server, and exit 0 — the pull itself succeeded. The
# UI parses the DEPENDENCY_CHANGES_DETECTED marker to surface a banner
# with a copy-to-clipboard command.
if git diff --name-only "${PRE_HEAD}..${POST_HEAD}" | grep -qE '^package(-lock)?\.json$'; then
  echo "${YELLOW}[update] DEPENDENCY_CHANGES_DETECTED${RESET}" >&2
  echo "${YELLOW}[update] package.json or package-lock.json changed in this update.${RESET}" >&2
  echo "${YELLOW}[update] The in-app updater does NOT run npm install for you when deps${RESET}" >&2
  echo "${YELLOW}[update] change — the dev server holds file handles in node_modules and${RESET}" >&2
  echo "${YELLOW}[update] the install would collide. After this update completes, do:${RESET}" >&2
  echo "${YELLOW}[update]${RESET}" >&2
  echo "${YELLOW}[update]   1. Stop the dev server (Ctrl+C in the npm run dev window).${RESET}" >&2
  echo "${YELLOW}[update]   2. In that same window run: npm install --no-audit --no-fund${RESET}" >&2
  echo "${YELLOW}[update]   3. Restart the dev server (bash start.sh or npm run dev).${RESET}" >&2
  echo "${YELLOW}[update]${RESET}" >&2
else
  info "No dependency changes — npm install not required."
fi

UPDATED_COUNT="$(git log --oneline "${PRE_HEAD}..${POST_HEAD}" | wc -l | tr -d ' ')"
info "${GREEN}Update complete${RESET} — pulled ${UPDATED_COUNT} new commit(s). HEAD is now ${POST_HEAD:0:7}."
info "${YELLOW}Restart the dev server (Ctrl+C in the npm run dev window, then re-run) to load the new server code.${RESET}"
