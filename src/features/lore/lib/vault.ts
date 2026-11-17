// React-side client for /api/vault — pairing detection + chronicle
// export to the sister project Tusk's Vault.

import { apiJson } from '@/platform/apiClient'

export type VaultPairStatus = {
  paired: boolean
  vaultRoot?: string
  loreDir?: string
  loreDirWritable?: boolean
  source: 'env' | 'sibling' | 'none'
  notes?: string[]
}

export async function getVaultPairStatus(): Promise<VaultPairStatus> {
  return apiJson<VaultPairStatus>('/api/vault/pair', { errorMode: 'text', bodySlice: 200 })
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
  return apiJson<VaultExportResult>('/api/vault/export-chronicle', {
    method: 'POST',
    body: args,
    errorMode: 'json',
  })
}
