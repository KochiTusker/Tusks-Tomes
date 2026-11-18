# Setting up without a terminal

If you've **never opened a terminal, never used GitHub, and never installed a
Node.js project**, this is the page for you. It assumes none of that and
explains each step as it comes.

![The road from nothing to a first chronicle, as eight numbered steps in three stretches. Once, on your computer: 1, install Node.js and Git from nodejs.org and git-scm.com; 2, download Tusk's Tomes by cloning it or taking the ZIP; 3, double-click setup.bat, which takes one to three minutes. Each time you start it: 4, double-click Start_Tusks_Tomes.bat, wait for READY and keep the window open; 5, your browser opens the app. In the app: 6, add a way to reach a model, a Gemini or OpenRouter key or Claude Code or Codex; 7, add your lore and players; then 8, chronicle a session, drawn in gold as what comes out. A dashed box between 7 and 8 marks an optional step with no number: audio transcription, with Python first and then Install.](../assets/diagrams/getting-it-running.svg)

I'll be honest about the time, because I'd rather you knew going in: **budget
about 20 minutes** the first time. Roughly ten of that is installing Node.js
and downloading the project — one-off, and you'll never do it again. The
remainder is the app itself, which is quick.

If you also want audio transcription for Craig recordings, add Python
(~5 minutes) and the transcription install (which downloads about 1.5–2.5 GB, so it depends
entirely on your connection). That part is optional and you can leave it until
later, or skip it entirely — there's a route that uses YouTube to do the
transcribing for you.

It's fiddlier than double-clicking an installer, and I know that. A proper
standalone installer is on the [roadmap](../about/roadmap.md); it isn't built yet,
and I'd rather tell you that now than halfway down the page.

> **What you get straight away:** the Chronicle tab (paste a transcript, get a
> proper write-up), Caption Repair (drop in a YouTube `.sbv`), Tome of Lore
> (your campaign notes and glossary), and Settings. The Sessions tab,
> with audio upload at the top of it, arrives with the add-on if you decide you want it.

> **If you get stuck, that's a bug in this guide, not a failing on your part.**
> Tell me via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)
> and I'll fix the wording.

---

<details class="docs-section">
<summary><h2>Step 1 — Install Node.js</h2></summary>
<div class="docs-section-body">


Node.js is the runtime that powers Tusk's Tomes. One install, then you never see it again.

1. Go to <https://nodejs.org>.
2. Click the big green **LTS** button (LTS = "long-term support" = the stable version).
3. Run the installer. Defaults are fine — click Next, Next, Install.
4. Restart your computer if it asks you to.

That's it. You don't need to "do anything" with Node — just installing it makes the launcher scripts work.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Step 2 — *(Optional)* Install Python</h2></summary>
<div class="docs-section-body">


> **Skip this step if you don't need audio transcription.** You can always come back later when you decide you want it. The Audio Transcription add-on (which needs Python) unlocks Craig multitrack uploads and direct audio-to-text. If you're starting from YouTube `.sbv` captions or pasting transcripts directly, you'll never touch Python.

1. Go to <https://python.org/downloads>.
2. Click the big yellow **Download Python 3.12** button (or 3.10 or 3.11 — any of those three).
3. Run the installer. **Important:** tick the box that says **"Add python.exe to PATH"** at the bottom of the first screen. Then click Install Now.
4. Restart your computer.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Step 3 — Download Tusk's Tomes</h2></summary>
<div class="docs-section-body">


You have two options here. Option B is recommended because it gets you one-click updates from inside the app.

### Option A — Download the ZIP

1. Go to <https://github.com/KochiTusker/Tusks-Tomes>.
2. Click the green **`<> Code`** button at the top, then **Download ZIP** at the bottom of the dropdown.
3. Find the file in your Downloads folder. **Right-click → Extract All…** Pick a folder you'll remember, like `Documents\Tusks-Tomes`.

> **Trade-off:** the in-app updater needs Git, so if you go the ZIP route you'll have to re-download a fresh ZIP whenever a new version drops. Most updates take 30 seconds; this isn't a big deal. **Setup also checks for Git and stops if it can't find it**, so install Git (the first step of Option B) even if you take the ZIP.

### Option B — Clone with Git (one-click updates later)

1. Install Git for Windows from <https://git-scm.com/download/win> — defaults are fine.
2. Right-click in any folder where you want Tusk's Tomes to live, and click **Open in Terminal** (or open Command Prompt and `cd` to that folder).
3. Type this and press Enter:

   ```sh
   git clone https://github.com/KochiTusker/Tusks-Tomes.git
   ```

   This creates a `Tusks-Tomes/` folder with the code in it.

> **About the folder name:** if you're also using [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault), keep both repos as **siblings** — for example, `Documents\Tusks-Tomes\` and `Documents\Tusks-Vault\`. The two find each other automatically when they're sitting next to each other. Don't rename `Tusks-Tomes` to something else, or sibling auto-detection won't work.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Step 4 — Run the first-time setup script</h2></summary>
<div class="docs-section-body">


1. Open the folder where you put Tusk's Tomes.
2. **Double-click `setup.bat`**. A black window opens. It will:
   - Confirm Node and Git are present (prints exact `winget` install commands for anything missing).
   - Detect your GPU (reports only — no install).
   - Copy `.env.example` to `.env`.
   - Install the Node packages (1–3 minutes, depending on your connection).
3. When it says "Setup complete", close the window.

`setup.bat` is plain readable text — open it in Notepad first if you want to see exactly what it does. About 100 lines, no admin elevation, no system-wide installs.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Step 5 — Launch the app</h2></summary>
<div class="docs-section-body">


1. **Double-click `Start_Tusks_Tomes.bat`**.
2. A black window opens and says "Starting on http://localhost:5173". Below that, the app prints its own numbered start-up steps — `[1/5]`, `[2/5]` and so on, each with the seconds elapsed — and then a line that says **READY** with the address.
3. Your browser opens to the dashboard by itself the moment that READY line appears. The first start after setup or an update takes 15–30 seconds, because the app prepares its files; later starts take a few seconds.
4. If you open the address yourself before READY, you get a dark page that says "starting…" and names the step the app is on. Leave it: it turns into the app on its own when the server is ready.
5. **Leave the black window open** — closing it stops the server.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Step 6 — Configure from the dashboard</h2></summary>
<div class="docs-section-body">


Everything below happens in your browser. No code, no config files.

1. **Add an LLM API key.** Settings → Providers & models → paste a Gemini or OpenRouter key → **Save**.
   - **Don't have one yet?** See [providers.md](../models/choosing-a-provider.md) for paid-key sign-up walkthroughs. (Gemini Pro moved behind billing in 2026 — a paid key is required for the main pipeline; the project has been engineered to keep that bill small.)
   - **Want the mechanical phases on your own machine?** Install [Ollama](https://ollama.com), start it, then open Settings → Providers & models; the panel detects it, and **Detect again** repeats the check. The chronicle still needs a cloud model or a subscription. There is nothing to install on the Tomes side.
2. *(Optional)* **Install Audio Transcription.** If you want to upload Craig recordings or transcribe audio files directly: **Settings → Transcription → Install**. This downloads the Whisper sidecar (about 1.5–2.5 GB) and requires Python from Step 2. Restart `Start_Tusks_Tomes.bat` when prompted. This is the only module that installs anything.
3. **Drop in your campaign lore.** Tome of Lore tab → upload PDFs / Word docs / notes. Add Glossary entries for proper nouns the model would otherwise mangle.
4. **List your players.** Same tab → Speakers card → add a row per player with their player name + character name.
5. **Chronicle a session.** Either paste a transcript into the Chronicle tab, or follow one of the [three routes](../importing/README.md).

---


</div>
</details>

<details class="docs-section">
<summary><h2>macOS / Linux equivalents</h2></summary>
<div class="docs-section-body">


Same idea, terminal-flavoured:

```sh
# 1. Install Node 22+, Python 3.10-3.12 (optional), Git
# macOS:  brew install node python git
# Debian: sudo apt install nodejs npm python3 python3-venv git
# Fedora: sudo dnf install nodejs npm python3 git
# Arch:   sudo pacman -S nodejs npm python git

# 2. Clone
git clone https://github.com/KochiTusker/Tusks-Tomes.git
cd Tusks-Tomes

# 3. One-time setup
bash setup.sh

# 4. Run any time
bash start.sh                       # or: npm run dev
```

`setup.sh` is optional — `start.sh` will install dependencies on first launch too. To stop: `Ctrl+C` in the terminal, or close the window.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Stopping / starting later</h2></summary>
<div class="docs-section-body">


- **Stop:** close the black window (Windows) or `Ctrl+C` in the terminal (macOS / Linux).
- **Start:** double-click `Start_Tusks_Tomes.bat` (Windows) or run `bash start.sh` (POSIX).

Your keys, lore, glossary, per-phase routing, and chronicles are all saved — Tomes picks up exactly where you left off.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Where to ask for help</h2></summary>
<div class="docs-section-body">


The fastest way to get unstuck right now is the **[feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)** — the maintainer reads every submission. A community Discord with a `#support` channel of fellow DMs is on the [roadmap](../about/roadmap.md); the form is what we have until enough interest signals it's worth spinning one up.

If you'd rather file a written issue, [open one on GitHub](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose) — the templates ask for exactly the info needed.


</div>
</details>
