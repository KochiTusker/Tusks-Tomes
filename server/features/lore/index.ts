// Tome of Lore (server): the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { loreRouter } from './routes/lore.js'
export { registerObsidianRoutes } from './routes/obsidian.js'
export { vaultRouter } from './routes/vault.js'
export { initAliasIndexManager } from './services/aliasIndexManager.js'
export { detectLore } from './services/detection.js'
export { docxBufferToMarkdown } from './services/docxToMarkdown.js'
export { autoApplyFrontmatter } from './services/entityExtraction.js'
