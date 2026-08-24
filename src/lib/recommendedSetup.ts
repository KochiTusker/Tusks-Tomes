// Planning logic for the Recommended Setup wizard.
//
// Kept as pure functions, separate from the dialog, for one reason: this is
// the part that can quietly destroy a user's configuration. The wizard writes
// API keys, installs add-ons, and REPLACES the per-phase routing document. A
// bug that silently clobbers a carefully-tuned routing setup is far worse than
// a bug that renders a step wrong, so the decision layer is testable in
// isolation and the React layer stays a thin renderer over it.
//
// The contract the UI relies on:
//   buildSetupPlan(current, answers) -> a list of steps, each with an explicit
//   before/after. Nothing is applied until the user confirms the plan, and
//   steps already in the desired state come back `skipped` rather than being
//   silently re-applied.
//
// The recommended configuration is the one the project's own A/B testing
// converged on (see budgetMode.ts): subscription CLI for the mechanical
// phases, latest paid Gemini Flash for the prose phases. When there's no
// subscription it degrades to Gemini-only measured hybrid.

import {
  buildGeminiCaptionRoutePerPhase,
  buildGeminiMeasuredHybridPerPhase,
  buildMeasuredHybridSubPerPhase,
  GEMINI_MEASURED_HYBRID_SAVING_PCT,
  MEASURED_HYBRID_SUB_SAVING_PCT,
  type SubscriptionTarget,
} from '@/lib/budgetMode'
import type { RoutingDocument } from '@/lib/routing'

/** One subscription CLI as reported by GET /api/system/cli-detect. */
export type CliProbe = {
  installed: boolean
  version: string | null
  authenticated: boolean
  loaded: boolean
}

export type CliDetect = {
  claudeCode: CliProbe
  codex: CliProbe
  restartRequired: boolean
}

/** Everything the planner reads. Assembled by the wizard from the existing
 *  endpoints; passed in whole so the planner does no fetching itself. */
export type CurrentSetup = {
  /** Is a paid Gemini key already stored in the keystore? */
  geminiConfigured: boolean
  routing: RoutingDocument | null
  /** addon name -> installed/ready. */
  addonsReady: Record<string, boolean>
  cli: CliDetect
  gpu: { detected: boolean; name?: string; vramGb?: number }
  /** Optional: the python the Whisper installer would use. Absent when the
   *  system probe failed — treated as "could not check", never as a pass
   *  or a fail. */
  python?: { found: boolean; version: string | null; supported: boolean }
}

export type SetupAnswers = {
  /** A newly-entered key, or null to keep whatever is already stored. */
  geminiKey: string | null
  /** Install the Whisper sidecar (~1.5 GB venv). */
  installWhisper: boolean
  /** Explicit acknowledgement that CPU-only transcription takes hours.
   *  Required before Whisper installs on a machine with no dedicated GPU —
   *  otherwise the most common first experience is a "broken" 3-hour wait. */
  acceptedCpuWhisper: boolean
  /** Which subscription CLI to route the mechanical phases through. */
  subscription: SubscriptionTarget | 'none'
  /** Absolute path to the folder to treat as an Obsidian vault, or null to
   *  skip lore grounding entirely. */
  vaultPath: string | null
  /** Vault-relative paths of .docx/.pdf files to convert to sibling .md.
   *  Explicit list, never "everything" — see server/api/obsidian.ts. */
  convertDocs: string[]
}

export type PlanStepKind = 'key' | 'addon' | 'routing' | 'vault' | 'convert'

export type PlanStep = {
  id: string
  kind: PlanStepKind
  label: string
  /** What the wizard will actually do, in plain language. */
  detail: string
  before: string
  after: string
  /** Already in the desired state — shown greyed, not applied. */
  skipped: boolean
}

export type SetupPlan = {
  steps: PlanStep[]
  /** Blocking problems: the plan cannot be applied until these are resolved. */
  blockers: string[]
  /** Non-blocking things the user should know before confirming. */
  warnings: string[]
  /** True when applying the plan needs a server restart to take effect. */
  restartRequired: boolean
  /** Rough saving vs the Maximum Quality baseline, for the summary line. */
  savingPct: number
}

export const WHISPER_ADDON = 'audio-addon'

/** Which add-on backs a subscription target. */
const SUB_LABEL: Record<SubscriptionTarget, string> = {
  claudeCode: 'Claude Code',
  codex: 'Codex',
}

/** Pick the subscription the wizard should offer by default: one that is both
 *  installed AND logged in. Claude Code wins ties only because it is the arm
 *  that has actually been validated end-to-end. Returns 'none' when neither
 *  is usable, so the wizard never proposes a provider that will 401. */
export function detectBestSubscription(cli: CliDetect): SubscriptionTarget | 'none' {
  if (cli.claudeCode.installed && cli.claudeCode.authenticated) return 'claudeCode'
  if (cli.codex.installed && cli.codex.authenticated) return 'codex'
  return 'none'
}

/** Human summary of one CLI's state, used for the "we detected…" line. */
export function describeCli(name: SubscriptionTarget, probe: CliProbe): string {
  const label = SUB_LABEL[name]
  if (!probe.installed) return `${label}: not found on PATH`
  if (!probe.authenticated) {
    // Phrased as "couldn't confirm" deliberately: detection is a credentials-
    // file presence check, not an authoritative auth query.
    return `${label} ${probe.version ?? ''} found, but a logged-in session couldn't be confirmed`.replace(
      /\s+/g,
      ' ',
    )
  }
  return `${label} ${probe.version ?? ''} found and signed in`.replace(/\s+/g, ' ')
}

function describeRouting(routing: RoutingDocument | null): string {
  const perPhase = routing?.perPhase
  if (!perPhase || Object.keys(perPhase).length === 0) {
    return routing?.lastSelectedProvider
      ? `${routing.lastSelectedProvider} for every phase (no per-phase overrides)`
      : 'not configured'
  }
  const providers = new Set<string>()
  for (const entry of Object.values(perPhase)) {
    if (!entry) continue
    providers.add(entry.target === 'local' ? 'local' : (entry.cloudProvider ?? 'inherit'))
  }
  return `custom per-phase routing (${[...providers].sort().join(' + ')})`
}

/** Deep-equality over the routing shape we care about. Used to mark the
 *  routing step `skipped` when the user is already on the recommended config,
 *  so re-running the wizard is a no-op rather than a pointless rewrite. */
function sameRouting(
  a: RoutingDocument['perPhase'] | undefined,
  b: RoutingDocument['perPhase'] | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Compute the recommended per-phase routing for the chosen subscription.
 * Exported so the wizard can preview it and tests can pin it.
 */
export function recommendedRouting(
  subscription: SubscriptionTarget | 'none',
  opts: { localTranscription?: boolean } = {},
): { perPhase: NonNullable<RoutingDocument['perPhase']>; savingPct: number; label: string } {
  // No local transcription means YouTube captions, which carry no speaker
  // labels — so the model has to infer who spoke and ask when it can't. That
  // is a Pro-tier job, and it outranks the cost presets: a cheap run that
  // silently misattributes half the dialogue isn't a saving.
  if (opts.localTranscription === false) {
    return {
      perPhase: buildGeminiCaptionRoutePerPhase(),
      // Pro on four of five phases, so barely cheaper than the baseline.
      savingPct: 15,
      label: 'Gemini Pro on grounding, audit, chronicle and condense; Flash on extras',
    }
  }
  if (subscription === 'none') {
    // No subscription: the best measured Gemini-only configuration.
    const perPhase = buildGeminiMeasuredHybridPerPhase('gemini')
    return {
      perPhase: perPhase ?? {},
      savingPct: GEMINI_MEASURED_HYBRID_SAVING_PCT,
      label: 'Latest paid Gemini Flash on every phase (thinking on)',
    }
  }
  return {
    perPhase: buildMeasuredHybridSubPerPhase(subscription),
    savingPct: MEASURED_HYBRID_SUB_SAVING_PCT,
    label: `${SUB_LABEL[subscription]} for grounding + audit, paid Gemini Flash for the prose phases`,
  }
}

/**
 * Build the change plan. Pure: reads `current`, returns what *would* happen.
 *
 * Every step carries before/after so the confirm screen can show a real diff
 * rather than a vague "this will configure things for you".
 */
export function buildSetupPlan(current: CurrentSetup, answers: SetupAnswers): SetupPlan {
  const steps: PlanStep[] = []
  const blockers: string[] = []
  const warnings: string[] = []

  // --- Gemini key -----------------------------------------------------------
  const willHaveGemini = current.geminiConfigured || Boolean(answers.geminiKey?.trim())
  if (answers.geminiKey?.trim()) {
    steps.push({
      id: 'gemini-key',
      kind: 'key',
      label: 'Save the paid Gemini API key',
      detail: 'Stored encrypted (AES-256-GCM, machine-bound) and verified with a test call.',
      before: current.geminiConfigured ? 'a Gemini key is already stored' : 'no Gemini key stored',
      after: current.geminiConfigured ? 'replaced with the new key' : 'key stored and verified',
      skipped: false,
    })
  } else if (current.geminiConfigured) {
    steps.push({
      id: 'gemini-key',
      kind: 'key',
      label: 'Paid Gemini API key',
      detail: 'A key is already stored — leaving it untouched.',
      before: 'key stored',
      after: 'unchanged',
      skipped: true,
    })
  }

  // Every recommended routing uses Gemini for the prose phases, so without a
  // key there is nothing coherent to apply.
  if (!willHaveGemini) {
    blockers.push(
      'A paid Gemini API key is required — every recommended routing uses Gemini for the chronicle phases.',
    )
  }

  // --- Subscription ---------------------------------------------------------
  const sub = answers.subscription
  if (sub !== 'none') {
    const probe = sub === 'claudeCode' ? current.cli.claudeCode : current.cli.codex

    if (!probe.installed) {
      blockers.push(
        `${SUB_LABEL[sub]} isn't on PATH. Install the CLI first, or choose the Gemini-only setup.`,
      )
    } else if (!probe.authenticated) {
      blockers.push(
        `${SUB_LABEL[sub]} is installed but no logged-in session could be confirmed. ` +
          `Run \`${sub === 'claudeCode' ? 'claude' : 'codex'} login\`, then re-run this wizard.`,
      )
    }

    // No enable step: the CLI bridge is part of the app. Detection (above)
    // is the only gate — if the CLI is installed and signed in, routing to
    // it just works.
  } else {
    // The cheaper path exists and they aren't taking it — say so once, plainly.
    const available = detectBestSubscription(current.cli)
    if (available !== 'none') {
      warnings.push(
        `${SUB_LABEL[available]} is installed and signed in on this machine. Routing the mechanical ` +
          `phases through it would use allowance you already pay for instead of per-token API credit — ` +
          `roughly ${MEASURED_HYBRID_SUB_SAVING_PCT}% cheaper than the baseline, versus ` +
          `${GEMINI_MEASURED_HYBRID_SAVING_PCT}% for the Gemini-only setup.`,
      )
    } else {
      warnings.push(
        'Everything will run on your Gemini API key, billed per token. If you have a Claude or ChatGPT ' +
          'subscription, installing that CLI and re-running this wizard would use allowance you already ' +
          'pay for instead.',
      )
    }
  }

  // --- Obsidian vault -------------------------------------------------------
  if (answers.vaultPath) {
    steps.push({
      id: 'vault-path',
      kind: 'vault',
      label: 'Point the lore source at your folder',
      detail: answers.vaultPath,
      before: 'no vault configured',
      after: answers.vaultPath,
      skipped: false,
    })
    if (answers.convertDocs.length > 0) {
      steps.push({
        id: 'vault-convert',
        kind: 'convert',
        label: `Make markdown copies of ${answers.convertDocs.length} document${answers.convertDocs.length === 1 ? '' : 's'}`,
        detail:
          'Grounding only reads .md files, so Word and PDF notes are invisible to it. This writes a .md ' +
          'copy next to each original. Originals are never modified, and an existing .md is never overwritten.',
        before: `${answers.convertDocs.length} document(s) not readable by grounding`,
        after: 'markdown copies created alongside the originals',
        skipped: false,
      })
    }
  }

  // --- Whisper --------------------------------------------------------------
  if (answers.installWhisper) {
    const ready = current.addonsReady[WHISPER_ADDON] === true
    // Python gate first, and absolute: a known-unsupported python means the
    // install downloads ~1.5 GB and then fails at the torch wheels. There is
    // nothing to acknowledge — it cannot succeed. An absent probe (python
    // undefined) is "could not check" and does not block.
    if (!ready && current.python && !current.python.supported) {
      blockers.push(
        current.python.found
          ? `Python ${current.python.version} was found, but Whisper needs 3.10–3.12 — the install ` +
            'would download ~1.5 GB and then fail. Install Python 3.12 from python.org (make it the ' +
            'version `python` runs), then re-run this wizard.'
          : 'Python was not found on this computer, and Whisper is written in Python. Install ' +
            "Python 3.12 from python.org (tick 'Add Python to PATH'), then re-run this wizard.",
      )
    }
    // Hard gate rather than a warning. Installing a 1.5 GB dependency that
    // then takes hours per session is the worst possible first experience,
    // and someone who clicked through a wizard has not consented to it.
    if (!ready && !current.gpu.detected && !answers.acceptedCpuWhisper) {
      blockers.push(
        'No dedicated GPU was detected, so Whisper would transcribe using your processor — a three-hour ' +
          'session can take several hours instead of 20–30 minutes. Tick the box to accept that, or skip ' +
          'Whisper and use the YouTube caption route instead.',
      )
    }
    steps.push({
      id: `addon-${WHISPER_ADDON}`,
      kind: 'addon',
      label: 'Install Audio Transcription (Whisper)',
      detail:
        'Creates a Python virtual environment under vendor/python-venv and downloads the speech-to-text ' +
        'model (~1.5–2.5 GB). Nothing is installed outside this folder, no Administrator rights are ' +
        'needed, and uninstalling removes all of it.',
      before: ready ? 'already installed' : 'not installed',
      after: ready ? 'unchanged' : 'installed into vendor/python-venv',
      skipped: ready,
    })
  } else if (!current.gpu.detected) {
    // Not installing Whisper on a GPU-less machine is the right call — say so
    // rather than leaving them wondering what they missed.
    warnings.push(
      'Skipping Whisper is the right choice without a dedicated GPU. Record the session, upload it to ' +
        'YouTube as unlisted, and import the captions instead — YouTube does the transcription on its ' +
        'hardware. Note that route carries no speaker labels, so expect to answer more questions.',
    )
  }

  // --- Routing --------------------------------------------------------------
  // Whisper present (already installed, or being installed now) means local
  // transcription with speaker tracks. Its absence means the caption route,
  // which needs a stronger model to reconstruct speakers.
  const localTranscription =
    answers.installWhisper || current.addonsReady[WHISPER_ADDON] === true
  const rec = recommendedRouting(sub, { localTranscription })
  const routingSame = sameRouting(current.routing?.perPhase, rec.perPhase)
  steps.push({
    id: 'routing',
    kind: 'routing',
    label: 'Apply the recommended per-phase routing',
    detail: rec.label,
    before: describeRouting(current.routing),
    after: routingSame ? 'unchanged' : rec.label,
    skipped: routingSame,
  })
  if (!routingSame && current.routing?.perPhase && Object.keys(current.routing.perPhase).length > 0) {
    warnings.push(
      'You already have custom per-phase routing. Applying this plan replaces it — the before/after above ' +
        'shows exactly what changes.',
    )
  }

  // A restart is unavoidable when an add-on is newly enabled: add-on routes are
  // mounted once at startup (server/addons/loader.ts), never mid-session.
  const restartRequired = steps.some((s) => s.kind === 'addon' && !s.skipped)

  return { steps, blockers, warnings, restartRequired, savingPct: rec.savingPct }
}

/** Does the plan actually change anything? Used to disable the Apply button
 *  when a re-run is a complete no-op. */
export function planIsNoop(plan: SetupPlan): boolean {
  return plan.steps.every((s) => s.skipped)
}
