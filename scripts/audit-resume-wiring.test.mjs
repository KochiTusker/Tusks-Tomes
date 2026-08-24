// Static guard that resume-from-checkpoint is wired up to actually
// continue execution. Before this guard, src/lib/resumeFlow.ts:planResumeAction
// existed and was fully unit-tested but was never imported in production
// code — RefinementTool's resumeFromCheckpoint hydrated state and then
// did nothing, so the user clicked Resume and saw the partial output
// loaded but no chunks fired. This caught us once; the static check
// here makes the regression cheap to detect.
//
// The check is intentionally cheap-and-coarse — grep for the import and
// the call. A future refactor that legitimately renames the helper or
// moves the dispatcher should update this test to match.

import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

describe('audit: resume-from-checkpoint dispatcher is wired', () => {
  it('RefinementTool.tsx imports planResumeAction', async () => {
    const body = await fs.readFile(
      path.join(REPO_ROOT, 'src', 'components', 'RefinementTool.tsx'),
      'utf8',
    )
    expect(body).toMatch(/import\s*\{[^}]*\bplanResumeAction\b[^}]*\}\s*from\s*['"]@\/lib\/resumeFlow['"]/)
  })

  it('RefinementTool.tsx calls planResumeAction inside resumeFromCheckpoint', async () => {
    const body = await fs.readFile(
      path.join(REPO_ROOT, 'src', 'components', 'RefinementTool.tsx'),
      'utf8',
    )
    // Locate the resumeFromCheckpoint callback by its declaration, then
    // look forward for a planResumeAction( call before any other top-level
    // useCallback definition. This is loose but it asserts the planner is
    // actually invoked when Resume fires, not just imported.
    const startIdx = body.indexOf('const resumeFromCheckpoint = useCallback(')
    expect(startIdx).toBeGreaterThan(-1)
    const nextCallbackIdx = body.indexOf('const ', startIdx + 1)
    const region = body.slice(startIdx, nextCallbackIdx === -1 ? undefined : nextCallbackIdx + 5000)
    expect(region).toMatch(/\bplanResumeAction\s*\(/)
  })

  it('RefinementTool.tsx has a dispatcher (runFromResumeAction) that runs the action', async () => {
    const body = await fs.readFile(
      path.join(REPO_ROOT, 'src', 'components', 'RefinementTool.tsx'),
      'utf8',
    )
    // The dispatcher must exist as a callback and must invoke at least
    // one runPhase function — otherwise the planner output goes nowhere.
    expect(body).toMatch(/const runFromResumeAction = useCallback\(/)
    const startIdx = body.indexOf('const runFromResumeAction = useCallback(')
    const region = body.slice(startIdx, startIdx + 10000)
    expect(region).toMatch(/\brunPhase1\s*\(/)
    expect(region).toMatch(/\bstartChunkIndex\s*:/)
    expect(region).toMatch(/\bpriorPartial\s*:/)
  })
})
