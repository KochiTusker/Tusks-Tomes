import { ExternalLink, BookOpen } from 'lucide-react'
import type { ProviderId } from '@/lib/providers/types'

type Props = {
  provider: ProviderId
}

/**
 * Per-runner setup instructions surfaced in the Settings dialog after the
 * user picks a local provider. These are the things the program *can't*
 * do for the user — model loading, FlashAttention/KV cache toggles in
 * GUI-driven runners, recommended chunk + context sizes given typical
 * consumer hardware.
 *
 * Keep these terse. The user can always cross-reference the runner's own
 * docs for depth — we just need them to land on the right config.
 */
export function RunnerInstructions({ provider }: Props) {
  if (provider === 'gemini') return null

  switch (provider) {
    case 'ollama':
      return (
        <Panel
          title="Ollama setup"
          docsUrl="https://ollama.com"
          steps={[
            'Install Ollama from ollama.com.',
            'In a terminal: `ollama pull qwen2.5:7b` (or `llama3.1:8b`, `gemma3:9b`, etc.) — pick a 7-9B model for an 8 GB GPU, 13B+ only if you have ≥16 GB.',
            'Click "Launch Ollama" in this dialog. We start `ollama serve` for you with FlashAttention and 4-bit KV cache enabled (OLLAMA_FLASH_ATTENTION=1, OLLAMA_KV_CACHE_TYPE=q4_0).',
            'Click Refresh — your installed models populate the tier dropdowns.',
          ]}
          notes={[
            'If "Launch Ollama" fails with "command not found", install Ollama first or add it to your PATH, then retry.',
            'Ollama applies the perf flags at server startup — if you launch it yourself outside this app, set those env vars before `ollama serve` or you\'ll OOM on long contexts.',
          ]}
        />
      )

    case 'unsloth':
      return (
        <Panel
          title="Unsloth Studio setup"
          docsUrl="https://github.com/unslothai/unsloth"
          steps={[
            'Install Unsloth Studio with the `unsloth` CLI on your PATH.',
            'Click "Launch Unsloth Studio" in this dialog. We run `unsloth studio -H 0.0.0.0 -p 8888` for you and open the web UI in your browser.',
            'Log in to the Unsloth Studio web UI with your username and password.',
            'In the Unsloth web UI, go to **Settings → API keys** and **create a new API key**. Copy it (it looks like `sk-unsloth-…`).',
            'In Unsloth Studio, **load a 7-9B model** suitable for your VRAM: Qwen 2.5 7B, Llama 3.1 8B, Gemma 3 9B, or DeepSeek-R1-Distill-Llama 8B for an 8 GB GPU. Click Start to put it in serving mode.',
            'Come back to this dialog. Expand the **API key / Bearer token** disclosure under Authentication and **paste your `sk-unsloth-…` key**. Press Enter or click away to save. Leave the username/password fields blank — the API key is all you need.',
            'Click **Sign in & test**. Status should turn green ("Authenticated and reachable").',
            'Unsloth\'s runtime **auto-adapts** Flash Attention, KV-cache quantisation, and other perf settings to your hardware — no manual toggles needed. Just pick a model that fits.',
            'Click Refresh under Provider status — the loaded model appears in the tier dropdowns.',
          ]}
          notes={[
            'The API key is the official way to authenticate with Unsloth Studio\'s API. Username/password authentication via OAuth2 may also work but the API key path is more reliable.',
            'Auto-adaptation handles most VRAM tuning, but model size is still a hard limit. On 8 GB VRAM, stay in the 7-9B range. 13B+ won\'t load; 27B+ definitely won\'t.',
            'If a run crashes mid-way despite picking the right size, it usually means the context window is too large. Reduce the context size in Unsloth\'s model-load options to ~16k tokens — our chunker keeps each request well under that.',
            'Unsloth Studio\'s server keeps running after this app closes. To stop it, close it from the Unsloth UI or kill the `unsloth` process.',
            'If "Launch Unsloth Studio" fails with "command not found", make sure `unsloth` works in a fresh terminal first (it should be on your PATH).',
          ]}
        />
      )

    case 'lmstudio':
      return (
        <Panel
          title="LM Studio / OpenAI-compatible setup"
          docsUrl="https://lmstudio.ai"
          steps={[
            'Install LM Studio (or your OpenAI-compatible runner of choice — vLLM, llama.cpp `llama-server`, koboldcpp, etc.).',
            'Load a 7-9B model in the runner\'s UI/CLI.',
            'In LM Studio: Models tab → click your model → toggle **Flash Attention** ON, set **K cache** and **V cache** to **Q4_0**. (Other runners: pass `-fa` and `-ctk q4_0 -ctv q4_0` to llama-server, or the equivalent for your runner.)',
            'Start the local server (LM Studio: "Local Server" tab → Start. llama.cpp: `llama-server --port 1234 ...`).',
            'In this dialog, set the Base URL to match your runner\'s port (default 1234) and click Refresh.',
          ]}
          notes={[
            'We can\'t auto-launch LM Studio reliably (it\'s a desktop GUI app). The "Launch" button tries `lms server start` if you have the LM Studio CLI installed, otherwise start the server manually.',
            'Same VRAM math as Unsloth: keep your model around 7-9B with 4-bit KV + FA on an 8 GB card. Set the context window to ~16k in your runner.',
          ]}
        />
      )
  }
}

function Panel({
  title,
  docsUrl,
  steps,
  notes,
}: {
  title: string
  docsUrl: string
  steps: string[]
  notes: string[]
}) {
  return (
    <section className="space-y-3 rounded-md border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <h3 className="font-medium text-sm">{title}</h3>
        </div>
        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
        >
          Docs
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <ol className="list-decimal space-y-1.5 pl-5 text-xs">
        {steps.map((s, i) => (
          <li key={i} className="leading-relaxed">
            {renderInline(s)}
          </li>
        ))}
      </ol>
      {notes.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-xs">
          <div className="font-medium text-amber-500">Notes</div>
          <ul className="list-disc space-y-1 pl-5">
            {notes.map((n, i) => (
              <li key={i} className="leading-relaxed">
                {renderInline(n)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Lightweight markdown-ish renderer: backticks → code, **x** → bold. */
function renderInline(text: string): React.ReactNode {
  // Split on `code` and **bold** while preserving the delimiters.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`')) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">
          {p.slice(1, -1)}
        </code>
      )
    }
    if (p.startsWith('**') && p.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {p.slice(2, -2)}
        </strong>
      )
    }
    return <span key={i}>{p}</span>
  })
}
