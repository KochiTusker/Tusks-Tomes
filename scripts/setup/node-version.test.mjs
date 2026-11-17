// The supported Node.js minimum and the advice given below it.
//
// Setup, the updater and the server all decide "is this Node new enough?"
// through node-version.mjs, so the boundary is tested once, here. The files
// that cannot import the constant are pinned to it in
// engineering/tests/node-minimum.test.ts.

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  MIN_NODE_MAJOR,
  NODE_PACKAGES,
  installCommands,
  isSupportedNode,
  nodeMajor,
  nodeUpgradeAdvice,
} from './node-version.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const PLATFORMS = ['win32', 'darwin', 'linux', 'freebsd']

describe('the supported Node.js minimum', () => {
  it('is Node 22', () => {
    expect(MIN_NODE_MAJOR).toBe(22)
  })

  it('reads the major number with or without a leading v', () => {
    expect(nodeMajor('22.0.0')).toBe(22)
    expect(nodeMajor('v21.7.3')).toBe(21)
    expect(nodeMajor('24')).toBe(24)
    expect(nodeMajor(' 20.19.0 ')).toBe(20)
  })

  it('reads nothing from a string that does not start with a version', () => {
    for (const bad of ['', 'node', 'x22.0.0', '.22', undefined, null]) {
      expect(nodeMajor(bad), String(bad)).toBeNull()
    }
  })

  it('refuses every 20.x and 21.x, up to the last patch of 21', () => {
    for (const v of ['20.0.0', '20.19.0', 'v20.18.0', '21.0.0', '21.7.3', '21.99.99']) {
      expect(isSupportedNode(v), v).toBe(false)
    }
  })

  it('accepts 22.0.0 itself and everything after it', () => {
    for (const v of ['22.0.0', 'v22.0.0', '22.12.0', '23.0.0', '24.20.0', '30.1.0']) {
      expect(isSupportedNode(v), v).toBe(true)
    }
  })

  it('refuses a version it cannot read, as setup always has', () => {
    expect(isSupportedNode('')).toBe(false)
    expect(isSupportedNode('unknown')).toBe(false)
  })
})

describe('install commands', () => {
  // Characterisation: these are the strings check-deps.mjs printed before the
  // commands moved here. check-deps joins the Linux lines with a newline and
  // six spaces, so its output is unchanged.
  it('names the Node.js package for each platform as setup always has', () => {
    expect(installCommands(NODE_PACKAGES, 'win32')).toEqual(['winget install OpenJS.NodeJS.LTS'])
    expect(installCommands(NODE_PACKAGES, 'darwin')).toEqual(['brew install node@22'])
    expect(installCommands(NODE_PACKAGES, 'linux')).toEqual([
      'sudo apt install nodejs npm    # Debian / Ubuntu',
      'sudo dnf install nodejs npm    # Fedora / RHEL',
      'sudo pacman -S nodejs npm    # Arch',
    ])
    expect(installCommands(NODE_PACKAGES, 'freebsd')).toEqual([
      '(install node@22 via your OS package manager)',
    ])
  })

  it('serves setup\'s other packages the same way', () => {
    const git = { winget: 'Git.Git', brew: 'git', apt: 'git', dnf: 'git', pacman: 'git' }
    expect(installCommands(git, 'win32')).toEqual(['winget install Git.Git'])
    expect(installCommands(git, 'darwin')).toEqual(['brew install git'])
    expect(installCommands(git, 'linux')[0]).toBe('sudo apt install git    # Debian / Ubuntu')
  })
})

describe('upgrade advice', () => {
  it('says nothing to a Node that is new enough', () => {
    for (const v of ['22.0.0', '24.20.0']) {
      for (const p of PLATFORMS) expect(nodeUpgradeAdvice(v, p), `${v} ${p}`).toBeNull()
    }
  })

  it('names both versions and the install command below the minimum', () => {
    expect(nodeUpgradeAdvice('21.99.99', 'win32')).toEqual([
      "Tusk's Tomes needs Node.js 22 or newer, and this computer runs Node.js 21.99.99.",
      'To install a newer one:',
      '    winget install OpenJS.NodeJS.LTS',
      '  or download the LTS installer from https://nodejs.org/',
    ])
    const linux = nodeUpgradeAdvice('20.19.0', 'linux')
    expect(linux).toContain('    sudo dnf install nodejs npm    # Fedora / RHEL')
  })

  it('is plain ASCII on every platform, so Windows PowerShell 5.1 shows it intact', () => {
    for (const p of PLATFORMS) {
      for (const line of nodeUpgradeAdvice('20.0.0', p)) {
        expect(line, `${p}: ${line}`).toMatch(/^[\x20-\x7e]*$/)
      }
    }
  })

  it('node-advice.mjs prints nothing and exits 0 on the Node running the tests', () => {
    // CI and development run a supported Node, so the script must stay quiet;
    // what it prints below the minimum is the advice tested above.
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'update', 'node-advice.mjs')], {
      encoding: 'utf8',
    })
    expect(out).toBe('')
  })
})
