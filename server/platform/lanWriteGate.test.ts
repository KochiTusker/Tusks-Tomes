// Phase 7 — LAN-write gate regression tests.
//
// Pins the default: when TUSKS_HOST=0.0.0.0 is set, LAN devices can
// read but cannot write unless TUSKS_LAN_WRITES=1 is also set. A
// future regression that removes the gate or flips its default would
// silently expose every write endpoint to LAN peers.

import { describe, expect, it, vi } from 'vitest'
import {
  isWriteRequest,
  lanWriteGate,
  parseLanWritesEnv,
} from './lanWriteGate.js'
import type { Request, Response } from 'express'

describe('isWriteRequest — pure predicate', () => {
  const safe = ['GET', 'HEAD', 'OPTIONS', 'get', 'Head', 'options']
  const write = ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'PuT']
  for (const m of safe) {
    it(`${JSON.stringify(m)} is NOT a write`, () =>
      expect(isWriteRequest(m)).toBe(false))
  }
  for (const m of write) {
    it(`${JSON.stringify(m)} IS a write`, () =>
      expect(isWriteRequest(m)).toBe(true))
  }
})

describe('parseLanWritesEnv — env-var parsing', () => {
  it('treats unset / empty as false', () => {
    expect(parseLanWritesEnv(undefined)).toBe(false)
    expect(parseLanWritesEnv('')).toBe(false)
    expect(parseLanWritesEnv('   ')).toBe(false)
  })
  it('parses the canonical truthy forms (case-insensitive)', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', 'On']) {
      expect(parseLanWritesEnv(v)).toBe(true)
    }
  })
  it('treats anything else as false (fail-closed)', () => {
    for (const v of ['0', 'false', 'no', 'off', 'maybe', 'sure', 'enable']) {
      expect(parseLanWritesEnv(v)).toBe(false)
    }
  })
})

describe('lanWriteGate middleware', () => {
  type Captured = { status?: number; json?: unknown; nextCalled?: boolean }

  function exercise(opts: {
    method: string
    remoteAddress: string | undefined
    enabled: boolean
  }): Captured {
    const captured: Captured = {}
    const req = {
      method: opts.method,
      socket: { remoteAddress: opts.remoteAddress },
    } as unknown as Request
    const res = {
      status(n: number) {
        captured.status = n
        return this
      },
      json(body: unknown) {
        captured.json = body
        return this
      },
    } as unknown as Response
    const next = vi.fn(() => {
      captured.nextCalled = true
    })
    lanWriteGate({ enabled: opts.enabled })(req, res, next)
    return captured
  }

  describe('reads always proceed', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      it(`${method} from loopback → next()`, () => {
        const c = exercise({ method, remoteAddress: '127.0.0.1', enabled: false })
        expect(c.nextCalled).toBe(true)
        expect(c.status).toBeUndefined()
      })
      it(`${method} from LAN (writes disabled) → next()`, () => {
        const c = exercise({ method, remoteAddress: '192.168.1.42', enabled: false })
        expect(c.nextCalled).toBe(true)
      })
      it(`${method} from LAN (writes enabled) → next()`, () => {
        const c = exercise({ method, remoteAddress: '192.168.1.42', enabled: true })
        expect(c.nextCalled).toBe(true)
      })
    }
  })

  describe('writes — loopback always proceeds (regardless of toggle)', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      it(`${method} from loopback (writes disabled) → next()`, () => {
        const c = exercise({ method, remoteAddress: '127.0.0.1', enabled: false })
        expect(c.nextCalled).toBe(true)
        expect(c.status).toBeUndefined()
      })
      it(`${method} from ::1 → next()`, () => {
        const c = exercise({ method, remoteAddress: '::1', enabled: false })
        expect(c.nextCalled).toBe(true)
      })
      it(`${method} from ::ffff:127.0.0.1 → next()`, () => {
        const c = exercise({ method, remoteAddress: '::ffff:127.0.0.1', enabled: false })
        expect(c.nextCalled).toBe(true)
      })
    }
  })

  describe('writes — LAN sources gated by toggle (the headline regression test)', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      it(`${method} from LAN with toggle OFF → 403`, () => {
        const c = exercise({ method, remoteAddress: '192.168.1.42', enabled: false })
        expect(c.nextCalled).toBeUndefined()
        expect(c.status).toBe(403)
        expect((c.json as { error: string }).error).toMatch(/LAN write access is disabled/i)
        expect((c.json as { error: string }).error).toMatch(/TUSKS_LAN_WRITES/)
      })
      it(`${method} from LAN with toggle ON → next()`, () => {
        const c = exercise({ method, remoteAddress: '192.168.1.42', enabled: true })
        expect(c.nextCalled).toBe(true)
        expect(c.status).toBeUndefined()
      })
    }
  })

  it('403 for LAN POST even when remoteAddress is an IPv4-mapped IPv6 LAN', () => {
    const c = exercise({
      method: 'POST',
      remoteAddress: '::ffff:192.168.1.42',
      enabled: false,
    })
    expect(c.status).toBe(403)
  })

  it('403 for LAN POST when remoteAddress is undefined (fail-closed)', () => {
    const c = exercise({ method: 'POST', remoteAddress: undefined, enabled: false })
    expect(c.status).toBe(403)
  })

  it('403 for LAN POST from a public IP source (would mean a misconfigured deployment)', () => {
    const c = exercise({ method: 'POST', remoteAddress: '8.8.8.8', enabled: false })
    expect(c.status).toBe(403)
  })
})
