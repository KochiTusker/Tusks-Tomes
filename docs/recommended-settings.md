# ⚙️ Recommended settings

This doc tells you which settings to keep on their defaults, which ones to tweak for cost or speed, and which ones to never touch unless you have a specific reason. Tusk's Tomes ships sensible defaults — most users only need step 1 of the TL;DR.

## TL;DR

Paste a **Paid Google Gemini API key** in **Settings → API Keys** and you're done. The defaults are tuned for that combination and produce a flagship-quality chronicle on a 3-4 hour session in roughly 6-10 minutes for ~£0.50-£2 of API spend.

> **Why paid?** Tomes ships as free, open-source software — there's no payment to the project. The only money involved is your chosen LLM provider's API fees. Google's free Gemini tier no longer includes Pro-class models, and free Flash on its own is too rate-limited to carry a 3-hour session's main pipeline within a sensible runtime. If you already hold a free-tier Gemini key, you can configure it as an optional secondary that handles Phase 4 extras under the Smart Budget preset; every other phase always uses your paid key. See [providers.md](providers.md).
>
> **💡 Better home for a free key:** [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault) is an upcoming AI-chatbot companion that queries your campaign lore — far lower per-query token use than Tomes' multi-phase pipeline, so a free quota fits comfortably. Vault is due to release soon; consider saving your free Gemini key for it.

## The best-quality stack (what experience actually recommends)

If you want the short answer to "what should I pick for the best result", this
is the combination that has produced the strongest output in practice. Every
part is optional and swappable.

1. **Record with [Craig](https://craig.chat) — the free tier is sufficient.**
   One audio track per participant. No paid Craig plan is needed for this
   workflow.
2. **Transcribe with Whisper locally** (Audio Transcription add-on). Strongly
   advised *alongside* Craig specifically: per-speaker tracks give Whisper
   audio that is trivially attributable, so every line in the finished
   chronicle is tied to the right person. This is the single biggest quality
   difference against any single-stream transcript. It does need an
   **NVIDIA** GPU specifically: AMD and Intel cards go completely unused, so
   they get the same speed as no graphics card at all. See
   [workflows.md](workflows.md) for the hardware reality and the alternative
   that needs no GPU.
3. **Keep lore in an Obsidian vault** ([Obsidian Vault add-on](add-ons/obsidian-vault.md)),
   in preference to the plain Tusks-Lore folder layout. It grounds names and
   lore more reliably. In head-to-head testing the two were *comparable* — the
   folder route is far from useless — but Obsidian is the better of the pair.
   Don't be shy with volume: **up to ~100,000 words of lore across several
   documents made no noticeable difference to cost**, and the grounding it buys
   is worth far more than the tokens.
4. **Route Gemini + Claude Code.** The best cost-to-quality balance found so
   far. Part of the reason is bluntly practical: **Gemini's API allows the
   content filters to be switched off** (Tomes maps the per-category
   guardrail toggles to `BLOCK_NONE` — see [configuration.md](configuration.md)),
   so the mature material a real session contains — violence, swearing,
   explicit dialogue — is processed and written up as it happened. Claude and
   ChatGPT models sanitise that content by default, and prompt framing only
   partly mitigates it. Pairing Gemini with a Claude Code subscription keeps
   API spend down at the same time.

> **Expected output size.** A three-hour session lands at roughly
> **16,000–18,000 words** of chronicle. The optional condense phase cuts that
> down as far as you like — you set the target.

## Three preset profiles

Pick whichever matches your priorities. All three live in **Settings → Hybrid Routing** and can be configured manually; the Hybrid Routing card has a one-click **Budget mode** button for the most common cost-conscious combo.

### 🐢 Budget — ~£0.70 per 3hr session

For paid-Gemini users willing to trade some prose quality for ~4× cost reduction vs the Balanced default. Every phase uses Paid Flash.

| Phase | Setting | Why |
|---|---|---|
| 1 — Ground | `gemini-2.5-flash` | Mechanical phase; fast model is fine |
| 2 — Audit | `gemini-2.5-flash` | JSON output; speed > prose |
| 3 — Chronicle | `gemini-2.5-flash` | The trade-off — prose noticeably less polished than Pro, but readable |
| 4 — Extras | `gemini-2.5-flash` | JSON output; speed > prose |
| 5 — Polish | (cloud: skipped) | — |
| 6 — Condense | `gemini-2.5-flash` | Mechanical compression; Flash handles it cleanly |

Click **Settings → Hybrid Routing → Budget mode** to apply this in one click.

### ⚖️ Balanced (default) — ~£0.50-£2 per 3hr session

The default. Pro on the prose-heavy phases, Flash on the JSON-output phases. This is what a fresh install ships with.

| Phase | Setting | Why |
|---|---|---|
| 1 — Ground | `gemini-2.5-pro` | Grounding quality directly affects every later phase |
| 2 — Audit | `gemini-2.5-flash` | JSON output; faster + cheaper |
| 3 — Chronicle | `gemini-2.5-pro` | Long-form prose; flagship model matters |
| 4 — Extras | `gemini-2.5-flash` | JSON output; fast |
| 5 — Polish | (cloud: skipped) | — |
| 6 — Condense | `gemini-2.5-pro` | Short but high-stakes output; flagship matters |

### 💎 Quality — ~£2-£5 per 3hr session

Flagship model everywhere. Slowest, most expensive, best prose. Recommended if you're producing a public actual-play recap or chronicling a campaign you intend to publish.

| Phase | Setting | Why |
|---|---|---|
| 1 — Ground | `gemini-2.5-pro` | — |
| 2 — Audit | `gemini-2.5-pro` | — |
| 3 — Chronicle | `gemini-2.5-pro` *or* `claude-sonnet-4-6` | Claude Sonnet has noticeably different prose voice — try both |
| 4 — Extras | `gemini-2.5-pro` | — |
| 5 — Polish | (cloud: skipped) | — |
| 6 — Condense | `gemini-2.5-pro` | — |

If you go Claude on Phase 3, you'll need an Anthropic key in Settings → API Keys. Per-phase routing lets you mix providers — Gemini Pro on grounding (cheap, fast, very good) plus Claude Sonnet on chronicle (best prose voice) is a popular combination.

## Per-setting reference

Every setting the UI exposes (or that ships with a sensible default), with the recommended action.

| Setting | Default | Keep or change? |
|---|---|---|
| **Active provider** | `Gemini` | Keep, unless you've configured Claude or OpenAI keys. The Banner in the Chronicle tab tells you which one a run will use. |
| **Phase 1-4, 6 model** | `gemini-2.5-pro` (Phase 1/3/6), `gemini-2.5-flash` (Phase 2/4) | Keep. Swap individual phases via Hybrid Routing only if you're chasing one of the three profiles above. |
| **Phase 5 (Polish)** | Skipped on cloud providers | Keep. Polish is a local-LLM-only phase by design — cloud outputs don't need it. |
| **Max output tokens** | `32,768` | Keep. Safe ceiling for all current models. Override via `.env` (`VITE_MAX_OUTPUT_TOKENS=…`) only if your model genuinely supports more. |
| **Max retries** | `4` | Keep. Tuned to ride out a single bad chunk + a brief network blip. |
| **Phase 6 condense target** | **Condense Slider** (0-100%, default 20% — set per run on the Output Picker) | v1.1.0+ replaced the static `min(2000, 25%)` formula with a user-controlled wand-themed slider. The slider shows the projected word count live as you drag; Phase 6 recomputes against the actual chronicle word count at runtime and instructs the model to aim within ±10%. 20% on a typical 14,000-word session lands around 2,800 words. |
| **Phase 6 condense floor** | `200 words` (catastrophic-only warning) | Keep. Anything below 200 indicates a truncation / quota event, not under-condensation. |
| **Cloud chunk sizes** | Per-provider table in `src/lib/chunking.ts` | Don't touch. Tuned empirically for each provider's TPM ceiling. |
| **Rate-limit pacing** | Self-tuning from provider headers (Claude/OpenAI), static table (Gemini) | Don't touch. The "Slow down" dialog gives you a runtime multiplier if you're hitting 429s — that's the right place to adjust. |
| **Audio Transcription add-on** | Off by default | Install only if you record sessions with audio. Adds ~600MB of Python deps. See [add-ons/audio-transcription.md](add-ons/audio-transcription.md). |
| **Local LLMs add-on** | Off by default | Install only if you run Ollama / LM Studio / Unsloth and want to route phases through them. See [add-ons/local-llm.md](add-ons/local-llm.md). |
| **Personas add-on** | Off by default | Install for narrator-voice presets (Gandalf, Arnold, etc.). Cosmetic; doesn't affect grounding. |
| **Whisper compute type** | `int8_float16` on CUDA, `float32` on CPU | Keep. Auto-detected at install time. |
| **Knowledge Base soft limit** | `2 MB` of extracted text | Keep as warning threshold. The pipeline still runs above it, just costs more per chunk. |
| **Halt → Resume checkpoint** | Auto-written on Halt + every phase boundary | Keep on. The 20MB cap protects your disk from a runaway transcript. |

## What NOT to touch

These settings exist as constants in the codebase because they're tuned, not configurable through the UI. Touching them without a specific reason makes things worse:

- **Chunk sizes** (`src/lib/chunking.ts`). Sized to keep each chunk under the provider's TPM ceiling while leaving headroom for the system prompt and response. Smaller chunks = more round-trips = more cost + more 429s. Larger chunks = the model truncates output mid-paragraph.
- **Rate-limit logic** (`src/lib/rateLimit.ts`). Self-tunes from Claude/OpenAI response headers. Gemini uses a static tier table; the tier is derived from which env-var seeded the key (`PAID_GEMINI_API_KEY` vs `VITE_GEMINI_API_KEY`). Changing these without re-reading the providers' published rate-limit docs will cause 429 storms.
- **`MAX_RETRIES = 4`**. More retries = longer hangs on permanent failures (bad model ID, billing not enabled). Fewer retries = transient 5xx errors abort the run.
- **Phase 1 grounding prompt** (`src/lib/prompts.ts`). The voice contract baked into Phase 3 (DM-as-narration, exhaustive chronicle, condense formula) was iterated on real-session output — see the in-repo iteration history. Edits here can quietly degrade chronicle quality across the board.
- **`server_boot_id`** localStorage key. Auto-managed; the UI uses it to detect server restarts and refresh stale provider state.

## When to override the defaults via `.env`

The only common reason: your Gemini API key reports newer model IDs (`gemini-3-pro-...`) that aren't in the default constants. Override via `.env`:

```sh
VITE_MODEL_PRO=gemini-3-pro-latest
VITE_MODEL_FLASH=gemini-3-flash-latest
```

The in-app "Check available models" button (Settings → Model Profiles) lists what your key actually supports. If a phase-1 grounding call fails with HTTP 404 on a model ID, that's the fix.

For everything else, the UI's Hybrid Routing card is the right surface — `.env` overrides apply across all phases and are harder to back out.
