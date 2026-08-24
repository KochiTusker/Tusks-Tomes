# Codex

Use your own locally-installed **OpenAI Codex CLI** as the pipeline's LLM —
no API key, no per-token billing. Runs bill against the ChatGPT Plus/Pro
subscription you're already paying for.

This is the Codex twin of **Claude Code**. The two are fully independent: use
either, both, or neither, and turning one on or off never affects the other.

Built in — nothing to install, nothing to restart. The app detects the CLI and
its login state on its own.

## Setup

1. Install the CLI: `npm install -g @openai/codex` (or the Homebrew
   package on macOS).
2. Log in with your ChatGPT account:

   ```bash
   codex login
   ```

3. Open **Settings → Providers & models**. The **Codex** row detects the CLI
   and whether you're signed in.
4. Route individual phases to it in the routing rows, or pick a subscription
   rung in guided routing to put every phase on it at once.

> [!CAUTION]
> Make sure `OPENAI_API_KEY` is **not** set in your environment or `.env`.
> Tomes strips it from the CLI's environment so Codex always uses your
> subscription login — an API key present there would silently switch you to
> per-token billing.

## Model selection

The default model id `default` defers to whatever the CLI currently ships
as its default, so CLI upgrades are inherited without a change here. You can
pin a specific model (`gpt-5-codex`, `gpt-5`, `gpt-5-mini`, `o3`) per phase in
the routing rows.

## Usage limits, pausing, and resuming

ChatGPT subscriptions meter usage in rolling windows.

> [!TIP]
> **Exhausting your window mid-run is not a lost run.** When Codex reports the
> window is spent, the pipeline **pauses itself and saves a checkpoint** — the
> run appears in the paused-runs banner marked `quota hit`. Resume from the
> banner once your window resets and it picks up at the exact chunk it stopped
> on.

> [!WARNING]
> Codex's limit messages include a human-readable reset time (shown in the
> error toast) but no machine-readable timestamp, so the app cannot count down
> to the reset for you.

## Privacy and safety notes

- Prompts are sent to the CLI via stdin, never via shell arguments.
- The CLI runs in a scratch directory with `--sandbox read-only` — it
  cannot write to your project or vault.
- The app never sees or stores your ChatGPT credentials; `codex login`
  state lives wherever the CLI keeps it.

## Known limitations

> [!WARNING]
> Marked **experimental**. The Codex CLI's non-interactive JSON output is
> under-documented, so an unusual CLI version may need this integration
> updated before it works.

- The refusal-repair path (built for Claude Code's occasional content
  refusals) does not yet cover Codex — a refusal surfaces as a plain chunk
  error instead of being automatically repaired.
