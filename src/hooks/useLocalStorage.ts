import { useCallback, useEffect, useState } from 'react'
import { safeGet, safeSet } from '@/lib/storage'

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => safeGet<T>(key, initial))

  const setAndPersist = useCallback(
    (updater: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next =
          typeof updater === 'function'
            ? (updater as (p: T) => T)(prev)
            : updater
        safeSet(key, next)
        return next
      })
    },
    [key]
  )

  useEffect(() => {
    function handler(e: StorageEvent) {
      if (e.key !== key || e.newValue == null) return
      try {
        setValue(JSON.parse(e.newValue) as T)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [key])

  return [value, setAndPersist] as const
}
