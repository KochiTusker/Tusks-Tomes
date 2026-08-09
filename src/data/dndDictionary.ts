/* ============================================================================
 *  BUILT-IN D&D MISTRANSCRIPTION DICTIONARY
 *
 *  Common errors YouTube auto-captions consistently produce for tabletop
 *  / D&D 5e terminology. These are baked into the pre-grounding pass and
 *  applied BEFORE your campaign-specific corrections.ts rules.
 *
 *  All entries here must be SAFE to apply unconditionally — i.e. the
 *  wrong form is never a real English word that could legitimately appear.
 *  If you find one of these is wrong for your campaign, override it by
 *  adding the opposite rule to corrections.ts (campaign-specific rules
 *  take precedence by being applied second — the last write wins).
 *
 *  Add entries here as you discover patterns. Keep the list narrow and
 *  defensible — anything ambiguous belongs in corrections.ts as a
 *  contextual hint, not here.
 * ============================================================================
 */

import type { SafeReplacement } from './corrections'

export const dndDictionary: SafeReplacement[] = [
  // ---- Class names ----
  { from: 'rouge', to: 'rogue' },
  { from: 'rouges', to: 'rogues' },

  // ---- Common D&D terms ----
  { from: 'd&d', to: 'D&D' },
  { from: 'tpk', to: 'TPK' },

  // ---- Race / monster names commonly mangled ----
  { from: 'tieflings', to: 'tieflings' },
  { from: 'dragonborn', to: 'dragonborn' },
  // (Above are no-ops, listed as documentation; uncomment if you find drift.)

  // ---- Setting / lore names ----
  // Add as confirmed by community usage; leave commented-out entries as
  // examples of patterns you might extend.
  // { from: 'fair-run', to: 'Faerûn' },   // accent dropped on purpose; some users prefer 'Faerun'
  // { from: 'wattafarrin', to: 'Waterdeep' },
]
