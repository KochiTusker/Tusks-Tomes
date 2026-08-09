# Codex (your ChatGPT subscription)

Use your own locally-installed **OpenAI Codex CLI** as the pipeline's LLM —
no API key, no per-token billing. Runs bill against the ChatGPT Plus/Pro
subscription you're already paying for.

This add-on is the Codex twin of the **Claude Code** add-on. The two are
fully independent: you can install either, both, or neither, and enabling
or removing one never affects the other.

## Setup

1. Install the CLI: `npm install -g @openai/codex` (or the Homebrew
   package on macOS).
2. Log in with your ChatGPT account:

   ```bash
   codex login
   ```

3. Install this add-on from **Settings → Add-ons**, then restart the app
   (`npm run dev`).
4. Pick **Codex (your ChatGPT subscription)** as the provider in Settings,
   or route individual phases to it via Hybrid Routing.

> **Important:** make sure `OPENAI_API_KEY` is **not** set in your
> environment or `.env`. The add-on strips it from the CLI's environment so
> Codex always uses your subscription login — an API key would silently
> switch you to per-token billing.

## Model selection

The default model id `default` defers to whatever the CLI currently ships
as its default — CLI upgrades are inherited automatically. You can pin a
specific model (`gpt-5-codex`, `gpt-5`, `gpt-5-mini`, `o3`) per phase in
Hybrid Routing.

## Usage limits, pausing, and resuming

ChatGPT subscriptions meter usage in rolling windows. When Codex reports
that your window is exhausted mid-run, the pipeline **pauses automatically
and saves a checkpoint** — the run appears in the paused-runs banner marked
`quota hit`. Nothing is lost: resume from the banner once your window
resets, and the run picks up at the exact chunk it stopped on.

Codex's limit messages include a human-readable reset time (shown in the
error toast) but no machine-readable timestamp, so the app cannot count
down to the reset for you.

## Privacy and safety notes

- Prompts are sent to the CLI via stdin, never via shell arguments.
- The CLI runs in a scratch directory with `--sandbox read-only` — it
  cannot write to your project or vault.
- The app never sees or stores your ChatGPT credentials; `codex login`
  state lives wherever the CLI keeps it.

## Known limitations

- Marked **work in progress**: the Codex CLI's non-interactive JSON output
  is under-documented, so unusual CLI versions may need the add-on updated.
- The refusal-repair path (built for Claude Code's occasional content
  refusals) does not yet cover Codex — a refusal surfaces as a plain chunk
  error instead of being automatically repaired.
