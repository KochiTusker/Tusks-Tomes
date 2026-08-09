# ===========================================================================
# Tusk's Tomes -- apply updates (Windows)
#
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\update\apply.ps1
#
# Same flow as scripts/update/apply.sh on macOS/Linux:
#   1. Confirm we're inside a git checkout (not a ZIP install).
#   2. Confirm we're on the main branch.
#   3. Confirm the working tree is clean (refuses to clobber local edits).
#   4. git fetch origin main
#   5. git pull --ff-only origin main  (refuses non-fast-forward)
#   6. npm install --no-audit --no-fund (ONLY if package.json or
#      package-lock.json changed between preHead and postHead -- skipped
#      otherwise so the running dev server's node_modules file handles
#      don't collide with npm's writes)
#
# Designed to be invoked by the in-app Updater UI (which calls
# /api/updater/apply) or run by hand from PowerShell.
#
# ASCII-only on purpose. Windows PowerShell 5.1 reads .ps1 files in the
# system ANSI codepage (CP-1252) when there is no UTF-8 BOM. Em-dashes and
# other multi-byte characters get misread and break the parser. Keep this
# file strict ASCII.
# ===========================================================================

$ErrorActionPreference = 'Stop'

# Move to repo root regardless of where the script was launched from.
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repoRoot

# Remote override: the server passes TUSKS_TOMES_UPDATE_REMOTE=dev when
# the maintainer has flipped updaterRemote in /api/settings. Default is
# "origin", which on a normal user install is the public Tusks-Tomes repo.
# The security gate is GitHub auth -- without dev-repo credentials,
# git pull from "dev" just 404s.
$remote = if ($env:TUSKS_TOMES_UPDATE_REMOTE) { $env:TUSKS_TOMES_UPDATE_REMOTE } else { 'origin' }

function Write-Step { param([string]$m) Write-Host "[update] $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "[update] $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "[update] $m" -ForegroundColor Yellow }
function Fail       { param([string]$m) Write-Host "[update] $m" -ForegroundColor Red; exit 1 }

# Step 1 -- git checkout?
if (-not (Test-Path '.git')) {
    Fail "Not a git checkout (no .git directory at $repoRoot). If you installed Tusk's Tomes by downloading a ZIP from GitHub, the in-app updater can't help -- re-download the latest ZIP or clone with git instead."
}

# Step 2 -- on main?
$currentBranch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($currentBranch -ne 'main') {
    Fail "Currently on branch '$currentBranch', not 'main'. The updater only updates the main branch -- switch with: git checkout main"
}

# Step 3 -- working tree clean?
$dirty = & git status --porcelain
if ($dirty) {
    Write-Warn "Working tree has uncommitted changes:"
    & git status --short
    Fail "Refusing to update -- commit or stash these changes first so they're not lost."
}

# Step 4 -- fetch
Write-Step "Fetching latest from $remote/main..."
& git fetch $remote main
if ($LASTEXITCODE -ne 0) {
    Fail "git fetch failed pulling from '$remote' (network problem? '$remote' remote misconfigured? credentials missing for a private remote?)."
}

$localHead = (& git rev-parse HEAD).Trim()
$remoteHead = (& git rev-parse "$remote/main").Trim()

if ($localHead -eq $remoteHead) {
    Write-Ok "Already up to date (HEAD is at $($localHead.Substring(0,7)))."
    exit 0
}

# Step 5 -- fast-forward pull
Write-Step "Pulling new commits from $remote/main..."
$preHead = $localHead
& git pull --ff-only $remote main
if ($LASTEXITCODE -ne 0) {
    Fail "git pull failed -- your local main has diverged from $remote/main. Resolve manually with: git status, git log --oneline main..$remote/main"
}
$postHead = (& git rev-parse HEAD).Trim()

# Step 6 -- DO NOT run npm install in-process when dependencies changed.
#
# The dev server (the same process that just invoked this script via the
# in-app updater) holds file handles inside node_modules via Vite's
# chokidar watcher. Running npm install while those handles are held
# collides on Windows (EPERM / EBUSY) and can corrupt node_modules.
#
# Our policy: the in-app updater handles the git pull only. If dependency
# files changed, we print the exact command the user needs to run after
# stopping the dev server, and exit 0 -- the pull itself succeeded. The
# UI parses the DEPENDENCY_CHANGES_DETECTED marker to surface a banner
# with a copy-to-clipboard command.
$depFiles = & git diff --name-only "$preHead..$postHead" 2>$null | Where-Object {
    $_ -eq 'package.json' -or $_ -eq 'package-lock.json'
}
if (-not $depFiles) {
    Write-Step "No dependency changes -- npm install not required."
} else {
    Write-Warn "DEPENDENCY_CHANGES_DETECTED"
    Write-Warn "package.json or package-lock.json changed in this update."
    Write-Warn "The in-app updater does NOT run npm install for you when deps change --"
    Write-Warn "the dev server holds file handles in node_modules and the install would"
    Write-Warn "collide. After this update completes, do the following manually:"
    Write-Warn ""
    Write-Warn "  1. Stop the dev server (Ctrl+C in the npm run dev window)."
    Write-Warn "  2. In that same window run: cmd /c npm install --no-audit --no-fund"
    Write-Warn "  3. Restart the dev server (Start_Tusks_Tomes.bat or npm run dev)."
    Write-Warn ""
}

$updatedCount = (& git log --oneline "$preHead..$postHead" | Measure-Object -Line).Lines
Write-Ok "Update complete -- pulled $updatedCount new commit(s). HEAD is now $($postHead.Substring(0,7))."
Write-Warn "Restart the dev server (Ctrl+C in the npm run dev window, then re-run) to load the new server code."
