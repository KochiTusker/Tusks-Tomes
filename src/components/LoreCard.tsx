// Surface the Tusks-Lore sibling folder status on the Settings tab.
// Mirrors VaultPairCard but with a "Create Tusk's Lore" action for the
// not-detected state — the lore folder is something Tusk's Tomes can
// scaffold for the user, unlike the Vault repo which they have to
// clone separately.

import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FolderPlus,
  RefreshCw,
} from 'lucide-react'
import { FlameLoader } from './FlameLoader'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { createLoreFolder, getLoreStatus, type LoreStatus } from '@/lib/lore'

export function LoreCard() {
  const [status, setStatus] = useState<LoreStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setStatus(await getLoreStatus())
    } catch (err) {
      setError((err as Error).message)
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }

  async function create() {
    setCreating(true)
    try {
      const next = await createLoreFolder()
      setStatus(next)
      toast.success(`Tusk's Lore folder ready at ${next.loreRoot}`)
    } catch (err) {
      toast.error(`Couldn't create Tusk's Lore: ${(err as Error).message}`)
    } finally {
      setCreating(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-amber-500" />
            Tusk's Lore — shared lore base
          </CardTitle>
          <CardDescription>
            A sibling folder both Tusk's Tomes and Tusk's Vault read from. Tomes
            saves finished chronicles into <code>Tusks-Lore/Sessions/</code> as
            structured <code>.docx</code> files; Vault treats the same folder
            as a lore corpus for in-Discord retrieval. Drop the folder as a
            sibling of this repo (e.g. <code>Documents/Tusks-Lore/</code>) and
            it gets auto-detected on next start.
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={loading}
          aria-label="Re-detect Tusk's Lore"
        >
          {loading ? (
            <FlameLoader size={16} className="mr-1" />
          ) : (
            <RefreshCw className="mr-1 h-4 w-4" />
          )}
          {loading ? 'Detecting…' : 'Re-detect'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            Couldn't check Lore status: {error}
          </div>
        )}
        {!error && status && status.found && (
          <div className="rounded-md border border-green-500/40 bg-green-500/5 p-3 text-xs">
            <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-300">
              <CheckCircle2 className="h-4 w-4" />
              Tusk's Lore detected ({status.source === 'env' ? 'via TUSKS_LORE_DIR' : 'sibling directory'}).
            </div>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt className="font-medium">Lore root</dt>
              <dd className="break-all"><code>{status.loreRoot}</code></dd>
              <dt className="font-medium">Sessions folder</dt>
              <dd className="break-all"><code>{status.sessionsDir}</code></dd>
              <dt className="font-medium">Existing sessions</dt>
              <dd>{status.sessionsCount ?? 0} <code>.docx</code> file{status.sessionsCount === 1 ? '' : 's'}</dd>
              <dt className="font-medium">Writable</dt>
              <dd>{status.writable ? 'yes' : <span className="text-amber-600">no — fix folder permissions before saving</span>}</dd>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              On a finished chronicle, hit <em>Save to Tusk's Lore</em> to write
              <code className="mx-1">Tusks-Lore/Sessions/&lt;campaign&gt;/Session-NN-&lt;date&gt;-&lt;full|condensed&gt;.docx</code>.
            </p>
          </div>
        )}
        {!error && status && !status.found && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
              Tusk's Lore not detected.
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Click below and Tomes will create <code>{status.defaultPath}</code>{' '}
              with a marker file plus an empty <code>Sessions/</code> subfolder.
              Vault auto-detects the same folder once it's there.
            </p>
            {status.notes && status.notes.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {status.notes.map((note, i) => (
                  <li key={i}>• {note}</li>
                ))}
              </ul>
            )}
            <div className="mt-3">
              <Button
                variant="default"
                size="sm"
                disabled={creating}
                onClick={create}
              >
                {creating ? (
                  <FlameLoader size={16} className="mr-2" />
                ) : (
                  <FolderPlus className="mr-2 h-4 w-4" />
                )}
                {creating ? 'Creating…' : "Create Tusk's Lore"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
