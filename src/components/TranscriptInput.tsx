import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { isSbv, sbvToText } from '@/lib/sbv'

type Props = {
  value: string
  onChange: (next: string) => void
  onRun: () => void
  disabled?: boolean
}

export function TranscriptInput({ value, onChange, onRun, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)

  const onFile = async (file: File) => {
    setLoading(true)
    try {
      const raw = await file.text()
      const cleaned = isSbv(raw) ? sbvToText(raw) : raw
      onChange(cleaned)
      toast.success(
        isSbv(raw)
          ? `Loaded SBV (${cleaned.length.toLocaleString()} chars after timestamp strip)`
          : `Loaded text (${cleaned.length.toLocaleString()} chars)`
      )
    } catch (err) {
      toast.error(`Failed to read file: ${(err as Error).message}`)
    }
    setLoading(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <Label htmlFor="transcript">Raw transcript</Label>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || loading}
          >
            <Upload className="mr-2 h-4 w-4" />
            {loading ? 'Loading…' : 'Load .txt / .sbv'}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.sbv,.md"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onFile(f)
              e.target.value = ''
            }}
          />
        </div>
      </div>
      <Textarea
        id="transcript"
        rows={14}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste your raw transcript here, or load a .sbv / .txt file…"
        disabled={disabled}
        className="font-mono text-xs"
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {value.length.toLocaleString()} characters
        </p>
        <Button
          data-slot="primary-cta"
          onClick={onRun}
          disabled={disabled || !value.trim()}
          size="lg"
          className="font-display tracking-wider uppercase"
        >
          Begin the Chronicle
        </Button>
      </div>
    </div>
  )
}
