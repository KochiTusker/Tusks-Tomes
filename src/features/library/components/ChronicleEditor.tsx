import { useState } from 'react'
import { Button } from '@/platform/ui/button'
import { Textarea } from '@/platform/ui/textarea'

type Props = {
  /** The chronicle markdown as it stands now. */
  value: string
  /** Persist the edited text. Only called when it differs from `value` and is
   *  not blank. A rejection keeps the editor open with the draft intact. */
  onSave: (text: string) => void | Promise<void>
  onCancel: () => void
}

/** Plain-text editor for the chronicle prose, shared by the result view and
 *  the saved-chronicle reader so both edit the same way. Cancel discards the
 *  draft; Save with no change just closes. */
export function ChronicleEditor({ value, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const blank = !draft.trim()

  async function save() {
    if (draft === value) {
      onCancel()
      return
    }
    setSaving(true)
    try {
      await onSave(draft)
    } catch {
      // The caller reports the failure; keep the draft so nothing is lost.
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Textarea
        aria-label="Chronicle text"
        className="min-h-[24rem] font-mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={saving}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving || blank}>
          Save
        </Button>
      </div>
    </div>
  )
}
