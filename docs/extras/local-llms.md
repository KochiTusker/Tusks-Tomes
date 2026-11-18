# Local LLMs

Built-in routing to Ollama, LM Studio and Unsloth Studio. Until you connect a
runner the pipeline runs on your cloud or subscription route (Gemini,
OpenRouter, Claude Code or Codex). Connect a runner if you want some phases to
run on a local model instead.

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


Tomes doesn't install a local runner for you. Pick one (or more):

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

Start the runner yourself: the Local LLMs panel detects a running Ollama,
LM Studio, llama.cpp server or Unsloth Studio, but has no button to launch one.


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
3. The Local LLMs panel probes localhost on each backend's default port when
   it opens and lists the models it finds; **Detect again** repeats the check.
   Enter auth credentials in the Unsloth section if your runner needs them,
   and use **Run probe** on a model for its capability check.
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


</div>
</details>

<details class="docs-section">
<summary><h2>Picking a model</h2></summary>
<div class="docs-section-body">


> **Read this before you pick a local model.**
>
> **Testing coverage is limited: no local model above 4B parameters has been
> run on the maintainer's hardware**, for want of VRAM. Everything larger is
> unverified here — the sizes listed below are *guidance based on general
> model behaviour*, not measured results. Treat them accordingly, and please
> report what you find.
>
> **Prose quality is the real constraint.** Local models are not as good at
> long-form narrative as the cloud models, which is why the routing rows offer
> no local model for the chronicle (Phase 3) or Condense (Phase 5):
>
> - **Grounding is weaker at smaller sizes.** Correcting names and lore
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
for exactly this, and the grid under **Hybrid routing** shows which phases may go local. You keep most of the cost saving and all of the
prose quality.

Commonly-used models and what to expect. **These are starting points, not
verified benchmarks** — see the coverage warning above:

| Model | VRAM | Expectation |
|---|---|---|
| `qwen2.5:7b-instruct` | ~8 GB | Reasonable for Phases 1/2/4. |
| `qwen2.5:14b-instruct` | ~10–12 GB | More headroom for grounding; slower. |
| `llama3.1:8b-instruct-q4_K_M` | ~6 GB | Faster; expect more drift on lore terms. |
| `phi4` | ~10 GB | Structured extraction (Phase 4) is its strength; Phase 1 wants a fuller glossary. |

The capability probe in the Local LLM panel runs two fixed tests, structured
JSON and grounding, so you can measure how a model actually performs on *your* hardware
rather than relying on the table above — which is the right way to settle it.


</div>
</details>

<details class="docs-section">
<summary><h2>Hybrid routing</h2></summary>
<div class="docs-section-body">


Open **Settings → Providers & models** and use the per-phase routing rows.
Each phase has a target:

- **Cloud** — uses the cloud provider set in Settings, or the phase's own provider when its row names one.
- **Local** — uses the runner + model you specify per phase.

| Phase | API key | Claude Code or Codex | Local model |
|---|---|---|---|
| 1 Ground | Yes | Yes | Yes, if the probe passes |
| 2 Audit | Yes | Yes | Yes, if the probe passes |
| 3 Chronicle | Yes | Yes | Never |
| 3.5 Polish | Does not run | Does not run | Does not run |
| 4 Extras | Yes | Yes | Yes, if the probe passes |
| 5 Condense | Yes | Yes | Never |

Polish runs only on a chronicle a local model wrote, and Chronicle never runs on a local model, so Polish does not run. Each phase picks its own route, so one run can use all three.

Common patterns:

- *All cloud* — default. Best quality, costs the most.
- *Local on the mechanical phases* — the local model column above. Expect slower
  runs and some accuracy loss on lore grounding.
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


</div>
</details>

<details class="docs-section">
<summary><h2>Troubleshooting</h2></summary>
<div class="docs-section-body">


| Symptom | Likely cause |
|---|---|
| "Offline" beside a runner in the Local LLM panel | The runner isn't running on its default port. Start it, then click **Detect again**. |
| Unsloth probe returns 401 | Stored credentials are stale. Re-enter them in the Unsloth section of the Local LLM panel. |
| Phase 1 result is gibberish on a local model | Glossary or KB content is too large for the model's context. Try a smaller KB or a model with a larger context window. |
| Pipeline halfway through a local phase throws "fetch failed" | The local runner crashed or unloaded the model. Restart it, then resume from the last completed chunk. |


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
