// Routing config. `lastSelectedProvider` + `geminiTier` are the session-wide
// defaults. `perPhase` overrides any individual phase — each entry can carry
// its own (provider, tier, model) tuple so users can mix Claude phase 1 with
// Gemini phase 3 etc. Cross-provider hybrid is independent of the local-llm
// add-on: it ships with the core install.
//
// PUT validates strictly: invalid lastSelectedProvider / geminiTier / unknown
// schema version → HTTP 400 with structured error (so the client toast can
// say exactly which field was wrong). Unknown modelId → HTTP 200 with a
// `warnings` array (the user may be probing an unreleased model, but they
// need to know the pipeline will fail at the LLM call if it's a typo).
// Reads use sanitize() defensively to tolerate older on-disk shapes.

import express, { type Router } from 'express'
import { readJson, routingFile, writeJson } from '../appData.js'
import { slog } from '../lib/slog.js'

type CloudProvider = 'gemini' | 'claude' | 'openai' | 'claudeCode' | 'codex'
type GeminiTier = 'paid' | 'free' | 'auto'

const CURRENT_VERSION = 3 as const
const ALLOWED_VERSIONS = [1, 2, 3] as const
const ALLOWED_PROVIDERS = ['gemini', 'claude', 'openai', 'claudeCode', 'codex'] as const
const ALLOWED_TIERS = ['paid', 'free', 'auto'] as const
const ALLOWED_TARGETS = ['cloud', 'local'] as const
const PHASE_KEYS = ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'] as const

// Known model IDs per cloud provider. Mirrors src/lib/pricing.ts (the
// browser-side source of truth for cost estimation) — edit BOTH when
// adding a new model. The list is intentionally non-blocking: unknown
// modelId surfaces as a 200-with-warning, not a 400, because users may
// configure newer models the server hasn't been updated to recognise.
// The warning still appears in the diagnose bundle, so a pipeline call
// that fails on "model not found" downstream is traceable to the routing
// PUT that introduced the typo.
const KNOWN_MODELS: Record<CloudProvider, ReadonlySet<string>> = {
  gemini: new Set([
    // Floating aliases — always resolve to the newest model in the tier.
    // Pricing is per TIER not per generation, so tracking latest is free.
    'gemini-pro-latest',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    // Pinned ids (verified present on the ListModels API 2026-08).
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview',
    'gemini-3-pro',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
  ]),
  claude: new Set([
    'claude-opus-4-7',
    'claude-opus-4-1',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
  ]),
  openai: new Set([
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
  ]),
  claudeCode: new Set([
    'sonnet',
    'opus',
    'haiku',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ]),
  codex: new Set([
    'default',
    'gpt-5-codex',
    'gpt-5',
    'gpt-5-mini',
    'o3',
  ]),
}

/** Known-model check with a tier heuristic for Gemini.
 *
 *  The pinned list above WILL drift — Google ships new ids continuously, and
 *  the app deliberately routes to floating `-latest` aliases. Warning on
 *  every unrecognised id trained users to ignore the warning, so Gemini ids
 *  that clearly name a tier (pro / flash / lite) are accepted even when
 *  unpinned. Mirrors src/lib/routingValidation.ts:isKnownPricedModel, which
 *  has always behaved this way client-side — the two disagreeing is what
 *  produced spurious warnings when a preset applied. Other providers keep
 *  strict matching: their ids don't carry a parseable tier. */
function isKnownModel(provider: CloudProvider, modelId: string): boolean {
  if (KNOWN_MODELS[provider].has(modelId)) return true
  if (provider === 'gemini') {
    const m = modelId.toLowerCase()
    return m.includes('lite') || m.includes('flash') || m.includes('pro')
  }
  return false
}

type PhaseRouteEntry =
  | {
      target: 'cloud'
      cloudProvider?: CloudProvider
      geminiTier?: GeminiTier
      modelId?: string
    }
  | { target: 'local'; modelId: string; baseUrl?: string }

export type RoutingDocument = {
  version: 1 | 2 | 3
  lastSelectedProvider: CloudProvider | null
  geminiTier?: GeminiTier
  perPhase?: {
    phase1?: PhaseRouteEntry
    phase2?: PhaseRouteEntry
    phase3?: PhaseRouteEntry
    phase4?: PhaseRouteEntry
    phase6?: PhaseRouteEntry
  }
}

const SEED: RoutingDocument = {
  version: 3,
  lastSelectedProvider: null,
}

function isCloudProvider(v: unknown): v is CloudProvider {
  return v === 'gemini' || v === 'claude' || v === 'openai' || v === 'claudeCode' || v === 'codex'
}

function isGeminiTier(v: unknown): v is GeminiTier {
  return v === 'paid' || v === 'free' || v === 'auto'
}

function sanitizeEntry(raw: unknown): PhaseRouteEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const entry = raw as Partial<PhaseRouteEntry> & Record<string, unknown>
  if (entry.target === 'local') {
    const modelId = typeof entry.modelId === 'string' ? entry.modelId : ''
    if (!modelId) return undefined
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined
    return { target: 'local', modelId, baseUrl }
  }
  if (entry.target === 'cloud') {
    const out: PhaseRouteEntry = { target: 'cloud' }
    if (isCloudProvider(entry.cloudProvider)) out.cloudProvider = entry.cloudProvider
    if (isGeminiTier(entry.geminiTier)) out.geminiTier = entry.geminiTier
    if (typeof entry.modelId === 'string' && entry.modelId.length > 0) {
      out.modelId = entry.modelId
    }
    return out
  }
  return undefined
}

function sanitize(input: unknown): RoutingDocument {
  const raw = (input ?? {}) as Partial<RoutingDocument> & Record<string, unknown>
  const last = raw.lastSelectedProvider
  const tier = raw.geminiTier
  const perPhaseRaw = (raw.perPhase ?? {}) as Record<string, unknown>
  const perPhase: NonNullable<RoutingDocument['perPhase']> = {}
  for (const k of PHASE_KEYS) {
    const entry = sanitizeEntry(perPhaseRaw[k])
    if (entry) perPhase[k] = entry
  }
  return {
    version: raw.version === 3 ? 3 : raw.version === 2 ? 2 : 1,
    lastSelectedProvider: isCloudProvider(last) ? last : null,
    geminiTier: isGeminiTier(tier) ? tier : undefined,
    perPhase: Object.keys(perPhase).length > 0 ? perPhase : undefined,
  }
}

/** Structured 400 body returned by the PUT handler when a field fails
 *  strict validation. The client toast renders `error` verbatim and the
 *  diagnose bundle captures the full body so a fresh Claude session can
 *  trace the rejected request back to its origin. */
export interface RoutingValidationError {
  error: string
  field: string
  allowedValues?: readonly (string | number | null)[]
  received?: unknown
}

type ValidateResult =
  | { ok: false; status: 400; body: RoutingValidationError }
  | { ok: true; warnings: string[] }

function fail(body: RoutingValidationError): ValidateResult {
  return { ok: false, status: 400, body }
}

/** Strict pre-write validation. Hard failures (invalid enum values,
 *  newer-than-server schema version, malformed perPhase shape) return
 *  400. Soft failures (modelId not in KNOWN_MODELS, possibly because
 *  the user is configuring a not-yet-released model) return as warnings
 *  on a 200. Reads stay lenient (sanitize) so older on-disk shapes still
 *  load — only the writer enforces the new contract. */
function validateInput(input: unknown): ValidateResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail({
      error: 'Request body must be a JSON object',
      field: '_root',
      received: typeof input,
    })
  }
  const raw = input as Record<string, unknown>
  const warnings: string[] = []

  if (raw.version !== undefined) {
    const v = raw.version
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return fail({
        error: 'Invalid version: must be 1, 2, or 3',
        field: 'version',
        allowedValues: ALLOWED_VERSIONS,
        received: v,
      })
    }
    if (v > CURRENT_VERSION) {
      return fail({
        error: `Routing schema version ${v} is from a newer client than this server (current: ${CURRENT_VERSION}). Update the server: pull, then re-run npm run dev.`,
        field: 'version',
        allowedValues: ALLOWED_VERSIONS,
        received: v,
      })
    }
    if (v !== 1 && v !== 2 && v !== 3) {
      return fail({
        error: `Invalid version: must be 1, 2, or 3 (got ${v})`,
        field: 'version',
        allowedValues: ALLOWED_VERSIONS,
        received: v,
      })
    }
  }

  if (raw.lastSelectedProvider !== undefined && raw.lastSelectedProvider !== null) {
    if (!isCloudProvider(raw.lastSelectedProvider)) {
      return fail({
        error: `Invalid lastSelectedProvider: '${String(raw.lastSelectedProvider)}'. Allowed: gemini, claude, openai, claudeCode, codex (or null to clear).`,
        field: 'lastSelectedProvider',
        allowedValues: [...ALLOWED_PROVIDERS, null],
        received: raw.lastSelectedProvider,
      })
    }
  }

  if (raw.geminiTier !== undefined && raw.geminiTier !== null) {
    if (!isGeminiTier(raw.geminiTier)) {
      return fail({
        error: `Invalid geminiTier: '${String(raw.geminiTier)}'. Allowed: paid, free, auto.`,
        field: 'geminiTier',
        allowedValues: ALLOWED_TIERS,
        received: raw.geminiTier,
      })
    }
  }

  if (raw.perPhase !== undefined && raw.perPhase !== null) {
    if (typeof raw.perPhase !== 'object' || Array.isArray(raw.perPhase)) {
      return fail({
        error: 'perPhase must be an object keyed by phase id (phase1, phase2, …)',
        field: 'perPhase',
        received: raw.perPhase,
      })
    }
    const perPhaseRaw = raw.perPhase as Record<string, unknown>
    for (const k of PHASE_KEYS) {
      const entry = perPhaseRaw[k]
      if (entry === undefined || entry === null) continue
      if (typeof entry !== 'object' || Array.isArray(entry)) {
        return fail({
          error: `perPhase.${k} must be an object`,
          field: `perPhase.${k}`,
          received: entry,
        })
      }
      const e = entry as Record<string, unknown>
      if (e.target !== 'cloud' && e.target !== 'local') {
        return fail({
          error: `perPhase.${k}.target must be 'cloud' or 'local' (got '${String(e.target)}')`,
          field: `perPhase.${k}.target`,
          allowedValues: ALLOWED_TARGETS,
          received: e.target,
        })
      }
      if (e.target === 'cloud') {
        if (e.cloudProvider !== undefined && e.cloudProvider !== null && !isCloudProvider(e.cloudProvider)) {
          return fail({
            error: `Invalid perPhase.${k}.cloudProvider: '${String(e.cloudProvider)}'. Allowed: gemini, claude, openai, claudeCode, codex.`,
            field: `perPhase.${k}.cloudProvider`,
            allowedValues: ALLOWED_PROVIDERS,
            received: e.cloudProvider,
          })
        }
        if (e.geminiTier !== undefined && e.geminiTier !== null && !isGeminiTier(e.geminiTier)) {
          return fail({
            error: `Invalid perPhase.${k}.geminiTier: '${String(e.geminiTier)}'. Allowed: paid, free, auto.`,
            field: `perPhase.${k}.geminiTier`,
            allowedValues: ALLOWED_TIERS,
            received: e.geminiTier,
          })
        }
        if (typeof e.modelId === 'string' && e.modelId.length > 0) {
          // Resolve effective provider: explicit perPhase.cloudProvider
          // overrides; otherwise inherit lastSelectedProvider from the
          // top-level doc.
          const effectiveProvider: CloudProvider | null = isCloudProvider(e.cloudProvider)
            ? e.cloudProvider
            : isCloudProvider(raw.lastSelectedProvider)
              ? raw.lastSelectedProvider
              : null
          if (effectiveProvider && !isKnownModel(effectiveProvider, e.modelId)) {
            const sample = [...KNOWN_MODELS[effectiveProvider]].slice(0, 4).join(', ')
            warnings.push(
              `perPhase.${k}.modelId '${e.modelId}' is not in the known-models list for ${effectiveProvider}. Pipeline runs may fail at the LLM call if this is a typo. Known IDs include: ${sample}.`,
            )
          }
        }
      } else {
        // target === 'local'
        if (typeof e.modelId !== 'string' || e.modelId.length === 0) {
          return fail({
            error: `perPhase.${k}.modelId is required when target is 'local'`,
            field: `perPhase.${k}.modelId`,
            received: e.modelId,
          })
        }
      }
    }
  }

  return { ok: true, warnings }
}

async function loadOrSeed(): Promise<RoutingDocument> {
  const file = routingFile()
  const existing = await readJson<RoutingDocument | null>(file, null)
  if (existing) return sanitize(existing)
  await writeJson(file, SEED)
  return SEED
}

export function routingRouter(): Router {
  const router = express.Router()

  router.get('/', async (_req, res) => {
    try {
      const doc = await loadOrSeed()
      res.json(doc)
    } catch (err) {
      console.error('[api/routing GET] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.put('/', async (req, res) => {
    try {
      const validated = validateInput(req.body)
      if (!validated.ok) {
        slog('routing', {
          event: 'putRouting_rejected',
          field: validated.body.field,
          received: validated.body.received,
        })
        res.status(validated.status).json(validated.body)
        return
      }
      const sanitized = sanitize(req.body)
      await writeJson(routingFile(), sanitized)
      // Surface the routing change in the diagnostic stream — equivalent
      // events on the browser side fire from sessions.ts:buildSession,
      // but the disk write is what's load-bearing for the failover dance.
      slog('routing', {
        event: 'putRouting',
        lastSelectedProvider: sanitized.lastSelectedProvider,
        geminiTier: sanitized.geminiTier,
        perPhaseKeys: sanitized.perPhase ? Object.keys(sanitized.perPhase) : [],
        warnings: validated.warnings.length > 0 ? validated.warnings : undefined,
      })
      const response: RoutingDocument & { warnings?: string[] } = { ...sanitized }
      if (validated.warnings.length > 0) response.warnings = validated.warnings
      res.json(response)
    } catch (err) {
      console.error('[api/routing PUT] failed:', err)
      slog('routing', { event: 'putRouting_error', error: (err as Error).message })
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
