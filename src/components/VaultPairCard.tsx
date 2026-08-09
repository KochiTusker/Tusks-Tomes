// Surface the Tusk's Vault pairing status on the Settings tab. Polls
// the /api/vault/pair endpoint on mount and on Refresh.
//
// When paired, shows the resolved Vault root + Lore directory and
// reassures the user that chronicle export will work. When not paired,
// shows the lookup paths tried so the user can fix it (most often by
// moving the Vault checkout next to the Tomes checkout, or setting
// TUSKS_VAULT_DIR in .env).

import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  BookHeart,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { getVaultPairStatus, type VaultPairStatus } from '@/lib/vault'

export function VaultPairCard() {
  const [status, setStatus] = useState<VaultPairStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setStatus(await getVaultPairStatus())
    } catch (err) {
      setError((err as Error).message)
      setStatus(null)
    } finally {
      setLoading(false)
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
            <BookHeart className="h-5 w-5 text-violet-500" />
            Paired with Tusk's Vault
          </CardTitle>
          <CardDescription>
            Tusk's Vault is the sister project — a NotebookLM-style lore
            assistant for your campaign that lives in your Discord. If
            you install it as a sibling directory to this repo, finished
            chronicles can be pushed into Vault's Lore folder with one
            click and Vault will cite them when players ask in-game
            questions.{' '}
            <a
              href="https://github.com/KochiTusker/Tusks-Vault"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2"
            >
              View Tusk's Vault on GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={loading}
          aria-label="Re-detect Tusk's Vault"
        >
          {loading ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-4 w-4" />
          )}
          {loading ? 'Detecting…' : 'Re-detect'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            Couldn't check pair status: {error}
          </div>
        )}
        {!error && status && status.paired && (
          <div className="rounded-md border border-green-500/40 bg-green-500/5 p-3 text-xs">
            <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-300">
              <CheckCircle2 className="h-4 w-4" />
              Vault detected ({status.source === 'env' ? 'via TUSKS_VAULT_DIR' : 'sibling directory'}).
            </div>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt className="font-medium">Vault root</dt>
              <dd className="break-all"><code>{status.vaultRoot}</code></dd>
              <dt className="font-medium">Lore drop folder</dt>
              <dd className="break-all"><code>{status.loreDir}</code></dd>
              <dt className="font-medium">Writable</dt>
              <dd>{status.loreDirWritable ? 'yes' : <span className="text-amber-600">no — fix folder permissions before exporting</span>}</dd>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              Tomes pushes chronicles to{' '}
              <code>{status.loreDir}/Tomes/&lt;campaign&gt;/&lt;file&gt;.md</code>{' '}
              when you click <em>Send to Vault</em> on a finished
              chronicle. Vault picks them up automatically on its
              Knowledge tab.
            </p>
          </div>
        )}
        {!error && status && !status.paired && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
              Vault not detected.
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Pair the projects by installing the Vault repo as a sibling
              directory of this one — e.g. if Tomes is at
              <code className="mx-1">~/Tusks-Tomes</code>
              (or <code className="mx-1">C:/Users/&lt;you&gt;/Tusks-Tomes</code> on Windows),
              clone Vault to <code className="mx-1">~/Tusks-Vault</code>.
              Or set <code>TUSKS_VAULT_DIR</code> in <code>.env</code> to
              point at your Vault checkout if it lives somewhere else.
            </p>
            {status.notes && status.notes.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {status.notes.map((note, i) => (
                  <li key={i}>• {note}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
