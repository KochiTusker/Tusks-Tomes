import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Sparkles, Settings as SettingsIcon } from 'lucide-react'
import {
  findSelectedPersona,
  getPersonas,
  peekPersonas,
  setSelectedPersona,
  subscribePersonas,
} from '@/lib/personas'
import type { PersonasDocument } from '@/lib/personas/types'

const BARD_VALUE = '__bard__'

/** Header chip that lets the user swap the Chronicle narrator persona. */
export function PersonaPicker() {
  const [doc, setDoc] = useState<PersonasDocument>(() => peekPersonas())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getPersonas()
      .then((d) => { if (!cancelled) setDoc(d) })
      .catch(() => { /* server unreachable — the bard default still renders */ })
    const unsub = subscribePersonas((d) => { if (!cancelled) setDoc(d) })
    return () => { cancelled = true; unsub() }
  }, [])

  const selected = findSelectedPersona(doc)
  const currentValue = selected ? selected.id : BARD_VALUE

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value
    const next = v === BARD_VALUE ? null : v
    setSaving(true)
    try {
      await setSelectedPersona(next)
    } catch (err) {
      toast.error(`Couldn't switch persona: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  function openManager() {
    // Settings tab listens to this event in App.tsx to jump tabs +
    // scroll the Personas card into view.
    window.dispatchEvent(new CustomEvent('sbts:open-personas'))
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm">
      <Sparkles className="h-4 w-4 text-primary" />
      <label htmlFor="persona-picker" className="text-sm font-medium">
        Narrator
      </label>
      <select
        id="persona-picker"
        value={currentValue}
        onChange={onChange}
        disabled={saving}
        className="h-8 min-w-[12rem] rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-60"
      >
        <option value={BARD_VALUE}>Bard (default)</option>
        {doc.personas.length > 0 && <option disabled>──────────</option>}
        {doc.personas.map((p) => (
          <option key={p.id} value={p.id}>
            {p.preset ? `★ ${p.name}` : p.name}
          </option>
        ))}
      </select>
      {selected?.description && (
        <span className="hidden text-xs text-muted-foreground sm:inline" title={selected.description}>
          {selected.description.length > 80
            ? selected.description.slice(0, 77) + '…'
            : selected.description}
        </span>
      )}
      <button
        type="button"
        onClick={openManager}
        className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        title="Manage personas in Settings"
      >
        <SettingsIcon className="h-3.5 w-3.5" />
        Manage
      </button>
    </div>
  )
}
