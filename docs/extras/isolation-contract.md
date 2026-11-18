# Module isolation

← Back to [add-on README](README.md) · Also lives at [the same path in Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault/blob/main/docs/add-ons/node-isolation.md) so both repos enforce the same contract.

> [!IMPORTANT]
> **The promise to the user:** installing a module must never change anything outside this repo's working directory. Uninstalling must remove every byte the install wrote. The host computer's Python, Node, PATH, registry, and home directory stay untouched. Apart from the download caches that pip and faster-whisper keep in your user profile (described below), the one thing a module keeps outside the repo is its on/off switch in `{configDir}/addons.json`, written only when you flip it.

> [!NOTE]
> **This contract binds installable modules only.** Today that is Audio
> Transcription, and any future module that genuinely puts bytes on disk. A
> built-in cannot declare `uninstall()` at all, so it has no way to violate
> the promise above.

---

<details class="docs-section">
<summary><h2>Why this matters</h2></summary>
<div class="docs-section-body">

The audience for Tusk's Tomes and Tusk's Vault is GMs and players, not sysadmins. We can't assume:

- A specific Python version is on the user's PATH (or that the user is willing to install one).
- A specific Node version is on the user's PATH (the app requires a minimum and warns at startup below it, but the user's system Node might be older or newer).
- The user is comfortable running a system-wide `npm install` that pulls 200 MB of transitive deps.
- The user can recover if an install corrupts their `%APPDATA%` or their system Python's `site-packages`.

So: **every add-on owns its own dependency tree, in a folder beneath this repo, and never touches global state.** Python via venv (already implemented for the Whisper add-on); Node via a per-add-on `package.json` + isolated `node_modules` (the pattern this doc enforces for the next add-on that needs Node deps).

</div>
</details>

<details class="docs-section">
<summary><h2>The Python pattern (reference implementation)</h2></summary>
<div class="docs-section-body">

The audio-transcription add-on (Whisper + Craig) is the canonical Python example. The pattern:

| Step | Where it lives | What it touches |
|---|---|---|
| Setup script | `scripts/whisper/setup.ps1` (Windows), `scripts/whisper/setup.sh` (POSIX) | The user's system Python is *read* (for `python -m venv`) but never mutated. |
| Venv created | `vendor/python-venv/` — inside this repo | One directory; uninstall deletes it. |
| Python deps installed | `vendor/python-venv/Lib/site-packages/` | Isolated. The user's global `site-packages` is untouched. |
| Bootstrap probe | `server/features/transcription/services/whisper/bootstrap.ts` spawns the venv's Python to `import faster_whisper` | If venv is missing or the import fails, `whisperStatus()` reports `ready: false` and the UI surfaces a clear error. |
| Toggle state | `{configDir}/addons.json` | Per-user config dir (`%APPDATA%\tusks-tomes\Config\` on Windows — Roaming; `~/.config/tusks-tomes/` on Linux; `~/Library/Preferences/tusks-tomes/` on macOS). Records whether you have switched the module off, which is distinct from whether it is installed. Written only when you flip the switch. |
| Uninstall | `fs.rm('vendor/python-venv', { recursive: true, force: true })` | Idempotent. Leaves the `addons.json` toggle as it is. |

**State written outside the repo on install:** none. `{configDir}/addons.json` is written only when you switch a module off or on, never by the install itself, and the setup scripts write only under `vendor/python-venv/`. No PATH change, no registry entry, no env var, no symlink, no home-directory dotfile. Two caches live outside the repo from ordinary tool use: pip keeps its usual download cache in your user profile, and the model weights `faster-whisper` fetches on your first transcription go to its Hugging Face cache (`~/.cache/huggingface` by default). Uninstalling does not remove them.

</div>
</details>

<details class="docs-section">
<summary><h2>The Node pattern (the rule for new add-ons)</h2></summary>
<div class="docs-section-body">

**No Node-installing add-on exists in either repo yet.** When the first one is built, it MUST follow this layout — non-negotiable. Reviewers should reject PRs that don't.

### Directory shape

```
vendor/
  python-venv/                        ← existing: Python venv for the Whisper addon
  addons/
    <addon-name>/                     ← new: one directory per Node addon
      package.json                    ← the add-on's *own* deps, not host's
      package-lock.json
      node_modules/                   ← isolated, gitignored
      index.mjs                       ← entrypoint loaded by the host
      README.md                       ← user-facing notes for this addon
```

### Install (in `AddonDefinition.install`)

The add-on's `install(emit)` callback runs `npm install` with `--prefix` pointed at the add-on directory. Use the existing log-emitter so progress streams to the AddonsManager UI.

```ts
// Pseudocode — see server/addons/registry.ts for the AddonDefinition shape.
async install(emit) {
  const addonDir = path.join(REPO_ROOT, 'vendor', 'addons', '<addon-name>')
  await fs.mkdir(addonDir, { recursive: true })
  await writePackageJson(addonDir, /* manifest */)
  return spawnNpm(['install', '--prefix', addonDir, '--no-audit', '--no-fund'], emit)
}
```

**Crucially:**

- `--prefix` ensures `node_modules` is created under `vendor/addons/<addon-name>/`, not the host repo's root `node_modules`.
- `--no-audit --no-fund` keeps the log quiet and avoids network calls beyond the registry.
- The host repo's `package.json` is never edited by the add-on. If a dep already exists in the host (e.g., shared Express middleware), the add-on still vendors its own copy — duplicated bytes are the price of guaranteed isolation.

### Load (in `AddonDefinition.registerRoutes`)

The host server loads the add-on entrypoint via dynamic import from the add-on directory:

```ts
registerRoutes(app) {
  const entry = path.join(REPO_ROOT, 'vendor', 'addons', '<addon-name>', 'index.mjs')
  // Use a file:// URL so the import resolver doesn't try to walk node_modules.
  void import(pathToFileURL(entry).href).then(mod => mod.register(app))
}
```

`node` resolves the add-on's own `require`/`import` calls against its own `node_modules` because Node's algorithm walks up from the file's directory — landing on `vendor/addons/<addon-name>/node_modules` before the host's root. The add-on cannot accidentally see host deps.

### Uninstall

```ts
async uninstall() {
  await fs.rm(path.join(REPO_ROOT, 'vendor', 'addons', '<addon-name>'), {
    recursive: true,
    force: true,
  })
}
```

One `fs.rm` call deletes the entire add-on tree. One `fs.rm` call deletes the entire add-on tree. The host's uninstall route does not edit `{configDir}/addons.json`; it records only the on/off switch, and a toggle you set there stays.

### Gitignore

The repo `.gitignore` already ignores all of `vendor/`, so add-on trees and their `node_modules/` stay out of git.

</div>
</details>

<details class="docs-section">
<summary><h2>External binaries (Ollama, LM Studio, Unsloth, …)</h2></summary>
<div class="docs-section-body">

Add-ons that depend on an *external program* the user installs separately (Ollama, LM Studio, Unsloth via uv, …) follow a thinner contract. ffmpeg is not one of them: it comes with the `ffmpeg-static` package, and `FFMPEG_PATH` points the app at a binary of your choice instead.

- **The add-on does not install the binary.** Period. The user installs Ollama from `ollama.com/download` themselves.
- **The add-on probes for the binary** via HTTP (`localhost:11434/api/tags` for Ollama) or a version check of the program. If the probe fails, the module reports itself as not usable through its own status endpoint, and its panel in Settings shows what to install or start.
- **Nothing is written to mark it enabled.** Modules of this shape are built
  in: they mount unconditionally and answer "am I usable?" by probing. There is
  no marker file, because there is no installation state to record.

> [!TIP]
> **This pattern writes no marker files.** A module that only probes has no
> install state to record. Any `{configDir}/<name>.enabled` files already on
> disk are not read, and are left in place rather than deleted.

The Local LLMs entry in `server/addons/featureRoutes.ts` is the reference for this pattern; its detection lives in `server/features/providers/routes/localLLM.ts`.

</div>
</details>

<details class="docs-section">
<summary><h2>What an add-on must never do</h2></summary>
<div class="docs-section-body">

These are blockers on PR review:

1. Run `npm install <pkg>` against the host repo's root (no `--prefix`).
2. `pip install` outside `vendor/python-venv/`.
3. Modify the user's PATH, environment variables, or shell rc files.
4. Write to `~/.config`, `~/.local/share`, `%APPDATA%`, `%LOCALAPPDATA%`, or any per-user data dir outside the canonical `{configDir}` (which is already managed by `env-paths` in `server/platform/appData.ts`).
5. Add a Windows registry entry.
6. Edit the host's `package.json` or `requirements.txt`.
7. Download a binary into `/usr/local/bin`, `C:\Program Files`, or anywhere on the system PATH.
8. Symlink anything outside the repo working tree.
9. Run any operation that requires sudo / admin elevation. (If your add-on needs admin, redesign it.)
10. Use `child_process.spawn(cmd, args, { shell: true })` with un-quoted args — see `runGraphifyBuild` in [`vaultTools.ts`](../../server/features/lore/services/obsidian/vaultTools.ts) for the pattern: literal arguments only, with any untrusted value passed through `cwd`.

</div>
</details>

<details class="docs-section">
<summary><h2>Verification checklist for a new add-on PR</h2></summary>
<div class="docs-section-body">

Before merging an add-on PR, the reviewer runs through these:

- [ ] Fresh clone on a clean Windows VM that has Node 22 + Python 3.11 + nothing else. App starts and the new module shows up as "not installed."
- [ ] Clicking *Install* in the AddonsManager succeeds. Log stream shows the install running.
- [ ] After install, the only new bytes on disk are inside the repo working tree + at most the module's on/off entry in `{configDir}/addons.json`, which only the on/off switch writes. (Spot-check with `git status` and a recursive diff of `{configDir}`.)
- [ ] System Python's `site-packages` is unchanged. System Node's globals (`npm ls -g`) are unchanged.
- [ ] PATH, env vars, registry entries: unchanged.
- [ ] Clicking *Uninstall* removes the entire `vendor/addons/<name>/` tree (or `vendor/python-venv/` for Python modules). User data created through the module — sessions, transcripts, authored files — is NOT removed.
- [ ] After uninstall, *re-installing* works (idempotent).
- [ ] The module's `isReady()` returns the correct value on every state (not-installed, installed-but-pending-restart, fully-active).
- [ ] If it installs nothing, it is listed in `FEATURE_ROUTES` (`server/addons/featureRoutes.ts`), not `ADDON_REGISTRY`, and has no `install()` / `uninstall()` at all — the type makes a destructive uninstall unexpressible rather than merely discouraged.

</div>
</details>

---

<details class="docs-section">
<summary><h2>Related</h2></summary>
<div class="docs-section-body">

- [add-on system overview](README.md) — the AddonsManager UI + lifecycle
- [audio-transcription add-on](audio-transcription.md) — the reference Python implementation
- [local-llm add-on](local-llms.md) — the reference external-binary implementation
- `server/addons/registry.ts` — `AddonDefinition` type definition
- `server/addons/loader.ts` — host-side install/uninstall machinery
- `scripts/whisper/setup.ps1` / `scripts/whisper/setup.sh` — canonical Python isolation scripts

</div>
</details>
