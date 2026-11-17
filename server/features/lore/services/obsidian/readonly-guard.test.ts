import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Read-only guard (mirrors scripts/audit-dangerous-fs-rm.test.mjs in spirit):
// the vault-facing modules must NEVER write. The derived index is persisted by
// the router into cacheDir — but vaultAdapter.ts / vaultKb.ts touch only the
// user's vault and must stay pure reads. A regression that introduces a write
// here could mutate the user's Obsidian vault, which we promise never to do.

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WRITE_CALLS = [
  /\bfs\.writeFile\b/,
  /\bfs\.mkdir\b/,
  /\bfs\.rm\b/,
  /\bfs\.rmdir\b/,
  /\bfs\.unlink\b/,
  /\bfs\.rename\b/,
  /\bfs\.appendFile\b/,
  /\bfs\.copyFile\b/,
  /\bwriteJson\b/,
  /\bwriteFileSync\b/,
]

describe('Obsidian vault-facing modules are strictly read-only', () => {
  // vaultClaudeMd.ts ASSEMBLES the navigation guide (pure read); the actual
  // write lives in vaultTools.ts (writeVaultClaudeMd), so this module must stay
  // write-free too.
  for (const file of ['vaultAdapter.ts', 'vaultKb.ts', 'vaultClaudeMd.ts']) {
    it(`${file} contains no filesystem write calls`, async () => {
      const src = await fs.readFile(path.join(__dirname, file), 'utf8')
      // Strip line comments so a doc-comment mentioning "writeFile" can't trip it.
      const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      const offenders = WRITE_CALLS.filter((re) => re.test(code)).map((re) => re.source)
      expect(offenders, `write calls found in ${file}: ${offenders.join(', ')}`).toEqual([])
    })
  }
})
