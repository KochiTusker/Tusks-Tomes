// Client for /api/system/info. The recommendation engine reads this to
// learn the user's VRAM ceiling without making them type it in.

import { createDocClient } from '@/platform/docClient'

export type SystemInfo = {
  ramGb: number
  cpuCount: number
  cpuModel: string | null
  platform: string
  arch: string
  gpu: {
    detected: boolean
    name?: string
    vramGb?: number
    source: 'nvidia-smi' | null
    error?: string
  }
  python: {
    found: boolean
    version: string | null
    supported: boolean
  }
}

const client = createDocClient<SystemInfo>({ path: '/api/system/info' })

export const getSystemInfo = client.get
