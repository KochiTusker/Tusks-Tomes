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
  /** Real-user validation status. Gemini has been exercised end-to-end
   *  against live sessions (Phases B-G validations); Claude and OpenAI
   *  have working SDK adapters + unit tests but have never been validated
   *  against a real account. The badge gives users honest disclosure so
   *  they don't assume Claude/OpenAI are at the same maturity level. */
  validationStatus: 'validated' | 'pending'
  /** One-line explanation shown in the badge tooltip. */
  validationNote: string
}

// Each group renders as one card; multi-key groups (Gemini) show every
// slot as a sub-row inside the same card so the Free key is visually
// nested under the Paid key rather than appearing as a sibling provider.
const PROVIDER_GROUPS: ProviderGroup[] = [
  {
    title: 'Google Gemini',
    description:
      "A billing-enabled Google Cloud API key is required for the main pipeline. An optional free-tier (non-billing) key can be configured as a secondary that handles Phase 4 extras only when the Smart Budget routing preset is selected; every other phase always uses the paid key. See providers.md for the v1.1.0 policy.",
    validationStatus: 'validated',
    validationNote:
      'Validated end-to-end against real Gemini sessions (cost reconciled, pause/resume tested).',
    keys: [
      {
        id: 'gemini',
        label: 'Paid tier (billing-enabled) — primary key, required',
        description: "Required for the main pipeline. Supports Gemini 3.x and high-throughput runs.",
        placeholder: 'AIza…',
      },
      {
        id: 'geminiFree',
        label: 'Free tier (optional, Smart Budget extras only)',
        description:
          'Used by the Smart Budget routing preset for Phase 4 (extras) only — the smallest JSON phase, where Free Flash quotas are comfortable. Skip this slot unless you also want the free-tier extras saving.',
        placeholder: 'AIza…',
      },
    ],
  },
  {
    title: 'Anthropic Claude',
    description: 'Pay-as-you-go API key from console.anthropic.com.',
    validationStatus: 'pending',
    validationNote:
      'Adapter implemented and unit-tested against the May-2026 Anthropic SDK shape but not yet validated against a live account. Please share findings via the feedback link if you try it.',
    keys: [
      {
        id: 'claude',
        label: 'API key',
        description: '',
        placeholder: 'sk-ant-…',
      },
    ],
  },
  {
    title: 'OpenAI',
    description: 'Pay-as-you-go API key from platform.openai.com.',
    validationStatus: 'pending',
    validationNote:
      'Adapter implemented and unit-tested against the OpenAI Responses API but not yet validated against a live account. Please share findings via the feedback link if you try it.',
    keys: [
      {
        id: 'openai',
        label: 'API key',
        description: '',
        placeholder: 'sk-…',
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
    claude: '',
    openai: '',
  })
  const [editing, setEditing] = useState<Record<ProviderName, boolean>>({
    gemini: false,
    geminiFree: false,
    claude: false,
    openai: false,
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
    // functions cover Gemini Paid, Gemini Free, Claude, and OpenAI.
    // Keeping a boolean for clarity / future opt-outs (e.g. local).
    const supportsProbe =
      row.id === 'gemini' ||
      row.id === 'geminiFree' ||
      row.id === 'claude' ||
      row.id === 'openai'
    return (
      <div
        key={row.id}
        className={`space-y-2 rounded-md border border-border p-3 ${
          indented ? 'ml-6 bg-muted/20' : ''
        }`}
      >
        <div className="flex items-start justify-between gap-3">
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
          <div className="flex items-center gap-2">
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
          Keys are encrypted at rest on this machine and cannot be decrypted on
          another machine without your assistance. They never leave your computer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {PROVIDER_GROUPS.map((group) => (
          <section key={group.title} className="space-y-3">
            <div className="space-y-1">
              <h3 className="font-display tracking-wider uppercase text-sm flex items-center gap-2">
                <span>{group.title}</span>
                <span
                  className={
                    group.validationStatus === 'validated'
                      ? 'inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-sm bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                      : 'inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-sm bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30'
                  }
                  title={group.validationNote}
                >
                  {group.validationStatus === 'validated' ? '✓ Validated' : '⚠ Pending validation'}
                </span>
              </h3>
              <p className="text-xs text-muted-foreground">{group.description}</p>
              {group.validationStatus === 'pending' && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {group.validationNote}
                </p>
              )}
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
