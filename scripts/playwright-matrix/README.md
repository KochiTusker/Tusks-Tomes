# Playwright MCP matrix harness

Five-scenario Gemini-only validation that runs the full pipeline UI end-to-end against the 24KB synthetic fixture at `scripts/safety-probe/fixtures-e2e.mjs`. Run by Claude Code shepherding the Playwright MCP browser; no `playwright` npm devDep required.

## What this verifies

For each of the five Gemini scenarios in [`scenarios.mjs`](scenarios.mjs):

- The pipeline reaches `status === 'done'` without unrecoverable errors
- Phase 3 chronicle is non-empty and contains ≥4 of 7 seeded entities (Cassian / Lakshmi / Zainab / Liesel / Thornholt / The Three / Pact of Mor)
- Phase 4 extras parses with ≥1 quote
- Phase 6 condensed narrative meets the 1500-word floor enforced by `src/lib/prompts.ts:631-634`
- Each phase routed to the model the scenario specifies
- No `prohibited_content` escalations on non–Smart-Budget scenarios (Smart-Budget scenarios are *allowed* to recover — that's the safety layer's job)
- Total cost falls in the scenario's expected USD band (warning only — model nondeterminism)

Outputs land in `.diagnose/playwright-runs/<scenario-id>-<ISO>.json`. Summary at `.diagnose/playwright-runs/summary-<ISO>.md`.

## Prerequisites

1. Both Gemini keys configured: `gemini` (paid) AND `geminiFallback` (free) — verify with `curl http://127.0.0.1:5173/api/providers`. Smart Budget UI button only renders when both are present.
2. `npm run dev` running on `127.0.0.1:5173`.
3. `npm run typecheck && npx vitest run` clean.
4. Playwright MCP server wired into the Claude Code session (verify with `ToolSearch "select:mcp__playwright__browser_navigate"`).

## Per-scenario playbook (Claude follows this)

For each scenario in [`scenarios.mjs`](scenarios.mjs):

### 1. Snapshot existing state (no API spend)

```sh
mkdir -p .diagnose/playwright-runs/snapshots/<ISO>
curl -s http://127.0.0.1:5173/api/settings  > .diagnose/playwright-runs/snapshots/<ISO>/settings.json
curl -s http://127.0.0.1:5173/api/routing   > .diagnose/playwright-runs/snapshots/<ISO>/routing.json
```

Done once before the first scenario; restored once at the end.

### 2. Reset per-scenario state

```js
// browser_evaluate
() => {
  localStorage.removeItem('refinement_state')
  localStorage.removeItem('output_picker_selection')
  return 'cleared'
}
```

### 3. Apply settings

```sh
curl -s -X POST http://127.0.0.1:5173/api/settings \
  -H 'Content-Type: application/json' \
  -d '<scenario.settingsPatch>'
```

The patch always carries `devTestMode: { enabled: false, maxChars: 24000 }` to defeat persistence from previous sessions.

### 4. Apply routing

- **Scenario 1 (All-Pro):** direct API write (no UI preset button for All-Pro):
  ```sh
  curl -s -X PUT http://127.0.0.1:5173/api/routing -H 'Content-Type: application/json' \
    -d '{ "version":3, "lastSelectedProvider":"gemini", "geminiTier":"paid", "perPhase": { ...ALL_PRO_PERPHASE } }'
  ```
- **Scenarios 2, 4, 5 (Smart Budget):** open Settings tab → click "Smart Budget (recommended)" button → Save.
- **Scenario 3 (Quality Budget):** load a transcript first so the CostEstimatorCard appears on the Chronicle tab → click "Balanced" preset → confirm "Active" badge → return to Chronicle.

### 5. Configure scenario-specific UI toggles

- **Scenario 4:** Settings tab → Phase 1 alias hints card → check "Use lore alias index…".
- **Scenario 5:** Settings tab → ThinkingBudgetCard → check Phase 1 disable, Phase 4 enable, Phase 6 enable.

### 6. Load transcript

```js
// browser_evaluate, importing the fixture via a fetch on /scripts/safety-probe/fixtures-e2e.mjs
//
// Easier path: read FIXTURE_E2E with Read tool, paste via browser_type into the
// textarea identified by `textbox "Raw transcript"` from browser_snapshot.
```

### 7. Begin the Chronicle

`browser_snapshot` → find `button "Begin the Chronicle"` → `browser_click`.

### 8. Wait for `awaiting_dm`

```js
// Poll every 30s, cap 10 min
() => {
  const state = JSON.parse(localStorage.getItem('refinement_state') ?? '{}')
  return state.status
}
```

### 9. Skip Phase 2

`browser_snapshot` → `button "Skip and continue"` → `browser_click`. (Phase 2 *always* enters `awaiting_dm`, even with zero clarifications — `useRefinementState.completePhase2`.)

### 10. Wait for OutputPicker → Run with selection

`browser_snapshot` → `button "Run with selection"` → `browser_click`. ([OutputPicker.tsx:169](../../src/components/OutputPicker.tsx))

### 11. Wait for `done`

```js
// Poll every 60s, cap 12 min wall-clock
```

If timeout: capture state-as-is, mark FAILED with reason `wall_clock_timeout`, proceed to next scenario.

### 12. Capture outputs

```js
// browser_evaluate
() => JSON.parse(localStorage.getItem('refinement_state'))
```

```js
// browser_network_requests with filter:
//   filter: 'generativelanguage\\.googleapis\\.com'
// Parse usageMetadata from each :generateContent response body.
```

### 13. Score with assertions.mjs

```js
import { SCENARIOS } from './scripts/playwright-matrix/scenarios.mjs'
import { assertRun, summarizeUsage } from './scripts/playwright-matrix/assertions.mjs'

const result = assertRun(capture, scenario)
// → { passed: string[], warnings: string[], failed: string[] }
```

### 14. Persist

Write `.diagnose/playwright-runs/<scenario.id>-<ISO>.json`:

```json
{
  "scenario": { "id": "...", "label": "..." },
  "startedAt": "...",
  "completedAt": "...",
  "durationMs": ...,
  "settings": { /* GET /api/settings */ },
  "routing": { /* GET /api/routing */ },
  "refinementState": { /* localStorage[LS_REFINEMENT] */ },
  "tokenUsage": [ /* per-call entries */ ],
  "perPhaseSummary": { /* summarizeUsage output */ },
  "assertions": { "passed": [...], "warnings": [...], "failed": [...] }
}
```

## End-of-matrix

1. Restore the snapshotted `settings.json` + `routing.json` via two `curl PUT` calls.
2. Aggregate per-scenario assertions into a markdown summary at `.diagnose/playwright-runs/summary-<ISO>.md`.
3. Print a table: scenario × passed / warnings / failed × total cost.
4. **Hard-fail count = 0** → proceed to commit + push (see plan file).
5. **Any hard fails** → surface findings, do NOT push.

## Re-running assertions against archived JSON

Assertions are pure and importable; you can re-score an archived run without re-driving the browser:

```js
import { assertRun } from './scripts/playwright-matrix/assertions.mjs'
import { SCENARIOS } from './scripts/playwright-matrix/scenarios.mjs'
import { readFile } from 'node:fs/promises'

const capture = JSON.parse(await readFile('.diagnose/playwright-runs/smart-budget-2026-05-26T...Z.json', 'utf8'))
const scenario = SCENARIOS.find(s => s.id === 'smart-budget')
console.log(assertRun(capture, scenario))
```

Useful for re-evaluating after an assertion threshold change.

## Why MCP-driven, not script-driven

- No new npm devDep (`playwright` package + Chromium install ≈ 200MB)
- User watches each step live; can interrupt at any turn boundary
- Accessibility snapshot finds elements without `data-testid` markup
- `browser_evaluate` reads `localStorage` directly — no need for a separate diagnostic endpoint
- `browser_network_requests` regex-filters the Gemini API responses with `usageMetadata`

Trade-off: Claude shepherds each click instead of one-shot script run. The matrix is ~30–50 minutes of wall-clock; the shepherding overhead is ~10% of that. Acceptable for a once-per-major-change validation run.

See [the plan file](../../) (`C:/Users/<you>/.claude/plans/yes-go-ahead-i-wondrous-pillow.md`) for full context.
