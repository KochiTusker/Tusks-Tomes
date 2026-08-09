// Settings panel for the whisper.cpp bridge.
//
// Two paths and a verdict. The verdict is the point: someone who downloaded an
// official whisper.cpp release expecting AMD acceleration has a CPU-only build
// and no way to know it — the binary starts fine, transcribes fine, and is
// simply slow. This panel reads the binary's own capability line and says so
// before they spend an evening wondering.
//
// Nothing here installs anything. The user owns the binary and the model; we
// store two paths and check them.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { InfoHint } from '@/components/ui/info-hint'

type Backends = {
  cuda: boolean
  vulkan: boolean
  metal: boolean
  coreml: boolean
  openvino: boolean
  blas: boolean
  cpuOnly: boolean
  raw: string
}

type Status = {
  configured: boolean
  binaryPath: string | null
  modelPath: string | null
  binaryOk: boolean
  version: string | null
  modelOk: boolean
  modelSizeMb: number | null
  backends: Backends | null
  summary: string
  error?: string
}

/** Green only when it will genuinely use the GPU — a working CPU-only build is
 *  amber, because "it works" isn't the same as "it does what you wanted". */
function tone(s: Status | null): 'ok' | 'warn' | 'bad' | 'idle' {
  if (!s || !s.configured) return 'idle'
  if (!s.binaryOk || !s.modelOk) return 'bad'
  return s.backends?.cpuOnly ? 'warn' : 'ok'
}

const TONE_CLASS: Record<string, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10',
  warn: 'border-amber-500/40 bg-amber-500/10',
  bad: 'border-destructive/50 bg-destructive/10',
  idle: 'border-border bg-muted/30',
}

export function WhisperCppPanel() {
  const [status, setStatus] = useState<Status | null>(null)
  const [binaryPath, setBinaryPath] = useState('')
  const [modelPath, setModelPath] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/whisper-cpp/status')
      if (!res.ok) return
      const s: Status = await res.json()
      setStatus(s)
      setBinaryPath((v) => v || s.binaryPath || '')
      setModelPath((v) => v || s.modelPath || '')
    } catch {
      /* panel is informational; a failed poll shouldn't throw in the UI */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/whisper-cpp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ binaryPath: binaryPath.trim(), modelPath: modelPath.trim() }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast.error(body.error ?? 'Could not save those paths.')
        return
      }
      setStatus(body)
      if (body.binaryOk && body.modelOk && !body.backends?.cpuOnly) toast.success('whisper.cpp is ready.')
      else toast.warning(body.summary)
    } catch (err) {
      toast.error(`Could not save: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const t = tone(status)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          whisper.cpp bridge
          <InfoHint label="About the whisper.cpp bridge">
            The built-in transcriber only accelerates on NVIDIA. This bridges to a whisper.cpp build you
            compile yourself, which is the route for AMD and Intel GPUs. Nothing is downloaded or installed
            — you point it at your binary and model, and removing the add-on leaves them untouched.
          </InfoHint>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={`rounded-md border p-3 text-sm ${TONE_CLASS[t]}`}>
          <p className="font-medium">
            {t === 'ok' && 'Ready'}
            {t === 'warn' && 'Working, but not using your GPU'}
            {t === 'bad' && 'Not usable yet'}
            {t === 'idle' && 'Not set up'}
          </p>
          <p className="mt-1 text-muted-foreground">{status?.summary ?? 'Checking…'}</p>
          {status?.version && (
            <p className="mt-1 text-xs text-muted-foreground">whisper.cpp {status.version}</p>
          )}
          {status?.backends && !status.backends.cpuOnly && (
            <p className="mt-1 text-xs text-muted-foreground">
              Backends:{' '}
              {[
                status.backends.vulkan && 'Vulkan',
                status.backends.cuda && 'CUDA',
                status.backends.metal && 'Metal',
                status.backends.coreml && 'CoreML',
                status.backends.openvino && 'OpenVINO',
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
          )}
          {status?.modelSizeMb ? (
            <p className="mt-1 text-xs text-muted-foreground">Model: {status.modelSizeMb} MB</p>
          ) : null}
        </div>

        {t === 'warn' && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-muted-foreground">
            Official whisper.cpp releases are built without a GPU backend, so downloading one gets you CPU
            speed. For AMD or Intel you need a build compiled with <code>-DGGML_VULKAN=1</code>. The
            step-by-step is in <strong>Help → whisper.cpp bridge</strong>.
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="wcpp-binary">Path to the whisper.cpp executable</Label>
          <Input
            id="wcpp-binary"
            value={binaryPath}
            onChange={(e) => setBinaryPath(e.target.value)}
            placeholder="C:\dev\whisper.cpp\build\bin\Release\whisper-cli.exe"
            spellCheck={false}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="wcpp-model">Path to the GGML model file</Label>
          <Input
            id="wcpp-model"
            value={modelPath}
            onChange={(e) => setModelPath(e.target.value)}
            placeholder="C:\dev\whisper.cpp\models\ggml-large-v3.bin"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Both must be full paths. Anything under 20 MB is rejected — that's almost always a
            Git-LFS pointer rather than the real weights.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={busy || !binaryPath.trim() || !modelPath.trim()}>
            {busy ? 'Checking…' : 'Save and check'}
          </Button>
          <Button variant="ghost" onClick={() => void refresh()} disabled={busy}>
            Re-check
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          While this is set up and working, audio transcription uses whisper.cpp instead of the built-in
          engine. If anything here stops checking out, it falls back automatically rather than failing
          your run.
        </p>
      </CardContent>
    </Card>
  )
}
