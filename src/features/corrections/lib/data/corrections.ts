// Type definitions for user-additive corrections. The data itself now lives
// on disk at `{configDir}/glossary.json` and is edited via the Tome of Lore
// tab's Glossary Editor — see `src/lib/glossary.ts` for the client.
//
// The built-in baseline (universal D&D mistranscriptions) is still hardcoded
// in `src/features/corrections/lib/data/dndDictionary.ts` and applied before the user glossary at
// pipeline time.

import type { ContextualHint, SafeReplacement } from '@shared/contracts/glossary'

export type { ContextualHint, SafeReplacement }
