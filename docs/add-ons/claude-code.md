# Claude Code (your subscription)

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
accident.

## ⚠️ Usage limits — chronicling burns through your plan fast

Claude subscriptions (Pro / Max) meter headless usage in rolling **~5-hour windows**, not per token. The chronicle pipeline is token-heavy — it runs your whole transcript through several phases — so a single session can consume a large slice of that window.

> **In testing, chronicling one full session used up to ~60% of the usage allowance in a 5-hour window.** Budget for roughly **one to two full sessions per window** before you hit the limit.

Ways to stretch it:

- If a run stops with a usage / limit message, wait for the window to reset, or move the remaining phases to another provider in **Hybrid Routing**.
- **Pair it with [Chronicle Reforge](../reforge.md):** let Claude Code do the phases it's strongest at (grounding + the chronicle prose), then re-run the cheaper extras and condensed recap on Gemini. That keeps the heaviest, most refusal-prone phases off your Claude allowance entirely.
- The lighter audit / extras phases default to `haiku`, which is cheaper against your plan than `sonnet` / `opus`.

## What you need

1. **Install Claude Code** — follow the official guide at [docs.claude.com/en/docs/claude-code](https://docs.claude.com/en/docs/claude-code). After install, the `claude` command must be on your `PATH`.
2. **Log in with your plan** — run:
   ```sh
   claude login
   ```
   and choose your Pro/Max plan when prompted.
3. **Make sure `ANTHROPIC_API_KEY` is not set.** If that environment variable is present, the CLI uses it (API billing) instead of your subscription. Tusk's Tomes strips it from the call it makes, but it's cleanest to leave it unset in your shell.

## Enabling it

1. Open **Settings → Add-ons** and install **Claude Code (your subscription)**.
2. Restart `npm run dev` so the server mounts the add-on's routes.
3. In **Settings**, the **Claude Code** panel shows whether the CLI is detected and logged in. Click **Recheck** after logging in.
4. Pick **Claude Code (your subscription)** in the **Active Provider** card — or assign it to individual phases in **Hybrid Routing**, mixing it with other providers.

## Choosing a model

Per-phase models are set in the **Model Profiles** card, exactly like the other providers. Claude Code accepts the aliases `sonnet`, `opus`, and `haiku` (each resolves to the latest matching model) as well as full model IDs. The defaults use `sonnet` for grounding and chronicle and `haiku` for the lighter audit/extras phases.

## How it differs from the Anthropic Claude (API) provider

| | Claude (API) | Claude Code (your subscription) |
|---|---|---|
| Auth | API key stored in the app's encrypted keystore | Your own `claude login` session — nothing stored by the app |
| Billing | Per-token API credit | Your Claude subscription |
| Rate limiting | Header-driven pacing | None — the subscription self-throttles; the CLI surfaces its own limit messages |
| Cost estimate | Per-token estimate | Shown as **$0** (covered by your subscription) |

## Troubleshooting

- **"CLI not found"** — `claude` isn't on your `PATH`. Reinstall Claude Code or restart your terminal/app so the updated `PATH` is picked up.
- **"Login not detected"** — run `claude login`. On macOS the session may live in the Keychain and not be detectable from here; if runs work anyway, you can ignore the warning.
- **A run fails with a usage/limit message** — you've reached your subscription's limit for headless usage. Wait for it to reset, or switch a phase to another provider in Hybrid Routing.

## A note on terms of use

Using Claude Code's headless mode with your own subscription is a documented feature. Because this add-on is distributed publicly, review Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and the [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) article to confirm your usage fits. The integration is intentionally hands-off: it only invokes the CLI you authenticated yourself.
