import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Pencil, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PersonaEditor } from './PersonaEditor'
import { deletePersona, getPersonas, peekPersonas, subscribePersonas } from '@/lib/personas'
import type { Persona, PersonasDocument } from '@/lib/personas/types'
import { emptyTemplatePrompts } from '@/lib/personas/templates'
import { generatePersonaDraft } from '@/lib/personas/generate'

type EditorState =
  | { mode: 'closed' }
  | { mode: 'edit'; existing: Persona }
  | { mode: 'new-from-scratch' }
  | { mode: 'new-from-template' }
  | { mode: 'new-from-preset'; preset: Persona }
  | { mode: 'new-from-ai'; draft: { name: string; description: string; prompts: Persona['prompts'] } }

export function PersonasManager() {
  const [doc, setDoc] = useState<PersonasDocument>(() => peekPersonas())
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [aiOpen, setAiOpen] = useState(false)
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    getPersonas()
      .then((d) => { if (!cancelled) setDoc(d) })
      .catch((err) => toast.error(`Couldn't load personas: ${(err as Error).message}`))
    const unsub = subscribePersonas((d) => { if (!cancelled) setDoc(d) })
    return () => { cancelled = true; unsub() }
  }, [])

  async function handleDelete(p: Persona) {
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return
    try {
      await deletePersona(p.id)
      toast.success(`Deleted "${p.name}".`)
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`)
    }
  }

  const presets = doc.personas.filter((p) => p.preset)
  const custom = doc.personas.filter((p) => !p.preset)

  return (
    <Card id="personas-manager">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          Chronicle Personas
        </CardTitle>
        <CardDescription>
          Switch the Chronicle narrator out of the locked Bard default. The Bard prompt
          is always available and cannot be edited; personas defined here override phases 3, 5, and 6
          when selected from the Chronicle tab dropdown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setPresetMenuOpen(true)} variant="outline">
            <Plus className="mr-1 h-4 w-4" /> From preset
          </Button>
          <Button onClick={() => setEditor({ mode: 'new-from-template' })} variant="outline">
            <Plus className="mr-1 h-4 w-4" /> From template
          </Button>
          <Button onClick={() => setEditor({ mode: 'new-from-scratch' })} variant="outline">
            <Plus className="mr-1 h-4 w-4" /> From scratch
          </Button>
          <Button onClick={() => setAiOpen(true)}>
            <Wand2 className="mr-1 h-4 w-4" /> Generate with AI
          </Button>
        </div>

        <PersonaList title="Presets" items={presets} onEdit={(p) => setEditor({ mode: 'edit', existing: p })} onDelete={handleDelete} />
        <PersonaList title="Custom" items={custom} onEdit={(p) => setEditor({ mode: 'edit', existing: p })} onDelete={handleDelete} emptyHint="No custom personas yet." />
      </CardContent>

      {/* Preset picker */}
      <Dialog open={presetMenuOpen} onOpenChange={setPresetMenuOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clone a preset</DialogTitle>
            <DialogDescription>Pick a preset to start from. You'll get a fully editable copy.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setPresetMenuOpen(false)
                  setEditor({ mode: 'new-from-preset', preset: p })
                }}
                className="w-full rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent"
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">{p.description}</div>
              </button>
            ))}
            {presets.length === 0 && (
              <p className="text-sm text-muted-foreground">No presets available — try reinstalling the add-on.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* AI generator */}
      <AIGenerateDialog
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onDraft={(draft) => {
          setAiOpen(false)
          setEditor({ mode: 'new-from-ai', draft })
        }}
      />

      {/* Editor */}
      {editor.mode !== 'closed' && (
        <PersonaEditor
          open
          onClose={() => setEditor({ mode: 'closed' })}
          existing={editor.mode === 'edit' ? editor.existing : undefined}
          initialDraft={
            editor.mode === 'new-from-scratch'
              ? { name: '', description: '', prompts: { phase3Cloud: '', phase3Local: '', phase5Local: '', phase6Cloud: '', phase6Local: '' } }
              : editor.mode === 'new-from-template'
                ? { name: '', description: '', prompts: emptyTemplatePrompts() }
                : editor.mode === 'new-from-preset'
                  ? { name: `${editor.preset.name} (copy)`, description: editor.preset.description, prompts: editor.preset.prompts }
                  : editor.mode === 'new-from-ai'
                    ? editor.draft
                    : undefined
          }
        />
      )}
    </Card>
  )
}

function PersonaList({
  title,
  items,
  onEdit,
  onDelete,
  emptyHint,
}: {
  title: string
  items: Persona[]
  onEdit: (p: Persona) => void
  onDelete: (p: Persona) => void
  emptyHint?: string
}) {
  if (items.length === 0 && !emptyHint) return null
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {items.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">{emptyHint}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((p) => (
            <li key={p.id} className="flex items-start gap-2 rounded-md border bg-card px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  {p.preset && <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">Preset</span>}
                </div>
                {p.description && <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => onEdit(p)} title="Edit">
                <Pencil className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(p)} title="Delete">
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AIGenerateDialog({
  open,
  onClose,
  onDraft,
}: {
  open: boolean
  onClose: () => void
  onDraft: (draft: { name: string; description: string; prompts: Persona['prompts'] }) => void
}) {
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (open) setDescription('') }, [open])

  async function go() {
    const desc = description.trim()
    if (desc.length < 6) {
      toast.error('Describe the persona in a few words first.')
      return
    }
    setBusy(true)
    try {
      const draft = await generatePersonaDraft(desc)
      onDraft({ name: draft.name, description: draft.description, prompts: draft.prompts })
    } catch (err) {
      toast.error(`Generation failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate a persona</DialogTitle>
          <DialogDescription>
            Describe the narrator you want in a sentence or two. Your active LLM will draft a
            persona for you to review and edit before saving.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="ai-desc">Description</Label>
          <Textarea
            id="ai-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. A weather-beaten sea captain who treats every encounter like a storm he's seen worse than"
            rows={3}
            disabled={busy}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={go} disabled={busy}>
            {busy ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Generating…</> : <>Generate</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
