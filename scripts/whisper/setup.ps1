# Whisper venv bootstrap (Windows). Creates vendor\python-venv and installs
# faster-whisper + torch with the CUDA variant detected via nvidia-smi.
#
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\whisper\setup.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$venvDir = Join-Path $repoRoot 'vendor\python-venv'
$requirementsFile = Join-Path $PSScriptRoot 'requirements.txt'

# Plain-English preamble. This is the step most likely to alarm a
# non-technical user: a terminal opens on its own and downloads well over a
# gigabyte while printing words like "CUDA" and "torch". Saying up front what
# is happening, where it is going, and how to undo it costs nothing and heads
# off "is my machine being hacked?".
Write-Host ""
Write-Host "  ============================================================"
Write-Host "    Setting up speech-to-text (Whisper)"
Write-Host "  ============================================================"
Write-Host ""
Write-Host "  WHAT IS ABOUT TO HAPPEN"
Write-Host ""
Write-Host "    This installs the software that turns your session recordings"
Write-Host "    into text. It runs entirely on your own computer - your audio"
Write-Host "    is never uploaded anywhere."
Write-Host ""
Write-Host "    You will see a lot of technical text scroll past, including"
Write-Host "    words like 'torch', 'CUDA' and 'pip'. Those are just the names"
Write-Host "    of the components being downloaded. It is normal."
Write-Host ""
Write-Host "    Where everything goes:"
Write-Host "      $venvDir"
Write-Host ""
Write-Host "    Everything is placed in that one folder, inside Tusk's Tomes."
Write-Host "    Nothing is installed into Windows. Administrator rights are"
Write-Host "    never requested. To remove it all later, either use"
Write-Host "    Settings > Add-ons > Uninstall, or just delete that folder."
Write-Host ""
Write-Host "    Download size: roughly 1.5-2.5 GB. This can take several"
Write-Host "    minutes on a slow connection. You can leave it running."
Write-Host ""
Write-Host "  ------------------------------------------------------------"
Write-Host ""

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "  [needed] Python isn't installed yet." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Whisper is written in Python, so Python has to be installed"
    Write-Host "  first. Install Python 3.10-3.12 from https://python.org,"
    Write-Host "  tick 'Add Python to PATH' in the installer, then close this"
    Write-Host "  window and try again."
    Write-Host ""
    Write-Error "Python is required on PATH. Install Python 3.10-3.12 from https://python.org and re-run."
}

if (-not (Test-Path $venvDir)) {
    Write-Host "  Step 1 of 4: making a private Python folder for Tusk's Tomes."
    Write-Host "    This keeps our components separate from any other Python"
    Write-Host "    you may already use, so nothing else on your PC changes."
    python -m venv $venvDir
} else {
    Write-Host "  Step 1 of 4: reusing the Python folder from a previous run."
}

$venvPython = Join-Path $venvDir 'Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    Write-Error "python.exe not found in venv at $venvPython"
}

# Detect CUDA via nvidia-smi.
$cudaTag = 'cpu'
Write-Host ""
Write-Host "  Step 2 of 4: checking whether you have a graphics card we can use."
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    $cudaLine = nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>$null
    if ($LASTEXITCODE -eq 0 -and $cudaLine) {
        Write-Host "    Found an NVIDIA graphics card. Transcription will use it,"
        Write-Host "    which makes it roughly 10x faster than using the processor."
        $cudaTag = 'cu124'
    }
}
if ($cudaTag -eq 'cpu') {
    Write-Host "    No NVIDIA graphics card found - transcription will use your"
    Write-Host "    processor instead. It still works, but expect a 3-hour"
    Write-Host "    recording to take a few hours rather than 20-30 minutes."
}

# Upgrade pip via `python -m pip` — pip can't modify itself when invoked
# directly as pip.exe.
Write-Host ""
Write-Host "  Step 3 of 4: updating the Python installer tool."
& $venvPython -m pip install --upgrade pip

# torch lower bound: 2.2 (earliest version we've validated against
# faster-whisper). No upper bound below the next major release; in
# particular torch < 2.6 has no Python 3.13 wheels, so a tight upper
# bound would break this script on newer Python installs.
Write-Host ""
Write-Host "  Step 4 of 4: downloading the speech-to-text components."
Write-Host "    This is the big one - most of the download happens here."
Write-Host "    Long lists of file names below are expected."
Write-Host ""
if ($cudaTag -eq 'cpu') {
    & $venvPython -m pip install --index-url https://download.pytorch.org/whl/cpu 'torch>=2.2,<3'
} else {
    & $venvPython -m pip install --index-url "https://download.pytorch.org/whl/$cudaTag" 'torch>=2.2,<3'
}

& $venvPython -m pip install -r $requirementsFile

Write-Host ""
Write-Host "  ------------------------------------------------------------"
Write-Host "    Done. Speech-to-text is ready." -ForegroundColor Green
Write-Host ""
Write-Host "    Installed into: $venvDir"
Write-Host "    Nothing outside Tusk's Tomes was changed."
Write-Host ""
Write-Host "    Next: close Tusk's Tomes and start it again with"
Write-Host "    Start_Tusks_Tomes.bat so the new feature loads."
Write-Host "  ------------------------------------------------------------"
Write-Host ""
