// Local LLM detection + probe panel. Surfaces:
//   - Detected backends (Ollama / LM Studio / llama.cpp / Unsloth Studio)
//   - Unsloth credential entry (its API is auth-gated by default).
//   - Per-model capability probes.
//   - System info + parameter-size + VRAM-fit + dynamic recommendations
//     per phase (local vs cloud).
// Emits via `subscribeLocalLLM()` so HybridRoutingEditor refreshes when a
// new probe lands or Unsloth becomes reachable.

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2,
  Cpu,
  FlaskConical,
  KeyRound,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  clearUnslothConfig,
  detectLocalBackends,
  getProbeResults,
  getUnslothConfig,
  notifyLocalLLMRefreshed,
  putUnslothConfig,
  runProbe,
  subscribeLocalLLM,
  type LocalBackendInfo,
  type ProbeResult,
  type UnslothConfigStatus,
} from '@/lib/localLLM'
import { getSystemInfo, type SystemInfo } from '@/lib/system'
import { fitFor, recommendRouting, type Recommendation } from '@/lib/recommendations'
import { parseParamSizeB } from '@/lib/providers/hardware'

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
        ok
          ? 'bg-green-500/15 text-green-600 dark:text-green-400'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  )
}

function fmtScore(n: number): string {
  return n.toFixed(2)
}

function FitBadge({ paramsB, vramGb }: { paramsB: number | null; vramGb: number | null }) {
  const fit = fitFor(paramsB, vramGb)
  const palette: Record<typeof fit, string> = {
    comfortable: 'bg-green-500/15 text-green-600 dark:text-green-400',
    tight: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    overflow: 'bg-destructive/15 text-destructive',
    unknown: 'bg-muted text-muted-foreground',
  }
  const label: Record<typeof fit, string> = {
    comfortable: 'Fits comfortably',
    tight: 'Fits with optimisation',
    overflow: "Won't fit",
    unknown: 'VRAM unknown',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${palette[fit]}`}>
      {label[fit]}
    </span>
  )
}

const PHASE_LABEL: Record<'phase1' | 'phase2' | 'phase3' | 'phase4', string> = {
  phase1: 'Phase 1 — Grounding',
  phase2: 'Phase 2 — Audit',
  phase3: 'Phase 3 — Chronicle',
  phase4: 'Phase 4 — Extras',
}

function RecommendationRow({ phase, rec }: { phase: keyof typeof PHASE_LABEL; rec: Recommendation }) {
  const kindStyle: Record<Recommendation['kind'], string> = {
    local: 'bg-green-500/15 text-green-600 dark:text-green-400',
    cloud: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    'probe-first': 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  }
  const kindLabel: Record<Recommendation['kind'], string> = {
    local: 'Local',
    cloud: 'Cloud',
    'probe-first': 'Probe first',
  }
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border p-2 md:flex-row md:items-center md:gap-3">
      <span className="font-medium text-sm md:w-44 shrink-0">{PHASE_LABEL[phase]}</span>
      <span className={`inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-xs ${kindStyle[rec.kind]}`}>
        {kindLabel[rec.kind]}
      </span>
      <span className="text-xs text-muted-foreground">{rec.reason}</span>
    </li>
  )
}

function UnslothConfigCard({
  status,
  onUpdate,
}: {
  status: UnslothConfigStatus | null
  onUpdate: () => void
}) {
  const [baseUrl, setBaseUrl] = useState('http://localhost:8888')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [bearer, setBearer] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (status?.baseUrl) setBaseUrl(status.baseUrl)
  }, [status?.baseUrl])

  async function save() {
    if (!baseUrl.trim()) {
      toast.error('baseUrl is required.')
      return
    }
    setBusy(true)
    try {
      await putUnslothConfig({
        baseUrl: baseUrl.trim(),
        username: username.trim() || undefined,
        password: password || undefined,
        bearerToken: bearer.trim() || undefined,
      })
      setPassword('')
      setBearer('')
      onUpdate()
      toast.success('Unsloth credentials saved.')
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    setBusy(true)
    try {
      await clearUnslothConfig()
      onUpdate()
      toast.success('Unsloth credentials cleared.')
    } catch (err) {
      toast.error(`Clear failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" />
          Unsloth Studio credentials
        </CardTitle>
        <CardDescription>
          Unsloth Studio's API requires auth by default. Provide either a
          bearer token or username + password (OAuth2 password flow is tried
          first; HTTP Basic is the fallback). Stored in the same encrypted
          keystore as the cloud API keys.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground">
          Status:{' '}
          {status?.configured ? (
            <span className="text-green-600 dark:text-green-400">
              Configured ({status.baseUrl})
            </span>
          ) : (
            'Not configured'
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="unsloth-base-url">Base URL</Label>
            <Input
              id="unsloth-base-url"
              placeholder="http://localhost:8888"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="unsloth-bearer">Bearer token (optional)</Label>
            <Input
              id="unsloth-bearer"
              type="password"
              autoComplete="off"
              placeholder={status?.hasBearerToken ? '••• stored •••' : 'sk-…'}
              value={bearer}
              onChange={(e) => setBearer(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="unsloth-username">Username</Label>
            <Input
              id="unsloth-username"
              autoComplete="off"
              placeholder={status?.hasUsername ? 'replace stored value' : 'admin'}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="unsloth-password">Password</Label>
            <Input
              id="unsloth-password"
              type="password"
              autoComplete="off"
              placeholder={status?.hasPassword ? '••• stored •••' : ''}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy}>
            <Save className="mr-2 h-4 w-4" />
            {busy ? 'Saving…' : 'Save'}
          </Button>
          {status?.configured && (
            <Button variant="outline" onClick={clear} disabled={busy}>
              <Trash2 className="mr-2 h-4 w-4" />
              Clear
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function LocalLLMPanel() {
  const [backends, setBackends] = useState<LocalBackendInfo[] | null>(null)
  const [probes, setProbes] = useState<ProbeResult[]>([])
  const [specs, setSpecs] = useState<SystemInfo | null>(null)
  const [unsloth, setUnsloth] = useState<UnslothConfigStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function refresh() {
    try {
      const [detected, cached, info, unslothStatus] = await Promise.all([
        detectLocalBackends(),
        getProbeResults(),
        getSystemInfo(),
        getUnslothConfig(),
      ])
      setBackends(detected)
      setProbes(cached)
      setSpecs(info)
      setUnsloth(unslothStatus)
      notifyLocalLLMRefreshed()
    } catch (err) {
      toast.error(`Local LLM detection failed: ${(err as Error).message}`)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function runOneProbe(backendBase: string, modelId: string) {
    const key = `${backendBase}::${modelId}`
    setBusy(key)
    try {
      const result = await runProbe({ baseUrl: backendBase, modelId })
      setProbes((prev) => {
        const others = prev.filter(
          (p) => !(p.baseUrl === result.baseUrl && p.modelId === result.modelId)
        )
        return [...others, result]
      })
      toast.success(`Probed ${modelId}.`)
    } catch (err) {
      toast.error(`Probe failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const detectedModels = useMemo(
    () =>
      (backends ?? []).flatMap((backend) =>
        backend.reachable
          ? backend.models.map((modelId) => ({ modelId, baseUrl: backend.baseUrl }))
          : []
      ),
    [backends]
  )

  const recommendations = useMemo(
    () => recommendRouting({ probes, detectedModels, specs }),
    [probes, detectedModels, specs]
  )

  const vramGb = specs?.gpu.vramGb ?? null

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="h-5 w-5" />
              Local LLMs
            </CardTitle>
            <CardDescription>
              Detected local backends and their installed models. Run a probe
              to evaluate eligibility per phase; recommendations below combine
              probe results with parameter count and your GPU's VRAM.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Detect again
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {specs && (
            <div className="rounded-md border border-border p-3 text-xs">
              <div className="font-medium">System</div>
              <div className="text-muted-foreground">
                {specs.cpuCount} CPU{specs.cpuCount === 1 ? '' : 's'}
                {specs.cpuModel ? ` · ${specs.cpuModel}` : ''} · {specs.ramGb}GB RAM ·{' '}
                {specs.gpu.detected
                  ? `${specs.gpu.name ?? 'GPU'} (${specs.gpu.vramGb}GB VRAM, via nvidia-smi)`
                  : specs.gpu.error
                  ? `GPU not detected (${specs.gpu.error})`
                  : 'No NVIDIA GPU detected'}
              </div>
            </div>
          )}
          {backends === null ? (
            <p className="text-sm text-muted-foreground">Detecting…</p>
          ) : backends.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No local backends detected. Start Ollama, LM Studio, llama.cpp
              server, or Unsloth Studio and click Detect again.
            </p>
          ) : (
            backends.map((backend) => (
              <section key={backend.name} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium capitalize">
                      {backend.name === 'lmstudio'
                        ? 'LM Studio'
                        : backend.name === 'llamacpp'
                        ? 'llama.cpp'
                        : backend.name === 'unsloth'
                        ? 'Unsloth Studio'
                        : 'Ollama'}
                    </div>
                    <div className="text-xs text-muted-foreground">{backend.baseUrl}</div>
                  </div>
                  <StatusBadge
                    ok={backend.reachable}
                    label={
                      backend.reachable
                        ? 'Reachable'
                        : backend.error?.includes('auth')
                        ? 'Auth required'
                        : 'Offline'
                    }
                  />
                </div>
                {backend.reachable && backend.models.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No models installed.</p>
                ) : backend.reachable ? (
                  <ul className="space-y-2">
                    {backend.models.map((modelId: string) => {
                      const probe = probes.find(
                        (p) => p.baseUrl === backend.baseUrl && p.modelId === modelId
                      )
                      const key = `${backend.baseUrl}::${modelId}`
                      const paramsB = parseParamSizeB(modelId)
                      return (
                        <li
                          key={modelId}
                          className="space-y-2 rounded-md border border-border p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="space-y-0.5">
                              <code className="text-sm">{modelId}</code>
                              <div className="flex flex-wrap items-center gap-1 text-xs">
                                {paramsB !== null && (
                                  <span className="rounded bg-muted px-1.5 py-0.5">
                                    {paramsB}B params
                                  </span>
                                )}
                                <FitBadge paramsB={paramsB} vramGb={vramGb} />
                              </div>
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy === key}
                              onClick={() => runOneProbe(backend.baseUrl, modelId)}
                            >
                              <FlaskConical className="mr-2 h-4 w-4" />
                              {busy === key ? 'Probing…' : probe ? 'Re-probe' : 'Run probe'}
                            </Button>
                          </div>
                          {probe && (
                            <div className="space-y-1 text-xs">
                              <div>
                                Structured JSON: {fmtScore(probe.structuredJsonScore)} ·
                                Grounding: {fmtScore(probe.groundingScore)} ·
                                Speed: {probe.tokensPerSecond.toFixed(1)} tok/s
                              </div>
                              <div className="flex flex-wrap gap-1">
                                <StatusBadge ok={probe.eligible.phase1} label="Phase 1" />
                                <StatusBadge ok={probe.eligible.phase2} label="Phase 2" />
                                <StatusBadge ok={probe.eligible.phase3} label="Phase 3" />
                                <StatusBadge ok={probe.eligible.phase4} label="Phase 4" />
                              </div>
                              <div className="text-muted-foreground">
                                Probed {new Date(probe.runAt).toLocaleString()}
                              </div>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </section>
            ))
          )}
        </CardContent>
      </Card>

      <UnslothConfigCard status={unsloth} onUpdate={() => void refresh()} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" />
            Recommended routing
          </CardTitle>
          <CardDescription>
            Based on the probed capability of each detected local model, its
            parameter count, and {specs?.gpu.detected ? `${specs.gpu.vramGb}GB of detected VRAM` : 'whatever VRAM the legacy Hardware profile reports'}. Apply via Plan & routing below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1">
            <RecommendationRow phase="phase1" rec={recommendations.phase1} />
            <RecommendationRow phase="phase2" rec={recommendations.phase2} />
            <RecommendationRow phase="phase3" rec={recommendations.phase3} />
            <RecommendationRow phase="phase4" rec={recommendations.phase4} />
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
