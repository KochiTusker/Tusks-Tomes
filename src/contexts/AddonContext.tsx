import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type AddonEntry = {
  name: string
  displayName: string
  description: string
  wip: boolean
  /** Optional Help-tab doc slug for this add-on. Surfaces a "Read docs" link. */
  docSlug?: string
  /** Prerequisites are installed. May be true before a restart picks up routes. */
  enabled: boolean
  /** User hasn't toggled this add-on off. Lets users disable without losing the install. */
  configEnabled: boolean
  /** Routes are mounted in the current server process. Source of truth for UI. */
  loaded: boolean
}

type AddonContextValue = {
  addons: AddonEntry[]
  loading: boolean
  isEnabled: (name: string) => boolean
  isLoaded: (name: string) => boolean
  refresh: () => Promise<void>
  setEnabled: (name: string, on: boolean) => Promise<void>
}

const AddonContext = createContext<AddonContextValue>({
  addons: [],
  loading: true,
  isEnabled: () => false,
  isLoaded: () => false,
  refresh: async () => {},
  setEnabled: async () => {},
})

export function AddonProvider({ children }: { children: ReactNode }) {
  const [addons, setAddons] = useState<AddonEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/addons')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { addons: list } = (await res.json()) as { addons: AddonEntry[] }
      setAddons(list)
    } catch {
      // Non-fatal — defaults to no add-ons enabled
    } finally {
      setLoading(false)
    }
  }, [])

  const setEnabled = useCallback(async (name: string, on: boolean) => {
    const res = await fetch(`/api/addons/${name}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configEnabled: on }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    await refresh()
  }, [refresh])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <AddonContext.Provider
      value={{
        addons,
        loading,
        isEnabled: (name) => addons.some((a) => a.name === name && a.enabled),
        isLoaded: (name) => addons.some((a) => a.name === name && a.loaded),
        refresh,
        setEnabled,
      }}
    >
      {children}
    </AddonContext.Provider>
  )
}

export function useAddons() {
  return useContext(AddonContext)
}
