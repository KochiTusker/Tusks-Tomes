import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  getSpeakers,
  putSpeakers,
  subscribeSpeakers,
  type Speaker,
  type SpeakersDocument,
} from '@/lib/speakers'

const EMPTY: SpeakersDocument = { version: 1, speakers: [] }

export function SpeakerEditor() {
  const [doc, setDoc] = useState<SpeakersDocument>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    getSpeakers()
      .then((d) => {
        if (cancelled) return
        setDoc(d)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        toast.error(`Failed to load speakers: ${(err as Error).message}`)
        setLoading(false)
      })
    const unsubscribe = subscribeSpeakers((next) => {
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

  function update(next: SpeakersDocument) {
    setDoc(next)
    setDirty(true)
  }

  function updateRow(index: number, patch: Partial<Speaker>) {
    const speakers = doc.speakers.map((s, i) =>
      i === index ? { ...s, ...patch } : s
    )
    update({ ...doc, speakers })
  }

  function addRow() {
    update({
      ...doc,
      speakers: [
        ...doc.speakers,
        { discordUserId: '', discordDisplayName: '', playerName: '', characterName: '' },
      ],
    })
  }

  function removeRow(index: number) {
    update({
      ...doc,
      speakers: doc.speakers.filter((_, i) => i !== index),
    })
  }

  async function save() {
    setSaving(true)
    try {
      const cleaned: SpeakersDocument = {
        version: 1,
        speakers: doc.speakers
          .map((s) => ({
            discordUserId: s.discordUserId.trim(),
            discordDisplayName: s.discordDisplayName?.trim() || undefined,
            playerName: s.playerName.trim(),
            characterName: s.characterName.trim(),
          }))
          .filter((s) => s.discordUserId),
      }
      const saved = await putSpeakers(cleaned)
      setDoc(saved)
      setDirty(false)
      toast.success('Speakers saved.')
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
          <CardTitle>Speakers</CardTitle>
          <CardDescription>
            Map speaker IDs to player and character names. When you upload
            a Craig zip the speaker IDs are populated automatically from
            the per-track filenames; you fill in the player and character
            names. The transcriber uses this to tag each line with the
            speaker.
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
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading speakers…</p>
        ) : (
          <>
            <div className="flex items-center justify-end">
              <Button variant="secondary" size="sm" onClick={addRow}>
                <Plus className="mr-2 h-4 w-4" />
                Add speaker
              </Button>
            </div>
            {doc.speakers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No speakers yet. Upload a Craig multitrack zip via the
                Upload tab to auto-populate this list, or add rows
                manually.
              </p>
            ) : (
              <ul className="space-y-3">
                {doc.speakers.map((speaker, i) => {
                  const autoDiscovered =
                    !!speaker.discordDisplayName &&
                    !speaker.playerName &&
                    !speaker.characterName
                  return (
                    <li
                      key={i}
                      className="space-y-2 rounded-md border border-border p-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-muted-foreground">
                          {speaker.discordDisplayName ? (
                            <span>
                              Track: <strong>{speaker.discordDisplayName}</strong>
                            </span>
                          ) : (
                            <span>Display name will populate from Craig track filename on upload</span>
                          )}
                          {autoDiscovered && (
                            <span className="ml-2 rounded bg-amber-500/20 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                              Auto-discovered
                            </span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove speaker"
                          onClick={() => removeRow(i)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor={`uid-${i}`}>Speaker ID</Label>
                          <Input
                            id={`uid-${i}`}
                            placeholder="Craig speaker ID or any unique handle"
                            value={speaker.discordUserId}
                            onChange={(e) =>
                              updateRow(i, { discordUserId: e.target.value })
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`display-${i}`}>Track display name</Label>
                          <Input
                            id={`display-${i}`}
                            placeholder="wyldfyre_dm"
                            value={speaker.discordDisplayName ?? ''}
                            onChange={(e) =>
                              updateRow(i, { discordDisplayName: e.target.value })
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`player-${i}`}>Player name</Label>
                          <Input
                            id={`player-${i}`}
                            placeholder="Wyldfyre"
                            value={speaker.playerName}
                            onChange={(e) =>
                              updateRow(i, { playerName: e.target.value })
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`character-${i}`}>Character name</Label>
                          <Input
                            id={`character-${i}`}
                            placeholder="Lakshmi"
                            value={speaker.characterName}
                            onChange={(e) =>
                              updateRow(i, { characterName: e.target.value })
                            }
                          />
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
