// CRUD endpoints for the user-additive glossary (safe replacements + contextual
// hints). The frontend used to read these from `shared/contracts/glossary.ts` —
// hardcoded campaign-specific entries that required a code edit + reload to
// change. They now live in `{configDir}/glossary.json` and are managed by the
// React Glossary Editor (Tome of Lore tab).
//
// The built-in `dndDictionary` remains in source — it's the universal baseline,
// not user-editable.
//
// PUT validates strictly: non-object body → 400. Silently-dropped entries
// (missing required fields) → 200 with a `warnings` field naming the
// dropped count so the user sees a toast rather than wondering where
// their glossary line went.

import express, { type Router } from 'express'
import { glossaryFile, readJson, writeJsonBackedUp } from '../../../platform/appData.js'
import { slog } from '../../../platform/slog.js'
import { createDocumentStore, rejectNonObjectBody } from '../../../platform/documentStore.js'
import type { ContextualHint, GlossaryDocument, SafeReplacement } from '../../../../shared/contracts/glossary.js'
import { asyncRoute } from '../../../platform/asyncRoute.js'



/**
 * The glossary a fresh install starts with.
 *
 * These entries are ILLUSTRATIVE, not anyone's real campaign. They exist so a
 * new user opening the Tome of Lore sees a worked example of each of the two
 * shapes — a blind find-and-replace, and a context-gated hint — rather than an
 * empty screen with no clue what good input looks like. Users are expected to
 * delete them and add their own.
 *
 * That distinction is load-bearing. A seed is copied into every install on
 * first run, so anything sitting in it is not an example of a campaign — it
 * becomes part of the product. Keep the entries invented.
 *
 * Both shapes must stay phonetically coherent — `from` has to be something a
 * speech-to-text engine would plausibly emit for `to`. An incoherent pair
 * teaches the wrong lesson and is worse than no example at all.
 */
const SEED: GlossaryDocument = {
  version: 1,
  safeReplacements: [
    { from: 'thorbin', to: 'Thorbyn' },
    { from: "thorbin's", to: "Thorbyn's" },
    { from: 'kaylith', to: 'Kaelyth' },
    { from: 'kalith', to: 'Kaelyth' },
  ],
  contextualHints: [
    {
      canonical: 'Az',
      commonMishears: ['as', 'Asz', 'Aza'],
      notes:
        'Character nickname (short form). YouTube auto-captions consistently hear "Az" as the English word "as". REPLACE only when the surrounding context clearly indicates a person — for example: a verb of speech ("said", "replied", "shouted", "whispered") that immediately follows or precedes; an action verb attributing the act to a person ("cast", "attacked", "stood", "drew"); a pronoun referring back to it; or an address ("hey, Az"). DO NOT REPLACE when "as" is being used as the conjunction or preposition — examples: "as the dragon roared", "as we approached", "as soon as", "treated as", "served as".',
    },
    {
      canonical: 'Vex',
      commonMishears: ['vex', 'Vecks', 'Vax'],
      notes:
        'Character nickname (short for Vexley). Speech-to-text hears the single syllable "Vex" as the English verb "vex", or splits it into "Vecks". REPLACE when context indicates a person — speech verbs nearby ("Vex said", "Vex laughed", "told Vex"), action verbs ("Vex cast", "Vex swung"), an address ("hey, Vex"), or a possessive ("Vex\'s blade"). DO NOT REPLACE when it is the ordinary verb — "it began to vex her", "vexed by the puzzle". If you encounter the longer form "Vexley", leave it as Vexley.',
    },
  ],
}

function sanitize(input: unknown): GlossaryDocument {
  const raw = (input ?? {}) as Partial<GlossaryDocument>
  const safeReplacements: SafeReplacement[] = Array.isArray(raw.safeReplacements)
    ? raw.safeReplacements
        .filter((r): r is SafeReplacement =>
          !!r && typeof (r as SafeReplacement).from === 'string'
            && typeof (r as SafeReplacement).to === 'string'
        )
        .map((r) => ({ from: r.from.trim(), to: r.to }))
        .filter((r) => r.from.length > 0)
    : []
  const contextualHints: ContextualHint[] = Array.isArray(raw.contextualHints)
    ? raw.contextualHints
        .filter((h): h is ContextualHint =>
          !!h && typeof (h as ContextualHint).canonical === 'string'
            && typeof (h as ContextualHint).notes === 'string'
        )
        .map((h) => ({
          canonical: h.canonical.trim(),
          commonMishears: Array.isArray(h.commonMishears)
            ? h.commonMishears.filter((s): s is string => typeof s === 'string')
            : undefined,
          notes: h.notes,
        }))
        .filter((h) => h.canonical.length > 0)
    : []
  return { version: 1, safeReplacements, contextualHints }
}

/** Count how many entries from the raw input were dropped during
 *  sanitisation (because they were missing required fields or were
 *  the wrong type). The PUT handler surfaces the count via the
 *  `warnings` array so users notice silently-lost data. */
function countDroppedEntries(raw: unknown, sanitized: GlossaryDocument): {
  droppedSafeReplacements: number
  droppedContextualHints: number
} {
  const r = (raw ?? {}) as Partial<GlossaryDocument>
  const rawSafe = Array.isArray(r.safeReplacements) ? r.safeReplacements.length : 0
  const rawHints = Array.isArray(r.contextualHints) ? r.contextualHints.length : 0
  return {
    droppedSafeReplacements: Math.max(0, rawSafe - sanitized.safeReplacements.length),
    droppedContextualHints: Math.max(0, rawHints - sanitized.contextualHints.length),
  }
}

// A read must never mutate user data, so the seed lives in memory only
// (`persistSeedOnRead: false`) and the file is created by the first real PUT.
// It used to persist the seed, which made a plain GET a destructive write: if
// the file ever went missing (a failed rename, an external delete, a
// half-finished restore) the next read committed the seed over the top of it
// with no backup and no warning. Saves go through the backed-up writer. A PUT
// carrying an empty document is guarded separately, in the PUT handler.
const store = createDocumentStore<GlossaryDocument>({
  file: glossaryFile,
  seed: () => SEED,
  sanitize,
  persistSeedOnRead: false,
  write: writeJsonBackedUp,
})

export function glossaryRouter(): Router {
  const router = express.Router()

  router.get('/', asyncRoute('api/glossary GET', async (_req, res) => {
    const doc = await store.load()
    res.json(doc)
  }))

  router.put('/', asyncRoute('api/glossary PUT', async (req, res) => {
    if (rejectNonObjectBody(req, res, 'glossary')) return
    const sanitized = sanitize(req.body)

    // Empty-overwrite guard. A PUT whose sanitised form is completely empty,
    // landing on a glossary that currently has entries, is almost never what
    // the user meant — the realistic cause is the editor saving its initial
    // blank state before its GET resolved, which is what wiped this file on
    // 2026-05-26. Refuse it unless the caller opts in with ?allowEmpty=1,
    // which the "clear all" affordance can pass deliberately.
    const incomingEmpty =
      sanitized.safeReplacements.length === 0 && sanitized.contextualHints.length === 0
    if (incomingEmpty && req.query.allowEmpty !== '1') {
      const current = await readJson<GlossaryDocument | null>(glossaryFile(), null)
      const currentCount =
        (current?.safeReplacements?.length ?? 0) + (current?.contextualHints?.length ?? 0)
      if (currentCount > 0) {
        slog('glossary', {
          event: 'putGlossary_empty_overwrite_blocked',
          currentEntryCount: currentCount,
        })
        res.status(409).json({
          error:
            `Refusing to replace ${currentCount} existing glossary entr${currentCount === 1 ? 'y' : 'ies'} with an empty glossary. ` +
            'If you meant to clear it, retry with ?allowEmpty=1.',
          field: '_root',
          currentEntryCount: currentCount,
        })
        return
      }
    }

    await store.save(sanitized)
    const dropped = countDroppedEntries(req.body, sanitized)
    const warnings: string[] = []
    if (dropped.droppedSafeReplacements > 0) {
      warnings.push(
        `${dropped.droppedSafeReplacements} safe-replacement entr${dropped.droppedSafeReplacements === 1 ? 'y' : 'ies'} were dropped because they were missing 'from' or 'to' fields, or had empty 'from'.`,
      )
    }
    if (dropped.droppedContextualHints > 0) {
      warnings.push(
        `${dropped.droppedContextualHints} contextual hint${dropped.droppedContextualHints === 1 ? '' : 's'} were dropped because they were missing 'canonical' or 'notes' fields, or had empty 'canonical'.`,
      )
    }
    if (warnings.length > 0) {
      slog('glossary', { event: 'putGlossary_warnings', warnings })
    }
    const response: GlossaryDocument & { warnings?: string[] } = { ...sanitized }
    if (warnings.length > 0) response.warnings = warnings
    res.json(response)
  }))

  return router
}
