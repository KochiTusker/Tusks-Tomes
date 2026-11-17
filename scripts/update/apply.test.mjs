// The update scripts the in-app updater runs. Neither is run here: both need
// a real clone with a remote. These pin what they must keep doing.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const read = (name) => readFileSync(join(HERE, name), 'utf8')

describe('apply.ps1', () => {
  it('is pure ASCII, which Windows PowerShell 5.1 needs to parse it', () => {
    // Without a BOM, PowerShell 5.1 reads a script in the ANSI codepage, and a
    // multi-byte character can break the parser and stop every update.
    const bytes = readFileSync(join(HERE, 'apply.ps1'))
    const offenders = [...bytes.entries()].filter(([, b]) => b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d))
    expect(offenders.slice(0, 5)).toEqual([])
  })
})

describe.each(['apply.sh', 'apply.ps1'])('%s', (name) => {
  const script = read(name)

  it('asks the freshly pulled tree whether the Node on PATH is new enough', () => {
    const pull = script.indexOf('pull --ff-only')
    const check = script.indexOf('node scripts/update/node-advice.mjs')
    expect(pull).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(pull)
  })

  it('gives the Node advice in the dependency guidance and when nothing else changed', () => {
    const marker = script.indexOf('DEPENDENCY_CHANGES_DETECTED')
    const advice = name === 'apply.sh' ? 'print_node_advice "' : 'Write-NodeAdvice "'
    const calls = [...script.matchAll(new RegExp(advice, 'g'))].map((m) => m.index)
    expect(calls).toHaveLength(2)
    expect(calls.some((i) => i > marker)).toBe(true)
  })

  it('never fails a pull that succeeded over the advice', () => {
    if (name === 'apply.sh') {
      expect(script).toMatch(/NODE_ADVICE="\$\(node scripts\/update\/node-advice\.mjs 2>\/dev\/null \|\| true\)"/)
    } else {
      expect(script).toMatch(/try \{\s*\$nodeAdvice = @\(& node scripts\/update\/node-advice\.mjs\)\s*\} catch/)
    }
  })

  it('does not name a Node version of its own', () => {
    expect(script).not.toMatch(/Node(\.js)? ?(>= ?)?\d{2}/)
  })
})
