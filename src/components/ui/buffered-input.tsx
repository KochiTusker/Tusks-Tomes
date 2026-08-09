import { useEffect, useRef, useState } from 'react'
import { Input } from './input'

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  /** Called on blur and on Enter — never on every keystroke. */
  onCommit: (value: string) => void
}

/**
 * Controlled input that buffers user input in local state and only fires
 * `onCommit` when the field loses focus or Enter is pressed. Avoids the
 * stale-closure / focus-interruption hazards of "persist to global state
 * on every keystroke" patterns inside dialogs / modals with focus traps.
 *
 * If the external `value` prop changes (e.g. settings reset, programmatic
 * change), the local buffer syncs to the new value — but only when the
 * input isn't currently focused, so we never interrupt the user.
 */
export function BufferedInput({ value, onCommit, onBlur, onKeyDown, ...rest }: Props) {
  const [local, setLocal] = useState(value)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (document.activeElement !== ref.current) {
      setLocal(value)
    }
  }, [value])

  return (
    <Input
      {...rest}
      ref={ref}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={(e) => {
        if (local !== value) onCommit(local)
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur()
        }
        onKeyDown?.(e)
      }}
    />
  )
}
