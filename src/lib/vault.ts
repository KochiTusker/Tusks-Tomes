// React-side client for /api/vault — pairing detection + chronicle
// export to the sister project Tusk's Vault.

export type VaultPairStatus = {
  paired: boolean
  vaultRoot?: string
  loreDir?: string
  loreDirWritable?: boolean
  source: 'env' | 'sibling' | 'none'
  notes?: string[]
}

export async function getVaultPairStatus(): Promise<VaultPairStatus> {
  const res = await fetch('/api/vault/pair')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET /api/vault/pair failed: HTTP ${res.status}. ${body.slice(0, 200)}`)
  }
  return (await res.json()) as VaultPairStatus
}

export type VaultExportResult = {
  ok: true
  written: string
  relativeToVault: string
}

export async function exportChronicleToVault(args: {
  campaign: string
  sessionNumber: number
  content: string
  fileName?: string
}): Promise<VaultExportResult> {
  const res = await fetch('/api/vault/export-chronicle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      /* ignore parse */
    }
    throw new Error(message)
  }
  return (await res.json()) as VaultExportResult
}
