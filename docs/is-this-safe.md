# 🛡️ How safe is this? What it installs, and what could go wrong

Short version: I'm a GM who got fed up and wrote this for my own table. This
page is me telling you exactly what it does to your computer, including the
parts I'm not thrilled about, because you're about to run a stranger's code and
you deserve to make that call with the facts.

I'd rather be transparent than reassuring. Where something could bite you, it's
below.

## Where this came from

I wanted a record of my sessions. Not minutes — the actual story. The bit where
the rogue did something monumentally stupid and it somehow worked. The joke
that had everyone crying. The line the DM delivered that made the table go
quiet.

The existing options didn't fit. Meeting transcribers are built for standups:
you get a transcript and a bulleted summary, for £15 a month, forever, in
somebody else's cloud. And none of them have the faintest idea who Wiktoria is —
they'd hear the name, invent a spelling, and confidently use the wrong one for
three hours straight.

So this got built. It's a niche tool for a niche group of people: GMs who want
their campaign written up properly, grounded in their own names and lore, on
their own machine, without a subscription. If that's you, welcome. If you need
something polished and enterprise-grade, I'd genuinely point you elsewhere —
this is one person's project, and the rest of this page is about what that
means for you.

## It's a work in progress, and it's tested on one PC

This is version 1.3.0. It's not a commercial product with a QA department. It's
tested on my machine, which runs Windows and has an NVIDIA card, and that shows
up in what I can honestly claim:

| Area | How well tested |
|---|---|
| Windows | My daily driver. Well exercised. |
| Linux / macOS | **Not tested.** It should work — I haven't proven it. |
| Cloud providers (Gemini / Claude / OpenAI) | Well exercised — this is the path I use every session. |
| Audio transcription (Whisper) | Exercised on an NVIDIA GPU. CPU-only works, but slowly. |
| Claude Code add-on | Exercised. |
| Codex add-on | Partially tested. |
| Local LLMs add-on | **Partially tested** — I don't have the VRAM to run anything above 4B. |
| Obsidian vault add-on | Exercised, including the writes described below. |

I don't expect anything serious to go wrong, but "I don't expect" isn't a
guarantee and I'm not going to dress it up as one. What I have tried hard to
do is make sure that if something *does* go wrong, it wrecks files this app
created — not the files you already had. Most of this page is about how well
that holds up, and where it doesn't.

---

## What you need before you start (I can't install these for you)

Being straight about this, because it's the bit that catches people out: there
is no one-click installer yet. You need a couple of things already on your
machine, and **Tusk's Tomes deliberately does not install them for you** — a
setup script that silently installs system-wide software is exactly the kind of
thing I wouldn't want running on my own PC. It checks, tells you the exact
command, and stops.

| You need | When | If it's missing |
|---|---|---|
| **Node.js 20+** | Always. Nothing runs without it. | Setup stops and prints `winget install OpenJS.NodeJS.LTS`. |
| **Git** | To download the project in the first place. | Setup prints the install command. |
| **Python 3.10, 3.11 or 3.12** | **Only** for the audio-transcription add-on. | The core app is completely fine without it. |

Two things worth knowing:

- **Python 3.13 does not work** for transcription — the speech-to-text
  libraries have no builds for it yet. If you have 3.13, install 3.12
  alongside it. Setup checks your version and says so rather than letting you
  discover it 2 GB into a failed install.
- **You do not need Visual Studio Build Tools**, whatever older guides say.
  Nothing in the dependency tree compiles native code any more.

So yes — realistically this is still a "you're comfortable installing Node and
running a `.bat` file" project. I'd like that not to be true, and a proper
standalone installer that handles the whole thing is on the
[roadmap](../ROADMAP.md). Right now it isn't done, and pretending otherwise
would just waste your evening.

## What it installs, and where

There's no installer. You clone a folder and run `setup.bat` (or `setup.sh`).
No MSI, no elevation prompt, nothing added to Windows itself.

| Location | What | Size |
|---|---|---|
| `<the folder you cloned into>` | The program itself. | ~8 MB |
| `…\node_modules` | JavaScript libraries, fetched by `npm install`. | ~360 MB (measured on Windows) |
| `…\dist`, `…\dist-server` | Built output, only if you run a build. | ~5 MB |
| `…\vendor\python-venv` | Python + the speech-to-text model. **Only if you install the audio add-on.** | 1.5–2.5 GB |
| `…\Sessions\<campaign>\` | Your finished chronicles, as Markdown. | small |
| `%APPDATA%\tusks-tomes` | Settings, glossary, speaker names, encrypted API key. | < 1 MB |
| `%LOCALAPPDATA%\tusks-tomes` | Session recordings, transcripts, run checkpoints. | large, if you upload audio |

The first six live inside the folder you cloned. Delete that folder and they're
gone.

### Three things I think you should understand

**`node_modules` is other people's code.** It's the standard JavaScript
dependency set from npm, and it's by far the largest body of code on your
machine that I didn't write. I can't personally vouch for all of it — nobody in
this ecosystem can. What I can tell you is that it's all listed in
`package.json`, `npm audit` will report known problems in it any time you ask,
and CI fails the build if a shipping dependency has a high-severity advisory.

**The Whisper add-on is the heavy one.** It installs Python packages including
PyTorch, plus a CUDA build if you have an NVIDIA card. It's big, it's fiddly,
and it's the step most likely to fall over on your machine. It's also entirely
optional and lives in exactly one folder.

**Your API key is encrypted, but it's still on your disk.** It's tied to this
machine — hostname, username, platform — so copying the file to another
computer won't decrypt it. That defends against someone stealing the file. It
doesn't defend against someone already sitting at your computer.

---

## Everything it writes outside its own folder

I'd rather list these than tell you "it all stays in one place", because that
isn't true. Every one of them happens because you asked for it.

| What it writes | Where | When |
|---|---|---|
| Settings, keys, glossary | `%APPDATA%\tusks-tomes` | When you change a setting. |
| Recordings, transcripts, checkpoints | `%LOCALAPPDATA%\tusks-tomes` | When you upload audio or pause a run. |
| Cached probe results | the platform cache folder | Throwaway; safe to delete any time. |
| A `Tusks-Lore` folder **beside** the program folder | your chosen location | Only if you click "Create lore folder". |
| Files into a paired **Tusk's Vault** install | wherever you put Vault | Only if you pair them and send a chronicle across. |
| **Into your Obsidian vault** | the folder you picked | Only via three specific, opt-in buttons — see below. |

### The Obsidian vault is the one that would worry me

That folder is *your notes*. It's the only place this app writes to something
you made, and I don't take that lightly. Reading is the normal mode. There are
exactly three writes, all behind a button you have to press:

1. **Markdown conversion** — makes a `.md` copy of a Word or PDF file, beside
   the original. It never modifies or deletes your original, and it refuses to
   overwrite an existing `.md`.
2. **`CLAUDE.md` generator** — writes a navigation guide into the vault root.
   If one already exists it stops and asks before replacing it.
3. **Graphify index** — writes a `graphify-out/` folder into the vault.

The code that reads your vault during a normal chronicle run cannot write at
all. That's not me promising to be careful — there's a test that fails the
build if a write call ever appears in those files.

**If your vault matters to you and isn't already backed up or in git, back it
up before you first use those features.** I'd tell you that about any tool that
touches your notes, including mine.

---

## What it never does

- No registry entries, no services, no scheduled tasks, no startup items, no
  PATH changes.
- No Administrator elevation, ever. If something asks you for admin rights
  while you're installing this, it didn't come from me.
- No telemetry, no analytics, no crash reporting, no update pings. There's
  nothing to opt out of because there's nothing there. I don't know how many
  people use this and I'm fine with that.
- No account, no login, no server of mine anywhere.
- It listens on `127.0.0.1` — your machine only, not your network.

The one thing that leaves your computer is transcript text going to whichever
AI provider you set up, so it can write the chronicle. That's the entire
network story. Point it at a local model and even that stops.

---

## What could go wrong — the things I already know about

### The folder isn't writable

The most common failure by a mile. It happens when the folder is in
`C:\Program Files`, at the root of `C:\`, on a disconnected network drive, or
being held by OneDrive or antivirus. Setup checks for this before touching
anything, so you get told rather than left with a half-finished install.

**Fix:** move the folder to Documents or Desktop and run setup again.

**Please don't "fix" it by running as Administrator.** It's the first thing
everyone tries and it makes things worse — you end up with files your normal
account can't modify, and the app fails later in far more confusing ways. This
never needs elevation.

### The Python / Whisper install falls over part-way

Python packaging is fragile and this step downloads a lot. I've seen it fail
from: no Python, Python not on PATH, no disk space, a dropped connection
mid-download, and antivirus interrupting file creation.

**How bad is it:** contained to `vendor\python-venv`. Delete that folder and
re-run the add-on install. Your system Python is never touched — the whole
reason it builds a separate environment is so a bad day here can't reach it.

### Antivirus gets involved

To a heuristic scanner, installing software looks a lot like malware: a process
creating hundreds of files fast and pulling down executables. If setup dies
with no explanation, check your antivirus history before assuming the app is
broken. All the source is public if you want to look first.

### The uninstaller genuinely deletes things

It's the one part with real destructive power, so here's how it's fenced in. It
refuses to run unless it's sitting in a real Tusk's Tomes folder. It resolves
every path through the filesystem before deleting, so a symlink can't redirect
it somewhere else. It refuses any path that isn't either inside the program
folder or inside a folder with `tusks-tomes` in its name. It makes you type
`I UNDERSTAND` before it starts. It keeps everything you authored unless you
explicitly tell it not to, and it never touches a lore folder or a custom
session folder.

It's still code, and code has bugs. **`npm run uninstall -- --dry-run` shows
you exactly what it would delete and deletes nothing.** Worth doing first.

One sharp edge I know about: it decides which folder to clean from **its own
location on disk**, not from where you run it. If you copy `uninstall.mjs`
somewhere else and run it there, it will still go after the folder it was
copied from. Run it in place with `npm run uninstall`. I know this because I
caught it out exactly that way during development.

### Platforms I can't test

On Linux or macOS you may well be the first person down that path. I don't
expect breakage, but I haven't earned the right to say more than that. If you
hit something, please tell me — that's genuinely the fastest way it gets fixed.

### Putting it on your network

By default only your own machine can reach it. Setting `TUSKS_HOST=0.0.0.0`
makes it reachable across your local network. Even then, write operations stay
off unless you separately enable them — but anyone on that network could still
read your transcripts. Only do it on a network you control.

### It runs other programs

Tusk's Tomes launches other software on your machine: Python for transcription,
`ffmpeg` for audio, `nvidia-smi` to ask about your graphics card, and — if you
turn those add-ons on — the `claude`, `codex` or `ollama` commands. All with
your normal user permissions, never elevated, and all programs you installed
yourself.

---

## Keeping the blast radius small

Things that genuinely limit what a bug of mine could reach:

- **Clone into a normal folder.** Documents or Desktop. Not Program Files, not
  a synced OneDrive folder.
- **Back up your Obsidian vault** before first using the conversion or
  generator buttons, if it isn't in version control already.
- **Run the uninstaller with `--dry-run` first.**
- **Skip add-ons you don't need.** Everything past "paste a transcript" is
  opt-in. Not installing Whisper skips 2 GB and the most fragile step there is.
- **Keep your lore folder outside the program folder** — that's the default, and
  it means deleting the app can never reach your notes.

---

## Don't take my word for it

It's all public at
[github.com/KochiTusker/Tusks-Tomes](https://github.com/KochiTusker/Tusks-Tomes).
If you only read four files, read these — they're the ones that actually answer
this question:

- `setup.bat` / `scripts/setup/check-deps.mjs` — everything the install does.
- `scripts/uninstall.mjs` — everything the uninstall does, guards included.
- `scripts/whisper/setup.ps1` — the Python environment build.
- `server/lore/obsidian/` — the vault code, and the read-only test that enforces
  what I claimed above.

If any of it doesn't match what you see happening, that's a bug and I want to
know: [open an issue](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose).

## Getting rid of it

```
npm run uninstall
```

It keeps everything you authored unless you pass `--purge-user-data`, and
leaves a `TUSKS-TOMES-uninstall-notes.md` in the folder listing what was
removed, what was kept and where, and which leftovers are **shared with other
software** and shouldn't be deleted just to tidy up. Move that file somewhere
safe before you delete the folder.

`npm run uninstall -- --list-locations` prints the same paths and deletes
nothing at all.

Then delete the folder. Nothing of mine is left outside the locations at the
top of this page.
