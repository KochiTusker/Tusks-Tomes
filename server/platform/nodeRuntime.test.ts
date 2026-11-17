import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const slogMock = vi.fn()
vi.mock('./slog.js', () => ({ slog: (...a: unknown[]) => slogMock(...a) }))

const { warnIfNodeUnsupported } = await import('./nodeRuntime.js')

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  slogMock.mockReset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

const printed = (): string => warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')

describe('warnIfNodeUnsupported', () => {
  it('warns once, with the install command, on the last Node 21', async () => {
    expect(await warnIfNodeUnsupported({ version: '21.99.99', platform: 'win32' })).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    const text = printed()
    expect(text).toContain('! Node.js 21.99.99 is older than Tusk\'s Tomes supports')
    expect(text).toContain("Tusk's Tomes needs Node.js 22 or newer, and this computer runs Node.js 21.99.99.")
    expect(text).toContain('       winget install OpenJS.NodeJS.LTS')
    expect(text).toContain('The app keeps running')
    expect(slogMock).toHaveBeenCalledWith('server', { event: 'node_unsupported', node: '21.99.99', minimum: 22 })
  })

  it('gives each platform its own install command', async () => {
    await warnIfNodeUnsupported({ version: '20.19.0', platform: 'darwin' })
    expect(printed()).toContain('brew install node@22')
  })

  it('says nothing on Node 22.0.0 or newer', async () => {
    for (const version of ['22.0.0', '24.20.0']) {
      expect(await warnIfNodeUnsupported({ version, platform: 'linux' })).toBe(false)
    }
    expect(warn).not.toHaveBeenCalled()
    expect(slogMock).not.toHaveBeenCalled()
  })

  it('checks the running process by default, which CI keeps on a supported Node', async () => {
    expect(await warnIfNodeUnsupported()).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })
})
