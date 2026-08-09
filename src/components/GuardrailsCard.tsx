import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Shield, ShieldCheck, ShieldOff } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  countActiveGuardrails,
  DEFAULT_GUARDRAILS,
  GUARDRAIL_KEYS,
  GUARDRAILS_EVENT,
  getGuardrails,
  setGuardrails,
} from '@/lib/guardrails'
import type { GuardrailKey, GuardrailsSettings } from '@/lib/guardrails'

type Meta = {
  label: string
  affects: string
  description: string
}

const META: Record<GuardrailKey, Meta> = {
  harassment: {
    label: 'Harassment',
    affects: 'Gemini',
    description: 'Filters insults, threats, and abusive language. Claude and OpenAI ignore this — they have no per-category API toggle.',
  },
  hateSpeech: {
    label: 'Hate speech',
    affects: 'Gemini',
    description: 'Filters content targeting protected groups. Claude and OpenAI ignore this — no per-category API toggle.',
  },
  sexuallyExplicit: {
    label: 'Sexually explicit',
    affects: 'Gemini',
    description: 'Filters sexual content. Claude and OpenAI ignore this — no per-category API toggle.',
  },
  dangerousContent: {
    label: 'Dangerous content',
    affects: 'Gemini',
    description: 'Filters self-harm, weapons, and unsafe-act instructions. Claude and OpenAI ignore this — no per-category API toggle.',
  },
  strictFraming: {
    label: 'Strict content framing',
    affects: 'Claude · OpenAI',
    description: 'Drops the "preserve mature themes verbatim" framing prepended to the system prompt. Claude and OpenAI then sanitise per their own defaults. Gemini ignores this — it uses the four categories above.',
  },
}

/** Small collapsed card mounted inside ActiveProviderCard. Displays the
 *  current guardrails posture and opens a popup to adjust per-toggle. */
export function GuardrailsCard() {
  const [g, setG] = useState<GuardrailsSettings>(() => getGuardrails())
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as GuardrailsSettings | undefined
      if (detail) setG(detail)
    }
    window.addEventListener(GUARDRAILS_EVENT, handler)
    return () => window.removeEventListener(GUARDRAILS_EVENT, handler)
  }, [])

  const active = countActiveGuardrails(g)
  const total = GUARDRAIL_KEYS.length
  const allOff = active === 0
  const allOn = active === total

  const Icon = allOff ? ShieldOff : allOn ? ShieldCheck : Shield
  const status = allOff
    ? 'All off — model responses are unfiltered.'
    : allOn
      ? 'All on — strictest safety on every provider.'
      : `${active} of ${total} on.`

  function update(next: GuardrailsSettings) {
    setGuardrails(next)
    setG(next)
  }

  function toggle(key: GuardrailKey) {
    update({ ...g, [key]: !g[key] })
  }

  function setAll(value: boolean) {
    const next: GuardrailsSettings = { ...g }
    for (const k of GUARDRAIL_KEYS) next[k] = value
    update(next)
    toast.success(value ? 'All guardrails enabled.' : 'All guardrails disabled.')
  }

  function reset() {
    update({ ...DEFAULT_GUARDRAILS })
    toast.success('Guardrails reset to defaults (all off).')
  }

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-start gap-2">
          <Icon className={`mt-0.5 h-4 w-4 ${allOff ? 'text-muted-foreground' : 'text-primary'}`} />
          <div className="min-w-0">
            <div className="text-sm font-medium">Guardrails</div>
            <div className="text-xs text-muted-foreground">{status}</div>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="ml-auto">
          Adjust
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Adjust guardrails</DialogTitle>
            <DialogDescription>
              Toggle individual safety filters or use the master buttons. Each toggle is labelled
              with which provider it actually affects — Claude and OpenAI don't expose per-category
              API controls, so only the strict-framing toggle changes their behaviour.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setAll(true)} disabled={allOn}>
              All on
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAll(false)} disabled={allOff}>
              All off
            </Button>
            <Button size="sm" variant="ghost" onClick={reset} className="ml-auto">
              Reset to defaults
            </Button>
          </div>

          <div className="space-y-2">
            {GUARDRAIL_KEYS.map((key) => {
              const m = META[key]
              const on = g[key]
              return (
                <label
                  key={key}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition ${
                    on ? 'border-primary bg-accent/30' : 'border-border hover:bg-accent/10'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(key)}
                    className="mt-1 h-4 w-4 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-medium">{m.label}</span>
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {m.affects}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{m.description}</p>
                  </div>
                </label>
              )
            })}
          </div>

          <DialogFooter>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
