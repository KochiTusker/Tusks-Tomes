/**
 * Hermetic environment for spawning git (or a script that shells out to
 * git) against a TEMPORARY fixture repository.
 *
 * Git exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE and friends to every
 * hook it runs, and child processes inherit them. Those variables take
 * precedence over `cwd`, so this:
 *
 *     execFileSync('git', ['init'], { cwd: tmpDir })
 *
 * silently operates on the OUTER repository when it runs inside a pre-push
 * hook. The failure mode is nasty in a specific way: the suite is green on
 * a plain `npm test` and only fails on `git push`, which is the moment you
 * are least able to investigate — and until it fails, the commands are
 * quietly mutating the real repo's config and index.
 *
 * This has now bitten twice (audit-security-contracts, publish-site), which
 * is why it lives here rather than being copied into a third test file.
 *
 * Strips the whole `GIT_*` namespace rather than an enumerated list, so a
 * variable added by a future git release cannot reopen the hole.
 *
 * @param {Record<string, string>} [overrides] Variables to set afterwards —
 *   including GIT_* ones the caller genuinely wants, e.g. pointing
 *   GIT_CONFIG_GLOBAL at a nonexistent path to neutralise user config.
 * @returns {Record<string, string>} A copy of process.env, git-neutralised.
 */
export function cleanGitEnv(overrides = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return { ...env, ...overrides }
}
