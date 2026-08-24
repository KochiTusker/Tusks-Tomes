// Client for /api/system/info. The recommendation engine reads this to
// learn the user's VRAM ceiling without making them type it in.

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

let cache: SystemInfo | null = null
let inflight: Promise<SystemInfo> | null = null

export async function getSystemInfo(): Promise<SystemInfo> {
  if (cache) return cache
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/system/info')
      if (!res.ok) throw new Error(`GET /api/system/info failed: HTTP ${res.status}`)
      const json = (await res.json()) as SystemInfo
      cache = json
      return json
    } finally {
      inflight = null
    }
  })()
  return inflight
}
