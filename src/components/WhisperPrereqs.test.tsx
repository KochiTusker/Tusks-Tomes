/** @vitest-environment jsdom */
// The Whisper install gate's three outcomes, as a component contract:
//   - unsupported Python  → blocked with the remedy, NO install button
//     (nothing to acknowledge — the install cannot succeed);
//   - NVIDIA card found   → proceed, naming the card;
//   - no NVIDIA card      → the acknowledgement checkbox gates the button;
//   - probe failed        → fail OPEN with a note, never fail closed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WhisperInstallPrecheck } from './WhisperPrereqs'
import type { SystemInfo } from '@/lib/system'

vi.mock('@/lib/system', () => ({
  getSystemInfo: vi.fn(),
}))
import { getSystemInfo } from '@/lib/system'

function sys(over: Partial<SystemInfo>): SystemInfo {
  return {
    ramGb: 32,
    cpuCount: 20,
    cpuModel: 'test-cpu',
    platform: 'win32',
    arch: 'x64',
    gpu: { detected: false, source: null },
    python: { found: true, version: '3.12.4', supported: true },
    ...over,
  } as SystemInfo
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderGate(info: SystemInfo | Error) {
  const mocked = vi.mocked(getSystemInfo)
  if (info instanceof Error) mocked.mockRejectedValue(info)
  else mocked.mockResolvedValue(info)
  const onProceed = vi.fn()
  render(<WhisperInstallPrecheck onProceed={onProceed} onCancel={vi.fn()} installing={false} />)
  // The checking state renders no buttons; the first button appearing
  // means the probe resolved and an outcome is on screen.
  await screen.findAllByRole('button')
  return onProceed
}

describe('WhisperInstallPrecheck', () => {
  it('unsupported Python blocks before the download — no install button at all', async () => {
    await renderGate(sys({ python: { found: true, version: '3.13.12', supported: false } }))
    expect(screen.getByText(/3\.13\.12 can't run Whisper/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Download and install/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Close/i })).toBeTruthy()
  })

  it('missing Python blocks with the PATH remedy', async () => {
    await renderGate(sys({ python: { found: false, version: null, supported: false } }))
    expect(screen.getByText(/Python was not found/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Download and install/i })).toBeNull()
  })

  it('an NVIDIA card proceeds, and the card is named so the check is visibly real', async () => {
    const onProceed = await renderGate(
      sys({ gpu: { detected: true, name: 'NVIDIA GeForce RTX 3070 Ti', vramGb: 8, source: 'nvidia-smi' } }),
    )
    expect(screen.getByText(/RTX 3070 Ti/)).toBeTruthy()
    const btn = screen.getByRole('button', { name: /Download and install/i })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(btn)
    expect(onProceed).toHaveBeenCalledOnce()
  })

  it('no NVIDIA card: the acknowledgement checkbox gates the install', async () => {
    const onProceed = await renderGate(sys({ gpu: { detected: false, source: null } }))
    expect(screen.getByText(/No dedicated graphics card/i)).toBeTruthy()
    const btn = screen.getByRole('button', { name: /Download and install/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onProceed).toHaveBeenCalledOnce()
  })

  it('a failed probe fails OPEN with a note — never blocks a working machine', async () => {
    await renderGate(new Error('nvidia-smi exploded'))
    expect(screen.getByText(/Couldn't check this computer/i)).toBeTruthy()
    const btn = screen.getByRole('button', { name: /Download and install/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })
})
