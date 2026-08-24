// Saved Chronicles library — browse / view / download / delete finished runs.
//
// Finished runs are auto-saved to the server disk store on completion (see
// RefinementTool), so this list is the durable home for chronicles: it
// survives reloads, dev-server restarts, and browser-cache clears. Lives in
// the Tome of Lore tab as its own section, separate from the grounding KB.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { BookOpen, ChevronDown, ChevronRight, Download, RefreshCw, Trash2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  CHRONICLE_LIBRARY_EVENT,
  deleteChronicle,
  getChronicle,
  listChronicles,
  type ChronicleSummary,
  type SavedChronicle,
} from '@/lib/chronicleLibrary'
import { downloadChronicleDocx } from '@/lib/exportDocx'

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

export function SavedChroniclesPanel() {
  const [items, setItems] = useState<ChronicleSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [openRecord, setOpenRecord] = useState<SavedChronicle | null>(null)
  const [openLoading, setOpenLoading] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

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

        {items.map((it) => {
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
                  </span>
                </button>
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
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => download(`${fileBase(openRecord)}.md`, openRecord.chronicle)}
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
                          onClick={() => {
                            window.dispatchEvent(
                              new CustomEvent('sbts:reforge-chronicle', { detail: { id: openRecord.id } }),
                            )
                            document
                              .querySelector('[data-reforge-panel]')
                              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          }}
                          title="Re-run extras / condense (and optionally the chronicle) on Gemini"
                        >
                          <Wand2 className="mr-1 h-3.5 w-3.5" /> Reforge on Gemini
                        </Button>
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
                      <div className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-sm">
                        {openRecord.chronicle}
                      </div>
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
