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
> Nothing to unset. Tomes removes any OpenAI API key or base URL left in your
> environment from the Codex call, so it always uses your subscription login
> and billing stays on your plan.

## Model selection

The default model id `default` defers to whatever the CLI currently ships
as its default, so CLI upgrades are inherited without a change here. You can
pin a specific model (`gpt-5-codex`, `gpt-5`, `gpt-5-mini`, `o3`) per phase in
the routing rows.

## Usage limits, pausing, and resuming

ChatGPT subscriptions meter usage in rolling windows.

![A paused run in three steps, top to bottom. 1, the run stops: you halt it, a rate limit hits, or a chunk fails. 2, a checkpoint is saved on your machine. 3, a banner offers Resume or trash, straight away or the next time you open Tomes; Resume carries the run on.](../assets/diagrams/pause-and-resume.svg)

Resume carries on at the saved chunk for Ground, Chronicle and Extras. For Audit and Condense the saved state comes back, but Resume does not run the phase; you run it again from its start. Trash discards a checkpoint you no longer want, and a clean finish deletes it.

When Codex reports the window is spent, the run pauses itself and the paused-runs banner marks it `quota hit`. Resume once your window resets.

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
