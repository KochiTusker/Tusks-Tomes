# Local LLMs

Optional add-on that adds Ollama, LM Studio, and Unsloth Studio routing to
Tusk's Tomes. Out of the box the pipeline runs cloud-only (Gemini / Claude /
OpenAI). Install this add-on if you want some or all phases to run on a
local model instead.

> [!NOTE]
> **View in app:** this doc renders inside Tusk's Tomes too — open the **Help** tab and pick "Local LLMs", or click **Read docs** from the Local LLMs row in Settings.

<details class="docs-section">
<summary><h2>When this is worth it</h2></summary>
<div class="docs-section-body">


- You already run a local LLM and want to avoid cloud spend for routine
  phases (especially Phase 1 grounding on a long transcript).
- You want sensitive transcripts to stay on-device.
- You want to experiment with hybrid routing — cloud for chronicle, local
  for grounding.


</div>
</details>

<details class="docs-section">
<summary><h2>Prerequisites</h2></summary>
<div class="docs-section-body">


This add-on doesn't install a local runner for you. Pick one (or more):

- **Ollama** — `ollama serve` running on `localhost:11434`. Install from
  [ollama.com](https://ollama.com). After install: `ollama pull llama3.1`
  (or any model you prefer).
- **LM Studio** — OpenAI-compatible API on `localhost:1234`. Install
  from [lmstudio.ai](https://lmstudio.ai) and start the server from the UI
  or via `lms server start`.
- **Unsloth Studio** — OpenAI-compatible API on `localhost:8888` with
  OAuth2 password auth. The `unsloth` CLI must be on your `PATH`.
- Any other OpenAI-compatible local runner (vLLM, llama.cpp server,
  koboldcpp). Point Tusk's Tomes at its base URL.

Tusk's Tomes can launch Ollama / LM Studio / Unsloth for you (the Local LLM
panel has a "Launch runner" button) but you still need the binary
installed on `PATH`.


</div>
</details>

<details class="docs-section">
<summary><h2>Setting it up</h2></summary>
<div class="docs-section-body">


> [!NOTE]
> Nothing to install on the Tomes side. Install a runner, start it, and its
> models appear in the routing rows.

1. Install and start a runner — [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai) or Unsloth Studio.
2. Open **Settings → Providers & models** inside Tusk's Tomes.
3. Use **Detect** on the runner's row. Tomes probes localhost on that
   backend's default port and lists the models it finds. Enter auth
   credentials here if your runner needs them, and run a capability probe.
4. Assign individual phases to the model you want in the routing rows — for
   example Phase 1 on Ollama, Phase 3 on a cloud model.


</div>
</details>

<details class="docs-section">
<summary><h2>Turning it off</h2></summary>
<div class="docs-section-body">


Point every phase back at a cloud connection in the routing rows, or just stop
the runner — a runner that isn't running has no models to offer, and the
routing rows say so rather than failing mid-run.

Your `routing.json` stays on disk either way, so going back to a local model
later restores your setup unchanged.

If you previously had a local provider selected and then disable this
add-on, Tusk's Tomes auto-switches the active provider back to Gemini and
shows a toast explaining what happened.


</div>
</details>

<details class="docs-section">
<summary><h2>Picking a model</h2></summary>
<div class="docs-section-body">


> ** Read this before you route Phase 3 locally.**
>
> **Testing coverage is limited: no local model above 4B parameters has been
> run on the maintainer's hardware**, for want of VRAM. Everything larger is
> unverified here — the sizes listed below are *guidance based on general
> model behaviour*, not measured results. Treat them accordingly, and please
> report what you find.
>
> **Prose quality is the real constraint.** Local models are not as good at
> long-form narrative as the cloud models, and it shows most in the phase that
> matters most:
>
> - Below roughly **15–20B parameters**, the chronicle tends to read like a
>   **log or bullet summary rather than a story** — events in sequence, little
>   narrative voice.
> - **Grounding is also weaker at those sizes.** Correcting names and lore
>   against a glossary is a demanding instruction-following task and smaller
>   models drift from it more often.
> - **Mileage varies considerably** between models of nominally similar size —
>   far more than between cloud models.
>
> Note the awkward gap: the sizes that start producing genuinely good prose
> are well above the sizes that have been tested here.

Local models on consumer GPUs (8–16 GB VRAM) don't have the accuracy of
Gemini 2.5 Pro on long-context grounding. Tusk's Tomes already chunks
local-phase work much tighter than cloud-phase work to keep accuracy
acceptable.

**The recommended compromise:** run the mechanical phases (1 grounding,
2 audit, 4 extras) locally and send **Phase 3 — the chronicle — to a cloud
model or a Claude Code / Codex subscription**. Per-phase hybrid routing exists
for exactly this. You keep most of the cost saving and all of the prose
quality.

Commonly-used models and what to expect. **These are starting points, not
verified benchmarks** — see the coverage warning above:

| Model | VRAM | Expectation |
|---|---|---|
| `qwen2.5:7b-instruct` | ~8 GB | Reasonable for Phases 1/2/4. Expect log-like, verbose Phase 3 prose. |
| `qwen2.5:14b-instruct` | ~10–12 GB | Approaching the size where chronicle prose becomes acceptable; slower. |
| `llama3.1:8b-instruct-q4_K_M` | ~6 GB | Faster; expect more drift on lore terms. |
| `phi4` | ~10 GB | Structured extraction (Phase 4) is its strength; Phase 1 wants a fuller glossary. |

The capability probe in the Local LLM panel runs a fixed Phase 1 / Phase 4
fixture, so you can measure how a model actually performs on *your* hardware
rather than relying on the table above — which is the right way to settle it.


</div>
</details>

<details class="docs-section">
<summary><h2>Hybrid routing</h2></summary>
<div class="docs-section-body">


Open **Settings → Providers & models** and use the per-phase routing rows.
Each phase has a target:

- **Cloud** — uses the cloud provider chosen at run start.
- **Local** — uses the runner + model you specify per phase.

Common patterns:

- *All cloud* — default. Best quality, costs the most.
- *All local* — pick a 14B+ instruct model; expect slower runs and some
  accuracy loss on lore grounding.
- *Local Phase 1 + cloud rest* — grounding chunks are short and Phase 1
  is the longest phase. Saves the most cloud cost.
- *Cloud Phase 1 + local Phase 4* — Phase 4 extras (jests, gore, quotes)
  is structured-JSON output and benefits least from a heavy model.


</div>
</details>

<details class="docs-section">
<summary><h2>Removing it</h2></summary>
<div class="docs-section-body">


There is nothing to uninstall — Local LLMs ships with the app. Removing the
runner itself (Ollama, LM Studio, Unsloth) is done through that tool's own
uninstaller; Tomes never installed it and never touches it.

> [!NOTE]
> Older versions wrote a marker file at `{configDir}/local-llm.enabled`. It is
> no longer read. It is deliberately not deleted either — this change altered
> what you have to understand, not the contents of your disk.


</div>
</details>

<details class="docs-section">
<summary><h2>Troubleshooting</h2></summary>
<div class="docs-section-body">


| Symptom | Likely cause |
|---|---|
| "Runner offline" in the Local LLM panel | The runner isn't running on its default port. Click **Launch runner** or start it manually. |
| Unsloth probe returns 401 | Stored credentials are stale. Re-enter them in the Unsloth section of the Local LLM panel. |
| Phase 1 result is gibberish on a local model | Glossary or KB content is too large for the model's context. Try a smaller KB or a model with a larger context window. |
| Pipeline halfway through Phase 3 throws "fetch failed" | The local runner crashed or unloaded the model. Restart it, then resume from the last completed chunk. |


</div>
</details>

<details class="docs-section">
<summary><h2>See also</h2></summary>
<div class="docs-section-body">


- [Audio Transcription add-on](audio-transcription.md) — same install pattern, different feature.
- [Providers](../models/choosing-a-provider.md) — overall provider model.
- [Configuration](../settings/configuration.md) — `TUSKS_HOST`, env vars, paths.


</div>
</details>
