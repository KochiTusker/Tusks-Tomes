# Diagnosis bundles for Claude Code

A single structured markdown file at `.diagnose/latest.md` that Claude Code
reads with one Read call to get full diagnostic context for a Tusk's Tomes
bug. Auto-built on every pipeline error; manual button in
Settings → Diagnostics for proactive snapshots.

## The user flow

1. You hit a bug. Pipeline error fires (or you click "Build bundle now").
2. A toast appears: *"Diagnosis ready — paste @.diagnose/latest.md into
   Claude Code (N soft-errors matched)."*
3. In Claude Code, type:
   ```
   @.diagnose/latest.md what's wrong?
   ```
4. Claude reads ONE file with everything it needs. No follow-up
   "send me your routing.json" round-trips.

## What's in a bundle

Predictable section headings so any Claude session can parse them fast:

| § | Section | Contents |
|---|---|---|
| 1 | Current state | Status / phase / chunk / active provider / output selection / last error (table) |
| 2 | Soft-error signatures matched | Severity-sorted matches with hint + suggested next step + collapsible evidence JSON |
| 3 | Last 80 events | JSON Lines from the merged browser+server ring |
| 4 | Graphify slice | Callers + callees + same-community siblings for the throw-site symbol |
| 5 | Probe cache snapshot | Per-slot fingerprint + accessibility count + notable inaccessible models |
| 6 | Routing snapshot | Full `routing.json` (formatted JSON block) |
| 7 | Git state | Branch + `git status --short` + last 5 commits |
| 8 | Recommended next steps | Prioritised actions generated from the matched signatures + stack trace |

## Soft-error signatures (current library)

Each signature is a pure function that scans the ring + state and decides
"is something fishy here?" — the curated subset worth investigating. New
signatures land in `server/lib/softErrorSignatures.ts` next to the
existing ones.

| ID | Severity | What it catches |
|---|---|---|
| `chunk_latency_outlier` | warning | A chunk took >3× the phase median — likely a silent retry. |
| `auto_fallback_mid_run` | warning | Gemini auto-tier soft-swapped to the Free key mid-run. |
| `probed_model_inaccessible_but_selected` | critical | Routing names a model the probe says is inaccessible. |
| `empty_phase_output` | warning | Phase 3 completed but `state.chronicle.length < 100`. |
| `stale_perPhase_override` | warning | A perPhase entry diverges from the global geminiTier. |
| `provider_keys_mismatch_with_fingerprint` | critical | Quota event reports a fingerprint that no current probe slot knows. |
| `hidden_500_retries` | info | ≥3 transient retries on one phase within 60s. |
| `tier_escalated_silently` | critical | `tier_escalated` fired but next `chunk_started` used the old tier. |

## Adding a new signature

1. Open `server/lib/softErrorSignatures.ts`.
2. Define a `Signature` object: `{ id, description, severity, match(input) }`.
3. Append to `SIGNATURES` at the bottom of the file.
4. Add positive + negative fixture in `server/lib/softErrorSignatures.test.ts`.
5. Bump the expected count in the `SIGNATURES.length` test.

That's it — the bundle assembler iterates the library directly, the API
echoes new matches, and the toast surfaces them automatically.

## Auto-trigger behaviour

- Fires from `RefinementTool.handlePipelineError` on any non-`AbortError`.
- 30-second debounce in the client wrapper (`src/lib/diagnose.ts`) so a
  rapid-fire failure produces one bundle, not twelve.
- Backup rotation: the most recent 10 timestamped bundles
  (`diagnose-<ISO>.md`) survive; older ones are pruned. `latest.md` is
  always the latest copy.
- Explicit "Build bundle now" button in Settings → Diagnostics bypasses
  the debounce (`force: true`).

## DevTools shortcuts

```js
// Build a bundle from the browser console (handy when investigating
// something that didn't trigger an automatic build):
fetch('/api/diagnose/bundle', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    trigger: 'manual',
    browserRing: window.__tusk.dumpRecentEvents({ count: 80 }),
  }),
}).then((r) => r.json()).then(console.log)

// List recent bundles:
fetch('/api/diagnose/recent').then((r) => r.json()).then(console.log)
```

## Privacy / file location

- Bundle path: `.diagnose/latest.md` (in repo root, gitignored).
- Sanitization: client-side `sanitizeForForwarding()` in `verboseLog.ts`
  redacts `apiKey`, `userPrompt`, `cacheablePrefix`, `rawTranscript`,
  `groundedTranscript`, and `systemPrompt` at the forwarder boundary.
  The bundle inherits those redactions.
- Key references: 6-char SHA-256 fingerprints only — same convention
  used by the RateLimitDialog + DiagnosticsCard.
- Endpoint: behind `loopbackOnly()` — LAN sources get 403.

## Out of scope today

- No WebSocket push to a live "diagnose viewer" tab — the file-based
  bundle covers the primary case.
- No `/diagnose` slash command in Claude Code — extending the
  graphify-skill pattern is a follow-up.
- No auto-issue creation in GitHub — the bundle has everything `gh
  issue create` would need, but the wrapper is a separate ask.
