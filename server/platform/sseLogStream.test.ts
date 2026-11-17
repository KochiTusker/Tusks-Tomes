import { describe, it, expect } from 'vitest'
import { streamLogToSse } from './sseLogStream.js'

function fakeRes() {
  const headers: Record<string, string> = {}
  const writes: string[] = []
  let ended = 0
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v },
    flushHeaders: () => { writes.push('<flush>') },
    write: (s: string) => { writes.push(s) },
    end: () => { ended++ },
  }
  return { res: res as never, headers, writes, ended: () => ended }
}

describe('streamLogToSse', () => {
  it('writes headers, a line event per entry, then done', async () => {
    const f = fakeRes()
    await streamLogToSse<{ m: string }>(f.res, async (onLine) => {
      onLine({ m: 'a' })
      return 0
    })
    expect(f.headers).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    expect(f.writes).toEqual([
      '<flush>',
      'event: line\n', 'data: {"m":"a"}\n\n',
      'event: done\n', 'data: {"exitCode":0}\n\n',
    ])
    expect(f.ended()).toBe(1)
  })

  it('writes an error event when the job throws, and still ends', async () => {
    const f = fakeRes()
    await streamLogToSse(f.res, async () => { throw new Error('boom') })
    expect(f.writes).toEqual(['<flush>', 'event: error\n', 'data: {"error":"boom"}\n\n'])
    expect(f.ended()).toBe(1)
  })
})
