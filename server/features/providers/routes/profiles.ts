// Per-provider model profiles. Each profile specifies which model handles
// each phase (1-4). Step 15 may add per-phase local-LLM routing on top,
// but profiles themselves are about "which model does this cloud provider
// use for this phase."
//
// PUT mirrors routing.ts: hard-shape errors (non-object body, unknown
// schema version) → 400; unknown modelIds → 200 with a `warnings` field
// so the user sees a toast before the pipeline call fails with
// "model not found".

import express, { type Router } from 'express'
import { profilesFile } from '../../../platform/appData.js'
import { createDocumentStore } from '../../../platform/documentStore.js'
import { slog } from '../../../platform/slog.js'
import { acceptModel, loadAvailabilityCache, warningFor } from '../services/knownModels.js'
import type { LegacyCloudProvider } from '../services/knownModels.js'
import type { AvailabilityCache } from './modelProbe.js'
import type { ProfilesDocument as SharedProfilesDocument, ProviderProfile } from '../../../../shared/contracts/profiles.js'
import { GEMINI_FLASH, GEMINI_PRO, OPENROUTER_GPT_OSS_120B } from '../../../../shared/models/catalogue.js'
import { asyncRoute } from '../../../platform/asyncRoute.js'

// Model recognition is shared with routing.ts via server/features/providers/services/knownModels.ts.
// It used to be a hand-maintained copy of that file's list, with a comment
// telling the next editor to update both. Neither copy consulted the probe,
// so a model the probe had verified against the user's key still warned here.
const PROVIDER_KEYS = [
  'gemini',
  'claude',
  'openai',
  'claudeCode',
  'codex',
  'openrouter',
] as const satisfies readonly LegacyCloudProvider[]
const PROFILE_PHASE_FIELDS = ['phase1Model', 'phase2Model', 'phase3Model', 'phase4Model', 'phase6Model'] as const

export type { ProviderProfile }
/** The on-disk document still carries a slot for each retired provider, so it
 *  is wider than the shared `ProfilesDocument` the client sees. Assignable to
 *  it, so a change to the shared shape still fails here. */
export type ProfilesDocument = {
  version: 1
  profiles: {
    gemini: ProviderProfile
    claude: ProviderProfile
    openai: ProviderProfile
    claudeCode: ProviderProfile
    codex: ProviderProfile
    openrouter: ProviderProfile
  }
}
const _assignableToShared = (d: ProfilesDocument): SharedProfilesDocument => d
void _assignableToShared

const SEED: ProfilesDocument = {
  version: 1,
  profiles: {
    // Seeded to the cheapest catalogue model that clears all three bars the
    // pipeline actually needs: unmoderated (the prose phases get refused
    // otherwise), structured-output capable (audit and extras emit JSON), and
    // an output ceiling at or above MAX_OUTPUT_TOKENS.
    openrouter: {
      phase1Model: OPENROUTER_GPT_OSS_120B,
      phase2Model: OPENROUTER_GPT_OSS_120B,
      phase3Model: OPENROUTER_GPT_OSS_120B,
      phase4Model: OPENROUTER_GPT_OSS_120B,
    },
    gemini: {
      phase1Model: GEMINI_PRO,
      phase2Model: GEMINI_FLASH,
      phase3Model: GEMINI_PRO,
      phase4Model: GEMINI_FLASH,
    },
    claude: {
      phase1Model: 'claude-sonnet-4-6',
      phase2Model: 'claude-haiku-4-5-20251001',
      phase3Model: 'claude-sonnet-4-6',
      phase4Model: 'claude-haiku-4-5-20251001',
    },
    openai: {
      phase1Model: 'gpt-5-mini',
      phase2Model: 'gpt-5-nano',
      phase3Model: 'gpt-5',
      phase4Model: 'gpt-5-mini',
    },
    claudeCode: {
      phase1Model: 'sonnet',
      phase2Model: 'haiku',
      phase3Model: 'sonnet',
      phase4Model: 'haiku',
    },
    codex: {
      phase1Model: 'default',
      phase2Model: 'gpt-5-mini',
      phase3Model: 'default',
      phase4Model: 'gpt-5-mini',
    },
  },
}

function sanitizeProfile(input: unknown, seed: ProviderProfile): ProviderProfile {
  const raw = (input ?? {}) as Partial<ProviderProfile>
  return {
    phase1Model: typeof raw.phase1Model === 'string' && raw.phase1Model ? raw.phase1Model : seed.phase1Model,
    phase2Model: typeof raw.phase2Model === 'string' && raw.phase2Model ? raw.phase2Model : seed.phase2Model,
    phase3Model: typeof raw.phase3Model === 'string' && raw.phase3Model ? raw.phase3Model : seed.phase3Model,
    phase4Model: typeof raw.phase4Model === 'string' && raw.phase4Model ? raw.phase4Model : seed.phase4Model,
    phase6Model:
      typeof raw.phase6Model === 'string' && raw.phase6Model
        ? raw.phase6Model
        : seed.phase6Model,
  }
}

function sanitize(input: unknown): ProfilesDocument {
  const raw = ((input ?? {}) as Partial<ProfilesDocument>).profiles ?? {}
  return {
    version: 1,
    profiles: {
      gemini: sanitizeProfile(
        (raw as Record<string, unknown>).gemini,
        SEED.profiles.gemini
      ),
      claude: sanitizeProfile(
        (raw as Record<string, unknown>).claude,
        SEED.profiles.claude
      ),
      openai: sanitizeProfile(
        (raw as Record<string, unknown>).openai,
        SEED.profiles.openai
      ),
      claudeCode: sanitizeProfile(
        (raw as Record<string, unknown>).claudeCode,
        SEED.profiles.claudeCode
      ),
      codex: sanitizeProfile(
        (raw as Record<string, unknown>).codex,
        SEED.profiles.codex
      ),
      openrouter: sanitizeProfile(
        (raw as Record<string, unknown>).openrouter,
        SEED.profiles.openrouter
      ),
    },
  }
}

const store = createDocumentStore<ProfilesDocument>({
  file: profilesFile,
  seed: () => SEED,
  sanitize,
})

interface ProfilesValidationError {
  error: string
  field: string
  allowedValues?: readonly (string | number | null)[]
  received?: unknown
}

type ValidateProfilesResult =
  | { ok: false; status: 400; body: ProfilesValidationError }
  | { ok: true; warnings: string[] }

/** Strict pre-write validation. Hard failures (non-object body, unknown
 *  schema version) → 400. Soft failures (a modelId the probe cache can't
 *  vouch for, often a typo by a user copying a model name from a docs page)
 *  → warning on a 200. The warning is captured in slog so the diagnose
 *  bundle has a trail when a subsequent pipeline call fails. */
function validateProfilesInput(
  input: unknown,
  cache: AvailabilityCache,
): ValidateProfilesResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Request body must be a JSON object',
        field: '_root',
        received: typeof input,
      },
    }
  }
  const raw = input as Record<string, unknown>
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'number' || !Number.isFinite(raw.version)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'Invalid version: must be 1',
          field: 'version',
          allowedValues: [1],
          received: raw.version,
        },
      }
    }
    if (raw.version !== 1) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `Profiles schema version ${raw.version} is not supported (current: 1). If the version is newer than 1, update the server: pull, then re-run npm run dev.`,
          field: 'version',
          allowedValues: [1],
          received: raw.version,
        },
      }
    }
  }
  const warnings: string[] = []
  const profilesRaw = raw.profiles
  if (profilesRaw && typeof profilesRaw === 'object' && !Array.isArray(profilesRaw)) {
    const p = profilesRaw as Record<string, unknown>
    for (const provider of PROVIDER_KEYS) {
      const profile = p[provider]
      if (!profile || typeof profile !== 'object') continue
      const pp = profile as Record<string, unknown>
      for (const field of PROFILE_PHASE_FIELDS) {
        const value = pp[field]
        if (typeof value === 'string' && value.length > 0) {
          // A profile is per-provider with no tier of its own, so pass
          // undefined: for Gemini that means "accessible on either key slot
          // is good enough", matching how the pipeline may dispatch.
          const verdict = acceptModel(provider, undefined, value, cache)
          if (!verdict.ok) {
            warnings.push(warningFor(`profiles.${provider}.${field}`, provider, value, verdict))
          }
        }
      }
    }
  }
  return { ok: true, warnings }
}

export function profilesRouter(): Router {
  const router = express.Router()

  router.get('/', asyncRoute('api/profiles GET', async (_req, res) => {
    const doc = await store.load()
    res.json(doc)
  }))

  router.put('/', asyncRoute('api/profiles PUT', async (req, res) => {
    const validated = validateProfilesInput(req.body, await loadAvailabilityCache())
    if (!validated.ok) {
      slog('profiles', {
        event: 'putProfiles_rejected',
        field: validated.body.field,
        received: validated.body.received,
      })
      res.status(validated.status).json(validated.body)
      return
    }
    const sanitized = sanitize(req.body)
    await store.save(sanitized)
    if (validated.warnings.length > 0) {
      slog('profiles', { event: 'putProfiles_warnings', warnings: validated.warnings })
    }
    const response: ProfilesDocument & { warnings?: string[] } = { ...sanitized }
    if (validated.warnings.length > 0) response.warnings = validated.warnings
    res.json(response)
  }))

  return router
}
