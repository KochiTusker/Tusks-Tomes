import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, ChevronDown, ChevronRight, KeyRound, Save, ScanSearch, ShieldQuestion, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  deleteProviderKey,
  getAvailabilityCache,
  getProvidersSummary,
  probeProviderKey,
  putProviderKey,
  slotForProvider,
  subscribeProviders,
  testProviderKey,
  type AvailabilityCache,
  type AvailabilitySlot,
  type ProviderName,
  type ProvidersSummary,
  type SlotAvailability,
} from '@/lib/providerSettings'
import { refreshProviders } from '@/lib/providers'

type KeySlotRow = {
  id: ProviderName
  label: string
  description: string
  placeholder: string
}

type ProviderGroup = {
  title: string
  description: string
  keys: KeySlotRow[]
}

// Each group renders as one card; multi-key groups (Gemini) show every
// slot as a sub-row inside the same card so the Free key is visually
// nested under the Paid key rather than appearing as a sibling provider.
const PROVIDER_GROUPS: ProviderGroup[] = [
  {
    title: 'Google Gemini',
    description:
      'The main pipeline needs a billing-enabled Google Cloud key. An optional free-tier key lets the cost-saving presets move the smallest phases off your bill.',
    keys: [
      {
        id: 'gemini',
        label: 'Paid tier (billing-enabled) — primary key, required',
        description: "Required for the main pipeline. Supports Gemini 3.x and high-throughput runs.",
        placeholder: 'AIza…',
      },
      {
        id: 'geminiFree',
        label: 'Free tier (optional)',
        description:
          'Used by the cost-saving presets for the smallest phases, where free-tier quotas are comfortable. Skip it unless you want that extra saving.',
        placeholder: 'AIza…',
      },
    ],
  },
  {
    title: 'OpenRouter',
    description:
      'One key, around 400 models from every major vendor — a cheap model for the mechanical phases, a strong one for the prose, without an account for each. Requests only go to hosts that do not retain your prompts; models that cannot meet that bar stay hidden unless you allow them per-model.',
    keys: [
      {
        id: 'openrouter',
        label: 'API key',
        description: '',
        placeholder: 'sk-or-…',
      },
    ],
  },
]

function statusFor(summary: ProvidersSummary | null, id: ProviderName): string {
  if (!summary) return 'Loading…'
  // The keystore stores the free key under the legacy slot name 'geminiFallback'.
  const slot = id === 'geminiFree' ? 'geminiFallback' : id
  const configured = summary.configured.includes(slot)
  if (!configured) return 'Not configured'
  return 'Configured'
}

export function ProviderSettings() {
  const [summary, setSummary] = useState<ProvidersSummary | null>(null)
  const [availability, setAvailability] = useState<AvailabilityCache>({})
  const [drafts, setDrafts] = useState<Record<ProviderName, string>>({
    gemini: '',
    geminiFree: '',
    openrouter: '',
  })
  const [editing, setEditing] = useState<Record<ProviderName, boolean>>({
    gemini: false,
    geminiFree: false,
    openrouter: false,
  })
  const [busy, setBusy] = useState<ProviderName | null>(null)
  const [testing, setTesting] = useState<ProviderName | null>(null)
  const [probing, setProbing] = useState<ProviderName | null>(null)
  // Probed-model lists are collapsed by default; track which slots the user
  // has expanded (keyed by provider id).
  const [expandedAvail, setExpandedAvail] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    function load() {
      Promise.all([getProvidersSummary(), getAvailabilityCache().catch(() => ({}))])
        .then(([s, cache]) => {
          if (cancelled) return
          setSummary(s)
          setAvailability(cache)
        })
        .catch((err) => {
          if (!cancelled) toast.error(`Failed to load provider settings: ${(err as Error).message}`)
        })
    }
    load()
    const unsubscribe = subscribeProviders(load)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  async function save(id: ProviderName) {
    const key = drafts[id].trim()
    if (!key) {
      toast.error('Enter a key first.')
      return
    }
    setBusy(id)
    try {
      const next = await putProviderKey(id, key)
      setSummary(next)
      setDrafts((d) => ({ ...d, [id]: '' }))
      setEditing((e) => ({ ...e, [id]: false }))
      await refreshProviders()
      toast.success(`${id} key saved.`)
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function clear(id: ProviderName) {
    setBusy(id)
    try {
      const next = await deleteProviderKey(id)
      setSummary(next)
      await refreshProviders()
      toast.success(`${id} key removed.`)
    } catch (err) {
      toast.error(`Clear failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function test(id: ProviderName) {
    setTesting(id)
    try {
      const result = await testProviderKey(id)
      if (result.ok) toast.success(`${id} key works.`)
      else toast.error(`${id} test failed: ${result.error ?? 'Unknown'}`)
    } catch (err) {
      toast.error(`${id} test errored: ${(err as Error).message}`)
    } finally {
      setTesting(null)
    }
  }

  async function probe(id: ProviderName) {
    setProbing(id)
    try {
      const result = await probeProviderKey(id)
      if (result.ok && result.availability) {
        setAvailability((prev) => ({ ...prev, [slotForProvider(id)]: result.availability }))
        const ok = result.availability.probed.filter((p) => p.accessible).length
        const total = result.availability.probed.length
        toast.success(`Probed ${id}: ${ok}/${total} models accessible.`)
      } else {
        toast.error(`${id} probe failed: ${result.error ?? 'Unknown'}`)
      }
    } catch (err) {
      toast.error(`${id} probe errored: ${(err as Error).message}`)
    } finally {
      setProbing(null)
    }
  }

  function renderAvailability(id: ProviderName, slotAvail: SlotAvailability | undefined) {
    if (!slotAvail) return null
    const accessible = slotAvail.probed.filter((p) => p.accessible)
    const inaccessible = slotAvail.probed.filter((p) => !p.accessible)
    const fetched = new Date(slotAvail.fetchedAt)
    // Compare fingerprints across the Gemini Paid + Free slots — equal
    // fingerprint means both slots hold the same key string.
    const thisSlot = slotForProvider(id)
    const otherGeminiSlot: AvailabilitySlot | null =
      thisSlot === 'gemini'
        ? 'geminiFallback'
        : thisSlot === 'geminiFallback'
          ? 'gemini'
          : null
    const otherFingerprint = otherGeminiSlot ? availability[otherGeminiSlot]?.keyFingerprint : undefined
    const duplicateKey =
      !!slotAvail.keyFingerprint && !!otherFingerprint && slotAvail.keyFingerprint === otherFingerprint
    const expanded = expandedAvail.has(id)
    const toggle = () =>
      setExpandedAvail((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    return (
      <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-xs space-y-2">
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center justify-between gap-2 text-left"
          aria-expanded={expanded}
        >
          <span className="flex items-center gap-1 font-medium">
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Probed model access
            <span className="ml-1 font-normal text-muted-foreground">
              ({accessible.length} accessible{inaccessible.length > 0 ? `, ${inaccessible.length} blocked` : ''})
            </span>
          </span>
          <span className="text-muted-foreground">{fetched.toLocaleString()}</span>
        </button>
        {!expanded ? null : (
        <>
        {slotAvail.keyFingerprint && (
          <div className="text-muted-foreground">
            Key fingerprint:{' '}
            <code className="font-mono">{slotAvail.keyFingerprint}</code>
            {duplicateKey && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                ⚠ same as your other Gemini slot — both rows hold the same key
                value
              </span>
            )}
          </div>
        )}
        {accessible.length > 0 && (
          <div>
            <div className="flex items-center gap-1 text-green-600 font-medium">
              <CheckCircle2 className="h-3 w-3" />
              Accessible ({accessible.length})
            </div>
            <ul className="mt-1 ml-4 list-disc space-y-0.5 text-muted-foreground">
              {accessible.map((p) => (
                <li key={p.id} className="font-mono">
                  {p.id}
                </li>
              ))}
            </ul>
          </div>
        )}
        {inaccessible.length > 0 && (
          <div>
            <div className="flex items-center gap-1 text-amber-600 font-medium">
              <XCircle className="h-3 w-3" />
              Blocked ({inaccessible.length})
            </div>
            <ul className="mt-1 ml-4 list-disc space-y-0.5 text-muted-foreground">
              {inaccessible.map((p) => (
                <li key={p.id}>
                  <span className="font-mono">{p.id}</span>
                  {p.reason && <span className="ml-2 italic">— {p.reason}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-muted-foreground italic">
          Only "Accessible" models can be picked for runs that use this key.
        </p>
        </>
        )}
      </div>
    )
  }

  function renderKeyRow(row: KeySlotRow, indented: boolean) {
    const status = statusFor(summary, row.id)
    const slot = slotForProvider(row.id)
    const isConfigured = summary?.configured.includes(slot) ?? false
    const slotAvail = availability[slot]
    // Probe is now supported for every slot — server-side probeXKey
    // Probing needs a per-provider model list to check against. Gemini has
    // one; OpenRouter's catalogue is public and key-less, so its picker
    // fetches directly rather than probing.
    const supportsProbe = row.id === 'gemini' || row.id === 'geminiFree'
    return (
      <div
        key={row.id}
        className={`space-y-2 rounded-md border border-border p-3 ${
          indented ? 'ml-6 bg-muted/20' : ''
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-0.5">
            <div className="font-medium text-sm">{row.label}</div>
            {row.description && (
              <p className="text-xs text-muted-foreground">{row.description}</p>
            )}
            <div className="text-xs text-muted-foreground flex items-center gap-1 pt-1">
              {isConfigured ? (
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              ) : (
                <ShieldQuestion className="h-3 w-3" />
              )}
              {status}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isConfigured && (
              <Button
                variant="outline"
                size="sm"
                disabled={testing === row.id}
                onClick={() => test(row.id)}
              >
                {testing === row.id ? 'Testing…' : 'Test'}
              </Button>
            )}
            {isConfigured && supportsProbe && (
              <Button
                variant="outline"
                size="sm"
                disabled={probing === row.id}
                onClick={() => probe(row.id)}
                title="Probe which models this key can actually call (consumes a small amount of quota)"
              >
                <ScanSearch className="mr-1 h-4 w-4" />
                {probing === row.id ? 'Probing…' : 'Probe models'}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEditing((e) => ({ ...e, [row.id]: !e[row.id] }))}
            >
              {editing[row.id] ? 'Cancel' : isConfigured ? 'Replace' : 'Add'}
            </Button>
            {isConfigured && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Clear ${row.label}`}
                disabled={busy === row.id}
                onClick={() => clear(row.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        {editing[row.id] && (
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={`key-${row.id}`}>New {row.label.toLowerCase()}</Label>
              <Input
                id={`key-${row.id}`}
                type="password"
                placeholder={row.placeholder}
                autoComplete="off"
                value={drafts[row.id]}
                onChange={(e) => setDrafts((d) => ({ ...d, [row.id]: e.target.value }))}
              />
            </div>
            <Button
              variant="default"
              size="sm"
              disabled={busy === row.id}
              onClick={() => save(row.id)}
            >
              <Save className="mr-2 h-4 w-4" />
              {busy === row.id ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
        {isConfigured && supportsProbe && renderAvailability(row.id, slotAvail)}
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          API Keys
        </CardTitle>
        <CardDescription>
          Keys are encrypted at rest and bound to this machine — they cannot be
          decrypted anywhere else, and they never leave your computer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {PROVIDER_GROUPS.map((group) => (
          <section key={group.title} className="space-y-3">
            <div className="space-y-1">
              <h3 className="font-display tracking-wider uppercase text-sm">{group.title}</h3>
              <p className="text-xs text-muted-foreground">{group.description}</p>
            </div>
            <div className="space-y-2">
              {group.keys.map((row, index) => renderKeyRow(row, index > 0))}
            </div>
          </section>
        ))}
      </CardContent>
    </Card>
  )
}
