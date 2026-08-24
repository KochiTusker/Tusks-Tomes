# Known issues

Tusk's Tomes is open-source software in active development. This page tracks two things separately:

1. ** Fixed in v1.1.0** — bugs that the v1.1.0 bug-hunt surfaced and resolved, kept here so you can see what changed and why. (Fixes landed in later releases are in the [roadmap's "Recently shipped"](../about/roadmap.md) and the commit log rather than repeated here.)
2. ** Still open / by-design limitations** — issues we either can't fix yet, won't fix (by design), or have planned for a future release.

If you hit something that isn't listed here, please [open an issue](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose) or send a note via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header).

## Severity legend

- **MEDIUM** — degrades a secondary flow or shows up under unusual conditions; ship-conditional with a workaround.
- **LOW** — cosmetic, classification, or polish; documented for transparency.

There are no HIGH-severity known issues at ship time. HIGH would mean a core flow (key entry, Begin pipeline, Resume, Export) is broken — none are.

---

# Platform and testing coverage

Not bugs — just an honest statement of what has actually been exercised, so
you know where you're likely to be the first person down a path.

| Area | Status |
|---|---|
| **Windows** | The tested platform. Day-to-day development and all release verification happen here. |
| **Linux / macOS** | **Not tested.** The current build is expected to work — the codebase is cross-platform and CI runs the suite on Ubuntu — but no one has run the full app end-to-end on either. Assume rough edges and please [report them](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose). |
| **Cloud providers (Gemini / Claude / OpenAI)** | Well exercised. This is the main path. |
| **Claude Code add-on** | Exercised. |
| **Codex add-on** | **Partially tested.** The provider, routing and usage-limit handling are covered by tests, but it has had far less real-session mileage than the cloud path. |
| **Local LLMs add-on** | **Partially tested — nothing above 4B parameters has been run**, for want of VRAM on the test machine. Everything larger is unverified for quality, timing and memory behaviour. Note the awkward gap this leaves: the sizes that produce genuinely good prose start well above the sizes that have been tested. See the prose-quality note below. |
| **Audio Transcription (Whisper)** | Exercised on NVIDIA GPU. CPU-only transcription works but is very slow — see [workflows.md](../importing/README.md). |

### Local LLM prose quality — set expectations before you route Phase 3

Local models are not generally as good at long-form narrative prose as the
cloud models, and the gap is most obvious in exactly the phase you care about
most. Concretely:

- **Below roughly 15–20B parameters**, the chronicle tends to read like a
  **log or a bullet summary rather than a story** — events in sequence, little
  narrative voice.
- **Grounding is also less reliable at those sizes.** Name and lore correction
  is a genuinely hard instruction-following task, and smaller models drift
  from the glossary more often.
- **Mileage varies a lot** between models of nominally similar size, far more
  than it does between cloud models.

A reasonable compromise if you want to keep spend down: route the mechanical
phases (grounding, audit, extras) locally and send **Phase 3 — the chronicle —
to a cloud model or a Claude Code / Codex subscription**. That is what per-phase
[hybrid routing](../about/roadmap.md) exists for, and it keeps the prose quality where
it matters while cutting most of the token cost.

---

# Fixed in v1.1.0

Bugs the v1.1.0 bug-hunt closed. Listed for transparency so you can see what changed.

## Phase 6 condense ratio overshoot — now controllable via the Condense Slider

**Was:** Phase 6's static formula (`min(2000 words, 25% of chronicle)`) overshot on short chronicles (a 600-word chronicle returned a 270-word condense, ~45% of source instead of the documented 25%). On real 3-hour sessions the 2,000-word cap bound, so the issue only surfaced on test-fixture sizes.

**Fixed:** v1.1.0 replaces the static formula with the **Condense Slider** — an animated-wand UI in the Output Picker that lets you pick the target length as a percentage of the chronicle's word count (0-100% in 5% steps, default 20%). The slider preview shows the projected word count live; Phase 6 recomputes the actual target at runtime against the real chronicle and instructs the model to aim within ±10%.

## Phase 6 bullet-point duplication on long sessions

**Was:** When a notable event sat at a chunk boundary (last few lines of chunk N, first few of chunk N+1), both chunks' condensed bullet sets often mentioned it with slightly different phrasing. A long session could land 60-90 bullets where ~15 was intended.

**Fixed:** `runPhase6()` now applies a two-pass dedup after chunk accumulation — exact-after-normalisation first, then Levenshtein-distance against already-kept bullets at the 0.8 similarity threshold. First-occurrence wins so chronological order is preserved.

## Phase 6 overshoot — no warning when the model exceeded the slider target

**Was:** The Condense Slider asks the model to aim within ±10% of a user-picked target word count, but the runtime check only warned when output was catastrophically *short* (`warnIfCondenseShort`, ≤200 words). If the user picked 10% (target 600 words on a 6,000-word chronicle) and the model returned 1,800 words, no warning fired — the user might not realise the recap was three times its intended length.

**Fixed:** new `warnIfCondenseOvershoot` symmetric warning at `RefinementTool.tsx`. Fires above 1.5× the user-picked target with a toast showing the actual word count, the target, and the percentage overshoot. Called at all 4 Phase 6 completion sites (happy path + 2 resume paths + the standalone Regenerate Phase 6 button).

## Shell scripts shipped with CRLF line endings — broke macOS / Linux first run

**Was:** Every tracked `.sh` script (`setup.sh`, `start.sh`, `scripts/whisper/setup.sh`, `scripts/update/apply.sh`) was 100% CRLF because it was authored on Windows with `core.autocrlf=true`. A Linux / macOS user who cloned from public and ran `bash setup.sh` would hit `\r: command not found` on the first line. **The "clone + run setup" experience was broken on every non-Windows platform.**

**Fixed:** added `.gitattributes` at the repo root that forces `text eol=lf` on `*.sh`, `*.bash`, and `*.py` regardless of the cloning user's git config. Existing CRLF bytes were normalised to LF in-place. Future contributors on any OS will land LF when these file types are touched.

## `npm run whisper:setup` was Windows-only

**Was:** The `whisper:setup` npm script hardcoded `powershell -ExecutionPolicy Bypass -File scripts/whisper/setup.ps1`. A macOS / Linux user typing the documented `npm run whisper:setup` command would see `powershell: command not found`. They had to know to use the (also documented) `whisper:setup:posix` variant instead. The in-app "Install Audio Transcription" button was always platform-aware via `runSetup` in `server/whisper/bootstrap.ts` — only the CLI path was broken.

**Fixed:** new `scripts/whisper/run-setup.mjs` Node dispatcher selects `setup.ps1` on Windows and `setup.sh` on POSIX, streams the child's stdout/stderr inline. `npm run whisper:setup` now works on every OS. The legacy `npm run whisper:setup:posix` and a new explicit `whisper:setup:windows` remain available if users want platform-pinned scripts.

## Walkthrough doc claimed Phase 6 was "user-triggered" — actually now auto-runs

**Was:** `docs/walkthrough.md` described Phase 6 Condense as *"Optional, user-triggered. One click after Phase 4 finishes."* That described the v1.0 behaviour. v1.1.0's OutputPicker runs Phase 6 automatically when the "Condensed" checkbox is checked at run-start. The walkthrough is the canonical first-time-user entry point linked from the README, so this drift was a real first-impression mismatch.

**Fixed:** walkthrough.md table now describes Phase 6 as *"Length controlled by the Condense Slider on the Output Picker (default 20%). Runs automatically when Condensed is checked at run start."* The audio-addon install estimate was also corrected from "~2-minute" to a more honest "5-15 minutes" since the Whisper venv + `torch` wheels are ~1.5 GB.

## Doc anchor in `SETUP.md` pointed at the old "Free tier available" heading

**Was:** `SETUP.md:34` linked to `docs/providers.md#google-gemini--free-tier-available-` — but the v1.1.0 doc rewrite renamed that heading to "Google Gemini — paid key required ". The anchor silently 404'd. A first-time user clicking the "How to get a Gemini key" link from the setup page jumped to nowhere.

**Fixed:** anchor corrected to `#google-gemini--paid-key-required-`. The link's surrounding copy ("Google Gemini — has a free tier; the path with the lowest barrier") was also rewritten to match the v1.1.0 positioning.

## Stale Phase 6 `min(2000, 25%)` formula in recommended-settings + faq

**Was:** Two docs still described Phase 6 with the legacy static formula — `docs/recommended-settings.md:71` table row, and `docs/faq.md:30` end-to-end walkthrough. Users reading either would expect a static formula that no longer exists in the UI.

**Fixed:** both lines now describe the **Condense Slider** (0-100%, default 20%, set per run on the Output Picker) and the ±10% target contract.

## `/api/runs/:id` returns 200 on structurally-malformed checkpoint files

**Was:** The list endpoint correctly excluded malformed checkpoint files from the Resume banner, but the detail endpoint only validated the file as parseable JSON — not that it matched the checkpoint schema. Clicking Resume on a corrupted card could result in a blank screen or a JavaScript error.

**Fixed:** Both endpoints now run the same `summariseOrReject` validator; the detail endpoint returns 404 for structurally-malformed files. Phase K.7 test in `server/api/runs.test.ts` locks the contract.

## Active-provider banner flash on first paint

**Was:** For roughly half a second after the Chronicle tab loaded, the banner showed the red "No cloud API key configured" warning even when keys were configured. It snapped to "Running with [provider]" once the providers fetch resolved.

**Fixed:** `ActiveProviderBanner` now tracks a `hasLoaded` state and renders nothing on the first paint, so users with configured keys never see the false-positive error banner. Catch path also flips the state so a `/api/providers` fetch failure surfaces the destructive banner intentionally.

## `npm run smoke-test` mis-classified `ready` and `skipped` as failures

**Was:** Running `npm run smoke-test` on a healthy install reported `Whisper: ready` and `Claude: skipped (no key)` under a "**Failed**" heading and exited with code 1.

**Fixed:** The categoriser in `scripts/smoke-test.mjs` now buckets `ready`, `skipped`, `not configured`, `not installed`, `no local backends running`, and `installed, restart required` as "Not configured" instead of falling through to "Failed". Exit code is 0 unless something actually failed.

## localStorage quota loss mid-run

**Was:** Long session + large Knowledge Base + tab close mid-run → the next `safeSet` from a `chunk_done` event silently failed and the user could lose everything from the last successful checkpoint.

**Fixed:** v1.1.0 adds a pre-flight `STORAGE_QUOTA_WARNING_EVENT` that fires BEFORE `setItem` when projected total localStorage usage would cross the 90% threshold (~4.5 MB of a typical 5 MB browser quota). The warning detail includes the full serialized payload so the UI can pre-emptively persist to a server-side disk checkpoint. The existing failure event also now includes the serialized payload as a recovery target.

## Addon-config corruption silently enabled every add-on

**Was:** A malformed `addons.json` (power loss during settings save, hand-edit gone wrong) triggered the catch handler at `loadAddons`, which returned an empty config object. Because the loader defaults unseen names to enabled, EVERY add-on was treated as enabled — including ones with missing or stale prerequisites, producing cryptic pipeline crashes at run time.

**Fixed:** `readAddonsConfig` now schema-validates the parsed shape via the new `validateAddonsConfig` exported function. Malformed JSON or schema mismatch flips a corruption signal exposed via `getAddonsConfigCorruption()`; `loadAddons` respects the signal and skips ALL add-ons (conservative-disabled) rather than the previous all-enabled fallback. The UI can read the corruption status to render a clear startup warning.

## Provider switch mid-run used stale singleton

**Was:** If a user opened Settings and changed a provider key while a pipeline run was in flight, the cached singletons stayed in place and subsequent chunks dispatched to the stale provider. The user could see unexpected charges on the wrong account.

**Fixed:** `refreshProviders()` now dispatches a `PROVIDERS_CHANGED_EVENT` window-level CustomEvent with a `changedKeys` detail listing which slots flipped between configured states. `RefinementTool` listens and, if a run is in progress, surfaces a 12-second toast telling the user the next chunk will dispatch to the new key and to halt if the change was unintentional.

## Vault export path-traversal defence-in-depth

**Was:** Vault export composes `<vaultRoot>/Lore/Tomes/<sanitizedCampaign>/<sanitizedFileName>.md`. `sanitizeSegment` already strips path separators + control chars + Windows reserved names, but there was no second-layer check confirming the resolved path stayed under the safe root — a hypothetical future sanitiser regression would have landed bytes outside the Tomes tree.

**Fixed:** `exportChronicleToVault` now resolves both the target path and the `<loreDir>/Tomes` root via `path.resolve` and throws if the target isn't a descendant. A 19-case malicious-input table in `server/api/vault.test.ts` locks the sanitiser contract against the standard traversal vectors.

## Free-tier Gemini Pro is slow — repositioned, no longer a recommended workflow

**Was:** A 3-hour session on Free Gemini Pro could take 30-60 minutes vs ~6-10 minutes on Paid Pro, because Free's per-minute quota is 2 RPM.

**Fixed (by repositioning):** Since Google moved Pro models behind billing, a fully free workflow is no longer viable for the main pipeline. v1.1.0 documents this honestly: Paid is required, Free remains as an optional secondary key used only by the Smart Budget preset for Phase 4 (extras) where the Free Flash quota is comfortable. The Free-tier-slow problem is now unreachable in normal use.

## Windows configDir documentation drift

**Was:** Multiple docs (`configuration.md`, `dependencies.md`, `node-isolation.md`, `SETUP.md`) said the encrypted keystore + glossary + speakers + routing all lived under `%LOCALAPPDATA%\tusks-tomes\Config\`. Code actually uses `env-paths`, which puts config under `%APPDATA%` (Roaming) on Windows. Users following the docs to back up keys before reinstalling Windows would find an empty folder and conclude their keys vanished.

**Fixed:** All five doc files now correctly identify Windows config as `%APPDATA%\tusks-tomes\Config\` (Roaming), with explicit notes that data + cache stay under `%LOCALAPPDATA%`.

---

# Still open / by-design

Bugs we know about and either haven't fixed yet, have a deliberate trade-off, or are upstream-blocked.

## Glossary / Speakers / Personas editors silently hide on fetch failure

**Affects:** Tome of Lore tab when the `/api/lore/*` endpoint fails on first load.

**What you'll see:** The editor card flashes "Loading…" briefly, then disappears. No error toast, no retry button.

**Workaround:** Reload the page. If the failure persists, the diagnostics surface (Help → Diagnose) will tell you whether the server endpoint or the client request is the culprit.

**Status:** Slated for the next release — error state + retry button.

---

## qs/express moderate vulnerability in transitive dependencies

**Affects:** Anyone exposing Tusk's Tomes to the network (`TUSKS_HOST=0.0.0.0`).

**What you'll see:** Running `npm audit` reports 2 moderate-severity advisories: `qs` is exposed to a `qs.stringify` DoS when handling untrusted comma-format arrays with `encodeValuesOnly` set.

**Why:** Indirect dependency via `express`. The fix requires Express to bump its qs dependency, which is pending upstream.

**Workaround:** The default deployment binds to `127.0.0.1` (loopback only), so the vulnerable surface is unreachable from the network. The `qs.stringify` path is not in our own code's request handling. The vuln is genuinely safe to defer for local-only use.

**Status:** Will be patched as soon as Express ships the fix.

---

## Add-on install requires server restart

**Affects:** First-time install of the Audio Transcription, Local LLMs, or Personas add-ons via Settings → Add-ons.

**What you'll see:** Installing an add-on shows "Installed". But the Upload/Sessions tabs (Audio) or Hybrid Routing card (Local LLMs) don't appear until you restart `npm run dev`.

**Workaround:** Stop and restart the dev server after installing an add-on. The state persists; no re-install needed.

**Status:** Architectural; loading add-ons at startup keeps the codebase simple. Hot-reload of add-ons is a future-release item.

---

## Run resume fingerprint doesn't tolerate trailing-whitespace edits to the glossary

**Affects:** Pause/Resume flow specifically when you edit the glossary between pause and resume.

**What you'll see:** Resume Banner switches to "Start over" instead of "Resume" if you edit the glossary mid-pause — even if your edit was just adding a trailing space.

**Why:** The fingerprint is a hash of the canonical glossary JSON; whitespace counts. This is a load-bearing safety check (we don't want to resume Phase 3 with a chunk plan based on a stale glossary), so we err on the side of "restart" when in doubt.

**Workaround:** If you genuinely want to resume after a glossary tweak, the unsaved transcript is still in localStorage — click Start over and it'll re-chunk and resume from chunk 0.

**Status:** Working as designed. Trading a small UX wart for a serious correctness guarantee.

---

## `.diagnose/latest.md` may include API-key fingerprints

**Affects:** Anyone sharing a diagnose bundle for support.

**What you'll see:** When you send `.diagnose/latest.md` to Claude (or anyone else) for one-round-trip debugging, it includes the 6-character SHA-256 fingerprint of any configured provider keys.

**Why:** The fingerprint is one-way (you cannot recover the key from it), and it's the only way to confirm whether the key the diagnose run saw matches the key you have today — load-bearing for diagnosing routing issues.

**Workaround:** None needed. Fingerprints are safe to share publicly. The full key never leaves your machine.

**Status:** Documented; not a leak.

---

## Extras list may mention "the Dungeon Master" in summary form

**Affects:** Phase 4 Extras output (quotes / jests / gore).

**What you'll see:** Even though Phase 3 Chronicle treats DM out-of-character speech as scene-setting (not as quoted dialogue), the Extras phase is more literal — it might surface a "Quote" attributed to the Dungeon Master.

**Workaround:** Edit the .docx / .md before publishing if the quote feels off-tone.

**Status:** Phase 3 voice contract has been tuned across three iterations; Phase 4 is next in line. Expected to land in the next release.

---

## Addon install SSE response not drained on disconnect

**Affects:** Server logs only — no user-visible impact.

**What you'll see:** If you cancel an in-flight add-on install (e.g. close the Add-ons panel mid-install), the server may log "write after close" errors as it tries to write SSE events to the closed socket.

**Workaround:** Cosmetic — ignore the log noise.

**Status:** Deferred to v1.2.0. Wrap the `res.write` calls in try/catch or listen to `res.on('close')` and break early.

---

## `@anthropic-ai/sdk` shipped into the browser bundle

**Affects:** Theoretical regression risk only — not active in v1.1.0.

**What you'll see:** Nothing today. `ClaudeProvider` is currently only instantiated server-side; the SDK's `node:fs` imports are externalised at build time. If a future change ever instantiates `ClaudeProvider` client-side, the browser will crash with "fs is not defined."

**Workaround:** Don't construct `ClaudeProvider` in a code path that runs in the browser.

**Status:** Documented for future contributors. Deferred to v1.2.0 — proper fix is to lazy-load the SDK only on the server path or guard the constructor with a `typeof window` check.

---

## Phase-1 speaker-detach toggle change during pause+resume produces stale brackets

**Affects:** Dev-settings path only. The toggle isn't surfaced in the production UI for general users.

**What you'll see:** If you pause a Phase 1 run with speaker-detach ON, change the dev setting to OFF, then resume, the cached `inputSnapshot` still has `detachAttached: true` but the resumed pipeline won't reattach speaker brackets. The grounded transcript ends up missing its bracket prefixes.

**Workaround:** Don't toggle the dev setting between pause and resume. The toggle is a developer affordance, not a production knob.

**Status:** Deferred to v1.2.0. Proper fix is to store the detach setting in the checkpoint rather than reading it from live settings at resume time.

---

## What's NOT a bug

For transparency, a few common questions that aren't bugs:

- **Phase 5 is always skipped on cloud providers.** This is by design — cloud outputs don't need a local-polish pass. If you see "Phase 5 skipped" in the run log, that's intentional.
- **A 3-hour session costs more than your friend's NotebookLM workflow.** True. We're an open-source app paying per-token at retail rates; NotebookLM is Google subsidising a free tier. We trade higher cost for local-first privacy and per-campaign grounding. See [comparison.md](../about/comparison.md).
- **The chronicle is verbose.** Also by design — see [feedback-chronicle-voice in the FAQ](faq.md#what-running-one-session-actually-looks-like). The Phase 6 condense is the version to share; the chronicle is the canonical record.
- **The app starts on `127.0.0.1`, not `localhost`.** Default for security. Set `TUSKS_HOST=0.0.0.0` in `.env` to expose to LAN; do so only on a trusted network.

If something not in this list is causing pain, please tell us through the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) or [open an issue](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose) — that's how this list gets shorter.
