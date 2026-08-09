/**
 * Publish site-dist/ to the `gh-pages` branch on the PUBLIC remote.
 *
 * Why a branch push rather than a GitHub Actions deploy:
 *   - `git push public gh-pages` runs the repo's pre-push hook, which gates
 *     by REMOTE NAME. So the generated site goes through the same seven-layer
 *     release scanner as any other public push. An Actions deploy would build
 *     inside GitHub and bypass that gate entirely.
 *   - No workflow file on the public repo means no world-readable CI logs for
 *     the site build, and one less thing to review per release.
 *
 * Isolation: the branch is rebuilt from an ORPHAN commit every time, so it
 * shares no history with dev — the same property the release branch relies on.
 * It carries exactly the bytes in site-dist/ and nothing else.
 *
 * Usage:
 *   node scripts/site/build-site.mjs
 *   node scripts/site/publish-site.mjs --dry-run   # build the branch, don't push
 *   node scripts/site/publish-site.mjs             # build and push
 *
 * The push is the last step and is printed before it runs.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { ALLOWED_AUTHORS, isAllowedIdentity } from '../lib/personal-info-scanner.mjs'
import { UNAPPROVED_PREVIEW_MARKER } from './build-site.mjs'

const REMOTE = 'public'
const BRANCH = 'gh-pages'
const OUT = 'site-dist'

const dryRun = process.argv.includes('--dry-run')

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim()
}

function fail(msg) {
  console.error(`\n✖ ${msg}\n`)
  process.exit(1)
}

/**
 * Resolve the identity to stamp on the orphan commit, and refuse to build
 * one the push gate would reject.
 *
 * This exists because a repo-local `user.name` is easy to set for testing
 * and then forget — and git's own precedence puts it ABOVE the global
 * config, so the wrong name gets baked in silently. Without this check the
 * mistake only surfaces at the pre-push scanner, after typecheck and the
 * full test suite have already run: several minutes of feedback delay for
 * a one-line config problem.
 *
 * Same rationale as forcing UTC dates below — a public commit must carry
 * the public identity regardless of whatever local config happens to be
 * in effect. The allowlist is imported rather than duplicated, so this can
 * never accept something the gate would then reject.
 */
function resolvePublicIdentity() {
  const readConfig = (scope, key) => {
    try {
      return git(['config', ...scope, key])
    } catch {
      return ''
    }
  }

  const candidates = [
    {
      source: 'TUSKS_PUBLIC_AUTHOR_NAME / TUSKS_PUBLIC_AUTHOR_EMAIL',
      name: process.env.TUSKS_PUBLIC_AUTHOR_NAME || '',
      email: process.env.TUSKS_PUBLIC_AUTHOR_EMAIL || '',
    },
    {
      source: 'git config --global',
      name: readConfig(['--global'], 'user.name'),
      email: readConfig(['--global'], 'user.email'),
    },
    {
      source: 'git config (repo)',
      name: readConfig([], 'user.name'),
      email: readConfig([], 'user.email'),
    },
  ]

  for (const c of candidates) {
    if (isAllowedIdentity(c.name, c.email)) return c
  }

  const seen = candidates
    .filter((c) => c.name || c.email)
    .map((c) => `    ${c.source}: ${c.name || '(unset)'} <${c.email || '(unset)'}>`)
    .join('\n')

  fail(
    `no publishable commit identity found.\n\n` +
      `  A public commit must be authored as "${ALLOWED_AUTHORS[0]}" with a\n` +
      `  users.noreply.github.com address — the pre-push scanner blocks anything\n` +
      `  else, and a repo-local user.name overrides your global one silently.\n\n` +
      `  Checked:\n${seen || '    (nothing configured)'}\n\n` +
      `  Fix with either:\n` +
      `    git config user.name  "${ALLOWED_AUTHORS[0]}"\n` +
      `    git config user.email "<id>+${ALLOWED_AUTHORS[0]}@users.noreply.github.com"\n` +
      `  or, to leave repo config alone, set TUSKS_PUBLIC_AUTHOR_NAME and\n` +
      `  TUSKS_PUBLIC_AUTHOR_EMAIL for this command only.`,
  )
}

const root = git(['rev-parse', '--show-toplevel'])
const dist = path.join(root, OUT)

if (!existsSync(path.join(dist, 'index.html'))) {
  fail(`${OUT}/index.html not found — run \`npm run site:build\` first.`)
}

// A build made with SITE_PREVIEW_UNAPPROVED=1 contains sample output nobody
// has signed off yet. The marker is checked here rather than trusting the
// environment, because the risky sequence is a preview build left sitting in
// site-dist/ and published later from a shell where the variable is long gone.
// The bytes are what get pushed, so the bytes are what get checked.
if (readFileSync(path.join(dist, 'index.html'), 'utf8').includes(UNAPPROVED_PREVIEW_MARKER)) {
  fail(
    `${OUT}/index.html was built for local review and contains unapproved sample output.\n` +
      `  Either set "approved": true in site/examples.json once the samples have been read,\n` +
      `  or rebuild without SITE_PREVIEW_UNAPPROVED to drop the section. Then \`npm run site:build\`.`,
  )
}

// The hook only scans pushes to the remote literally named `public`. Pushing
// by URL, or to a renamed remote, silently skips the gate.
let remoteUrl
try {
  remoteUrl = git(['remote', 'get-url', REMOTE])
} catch {
  fail(`no remote named "${REMOTE}". The pre-push scanner gates by remote NAME — do not push by URL.`)
}

// Resolved before any work so a misconfigured identity fails in
// milliseconds rather than after the pre-push hook's test suite.
const identity = resolvePublicIdentity()

console.log(`Publishing ${OUT}/ → ${REMOTE} (${remoteUrl}) branch ${BRANCH}`)
console.log(`  as ${identity.name} <${identity.email}>  (${identity.source})`)

// Build the commit with a temporary index so the working tree and the real
// index are untouched. GIT_INDEX_FILE is scoped to these calls only.
//
// Resolve the git dir rather than assuming `<root>/.git` is a directory — in
// a linked worktree `.git` is a FILE pointing at .git/worktrees/<name>, so
// joining onto it produces an unwritable path.
const gitDir = git(['rev-parse', '--absolute-git-dir'])
const tmpIndex = path.join(gitDir, `tmp-index-${BRANCH}`)
const env = { ...process.env, GIT_INDEX_FILE: tmpIndex, GIT_WORK_TREE: dist }

let tree
try {
  git(['add', '-A', '.'], { cwd: dist, env })
  tree = git(['write-tree'], { env })
} finally {
  try {
    execFileSync('node', ['-e', `require('fs').rmSync(${JSON.stringify(tmpIndex)},{force:true})`])
  } catch {
    /* best effort */
  }
}

// Orphan commit: no -p, so the branch has no parent and no shared history.
// Dates forced to UTC — a +HH:MM offset on a public commit is a geolocation
// tell (see the OSINT rules in the repo's contributor guidance). Identity is
// forced for the same reason: whatever local config is in effect, the bytes
// that reach the public remote carry only the public alias.
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const commit = git(
  ['commit-tree', tree, '-m', 'Publish documentation site'],
  {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    },
  },
)

git(['update-ref', `refs/heads/${BRANCH}`, commit])
console.log(`  built orphan commit ${commit.slice(0, 8)} on ${BRANCH} (tree ${tree.slice(0, 8)})`)

if (dryRun) {
  console.log(`\n--dry-run: not pushing. To publish:\n  git push ${REMOTE} ${BRANCH} --force\n`)
  process.exit(0)
}

// --force because every publish is a fresh orphan; there is no fast-forward
// path between them by design.
console.log(`  pushing (pre-push scanner runs now)…`)
try {
  execFileSync('git', ['push', REMOTE, BRANCH, '--force'], { stdio: 'inherit' })
} catch {
  fail('push failed — if the release scanner blocked it, fix the finding rather than bypassing the hook.')
}
console.log(`\n✓ Published. Set Pages source to branch "${BRANCH}" / root in the repo settings.`)
