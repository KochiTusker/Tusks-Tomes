// Five Gemini scenarios that the Playwright MCP harness runs against the
// 24KB synthetic fixture at `scripts/safety-probe/fixtures-e2e.mjs`.
//
// Pure data — no runtime logic. Imported by both:
//   - the live MCP-driven session (Claude follows README.md)
//   - the assertions module (assertions.mjs) which scores captured JSON
//
// To add a scenario: append an object to SCENARIOS. To change a setting
// shape: also update the SettingsPatch / RoutingPatch types in the
// per-scenario JSON outputs at `.diagnose/playwright-runs/<id>-<ISO>.json`.

/**
 * @typedef {Object} ExpectedPhaseModel
 * @property {'free'|'paid'} tier
 * @property {string} model
 */

/**
 * @typedef {Object} Scenario
 * @property {string} id           short kebab-case identifier (filename slug)
 * @property {string} label        human-friendly name for logs and summaries
 * @property {Object} settingsPatch payload merged onto /api/settings POST
 * @property {Object} routing      either { preset: 'smart-budget'|'quality-budget'|'cheapest' } (UI-driven) or { perPhase: ... } (direct PUT)
 * @property {Record<string, ExpectedPhaseModel>} expectedModels per-phase model the run should actually invoke
 * @property {[number, number]} costBand low + high USD bounds (warning only, not hard fail)
 * @property {Object} hardFails which assertions are HARD fails for this scenario; others soften to WARNING
 */

const DEFAULT_SETTINGS = {
  disableThinkingOnGrounding: false,
  phase1AliasHints: false,
  perPhaseThinking: {},
  devTestMode: { enabled: false, maxChars: 24000 },
}

const ALL_PRO_PERPHASE = {
  phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-pro' },
  phase2: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-pro' },
  phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-pro' },
  phase4: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-pro' },
  phase6: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-pro' },
}

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    id: 'all-pro',
    label: 'All-Pro baseline (every phase → gemini-2.5-pro)',
    settingsPatch: { ...DEFAULT_SETTINGS },
    routing: { perPhase: ALL_PRO_PERPHASE },
    expectedModels: {
      phase1_ground: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase2_audit: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase3_chronicle: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase6_condense: { tier: 'paid', model: 'gemini-2.5-pro' },
    },
    costBand: [0.08, 0.22],
    hardFails: { prohibitedContent: true },
  },
  {
    id: 'smart-budget',
    label: 'Smart Budget (Free Flash p1 · Paid Flash p2 · Pro p3 · Flash-Lite p4+p6)',
    settingsPatch: { ...DEFAULT_SETTINGS },
    routing: { preset: 'smart-budget' },
    expectedModels: {
      phase1_ground: { tier: 'free', model: 'gemini-2.5-flash' },
      phase2_audit: { tier: 'paid', model: 'gemini-2.5-flash' },
      phase3_chronicle: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras: { tier: 'paid', model: 'gemini-2.5-flash-lite' },
      phase6_condense: { tier: 'paid', model: 'gemini-2.5-flash-lite' },
    },
    costBand: [0.015, 0.045],
    hardFails: { prohibitedContent: false },
  },
  {
    id: 'quality-budget',
    label: 'Quality Budget (Pro p1/p2/p3/p6 · Flash p4)',
    settingsPatch: { ...DEFAULT_SETTINGS },
    routing: { preset: 'quality-budget' },
    expectedModels: {
      phase1_ground: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase2_audit: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase3_chronicle: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras: { tier: 'paid', model: 'gemini-2.5-flash' },
      phase6_condense: { tier: 'paid', model: 'gemini-2.5-pro' },
    },
    costBand: [0.04, 0.12],
    hardFails: { prohibitedContent: true },
  },
  {
    id: 'smart-budget-alias-hints',
    label: 'Smart Budget + Phase 1 alias hints ON',
    settingsPatch: { ...DEFAULT_SETTINGS, phase1AliasHints: true },
    routing: { preset: 'smart-budget' },
    expectedModels: {
      phase1_ground: { tier: 'free', model: 'gemini-2.5-flash' },
      phase2_audit: { tier: 'paid', model: 'gemini-2.5-flash' },
      phase3_chronicle: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras: { tier: 'paid', model: 'gemini-2.5-flash-lite' },
      phase6_condense: { tier: 'paid', model: 'gemini-2.5-flash-lite' },
    },
    costBand: [0.015, 0.045],
    hardFails: { prohibitedContent: false },
  },
  {
    id: 'smart-budget-thinking-tweaks',
    label: 'Smart Budget + thinking-budget tweaks (p1 off, p4+p6 on)',
    settingsPatch: {
      ...DEFAULT_SETTINGS,
      disableThinkingOnGrounding: true,
      perPhaseThinking: { phase4: true, phase6: true },
    },
    routing: { preset: 'smart-budget' },
    expectedModels: {
      phase1_ground: { tier: 'free', model: 'gemini-2.5-flash' },
      phase2_audit: { tier: 'paid', model: 'gemini-2.5-flash' },
      phase3_chronicle: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras: { tier: 'paid', model: 'gemini-2.5-flash-lite' },
      phase6_condense: { tier: 'paid', model: 'gemini-2.5-flash-lite' },
    },
    costBand: [0.015, 0.045],
    hardFails: { prohibitedContent: false },
  },
]

// Real lore canonical names for the Too Many Bruisers campaign. First names appear
// in the raw SBV transcript (e.g. "Solveig"); the canonical full names (e.g.
// "Solveig Crane") only show up if Phase 1 grounding consults the alias index
// and applies the substitution. This is the load-bearing grounding quality
// signal.
export const SEEDED_ENTITIES = [
  'Solveig Crane',
  'Chidi Osk',
  'Wiktoria Corvel',
  'Gustav Gensai',
  'Delphine Corvel',
  'Giulia',
  'CCW',
  'Stardust',
  'Pentagon',
]
