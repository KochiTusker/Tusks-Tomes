// Tome of Lore: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { LoreCard } from './components/LoreCard'
export { LoreMigrationCard } from './components/LoreMigrationCard'
export { LoreSourceCard } from './components/LoreSourceCard'
export { ObsidianVaultSettings } from './components/ObsidianVaultSettings'
export { VaultPairCard } from './components/VaultPairCard'
export { VaultSummaryCard } from './components/VaultSummaryCard'
export { useLoreDocuments } from './hooks/useLoreDocuments'
export { getAliasIndex } from './lib/aliasIndexClient'
export type { AliasIndex } from './lib/aliasIndexClient'
export { aliasIndexToSafeReplacements, annotateChunk } from './lib/aliasMatch'
export { COMPACT_KB_MAX_CHARS, compactKb, kbForPhase } from './lib/kbCompact'
export { getLoreStatus, saveChronicleToLore } from './lib/lore'
export type { LoreStatus } from './lib/lore'
export { exportChronicleToVault, getVaultPairStatus } from './lib/vault'
export type { VaultPairStatus } from './lib/vault'
export { DEFAULT_RETRIEVAL_MAX_CHARS, retrieveForText } from './lib/vaultRetrieval'
