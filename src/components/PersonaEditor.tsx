import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createPersona, PersonaValidationError, updatePersona } from '@/lib/personas'
import { validatePersona } from '@/lib/personas/validate'
import { PROMPT_SLOTS, REQUIRED_PLACEHOLDER } from '@/lib/personas/types'
import type { Persona, PersonaPrompts, PromptSlot } from '@/lib/personas/types'

const SLOT_META: Record<PromptSlot, { label: string; help: string }> = {
  phase3Cloud: {
    label: 'Phase 3 — Chronicle (cloud)',
    help: 'Used when the active provider is Gemini, Claude, or OpenAI. The main narrative voice.',
  },
  phase3Local: {
    label: 'Phase 3 — Chronicle (local LLM)',
    help: 'Used when the active provider is Ollama, LM Studio, or Unsloth. Same voice, simpler structural guardrails for smaller models.',
  },
  phase5Local: {
    label: 'Phase 5 — Polish (local LLM only)',
    help: 'Surgical edit pass that smoothes chunk seams in local-LLM output. Cloud runs skip this.',
  },
  phase6Cloud: {
    label: 'Phase 6 — Condense (cloud)',
    help: 'Produces the condensed narrative + recap bullets when condensing on a cloud provider.',
  },
  phase6Local: {
    label: 'Phase 6 — Condense (local LLM)',
    help: 'Same condense task, simpler instructions for local models.',
  },
}

type Props = {
  open: boolean
  onClose: () => void
  /** When supplied, editor edits this existing persona. When undefined, creates new. */
  existing?: Persona
  /** Pre-fill values (used by "From preset", "From template", and AI gen flows). */
  initialDraft?: { name: string; description: string; prompts: PersonaPrompts }
  onSaved?: () => void
}

export function PersonaEditor({ open, onClose, existing, initialDraft, onSaved }: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompts, setPrompts] = useState<PersonaPrompts>({
    phase3Cloud: '',
    phase3Local: '',
    phase5Local: '',
    phase6Cloud: '',
    phase6Local: '',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (existing) {
      setName(existing.name)
      setDescription(existing.description)
      setPrompts(existing.prompts)
      return
    }
    if (initialDraft) {
      setName(initialDraft.name)
      setDescription(initialDraft.description)
      setPrompts(initialDraft.prompts)
      return
    }
    setName('')
    setDescription('')
    setPrompts({ phase3Cloud: '', phase3Local: '', phase5Local: '', phase6Cloud: '', phase6Local: '' })
  }, [open, existing, initialDraft])

  const draft = useMemo(() => ({ name, description, prompts }), [name, description, prompts])
  const liveErrors = useMemo(() => validatePersona(draft), [draft])
  const errorsByField: Record<string, string[]> = {}
  for (const e of liveErrors) {
    const key = e.slot ?? e.field ?? '_'
    ;(errorsByField[key] ||= []).push(e.message)
  }

  async function handleSave() {
    if (liveErrors.length > 0) {
      toast.error('Fix the highlighted issues before saving.')
      return
    }
    setSaving(true)
    try {
      if (existing) {
        await updatePersona(existing.id, draft)
        toast.success(`Updated "${draft.name}".`)
      } else {
        await createPersona(draft)
        toast.success(`Created "${draft.name}".`)
      }
      onSaved?.()
      onClose()
    } catch (err) {
      if (err instanceof PersonaValidationError) {
        toast.error('Server rejected the persona — see inline errors.')
      } else {
        toast.error(`Save failed: ${(err as Error).message}`)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit "${existing.name}"` : 'New persona'}</DialogTitle>
          <DialogDescription>
            Five prompts power the persona — one per affected phase. The locked Bard prompt
            remains the default; this persona only overrides phases 3, 5, and 6 when selected.
            Required placeholders are listed in each section.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
            <div className="space-y-1.5">
              <Label htmlFor="persona-name">Name</Label>
              <Input id="persona-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sea Captain" maxLength={60} />
              {errorsByField.name && <p className="text-xs text-destructive">{errorsByField.name[0]}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="persona-desc">Description</Label>
              <Input id="persona-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One-line summary shown in the picker" maxLength={240} />
              {errorsByField.description && <p className="text-xs text-destructive">{errorsByField.description[0]}</p>}
            </div>
          </div>

          {PROMPT_SLOTS.map((slot, i) => {
            const meta = SLOT_META[slot]
            const required = REQUIRED_PLACEHOLDER[slot]
            const slotErrors = errorsByField[slot] ?? []
            return (
              <details key={slot} open={i === 0} className="rounded-md border bg-card">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm font-medium">
                  <span>
                    {meta.label}
                    {slotErrors.length > 0 && <span className="ml-2 text-xs text-destructive">({slotErrors.length} issue{slotErrors.length === 1 ? '' : 's'})</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">required: {`{${required}}`}</span>
                </summary>
                <div className="space-y-1.5 border-t px-3 py-2">
                  <p className="text-xs text-muted-foreground">{meta.help}</p>
                  <Textarea
                    value={prompts[slot]}
                    onChange={(e) => setPrompts((p) => ({ ...p, [slot]: e.target.value }))}
                    rows={14}
                    spellCheck={false}
                    className="font-mono text-xs leading-relaxed"
                  />
                  {slotErrors.map((m, j) => (
                    <p key={j} className="text-xs text-destructive">{m}</p>
                  ))}
                </div>
              </details>
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || liveErrors.length > 0}>
            {saving ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Saving…</> : (existing ? 'Save changes' : 'Create persona')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
