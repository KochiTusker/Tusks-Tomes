import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  getGlossary,
  putGlossary,
  subscribeGlossary,
  type GlossaryDocument,
} from '@/lib/glossary'
import type { ContextualHint, SafeReplacement } from '@/data/corrections'

const EMPTY: GlossaryDocument = {
  version: 1,
  safeReplacements: [],
  contextualHints: [],
}

function commaList(values: string[] | undefined): string {
  return (values ?? []).join(', ')
}

function parseCommaList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function GlossaryEditor() {
  const [doc, setDoc] = useState<GlossaryDocument>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    getGlossary()
      .then((d) => {
        if (cancelled) return
        setDoc(d)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        toast.error(`Failed to load glossary: ${(err as Error).message}`)
        setLoading(false)
      })
    const unsubscribe = subscribeGlossary((next) => {
      // External updates (e.g. another tab saving) flow in here. Only adopt
      // if we don't have unsaved local edits.
      setDirty((isDirty) => {
        if (!isDirty) setDoc(next)
        return isDirty
      })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  function update(next: GlossaryDocument) {
    setDoc(next)
    setDirty(true)
  }

  function updateSafe(index: number, patch: Partial<SafeReplacement>) {
    const safeReplacements = doc.safeReplacements.map((r, i) =>
      i === index ? { ...r, ...patch } : r
    )
    update({ ...doc, safeReplacements })
  }

  function addSafe() {
    update({
      ...doc,
      safeReplacements: [...doc.safeReplacements, { from: '', to: '' }],
    })
  }

  function removeSafe(index: number) {
    update({
      ...doc,
      safeReplacements: doc.safeReplacements.filter((_, i) => i !== index),
    })
  }

  function updateHint(index: number, patch: Partial<ContextualHint>) {
    const contextualHints = doc.contextualHints.map((h, i) =>
      i === index ? { ...h, ...patch } : h
    )
    update({ ...doc, contextualHints })
  }

  function addHint() {
    update({
      ...doc,
      contextualHints: [
        ...doc.contextualHints,
        { canonical: '', commonMishears: [], notes: '' },
      ],
    })
  }

  function removeHint(index: number) {
    update({
      ...doc,
      contextualHints: doc.contextualHints.filter((_, i) => i !== index),
    })
  }

  async function save() {
    setSaving(true)
    try {
      const cleaned: GlossaryDocument = {
        version: 1,
        safeReplacements: doc.safeReplacements
          .map((r) => ({ from: r.from.trim(), to: r.to }))
          .filter((r) => r.from && r.to),
        contextualHints: doc.contextualHints
          .map((h) => ({
            canonical: h.canonical.trim(),
            commonMishears: h.commonMishears,
            notes: h.notes,
          }))
          .filter((h) => h.canonical && h.notes.trim()),
      }
      const saved = await putGlossary(cleaned)
      setDoc(saved)
      setDirty(false)
      toast.success('Glossary saved.')
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Glossary</CardTitle>
          <CardDescription>
            Campaign-specific corrections applied during grounding. Safe
            replacements run deterministically before any AI call; contextual
            hints are injected into the AI prompt for case-by-case judgement.
          </CardDescription>
        </div>
        <Button
          variant="default"
          size="sm"
          disabled={!dirty || saving || loading}
          onClick={save}
        >
          <Save className="mr-2 h-4 w-4" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-8">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading glossary…</p>
        ) : (
          <>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display tracking-wider uppercase">
                    Safe Replacements
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Unambiguous fixes. The wrong form is never a real word.
                    Matched case-insensitively as a whole word.
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={addSafe}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add rule
                </Button>
              </div>
              {doc.safeReplacements.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No safe replacements. Add one to start.
                </p>
              ) : (
                <ul className="space-y-2">
                  {doc.safeReplacements.map((rule, i) => (
                    <li
                      key={i}
                      className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2"
                    >
                      <Input
                        placeholder="from (mistranscription)"
                        value={rule.from}
                        onChange={(e) => updateSafe(i, { from: e.target.value })}
                      />
                      <span className="text-muted-foreground">→</span>
                      <Input
                        placeholder="to (canonical)"
                        value={rule.to}
                        onChange={(e) => updateSafe(i, { to: e.target.value })}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove rule"
                        onClick={() => removeSafe(i)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display tracking-wider uppercase">
                    Contextual Hints
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    For cases where the wrong form IS a real word. The AI
                    decides per-occurrence based on your notes.
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={addHint}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add hint
                </Button>
              </div>
              {doc.contextualHints.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No contextual hints yet.
                </p>
              ) : (
                <ul className="space-y-4">
                  {doc.contextualHints.map((hint, i) => (
                    <li
                      key={i}
                      className="space-y-2 rounded-md border border-border p-3"
                    >
                      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                        <div className="space-y-1">
                          <Label htmlFor={`canon-${i}`}>Canonical</Label>
                          <Input
                            id={`canon-${i}`}
                            placeholder="e.g. Az"
                            value={hint.canonical}
                            onChange={(e) =>
                              updateHint(i, { canonical: e.target.value })
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`mish-${i}`}>
                            Common mishears (comma separated)
                          </Label>
                          <Input
                            id={`mish-${i}`}
                            placeholder="as, Asz, Aza"
                            value={commaList(hint.commonMishears)}
                            onChange={(e) =>
                              updateHint(i, {
                                commonMishears: parseCommaList(e.target.value),
                              })
                            }
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove hint"
                          onClick={() => removeHint(i)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`notes-${i}`}>
                          Notes (when to apply)
                        </Label>
                        <Textarea
                          id={`notes-${i}`}
                          placeholder="REPLACE only when …; DO NOT REPLACE when …"
                          value={hint.notes}
                          rows={4}
                          onChange={(e) =>
                            updateHint(i, { notes: e.target.value })
                          }
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  )
}
