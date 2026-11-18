# Claude Code

If you already pay for [Claude Code](https://docs.claude.com/en/docs/claude-code)
(Pro or Max), this lets the chronicle pipeline use that allowance instead of an
API key. No per-token billing, because there's no API key involved at all.

The realisation behind it was slightly annoying: I was paying a monthly
subscription for Claude *and* paying per token through the API to write up my
sessions. Two bills for the same company. This closes that gap — it shells out
to the `claude` command already on your machine, running against the session
you logged into.

It never touches your login, and it strips any API key out of the call before
running, specifically so the work can't quietly land on a metered bill by
accident. Each call also runs with Claude Code's tools, your MCP servers and
your personal settings switched off, so a phase is a plain text request: the
transcript can only shape the words that come back.

## Usage limits — chronicling burns through your plan fast

Claude subscriptions (Pro / Max) meter headless usage in rolling **~5-hour windows**, not per token. The chronicle pipeline is token-heavy — it runs your whole transcript through several phases — so a single session can consume a large slice of that window.

> [!CAUTION]
> **In testing, chronicling one full session used up to ~60% of the usage allowance in a 5-hour window.** Budget for roughly **one to two full sessions per window** before you hit the limit.

Ways to stretch it:

- If a run stops with a usage / limit message, wait for the window to reset, or move the remaining phases to another connection in the routing rows.
- **Pair it with [Chronicle Reforge](../chronicling/reforging.md):** let Claude Code do the phases it's strongest at (grounding and the chronicle prose), and put the extras and condensed recap on another connection, in the routing rows or by reforging afterwards. Their tokens then stay off your Claude allowance.
- The lighter audit / extras phases default to `haiku`, which is cheaper against your plan than `sonnet` / `opus`.

## What you need

1. **Install Claude Code** — follow the official guide at [docs.claude.com/en/docs/claude-code](https://docs.claude.com/en/docs/claude-code). After install, the `claude` command must be on your `PATH`.
2. **Log in with your plan** — run:
   ```sh
   claude login
   ```
   and choose your Pro/Max plan when prompted.

## Enabling it

> [!NOTE]
> Nothing to install and no restart — the app detects whether the CLI is
> present and signed in.

1. Open **Settings → Providers & models**. The **Claude Code** row shows whether the CLI is detected and logged in. Click **Recheck** after logging in.
2. Assign it to individual phases in the routing rows, mixing it with other connections — or pick a subscription rung in guided routing to put every phase on it at once.

## Choosing a model

Per-phase models are set in the routing rows, exactly like every other connection. Claude Code accepts the aliases `sonnet`, `opus`, and `haiku` as well as full model IDs. The aliases are listed first, and deliberately: each resolves to whatever the CLI currently calls that tier, so a CLI upgrade moves them forward on its own. A pinned ID does not, which is how a configuration ends up still naming a superseded model months later.

## How it differs from a metered API key

| | An API key (e.g. via OpenRouter) | Claude Code (your subscription) |
|---|---|---|
| Auth | API key stored in the app's encrypted keystore | Your own `claude login` session — nothing stored by the app |
| Billing | Per-token API credit | Your Claude subscription |
| Rate limiting | Paced between chunks, retried on a rate-limit error | None — not paced and not retried; a limit message from the CLI pauses the run and saves a checkpoint |
| Cost estimate | Per-token estimate | Shown as **$0**, covered by your subscription |

## Troubleshooting

- **"CLI not found"** — `claude` isn't on your `PATH`. Reinstall Claude Code or restart your terminal/app so the updated `PATH` is picked up.
- **"Login not detected"** — run `claude login`. On macOS the session may live in the Keychain and not be detectable from here; if runs work anyway, you can ignore the warning.
- **"Your Claude Code is older than Tusk's Tomes needs"** — the options that switch off tools, MCP servers and personal settings need a recent Claude Code. Run `claude update`, then run again.
- **Signed in through your Claude Code settings file instead of `claude login`** — personal settings are switched off for these calls, so a sign-in kept there (an API key helper, for example) is not used. Run `claude login` with your plan.
- **A run fails with a usage/limit message** — you've reached your subscription's limit for headless usage. Wait for it to reset, or switch a phase to another connection in the routing rows. The run pauses and checkpoints rather than failing, so you can resume at the exact chunk it stopped on.

## A note on terms of use

Using Claude Code's headless mode with your own subscription is a documented feature. Because this integration is distributed publicly, review Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and the [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) article to confirm your usage fits. The integration is intentionally hands-off: it only invokes the CLI you authenticated yourself.
