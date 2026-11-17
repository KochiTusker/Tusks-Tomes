// Tests for the Recommended Setup planner.
//
// This is the layer that can wreck someone's configuration — it decides
// whether to overwrite a stored API key and whether to replace a hand-tuned
// per-phase routing document. The tests below are mostly about what the
// planner REFUSES to do and what it marks as already-done, rather than the
// happy path.

import { describe, expect, it } from 'vitest'
import {
  buildSetupPlan,
  detectBestSubscription,
  describeCli,
  planIsNoop,
  recommendedRouting,
  type CliDetect,
  type CurrentSetup,
  type SetupAnswers,
} from './recommendedSetup'

const noCli: CliDetect = {
  claudeCode: { installed: false, version: null, authenticated: false, loaded: false },
  codex: { installed: false, version: null, authenticated: false, loaded: false },
  restartRequired: false,
}

const withClaudeCode: CliDetect = {
  ...noCli,
  claudeCode: { installed: true, version: '2.1.220', authenticated: true, loaded: false },
}

const base: CurrentSetup = {
  geminiConfigured: true,
  routing: null,
  addonsReady: {},
  cli: noCli,
  gpu: { detected: true, name: 'RTX 3070 Ti', vramGb: 8 },
}

const answers: SetupAnswers = {
  geminiKey: null,
  installWhisper: false,
  acceptedCpuWhisper: false,
  subscription: 'none',
  vaultPath: null,
  convertDocs: [],
}

const step = (plan: ReturnType<typeof buildSetupPlan>, id: string) =>
  plan.steps.find((s) => s.id === id)

describe('detectBestSubscription', () => {
  it('picks a CLI only when it is installed AND signed in', () => {
    expect(detectBestSubscription(noCli)).toBe('none')
    expect(detectBestSubscription(withClaudeCode)).toBe('claudeCode')
  })

  it('ignores an installed-but-not-signed-in CLI', () => {
    // Proposing this would route phases at a provider that 401s mid-run.
    expect(
      detectBestSubscription({
        ...noCli,
        claudeCode: { installed: true, version: '2.1.220', authenticated: false, loaded: false },
      }),
    ).toBe('none')
  })

  it('falls back to Codex when only Codex is usable', () => {
    expect(
      detectBestSubscription({
        ...noCli,
        codex: { installed: true, version: '0.9.0', authenticated: true, loaded: false },
      }),
    ).toBe('codex')
  })
})

describe('describeCli', () => {
  it('never claims the user is logged out — only that it could not confirm', () => {
    // Detection is a credentials-FILE presence check, not an auth query, so
    // the copy must not assert something it cannot know.
    const text = describeCli('claudeCode', {
      installed: true,
      version: '2.1.220',
      authenticated: false,
      loaded: false,
    })
    expect(text).toMatch(/couldn't be confirmed/i)
    expect(text).not.toMatch(/logged out|not signed in/i)
  })
})

describe('blockers', () => {
  it('refuses to proceed with no Gemini key', () => {
    const plan = buildSetupPlan({ ...base, geminiConfigured: false }, answers)
    expect(plan.blockers.join(' ')).toMatch(/Gemini API key is required/i)
  })

  it('accepts a newly entered key in place of a stored one', () => {
    const plan = buildSetupPlan(
      { ...base, geminiConfigured: false },
      { ...answers, geminiKey: 'a-new-key' },
    )
    expect(plan.blockers).toHaveLength(0)
    expect(step(plan, 'gemini-key')?.skipped).toBe(false)
  })

  it('blocks a subscription that is not installed', () => {
    const plan = buildSetupPlan(base, { ...answers, subscription: 'claudeCode' })
    expect(plan.blockers.join(' ')).toMatch(/isn't on PATH/i)
  })

  it('blocks a subscription that is installed but not signed in, and says which command to run', () => {
    const plan = buildSetupPlan(
      {
        ...base,
        cli: {
          ...noCli,
          codex: { installed: true, version: '0.9.0', authenticated: false, loaded: false },
        },
      },
      { ...answers, subscription: 'codex' },
    )
    expect(plan.blockers.join(' ')).toMatch(/codex login/)
  })
})

describe('idempotence — re-running must not clobber', () => {
  it('marks an existing Gemini key as skipped rather than overwriting it', () => {
    const plan = buildSetupPlan(base, answers)
    const s = step(plan, 'gemini-key')
    expect(s?.skipped).toBe(true)
    expect(s?.after).toBe('unchanged')
  })

  it('marks routing skipped when already on the recommended config', () => {
    // Must ask for the SAME routing the planner will choose for this fixture:
    // `base` has no Whisper, so the planner picks the caption route.
    const rec = recommendedRouting('none', { localTranscription: false })
    const plan = buildSetupPlan(
      { ...base, routing: { version: 3, lastSelectedProvider: 'gemini', perPhase: rec.perPhase } },
      answers,
    )
    expect(step(plan, 'routing')?.skipped).toBe(true)
  })

  it('is a complete no-op when everything is already in the desired state', () => {
    const rec = recommendedRouting('none', { localTranscription: false })
    const plan = buildSetupPlan(
      { ...base, routing: { version: 3, lastSelectedProvider: 'gemini', perPhase: rec.perPhase } },
      answers,
    )
    expect(planIsNoop(plan)).toBe(true)
    expect(plan.restartRequired).toBe(false)
  })

  it('marks an already-installed add-on as skipped', () => {
    const plan = buildSetupPlan(
      { ...base, addonsReady: { 'audio-addon': true } },
      { ...answers, installWhisper: true },
    )
    expect(step(plan, 'addon-audio-addon')?.skipped).toBe(true)
  })
})

describe('Whisper GPU gate', () => {
  it('BLOCKS installing Whisper with no GPU until the user accepts the cost', () => {
    // A blocker, not a warning: a 1.5 GB install that then takes hours per
    // session is the worst possible first experience, and clicking Next
    // through a wizard is not consent to it.
    const plan = buildSetupPlan(
      { ...base, gpu: { detected: false } },
      { ...answers, installWhisper: true },
    )
    expect(plan.blockers.join(' ')).toMatch(/several hours/i)
  })

  it('allows it once acknowledged', () => {
    const plan = buildSetupPlan(
      { ...base, gpu: { detected: false } },
      { ...answers, installWhisper: true, acceptedCpuWhisper: true },
    )
    expect(plan.blockers).toHaveLength(0)
  })

  it('never gates when a GPU is present', () => {
    const plan = buildSetupPlan(base, { ...answers, installWhisper: true })
    expect(plan.blockers).toHaveLength(0)
  })

  it('does not gate a Whisper install that is already done', () => {
    const plan = buildSetupPlan(
      { ...base, gpu: { detected: false }, addonsReady: { 'audio-addon': true } },
      { ...answers, installWhisper: true },
    )
    expect(plan.blockers).toHaveLength(0)
  })

  it('suggests the YouTube route when Whisper is skipped on a GPU-less machine', () => {
    const plan = buildSetupPlan({ ...base, gpu: { detected: false } }, answers)
    expect(plan.warnings.join(' ')).toMatch(/YouTube/i)
    expect(plan.warnings.join(' ')).toMatch(/no speaker labels/i)
  })
})

describe('Obsidian vault', () => {
  it('records the chosen folder without an enable step', () => {
    // The Obsidian lore source is part of the app now — there is no add-on
    // to enable, only a folder to point at.
    const plan = buildSetupPlan(base, { ...answers, vaultPath: 'D:/Vault' })
    expect(step(plan, 'addon-obsidian-vault-addon')).toBeUndefined()
    expect(step(plan, 'vault-path')?.after).toBe('D:/Vault')
  })

  it('adds a conversion step only when documents were selected', () => {
    const without = buildSetupPlan(base, { ...answers, vaultPath: 'D:/Vault' })
    expect(step(without, 'vault-convert')).toBeUndefined()

    const withDocs = buildSetupPlan(base, {
      ...answers,
      vaultPath: 'D:/Vault',
      convertDocs: ['Lore/Gods.docx', 'Notes/Session 1.pdf'],
    })
    const s = step(withDocs, 'vault-convert')
    expect(s?.label).toMatch(/2 documents/)
    // The promise that makes this safe to offer at all.
    expect(s?.detail).toMatch(/never modified/i)
    expect(s?.detail).toMatch(/never overwritten/i)
  })

  it('adds no vault steps when no folder was chosen', () => {
    const plan = buildSetupPlan(base, answers)
    expect(plan.steps.some((s) => s.kind === 'vault' || s.kind === 'convert')).toBe(false)
  })

  it('does not require a restart to adopt a vault lore source', () => {
    // The obsidian routes are always mounted; choosing a vault is pure
    // configuration.
    const plan = buildSetupPlan(base, { ...answers, vaultPath: 'D:/Vault' })
    expect(plan.restartRequired).toBe(false)
  })
})

describe('warnings', () => {
  it('warns before replacing existing custom routing', () => {
    const plan = buildSetupPlan(
      {
        ...base,
        routing: {
          version: 3,
          lastSelectedProvider: 'claudeCode',
          perPhase: { phase3: { target: 'cloud', cloudProvider: 'claudeCode', modelId: 'claude-opus-4-8' } },
        },
      },
      answers,
    )
    expect(plan.warnings.join(' ')).toMatch(/replaces it/i)
    expect(step(plan, 'routing')?.before).toMatch(/custom per-phase routing/)
  })

  it('points out the cheaper subscription path when one is available but declined', () => {
    const plan = buildSetupPlan({ ...base, cli: withClaudeCode }, answers)
    expect(plan.warnings.join(' ')).toMatch(/Claude Code is installed and signed in/i)
    expect(plan.warnings.join(' ')).toMatch(/allowance you already pay for/i)
  })

  // CPU-only Whisper was a warning here originally. It is now a hard blocker
  // requiring explicit acknowledgement — see the "Whisper GPU gate" block.
})

describe('restart handling', () => {
  it('a subscription CLI needs no enable step and no restart', () => {
    // The CLI bridges are part of the app; detection is the only gate.
    const plan = buildSetupPlan(
      { ...base, cli: withClaudeCode },
      { ...answers, subscription: 'claudeCode' },
    )
    expect(plan.steps.some((s) => s.kind === 'addon')).toBe(false)
    expect(plan.restartRequired).toBe(false)
  })

  it('still requires a restart when Whisper is newly installed', () => {
    // Audio transcription is the one genuine install — its routes mount at
    // startup, so a fresh install cannot serve traffic in this process.
    const plan = buildSetupPlan(base, { ...answers, installWhisper: true })
    expect(step(plan, 'addon-audio-addon')?.skipped).toBe(false)
    expect(plan.restartRequired).toBe(true)
  })

  it('does not require a restart for a routing-only change', () => {
    const plan = buildSetupPlan(base, answers)
    expect(plan.steps.some((s) => s.kind === 'addon')).toBe(false)
    expect(plan.restartRequired).toBe(false)
  })
})

describe('recommendedRouting', () => {
  it('routes mechanical phases to the subscription and prose to Gemini', () => {
    const { perPhase } = recommendedRouting('claudeCode')
    expect(perPhase.phase1).toMatchObject({ cloudProvider: 'claudeCode' })
    expect(perPhase.phase2).toMatchObject({ cloudProvider: 'claudeCode' })
    expect(perPhase.phase3).toMatchObject({ cloudProvider: 'gemini' })
    expect(perPhase.phase6).toMatchObject({ cloudProvider: 'gemini' })
  })

  it('falls back to Gemini everywhere with no subscription', () => {
    const { perPhase, savingPct } = recommendedRouting('none')
    for (const entry of Object.values(perPhase)) {
      expect(entry).toMatchObject({ cloudProvider: 'gemini' })
    }
    expect(savingPct).toBeGreaterThan(0)
  })

  it('quotes a bigger saving for the subscription path than Gemini-only', () => {
    expect(recommendedRouting('claudeCode').savingPct).toBeGreaterThan(
      recommendedRouting('none').savingPct,
    )
  })
})

describe('caption route — no local transcription', () => {
  // Without Whisper the user is importing YouTube captions, which carry no
  // speaker labels. Phase 1 has to infer who spoke and Phase 2 has to ask when
  // it can't, so both need Pro. Flash under-asks: it guesses an attribution
  // and moves on, and a confidently wrong speaker is worse than a question.
  it('puts Gemini Pro on every judgement phase', () => {
    const { perPhase } = recommendedRouting('none', { localTranscription: false })
    for (const phase of ['phase1', 'phase2', 'phase3', 'phase6'] as const) {
      expect(perPhase[phase]).toMatchObject({ cloudProvider: 'gemini', modelId: 'gemini-pro-latest' })
    }
  })

  it('leaves Flash on extras, which is extraction rather than inference', () => {
    const { perPhase } = recommendedRouting('none', { localTranscription: false })
    expect(perPhase.phase4).toMatchObject({ modelId: 'gemini-flash-latest' })
  })

  it('overrides the subscription preset — attribution outranks cost here', () => {
    // Even with Claude Code available, the caption route wins: a cheap run
    // that misattributes half the dialogue is not a saving.
    const { perPhase } = recommendedRouting('claudeCode', { localTranscription: false })
    expect(perPhase.phase1).toMatchObject({ cloudProvider: 'gemini' })
  })

  it('does not apply when transcription is local', () => {
    const { perPhase } = recommendedRouting('none', { localTranscription: true })
    expect(perPhase.phase1).toMatchObject({ modelId: 'gemini-flash-latest' })
  })

  it('is selected by the planner when Whisper is neither present nor being installed', () => {
    const plan = buildSetupPlan(base, answers)
    const routing = plan.steps.find((s) => s.id === 'routing')
    expect(routing?.detail).toMatch(/Gemini Pro on grounding/i)
  })

  it('is NOT selected when Whisper is already installed', () => {
    const plan = buildSetupPlan(
      { ...base, addonsReady: { 'audio-addon': true } },
      answers,
    )
    expect(plan.steps.find((s) => s.id === 'routing')?.detail).not.toMatch(/Gemini Pro on grounding/i)
  })

  it('is NOT selected when Whisper is being installed in this run', () => {
    const plan = buildSetupPlan(base, { ...answers, installWhisper: true })
    expect(plan.steps.find((s) => s.id === 'routing')?.detail).not.toMatch(/Gemini Pro on grounding/i)
  })
})
