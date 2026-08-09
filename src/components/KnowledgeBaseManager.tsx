import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  FileDown,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLoreDocuments } from '@/hooks/useLoreDocuments'
import { LS_KB } from '@/lib/constants'
import type { KBDocument } from '@/types'

/** Bytes above which an uploaded KB doc gets a per-file warning at upload
 *  time. Picked empirically — files >500 KB are large enough that being
 *  included as context on Phase 1 / 3 / 6 calls meaningfully inflates per-
 *  chunk token cost. Surfaced to tests so the threshold contract can't drift
 *  silently. */
export const KB_LARGE_FILE_THRESHOLD_BYTES = 500_000

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function inferType(file: File): 'pdf' | 'docx' | 'txt' | 'md' | null {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return 'pdf'
  if (name.endsWith('.docx')) return 'docx'
  if (name.endsWith('.md')) return 'md'
  if (name.endsWith('.txt')) return 'txt'
  return null
}

async function uploadFile(file: File): Promise<void> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/lore/documents', { method: 'POST', body: fd })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Upload failed (${res.status})`)
  }
}

async function convertDocxToMarkdown(file: File): Promise<{
  name: string
  markdown: string
  entitiesAutoIndexed: number
  headingsPromoted: boolean
}> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/parse/docx', { method: 'POST', body: fd })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Conversion failed (${res.status})`)
  }
  const body = (await res.json()) as {
    name?: string
    text?: string
    entitiesAutoIndexed?: number
    headingsPromoted?: boolean
  }
  return {
    name: (body.name ?? file.name).replace(/\.docx$/i, '.md'),
    markdown: body.text ?? '',
    entitiesAutoIndexed: body.entitiesAutoIndexed ?? 0,
    headingsPromoted: body.headingsPromoted ?? false,
  }
}

function triggerDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function deleteDoc(relPath: string): Promise<void> {
  const res = await fetch(
    `/api/lore/documents?relPath=${encodeURIComponent(relPath)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Delete failed (${res.status})`)
  }
}

type BulkConvertOutcome =
  | {
      relPath: string
      status: 'converted'
      mdRelPath: string
      sizeBytes: number
      entitiesAutoIndexed?: number
      headingsPromoted?: boolean
    }
  | { relPath: string; status: 'skipped_existing_md'; mdRelPath: string }
  | { relPath: string; status: 'error'; error: string }

type BulkRemoveOutcome =
  | { relPath: string; status: 'removed' }
  | { relPath: string; status: 'skipped'; reason: string }

async function bulkConvertDocx(): Promise<{ loreRoot: string; report: BulkConvertOutcome[] }> {
  const res = await fetch('/api/lore/convert-docx', { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Convert failed (${res.status})`)
  return body as { loreRoot: string; report: BulkConvertOutcome[] }
}

async function bulkRemoveDocx(relPaths: string[]): Promise<{ report: BulkRemoveOutcome[] }> {
  const res = await fetch('/api/lore/remove-docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relPaths }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Remove failed (${res.status})`)
  return body as { report: BulkRemoveOutcome[] }
}

async function migrateLegacyDoc(doc: KBDocument): Promise<void> {
  const res = await fetch('/api/lore/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: doc.name, text: doc.text }),
  })
  if (!res.ok && res.status !== 409) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Migrate failed (${res.status})`)
  }
}

export function KnowledgeBaseManager() {
  const lore = useLoreDocuments()
  const [legacyDocs, setLegacyDocs] = useLocalStorage<KBDocument[]>(LS_KB, [])
  const [busy, setBusy] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [converting, setConverting] = useState(false)
  const [bulkConverting, setBulkConverting] = useState(false)
  const [bulkRemoving, setBulkRemoving] = useState(false)
  // Holds the converted-file entries from the most recent bulk convert
  // call. Drives the "Remove originals?" prompt below the upload zone.
  // Cleared after a remove run or when the user dismisses the prompt.
  // Narrowed to the 'converted' variant so `mdRelPath` is always defined.
  const [pendingRemoval, setPendingRemoval] = useState<
    Array<Extract<BulkConvertOutcome, { status: 'converted' }>> | null
  >(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const convertInputRef = useRef<HTMLInputElement>(null)

  const totalBytes = useMemo(
    () => lore.documents.reduce((acc, d) => acc + d.sizeBytes, 0),
    [lore.documents],
  )
  const totalText = useMemo(
    () => lore.documents.reduce((acc, d) => acc + d.text.length, 0),
    [lore.documents],
  )

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setBusy(true)
      let written = 0
      for (const f of Array.from(files)) {
        const kind = inferType(f)
        if (!kind) {
          toast.error(`Unsupported file type: ${f.name}`)
          continue
        }
        try {
          await uploadFile(f)
          written += 1
          // Files >500KB significantly inflate per-chunk token cost because
          // the KB is included as context on Phase 1 / Phase 3 / Phase 6
          // calls. Warn at upload time so the user can split or archive
          // BEFORE running a session and getting a surprise bill.
          if (f.size > KB_LARGE_FILE_THRESHOLD_BYTES) {
            const sizeMB = (f.size / 1_000_000).toFixed(2)
            toast.warning(
              `Added "${f.name}" (${sizeMB} MB) — large lore files are sent as context with every ` +
                'Phase 1 / 3 / 6 call. Each ~100 KB of KB adds roughly 25k input tokens per chunk. ' +
                'Consider splitting into smaller per-topic files OR moving rarely-needed content out of ' +
                'Tusks-Lore to keep per-session cost predictable.',
              { duration: 12_000 },
            )
          } else {
            toast.success(`Added "${f.name}" to Tusks-Lore`)
          }
        } catch (err) {
          toast.error(`Failed: ${f.name} — ${(err as Error).message}`)
        }
      }
      if (written) await lore.refresh()
      setBusy(false)
    },
    [lore],
  )

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragActive(false)
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files)
  }

  const handleConvertDocx = useCallback(
    async (files: FileList | File[]) => {
      setConverting(true)
      try {
        for (const f of Array.from(files)) {
          if (!/\.docx$/i.test(f.name)) {
            toast.error(`${f.name} isn't a .docx — skipped.`)
            continue
          }
          try {
            const { name, markdown, entitiesAutoIndexed, headingsPromoted } =
              await convertDocxToMarkdown(f)
            triggerDownload(name, markdown)
            const fmNote =
              entitiesAutoIndexed > 0
                ? ` + ${entitiesAutoIndexed} ${entitiesAutoIndexed === 1 ? 'entity' : 'entities'} auto-indexed via frontmatter`
                : ''
            const promotedNote = headingsPromoted
              ? ' (recovered section headings from docx bold-text styling)'
              : ''
            toast.success(`Converted ${f.name} → ${name}${fmNote}${promotedNote}`)
          } catch (err) {
            toast.error(`Convert failed: ${f.name} — ${(err as Error).message}`)
          }
        }
      } finally {
        setConverting(false)
      }
    },
    [],
  )

  const handleBulkConvert = useCallback(async () => {
    setBulkConverting(true)
    setPendingRemoval(null)
    try {
      const result = await bulkConvertDocx()
      const converted = result.report.filter(
        (r): r is Extract<BulkConvertOutcome, { status: 'converted' }> =>
          r.status === 'converted',
      )
      const skipped = result.report.filter((r) => r.status === 'skipped_existing_md')
      const errored = result.report.filter((r) => r.status === 'error')
      if (converted.length > 0) {
        const totalEntities = converted.reduce(
          (sum, r) => sum + (r.entitiesAutoIndexed ?? 0),
          0,
        )
        const promotedFiles = converted.filter((r) => r.headingsPromoted).length
        const fmNote =
          totalEntities > 0
            ? ` + ${totalEntities} ${totalEntities === 1 ? 'entity' : 'entities'} auto-indexed via frontmatter`
            : ''
        const promotedNote =
          promotedFiles > 0
            ? ` (${promotedFiles} file${promotedFiles === 1 ? '' : 's'} had bold-text section headings auto-promoted)`
            : ''
        toast.success(
          `Converted ${converted.length} .docx file${converted.length === 1 ? '' : 's'} to .md${fmNote}` +
            (skipped.length > 0 ? ` (skipped ${skipped.length} with existing .md)` : '') +
            promotedNote,
        )
        // Refresh the document list so the new .md files appear, then
        // surface the removal prompt.
        await lore.refresh()
        setPendingRemoval(converted)
      } else if (skipped.length > 0 && errored.length === 0) {
        toast.info(
          `Nothing to convert — every .docx already has a sibling .md (${skipped.length} skipped).`,
        )
      } else if (errored.length === converted.length + skipped.length + errored.length && errored.length > 0) {
        toast.error(`All conversions failed (${errored.length}). See diagnostics for details.`)
      } else {
        toast.info('No .docx files found under Tusks-Lore (outside Sessions/).')
      }
      if (errored.length > 0) {
        console.warn('[bulk convert] failures:', errored)
      }
    } catch (err) {
      toast.error(`Bulk convert failed: ${(err as Error).message}`)
    } finally {
      setBulkConverting(false)
    }
  }, [lore])

  const handleBulkRemove = useCallback(async () => {
    if (!pendingRemoval) return
    const relPaths = pendingRemoval.map((r) => r.relPath)
    setBulkRemoving(true)
    try {
      const { report } = await bulkRemoveDocx(relPaths)
      const removed = report.filter((r) => r.status === 'removed')
      const skipped = report.filter((r) => r.status === 'skipped')
      if (removed.length > 0) {
        toast.success(
          `Removed ${removed.length} .docx original${removed.length === 1 ? '' : 's'}` +
            (skipped.length > 0 ? ` (${skipped.length} skipped)` : ''),
        )
      }
      if (skipped.length > 0) {
        console.warn('[bulk remove] skipped:', skipped)
        if (removed.length === 0) {
          toast.error(
            `Nothing was removed — see the dev console for the per-file reason. Most common: no sibling .md found.`,
          )
        }
      }
      await lore.refresh()
      setPendingRemoval(null)
    } catch (err) {
      toast.error(`Bulk remove failed: ${(err as Error).message}`)
    } finally {
      setBulkRemoving(false)
    }
  }, [pendingRemoval, lore])

  const removeDoc = async (doc: KBDocument) => {
    if (!doc.relPath) {
      toast.error('Missing relative path — cannot remove from disk.')
      return
    }
    try {
      await deleteDoc(doc.relPath)
      toast.success(`Removed "${doc.name}" from Tusks-Lore`)
      await lore.refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const runMigration = async () => {
    setMigrating(true)
    let okCount = 0
    for (const d of legacyDocs) {
      try {
        await migrateLegacyDoc(d)
        okCount += 1
      } catch (err) {
        toast.error(`Migrate "${d.name}" failed: ${(err as Error).message}`)
      }
    }
    if (okCount === legacyDocs.length) {
      setLegacyDocs([])
      toast.success(`Migrated ${okCount} doc${okCount === 1 ? '' : 's'} to Tusks-Lore.`)
    } else {
      toast.warning(`Migrated ${okCount}/${legacyDocs.length}. The rest are still in browser storage.`)
    }
    await lore.refresh()
    setMigrating(false)
  }

  const loreMissing = lore.status === 'missing'
  const loading = lore.status === 'loading' || lore.status === 'idle'

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Knowledge Base — Tusks-Lore folder</CardTitle>
            <CardDescription>
              {loreMissing ? (
                <>Tusks-Lore folder not detected. Create it from Settings, then refresh.</>
              ) : (
                <>
                  {lore.documents.length} doc{lore.documents.length === 1 ? '' : 's'}
                  {' · '}
                  {fmtBytes(totalBytes)} on disk · {fmtBytes(totalText)} of extracted text.
                  {lore.loreRoot ? <> <span className="font-mono text-xs">{lore.loreRoot}</span></> : null}
                </>
              )}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => lore.refresh()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {lore.status === 'error' && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-50 p-3 text-sm dark:bg-red-950/30">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-red-600" />
            <div>
              <strong>Couldn't load Tusks-Lore:</strong> {lore.error}
            </div>
          </div>
        )}

        {loreMissing && lore.notes.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
            <FolderOpen className="mt-0.5 h-4 w-4 text-amber-600" />
            <div className="space-y-1">
              {lore.notes.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </div>
          </div>
        )}

        {legacyDocs.length > 0 && (
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
            <div className="flex-1 space-y-2">
              <p>
                <strong>{legacyDocs.length} doc{legacyDocs.length === 1 ? '' : 's'}</strong> are
                still in browser storage from the old in-app KB. Migrate them to Tusks-Lore so
                they survive across machines and feed grounding from the shared folder.
              </p>
              <Button
                size="sm"
                disabled={migrating || loreMissing}
                onClick={runMigration}
              >
                {migrating ? 'Migrating…' : 'Migrate to Tusks-Lore'}
              </Button>
            </div>
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-8 text-sm text-muted-foreground transition-colors ${
            dragActive ? 'border-primary bg-accent' : 'border-input'
          } ${loreMissing ? 'pointer-events-none opacity-50' : ''}`}
        >
          <Upload className="h-6 w-6" />
          <p>Drag &amp; drop PDF / DOCX / TXT / MD files here</p>
          <p className="text-xs">or drop them straight into Tusks-Lore in File Explorer, then Refresh.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || loreMissing}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? 'Uploading…' : 'Choose files'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={converting}
              onClick={() => convertInputRef.current?.click()}
              title="Convert a single .docx file to .md and download the result. Does not touch Tusks-Lore."
            >
              <FileDown className="mr-1 h-4 w-4" />
              {converting ? 'Converting…' : 'Convert one .docx → .md'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={bulkConverting || loreMissing}
              onClick={handleBulkConvert}
              title="Walk Tusks-Lore and convert every .docx (outside Sessions/) to a sibling .md so AI models read markdown directly. Skips any .docx that already has a .md. Originals stay on disk until you opt to remove them."
            >
              <FileDown className="mr-1 h-4 w-4" />
              {bulkConverting ? 'Converting…' : 'Bulk convert .docx in Tusks-Lore'}
            </Button>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <input
            ref={convertInputRef}
            type="file"
            multiple
            accept=".docx"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) handleConvertDocx(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        {pendingRemoval && pendingRemoval.length > 0 && (
          <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="space-y-1">
                <p>
                  <strong>
                    {pendingRemoval.length} .docx file
                    {pendingRemoval.length === 1 ? '' : 's'} now have a sibling .md.
                  </strong>{' '}
                  Removing the originals keeps Tusks-Lore tidy and means the
                  grounding loop reads .md natively (faster, no per-run docx
                  re-parsing). Only the .docx files in this list will be
                  deleted — the .md files stay.
                </p>
                <p className="text-xs text-muted-foreground">
                  Files in <code className="font-mono">Sessions/</code>{' '}
                  (chronicle exports) are protected and never affected.
                </p>
              </div>
            </div>
            <ul className="max-h-40 overflow-y-auto rounded-sm border border-amber-500/20 bg-background/60 p-2 text-xs">
              {pendingRemoval.map((r) => (
                <li key={r.relPath} className="font-mono">
                  {r.relPath} → {r.mdRelPath}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={bulkRemoving}
                onClick={handleBulkRemove}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                {bulkRemoving
                  ? 'Removing…'
                  : `Remove ${pendingRemoval.length} .docx original${pendingRemoval.length === 1 ? '' : 's'}`}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={bulkRemoving}
                onClick={() => setPendingRemoval(null)}
              >
                Keep both
              </Button>
            </div>
          </div>
        )}

        {lore.documents.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {loreMissing
              ? 'No lore loaded.'
              : loading
                ? 'Loading documents from Tusks-Lore…'
                : 'No documents in Tusks-Lore yet.'}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {lore.documents.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{d.relPath ?? d.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.type.toUpperCase()} · {fmtBytes(d.sizeBytes)} · {d.text.length.toLocaleString()} chars
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${d.name}`}
                  onClick={() => removeDoc(d)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
