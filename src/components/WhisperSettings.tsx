import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BookOpen, CheckCircle2, Mic, MicOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { openHelpDoc } from '@/components/DocsViewer'

type WhisperStatus = {
  ready: boolean
  error?: string
}

type LogEntry = { stream: 'stdout' | 'stderr'; line: string }

export function WhisperSettings() {
  const [status, setStatus] = useState<WhisperStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [logLines, setLogLines] = useState<LogEntry[]>([])
  const logRef = useRef<HTMLPreElement>(null)

  async function fetchStatus() {
    try {
      const res = await fetch('/api/whisper/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStatus(await res.json() as WhisperStatus)
    } catch (err) {
      setStatus({ ready: false, error: (err as Error).message })
    }
  }

  useEffect(() => { void fetchStatus() }, [])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logLines])

  async function install() {
    setInstalling(true)
    setLogLines([])
    try {
      const res = await fetch('/api/whisper/setup', { method: 'POST' })
      if (!res.body) throw new Error('No response body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const block of parts) {
          const eventMatch = block.match(/^event: (\w+)/)
          const dataMatch = block.match(/^data: (.+)$/m)
          if (!eventMatch || !dataMatch) continue
          const event = eventMatch[1]
          const data = JSON.parse(dataMatch[1])
          if (event === 'line') {
            setLogLines((prev) => [...prev, data as LogEntry])
          } else if (event === 'done') {
            if ((data as { exitCode: number }).exitCode === 0) {
              toast.success('Whisper installed successfully.')
            } else {
              toast.error('Whisper installation failed — see the log above.')
            }
          }
        }
      }
    } catch (err) {
      toast.error(`Install error: ${(err as Error).message}`)
    } finally {
      setInstalling(false)
      void fetchStatus()
    }
  }

  async function uninstall() {
    setUninstalling(true)
    try {
      const res = await fetch('/api/whisper', { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success('Whisper uninstalled.')
      setLogLines([])
    } catch (err) {
      toast.error(`Uninstall failed: ${(err as Error).message}`)
    } finally {
      setUninstalling(false)
      void fetchStatus()
    }
  }

  const isReady = status?.ready === true

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {isReady ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : (
            <MicOff className="h-5 w-5 text-muted-foreground" />
          )}
          Whisper Audio Transcription
          <span
            className={`ml-2 rounded px-2 py-0.5 text-xs font-medium ${
              status === null
                ? 'bg-muted text-muted-foreground'
                : isReady
                ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                : 'bg-destructive/15 text-destructive'
            }`}
          >
            {status === null ? 'Checking…' : isReady ? 'Installed' : 'Not installed'}
          </span>
        </CardTitle>
        <CardDescription>
          {isReady
            ? 'Whisper is ready. Upload Craig recordings from the Sessions tab and transcribe them locally.'
            : 'Optional — enables local audio transcription from Craig recordings. Without it, paste a transcript directly into the Chronicle tab. Requires Python 3.10–3.12 on your PATH.'}
        </CardDescription>
        <button
          type="button"
          onClick={() => openHelpDoc('docs-extras-audio-transcription')}
          className="mt-1 inline-flex items-center gap-1 self-start text-xs text-primary underline-offset-2 hover:underline"
        >
          <BookOpen className="h-3 w-3" />
          Read the Audio Transcription docs
        </button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!isReady && status?.error && (
          <p className="text-xs text-destructive">{status.error}</p>
        )}

        <div className="flex gap-2">
          {!isReady && (
            <Button
              variant="default"
              size="sm"
              disabled={installing || status === null}
              onClick={install}
            >
              <Mic className="mr-2 h-4 w-4" />
              {installing ? 'Installing…' : 'Install Whisper'}
            </Button>
          )}
          {isReady && (
            <Button
              variant="ghost"
              size="sm"
              disabled={uninstalling}
              onClick={uninstall}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {uninstalling ? 'Removing…' : 'Uninstall'}
            </Button>
          )}
        </div>

        {logLines.length > 0 && (
          <pre
            ref={logRef}
            className="max-h-48 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 text-xs leading-relaxed"
          >
            {logLines.map((entry, i) => (
              <span
                key={i}
                className={entry.stream === 'stderr' ? 'text-amber-600 dark:text-amber-400' : ''}
              >
                {entry.line}
                {'\n'}
              </span>
            ))}
          </pre>
        )}
      </CardContent>
    </Card>
  )
}
