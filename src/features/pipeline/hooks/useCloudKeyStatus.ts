import { useEffect, useState } from 'react'
import {
  fetchConfiguredCloudKeyOptions,
  hasApiKey,
  isLocalProvider,
} from '@/features/providers'
import { listConfiguredCloudKeys } from '@/features/routing'

/** Whether a cloud run has no key at all to use, and whether a Paid Gemini key
 *  is configured (which the rate-limit dialog offers as a fallback). */
export function useCloudKeyStatus(): { apiKeyMissing: boolean; paidKeyAvailable: boolean } {
  const [cloudKeys, setCloudKeys] = useState<Array<unknown> | null>(null)
  const apiKeyMissing =
    !isLocalProvider() && cloudKeys !== null && cloudKeys.length === 0 && !hasApiKey()
  const [paidKeyAvailable, setPaidKeyAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchConfiguredCloudKeyOptions()
      .then((opts) => {
        if (!cancelled) setPaidKeyAvailable(opts.some((o) => o.id === 'gemini-paid'))
      })
      .catch(() => {
        if (!cancelled) setPaidKeyAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    listConfiguredCloudKeys()
      .then((c) => {
        if (!cancelled) setCloudKeys(c)
      })
      .catch(() => {
        if (!cancelled) setCloudKeys([])
      })
    return () => {
      cancelled = true
    }
  }, [])
  return { apiKeyMissing, paidKeyAvailable }
}
