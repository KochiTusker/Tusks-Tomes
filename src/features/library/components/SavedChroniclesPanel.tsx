// Saved Chronicles library — browse / view / download / delete finished runs.
//
// Finished runs are auto-saved to the server disk store on completion (see
// RefinementTool), so this list is the durable home for chronicles: it
// survives reloads, dev-server restarts, and browser-cache clears. Lives in
// the Tome of Lore tab as its own section, separate from the grounding KB.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { BookOpen, ChevronDown, ChevronRight, Download, Pencil, RefreshCw, Trash2, Wand2 } from 'lucide-react'
import { Button } from '@/platform/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/platform/ui/card'
import {
  CHRONICLE_LIBRARY_EVENT,
  deleteChronicle,
  getChronicle,
  listChronicles,
  updateChronicle,
  type ChronicleSummary,
  type SavedChronicle,
} from '@/features/library/lib/chronicleLibrary'
import { downloadChronicleDocx } from '@/features/library/lib/exportDocx'
import { buildMarkdown } from '@/features/library/lib/exportMarkdown'
import { ChronicleEditor } from './ChronicleEditor'

function download(name: string, text: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

function fileBase(c: { campaign: string; sessionNumber: number }): string {
  const camp = (c.campaign || 'chronicle').replace(/[^\w.-]+/g, '_')
  return `${camp}-session-${c.sessionNumber}`
}

/** Hand this record to the Reforge panel and scroll it into view. The panel
 *  loads the full record itself — the list only carries summaries, and the
 *  transcript is far too large to keep in every row. */
function launchReforge(id: string): void {
  window.dispatchEvent(new CustomEvent('sbts:reforge-chronicle', { detail: { id } }))
  document.querySelector('[data-reforge-panel]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export function SavedChroniclesPanel() {
  const [items, setItems] = useState<ChronicleSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [openRecord, setOpenRecord] = useState<SavedChronicle | null>(null)
  const [openLoading, setOpenLoading] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await listChronicles())
    } catch (err) {
      toast.error(`Couldn't load saved chronicles: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const handler = () => void refresh()
    window.addEventListener(CHRONICLE_LIBRARY_EVENT, handler)
    return () => window.removeEventListener(CHRONICLE_LIBRARY_EVENT, handler)
  }, [refresh])

  const toggleOpen = useCallback(
    async (id: string) => {
      setEditing(false)
      if (openId === id) {
        setOpenId(null)
        setOpenRecord(null)
        return
      }
      setOpenId(id)
      setOpenRecord(null)
      setOpenLoading(true)
      try {
        setOpenRecord(await getChronicle(id))
      } catch (err) {
        toast.error(`Couldn't open chronicle: ${(err as Error).message}`)
        setOpenId(null)
      } finally {
        setOpenLoading(false)
      }
    },
    [openId],
  )

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteChronicle(id)
        if (openId === id) {
          setOpenId(null)
          setOpenRecord(null)
        }
        setConfirmId(null)
        toast.success('Chronicle deleted.')
        await refresh()
      } catch (err) {
        toast.error(`Couldn't delete chronicle: ${(err as Error).message}`)
      }
    },
    [openId, refresh],
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              Saved Chronicles
            </CardTitle>
            <CardDescription>
              Every finished run is auto-saved here and kept until you delete it — safe across
              reloads and restarts. Download what you need, then bin the rest.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span className="ml-1">Refresh</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground">
            No saved chronicles yet. When a pipeline run finishes, its chronicle and extras land
            here automatically.
          </p>
        )}

        {/* A record holding neither the prose nor the Phase 1 output can be
            neither read nor reforged, so it is not offered. Listing a row whose
            every action is disabled reads as a bug rather than as a record. */}
        {items
          .filter((it) => it.hasChronicle || it.hasGroundedTranscript)
          .map((it) => {
          const isOpen = openId === it.id
          return (
            <div key={it.id} className="rounded-md border border-border">
              <div className="flex items-center justify-between gap-2 p-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => void toggleOpen(it.id)}
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {it.campaign || 'Untitled campaign'} — Session {it.sessionNumber}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {new Date(it.createdAt).toLocaleString()} · {it.wordCount.toLocaleString()} words
                      {it.provider ? ` · ${it.provider}` : ''}
                      {it.hasExtras ? ' · extras' : ''}
                      {it.hasCondensed ? ' · condensed' : ''}
                    </span>
                    {/* What a later reforge has to work from. Shown on the
                        collapsed row because it decides whether reforging is
                        worth opening at all. */}
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      <SourceChip ok={it.hasGroundedTranscript} label="grounded transcript" />
                      <SourceChip ok={it.hasChronicle} label="chronicle" />
                    </span>
                  </span>
                </button>
                {confirmId !== it.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => launchReforge(it.id)}
                    title={reforgeHint(it)}
                  >
                    <Wand2 className="mr-1 h-3.5 w-3.5" /> Reforge
                  </Button>
                )}
                {confirmId === it.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button variant="destructive" size="sm" onClick={() => void remove(it.id)}>
                      Confirm
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive"
                    onClick={() => setConfirmId(it.id)}
                    aria-label="Delete chronicle"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              {isOpen && (
                <div className="space-y-2 border-t border-border p-3">
                  {openLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
                  {openRecord && (
                    <>
                      {/* Stated before the buttons, not after the run: a reforge
                          that quietly falls back to the lossier source produces
                          weaker extras with nothing on screen to explain why. */}
                      {(!openRecord.groundedTranscript?.trim() ||
                        !openRecord.chronicle?.trim()) && (
                        <p className="rounded border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                          {reforgeHint({
                            hasGroundedTranscript: !!openRecord.groundedTranscript?.trim(),
                            hasChronicle: !!openRecord.chronicle?.trim(),
                          })}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            download(
                              `${fileBase(openRecord)}.md`,
                              buildMarkdown({
                                campaign: openRecord.campaign,
                                sessionNumber: openRecord.sessionNumber,
                                chronicle: openRecord.chronicle,
                                extras: openRecord.extras ?? null,
                                condensed: openRecord.condensed ?? null,
                              }),
                            )
                          }
                        >
                          <Download className="mr-1 h-3.5 w-3.5" /> Chronicle (.md)
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          title="Formatted Word document: chronicle, condensed version, recap, jests, gore, and quotes (whatever was generated)."
                          onClick={() => {
                            void downloadChronicleDocx({
                              campaign: openRecord.campaign,
                              sessionNumber: openRecord.sessionNumber,
                              chronicle: openRecord.chronicle,
                              extras: openRecord.extras ?? null,
                              condensed: openRecord.condensed ?? null,
                              mode: 'full',
                            }).catch((err) => toast.error(`Download failed: ${(err as Error).message}`))
                          }}
                        >
                          <Download className="mr-1 h-3.5 w-3.5" /> Full (.docx)
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => launchReforge(openRecord.id)}
                          title={reforgeHint({
                            hasGroundedTranscript: !!openRecord.groundedTranscript?.trim(),
                            hasChronicle: !!openRecord.chronicle?.trim(),
                          })}
                        >
                          <Wand2 className="mr-1 h-3.5 w-3.5" /> Reforge
                        </Button>
                        {!editing && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditing(true)}
                            disabled={!openRecord.chronicle?.trim()}
                          >
                            <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                          </Button>
                        )}
                        {openRecord.extras != null && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              download(
                                `${fileBase(openRecord)}-extras.json`,
                                JSON.stringify(openRecord.extras, null, 2),
                              )
                            }
                          >
                            <Download className="mr-1 h-3.5 w-3.5" /> Extras (.json)
                          </Button>
                        )}
                        {openRecord.condensed != null && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              title="Formatted Word document: condensed narrative + recap + extras."
                              onClick={() => {
                                void downloadChronicleDocx({
                                  campaign: openRecord.campaign,
                                  sessionNumber: openRecord.sessionNumber,
                                  chronicle: openRecord.chronicle,
                                  extras: openRecord.extras ?? null,
                                  condensed: openRecord.condensed ?? null,
                                  mode: 'condensed',
                                }).catch((err) => toast.error(`Download failed: ${(err as Error).message}`))
                              }}
                            >
                              <Download className="mr-1 h-3.5 w-3.5" /> Condensed (.docx)
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                download(
                                  `${fileBase(openRecord)}-condensed.json`,
                                  JSON.stringify(openRecord.condensed, null, 2),
                                )
                              }
                            >
                              <Download className="mr-1 h-3.5 w-3.5" /> Condensed (.json)
                            </Button>
                          </>
                        )}
                      </div>
                      {editing ? (
                        <ChronicleEditor
                          value={openRecord.chronicle}
                          onCancel={() => setEditing(false)}
                          onSave={async (text) => {
                            try {
                              const updated = await updateChronicle(openRecord.id, { chronicle: text })
                              setOpenRecord(updated)
                              setEditing(false)
                              toast.success('Chronicle edit saved.')
                            } catch (err) {
                              toast.error(`Couldn't save the edit: ${(err as Error).message}`)
                              throw err
                            }
                          }}
                        />
                      ) : (
                        <div className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-sm">
                          {openRecord.chronicle}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

/** Presence marker for one of the two artefacts a reforge can run from.
 *  Absence is stated rather than omitted — a missing chip would be read as a
 *  layout quirk, whereas a struck-through one is read as a fact. */
function SourceChip(props: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded px-1 py-0.5 text-[10px] ${
        props.ok
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : 'bg-muted text-muted-foreground line-through'
      }`}
      title={props.ok ? `${props.label} saved with this run` : `no ${props.label} saved with this run`}
      aria-label={props.ok ? `${props.label} saved with this run` : `no ${props.label} saved with this run`}
    >
      {props.label}
    </span>
  )
}

/** What a reforge of this record can and cannot do, in one line.
 *
 *  The grounded transcript is the load-bearing artefact: with it, extras can be
 *  re-extracted from what was actually said and the chronicle can be rewritten
 *  from scratch. Without it, a reforge is limited to re-reading its own prose,
 *  which is lossier — so the row says which of the two it is BEFORE the run,
 *  rather than letting the user discover it in the output. */
export function reforgeHint(it: {
  hasGroundedTranscript: boolean
  hasChronicle: boolean
}): string {
  if (it.hasGroundedTranscript && it.hasChronicle) {
    return 'Re-run any phase: extras and condense from the chronicle, or rewrite the chronicle from the grounded transcript.'
  }
  if (it.hasGroundedTranscript) {
    return 'No chronicle saved — a reforge will rewrite it from the grounded transcript first, then extras and condense are available.'
  }
  return 'No grounded transcript saved — extras can only be re-extracted from the chronicle prose (lossier), and the chronicle cannot be rewritten.'
}
