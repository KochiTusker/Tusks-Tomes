// User-tunable runtime settings persisted in {configDir}/settings.json.
//
// Each field is a small, narrow choice that affects how some server
// subsystem behaves — currently just the updater's git remote. The shape
// is a single shallow object so callers can fetch/update without an
// explosion of per-feature endpoints. Anything that's already in its
// own file (glossary, routing, profiles, etc.) stays there — this is
// purely for cross-cutting toggles that don't fit those buckets.
//
// Validation: every field has a closed union of legal values. A
// hand-edited settings.json or a malicious POST gets each unknown value
// snapped back to the safe default. The updater specifically must never
// see an arbitrary string here — that string ends up as a git remote
// name, and a bogus name would bubble up as a git error to the user.

import express, { type Router } from 'express'
import { readJson, settingsFile, writeJson } from '../appData.js'
import { loopbackOnly } from '../lib/loopbackGate.js'

export type UpdaterRemote = 'origin' | 'dev'

export type Settings = {
  /** Which git remote the in-app updater pulls from.
   *  - "origin" (default): the public Tusks-Tomes repo on a normal user
   *    install (or whatever the local clone calls origin).
   *  - "dev": a remote literally named `dev`, added locally with
   *    `git remote add dev <url>`
   *    before flipping this. The toggle is gated behind a 5-tap unlock
   *    in the dashboard so casual users don't stumble onto it.
   *
   *  The toggle is UX. The real security boundary is GitHub auth — a
   *  user without credentials for it gets a 404 from `git pull dev`
   *  even if they flip the setting. */
  updaterRemote: UpdaterRemote
  /** Phase A: Gemini thinking-budget toggle for the grounding phase.
   *  When true, Phase 1 grounding calls are sent with thinkingBudget: 0,
   *  which disables Gemini's internal reasoning mode. Grounding is a
   *  mechanical phase (substitute lore names) that doesn't benefit from
   *  thinking — disabling it cuts ~10-15% off the Phase 1 token bill
   *  without affecting grounding accuracy in any measurable way.
   *
   *  Default: false (existing behaviour preserved). User opts in to
   *  save cost; any observed regression rolls back via the same toggle.
   *
   *  Phase 3 (chronicle) is NOT controlled by this — it's hardcoded to
   *  keep thinking on so the toggle can never accidentally degrade
   *  chronicle voice quality. */
  disableThinkingOnGrounding: boolean
  /** Stage 1 opt-in (default false): when on, Phase 1 grounding uses the
   *  lore alias index to (a) inject canonical-name safe-replacements for
   *  any aliases that appear literally in the chunk, and (b) annotate
   *  the chunk with inline `[≈Name? NN%]` fuzzy hints for phonetic
   *  mishears that exact matching misses. Improves Flash grounding
   *  accuracy on names like "Morvan Vayne" mis-transcribed as "more
   *  than vain". Costs nothing extra; the model accepts or rejects each
   *  hint based on context. Toggle off if you ever observe wrong-name
   *  substitutions caused by an over-confident annotation. */
  phase1AliasHints: boolean
  /** Opt-in (default false): let Phase 4 reassemble fragmented quotes.
   *
   *  Craig/Whisper transcribes each player's track separately with
   *  `condition_on_previous_text=False`, so speech is cut into ~2s
   *  segments and punctuation/capitalisation resets at every cut. One
   *  spoken sentence therefore lands across several consecutive lines,
   *  often interleaved with another speaker's fragments. Phase 1 is
   *  required to preserve line breaks, so Phase 4 sees the shards and —
   *  bound by its "verbatim" rule — quotes them raw. That is where
   *  quotes like "took more than that" (the "I" is on the previous
   *  line) come from.
   *
   *  When ON, Phase 4 is told the source is fragmented and is allowed to
   *  rejoin a speaker's consecutive fragments and restore sentence
   *  punctuation/capitalisation. Words may not be added, dropped, or
   *  changed.
   *
   *  Measured on Session 29 (two 30k chunks, 5 runs/arm, blind LLM
   *  judge): grammatically-complete quote turns rose 70% -> 93% and
   *  truncated turns fell 25% -> 5%, at unchanged quote volume. The
   *  trade-off is fidelity — turns whose words appear contiguously in
   *  the source fell 100% -> ~83%, because the model also silently drops
   *  disfluencies ("stunning a strike" -> "stunning strike") and, rarely,
   *  substitutes a word. Default OFF per the project rule that anything
   *  which can regress output ships opt-in. */
  reassembleQuotes: boolean
  /** Opt-in (default false): retrieve only the lore the chronicle actually
   *  references for Phase 6 (condense), instead of shipping the whole vault.
   *
   *  Phase 6 is the ONLY cloud phase handed the full KB — Phase 3 sends no
   *  lore at all, and Phases 1/2/4 send `compactKb`. On the reference vault
   *  that is ~2.13 MB / ~557k tokens per call, spent condensing a chronicle
   *  that is already written.
   *
   *  Retrieval is vault-agnostic: it keys off note titles, frontmatter
   *  aliases and inbound reference counts, never folder names, so it works
   *  on any vault layout with or without the mapping pass. Measured on
   *  Session 29: 2,228,864 -> 176,196 chars (-92%) with 17/17 referenced
   *  entities still present. Any note named in the text is always included,
   *  so this cannot silently drop grounding. */
  retrieveVaultKb: boolean
  /** Subscription tier of the user's Claude Code plan. Set manually on the
   *  routing preset panel — the CLI exposes no non-interactive way to query
   *  it (verified against docs + issue tracker 2026-08; open feature
   *  requests #21943 / #44328). Feeds the usage-hint copy on
   *  subscription-backed routing presets; nothing routing-critical reads
   *  it. 'unknown' = never asked / user skipped. */
  claudeCodePlan: 'unknown' | 'pro' | 'max5x' | 'max20x'
  /** Subscription tier of the user's ChatGPT (Codex) plan. Same manual-
   *  capture story as claudeCodePlan — no programmatic probe exists. */
  codexPlan: 'unknown' | 'plus' | 'pro'
  /** Stage 4: per-phase thinking-budget overrides. undefined keeps the
   *  legacy default for that phase. Phase 3 is intentionally absent —
   *  it's hardcoded to always have thinking on (voice protection). */
  perPhaseThinking: {
    phase1?: boolean
    phase2?: boolean
    phase4?: boolean
    phase6?: boolean
  }
  /** Dev-only test mode for cheap end-to-end pipeline runs. When
   *  enabled, the raw transcript is truncated at the last line-break
   *  before `maxChars` BEFORE Phase 1 sees it. The whole pipeline
   *  (Phase 1 → 2 → 3 → 4 → 6) then runs on the truncated content, so
   *  the user can verify everything works without paying for a full
   *  multi-hundred-KB session.
   *
   *  Defaults: { enabled: false, maxChars: 24000 }. 24KB ≈ ~3 chunks
   *  on Free Flash, ~1 chunk on Paid Pro — enough to exercise every
   *  phase with bounded cost.
   *
   *  The Settings UI surfaces this card ONLY when the user has the
   *  session-local dev mode unlocked (5-tap on the coat-of-arms in
   *  App.tsx). The setting itself persists so the user doesn't have to
   *  re-toggle every session; the card visibility gate exists so a
   *  non-dev user can never accidentally enable test-mode truncation. */
  devTestMode: {
    enabled: boolean
    maxChars: number
  }
}

const DEFAULTS: Settings = {
  updaterRemote: 'origin',
  disableThinkingOnGrounding: false,
  phase1AliasHints: false,
  reassembleQuotes: false,
  retrieveVaultKb: false,
  claudeCodePlan: 'unknown',
  codexPlan: 'unknown',
  perPhaseThinking: {},
  devTestMode: { enabled: false, maxChars: 24000 },
}

function coerce(raw: unknown): Settings {
  const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {})
  // The `=== 'dev' ? 'dev' : 'origin'` shape deliberately rejects any
  // unknown value so git is never invoked with an arbitrary string.
  const updaterRemote: UpdaterRemote = obj.updaterRemote === 'dev' ? 'dev' : 'origin'
  // Boolean toggle — strict === true so a hand-edited "yes" / 1 / etc.
  // falls back to the safe-default OFF.
  const disableThinkingOnGrounding = obj.disableThinkingOnGrounding === true
  const phase1AliasHints = obj.phase1AliasHints === true
  const reassembleQuotes = obj.reassembleQuotes === true
  const retrieveVaultKb = obj.retrieveVaultKb === true
  // Closed unions — an unrecognised value snaps back to 'unknown'.
  const claudeCodePlan =
    obj.claudeCodePlan === 'pro' || obj.claudeCodePlan === 'max5x' || obj.claudeCodePlan === 'max20x'
      ? obj.claudeCodePlan
      : 'unknown'
  const codexPlan = obj.codexPlan === 'plus' || obj.codexPlan === 'pro' ? obj.codexPlan : 'unknown'
  // perPhaseThinking: object with optional boolean entries. Strict ===
  // true/false coercion so a stray "yes" or 1 falls back to undefined
  // (which then triggers the legacy default for that phase).
  const rawPpt = (obj.perPhaseThinking && typeof obj.perPhaseThinking === 'object'
    ? (obj.perPhaseThinking as Record<string, unknown>)
    : {})
  const coerceBool = (v: unknown): boolean | undefined =>
    v === true ? true : v === false ? false : undefined
  const perPhaseThinking = {
    ...(coerceBool(rawPpt.phase1) !== undefined ? { phase1: coerceBool(rawPpt.phase1)! } : {}),
    ...(coerceBool(rawPpt.phase2) !== undefined ? { phase2: coerceBool(rawPpt.phase2)! } : {}),
    ...(coerceBool(rawPpt.phase4) !== undefined ? { phase4: coerceBool(rawPpt.phase4)! } : {}),
    ...(coerceBool(rawPpt.phase6) !== undefined ? { phase6: coerceBool(rawPpt.phase6)! } : {}),
  }
  // devTestMode: nested object. Coerce each field; unknown shapes fall
  // back to the safe defaults. Cap maxChars to a sensible band so a
  // typo can't accidentally request a 10MB pipeline run.
  const rawDtm = (obj.devTestMode && typeof obj.devTestMode === 'object'
    ? (obj.devTestMode as Record<string, unknown>)
    : {})
  const dtmEnabled = rawDtm.enabled === true
  const rawMax = typeof rawDtm.maxChars === 'number' ? rawDtm.maxChars : DEFAULTS.devTestMode.maxChars
  const dtmMaxChars = Math.max(1000, Math.min(200000, Math.floor(rawMax)))
  return {
    updaterRemote,
    disableThinkingOnGrounding,
    phase1AliasHints,
    reassembleQuotes,
    retrieveVaultKb,
    claudeCodePlan,
    codexPlan,
    perPhaseThinking,
    devTestMode: { enabled: dtmEnabled, maxChars: dtmMaxChars },
  }
}

export async function readSettings(): Promise<Settings> {
  // appData.readJson rethrows on JSON-parse failures (only ENOENT is
  // swallowed). A hand-edited settings.json with a stray comma must NOT
  // bring the updater down — it would block all in-app updates. Swallow
  // any read/parse error and fall back to defaults; the caller can
  // re-write a clean copy via POST /api/settings whenever ready.
  let raw: unknown = {}
  try {
    raw = await readJson<unknown>(settingsFile(), {})
  } catch (err) {
    console.warn('[api/settings] settings.json unreadable, using defaults:', (err as Error).message)
  }
  return coerce(raw)
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await readSettings()
  const next = coerce({ ...current, ...patch })
  await writeJson(settingsFile(), next)
  // Switching back to public invalidates any active dev-mode session.
  // The user has to re-authenticate to come back to dev. Switching TO
  // dev does NOT auto-grant — the POST /dev-auth endpoint is the only
  // path to a true grant.
  if (next.updaterRemote === 'origin') {
    clearDevAuthSession()
  }
  return next
}

// ----- Dev-mode session auth -----
//
// The persisted `updaterRemote` setting records the user's PREFERENCE
// (origin / dev). The in-memory `devAuthSession` flag below records
// whether the current process has been authenticated for dev-mode use
// in this session. The two are deliberately separate:
//
//   - The setting persists across restarts (so it doesn't
//     have to re-click "Switch to dev" every reboot).
//   - The session flag does NOT persist (it must be re-entered
//     their email each reboot to actually exercise dev mode).
//
// On boot, devAuthSession is false. If settings says "dev" but the
// session isn't granted, the updater falls back to the public remote
// and surfaces `devAuthRequired: true` in its status so the UI can
// prompt for re-entry.
//
// The typed email is NOT checked against anything — the gate is
// deliberate intent, not cryptographic proof. Real security lives at
// access control at the remote (unauthenticated
// fetches 404 regardless of what's typed here).

let devAuthSession = false

export function isDevAuthGranted(): boolean {
  return devAuthSession
}

export function clearDevAuthSession(): void {
  devAuthSession = false
}

/** Server-only resolver for the EFFECTIVE remote git operations should
 *  use this request. Combines the persisted setting with the session
 *  auth flag. Returns 'origin' whenever dev auth is missing. */
export async function effectiveUpdaterRemote(): Promise<UpdaterRemote> {
  const { updaterRemote } = await readSettings()
  return updaterRemote === 'dev' && devAuthSession ? 'dev' : 'origin'
}

/** True iff the user PREFERS dev mode (setting === 'dev') but the
 *  current session hasn't been authenticated yet. UI shows the email
 *  prompt when this is true. */
export async function isDevAuthRequired(): Promise<boolean> {
  const { updaterRemote } = await readSettings()
  return updaterRemote === 'dev' && !devAuthSession
}

export function settingsRouter(): Router {
  const router = express.Router()

  router.get('/', async (_req, res) => {
    try {
      res.json(await readSettings())
    } catch (err) {
      console.error('[api/settings GET] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Loopback-only: writes the `updaterRemote` field which feeds into
  // the updater subsystem. Symmetrical with /dev-auth* below — both
  // shape what the updater will do, so both should require host-only
  // access. A LAN visitor with TUSKS_LAN_WRITES=1 must NOT be able to
  // flip the persisted updater remote.
  router.post('/', loopbackOnly(), async (req, res) => {
    try {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Partial<Settings>
      const next = await writeSettings(body)
      res.json(next)
    } catch (err) {
      console.error('[api/settings POST] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Dev-mode session auth. The body is { email: string }; we only
  // check that it's a non-empty trimmed string of plausible shape.
  // The value itself is NOT stored — only the in-memory grant flag
  // flips. Restart the server and the user must re-enter.
  //
  // On success the persisted `updaterRemote` setting is ALSO flipped
  // to 'dev' so the user's preference is remembered for next boot
  // (matching the "switch to dev means switch to dev" UX). The grant
  // itself still resets each session.
  //
  // Loopback-only: this unlocks pre-release builds; should never cross
  // trust boundaries. LAN visitors get 403 — same threat model as the
  // updater itself.
  router.post('/dev-auth', loopbackOnly(), async (req, res) => {
    try {
      const body = (req.body ?? {}) as { email?: unknown }
      const raw = typeof body.email === 'string' ? body.email.trim() : ''
      if (raw.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'Email is required to unlock dev mode for this session.',
        })
      }
      // Sanity bound: anything longer than RFC 5321's 254-char address
      // limit is almost certainly a paste accident; reject it so the
      // memory footprint stays tiny and the friction stays meaningful.
      if (raw.length > 254) {
        return res.status(400).json({ ok: false, error: 'Input too long for an email address.' })
      }
      // The deliberate-action gate. We don't compare to anything — the
      // real security is access control at the remote + your cached
      // credentials. Anyone who types something here still gets a 404
      // from `git fetch dev main` if they don't have access.
      devAuthSession = true
      const next = await writeSettings({ updaterRemote: 'dev' })
      res.json({ ok: true, ...next })
    } catch (err) {
      console.error('[api/settings/dev-auth POST] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Explicit lock — clears the session grant without changing the
  // persisted preference. The UI uses this for a "lock dev mode"
  // button you can hit before stepping away from the machine.
  router.post('/dev-auth/lock', loopbackOnly(), async (_req, res) => {
    try {
      clearDevAuthSession()
      res.json({ ok: true })
    } catch (err) {
      console.error('[api/settings/dev-auth/lock POST] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

export { DEFAULTS as SETTINGS_DEFAULTS }
