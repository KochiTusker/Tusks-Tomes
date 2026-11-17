/*
 * The oldest Node.js this version of Tusk's Tomes supports, and how to get a
 * newer one. Every check of the running Node reads the number from here:
 *
 *   - scripts/setup/check-deps.mjs   first-time setup refuses an older Node
 *   - scripts/update/node-advice.mjs  the updater says so after a pull
 *   - server/platform/nodeRuntime.ts  the server warns at every start
 *
 * Files that cannot import it (the CI workflow, the release tree's CI
 * template and the setup launchers, which run before Node is known to work)
 * name the same number, and engineering/tests/node-minimum.test.ts fails when
 * one drifts.
 *
 * Dependency-free, and in syntax an old Node parses: its whole job is to run
 * on a Node that is too old, before npm install has ever run, and say so.
 * The advice is ASCII so Windows PowerShell 5.1 shows it intact.
 */

export const MIN_NODE_MAJOR = 22

/** The major number of a Node version string such as '22.1.0' or 'v22.1.0',
 *  or null when the string doesn't start with one. */
export function nodeMajor(version) {
  const match = /^v?(\d+)(?:\.|$)/.exec(String(version == null ? '' : version).trim())
  return match ? Number(match[1]) : null
}

/** True when `version` is MIN_NODE_MAJOR.0.0 or newer. An unreadable version
 *  is not supported: setup has always refused what it couldn't read. */
export function isSupportedNode(version) {
  const major = nodeMajor(version)
  return major !== null && major >= MIN_NODE_MAJOR
}

/** Package names per package manager, for installCommands(). */
export const NODE_PACKAGES = {
  winget: 'OpenJS.NodeJS.LTS',
  brew: `node@${MIN_NODE_MAJOR}`,
  apt: 'nodejs npm',
  dnf: 'nodejs npm',
  pacman: 'nodejs npm',
}

/** The command that installs `pkg` on `platform`, one line per package
 *  manager. Linux gets all three common ones: the user knows which they have. */
export function installCommands(pkg, platform) {
  switch (platform) {
    case 'win32':
      return [`winget install ${pkg.winget}`]
    case 'darwin':
      return [`brew install ${pkg.brew}`]
    case 'linux':
      return [
        `sudo apt install ${pkg.apt}    # Debian / Ubuntu`,
        `sudo dnf install ${pkg.dnf}    # Fedora / RHEL`,
        `sudo pacman -S ${pkg.pacman}    # Arch`,
      ]
    default:
      return [`(install ${pkg.brew ?? pkg.apt ?? 'the package'} via your OS package manager)`]
  }
}

/** What to tell someone running Node `version` on `platform`: null when that
 *  Node is new enough, otherwise lines naming both versions and how to
 *  install a newer one. Callers add what to do next, which depends on where
 *  the advice appears. */
export function nodeUpgradeAdvice(version, platform) {
  if (isSupportedNode(version)) return null
  return [
    `Tusk's Tomes needs Node.js ${MIN_NODE_MAJOR} or newer, and this computer runs Node.js ${version}.`,
    'To install a newer one:',
    ...installCommands(NODE_PACKAGES, platform).map((line) => `    ${line}`),
    '  or download the LTS installer from https://nodejs.org/',
  ]
}
