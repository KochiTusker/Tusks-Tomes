import React, { createContext, useContext, useId, useRef, useState } from 'react'
import { motion } from 'motion/react'

// Shared with Tusk's Vault — mirror of src/components/ui/Tabs.tsx in the
// Vault repo so both apps render the same top-bar strip with the same
// motion-spring active indicator. See the Vault copy for the full design
// rationale and accessibility notes. Public API matches Radix UI's Tabs
// (Tabs / TabsList / TabsTrigger / TabsContent) so this is a drop-in
// replacement for the previous Radix-based implementation; supports both
// controlled (`value` + `onValueChange`) and uncontrolled (`defaultValue`)
// modes.

interface TabsContextValue {
  value: string
  onValueChange: (v: string) => void
  rootId: string
  registerTrigger: (value: string, el: HTMLButtonElement | null) => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error(`${component} must be used inside <Tabs>`)
  return ctx
}

interface TabsProps {
  /** Controlled value. Pass alongside `onValueChange`. */
  value?: string
  /** Uncontrolled initial value. Used when `value` is not supplied. */
  defaultValue?: string
  /** Fires whenever the active tab changes — controlled or uncontrolled. */
  onValueChange?: (v: string) => void
  children: React.ReactNode
  className?: string
}

export function Tabs({
  value: controlledValue,
  defaultValue,
  onValueChange,
  children,
  className = '',
}: TabsProps) {
  const rootId = useId()
  const [internalValue, setInternalValue] = useState<string>(defaultValue ?? '')
  const isControlled = controlledValue !== undefined
  const value = isControlled ? controlledValue : internalValue

  const handleValueChange = (v: string) => {
    if (!isControlled) setInternalValue(v)
    onValueChange?.(v)
  }

  const triggersRef = useRef<Map<string, HTMLButtonElement>>(new Map())

  const registerTrigger = (val: string, el: HTMLButtonElement | null) => {
    if (el) {
      triggersRef.current.set(val, el)
    } else {
      triggersRef.current.delete(val)
    }
  }

  return (
    <TabsContext.Provider
      value={{ value, onValueChange: handleValueChange, rootId, registerTrigger }}
    >
      <div className={className} data-tabs-root>
        {React.Children.map(children, (child) => {
          if (
            React.isValidElement(child) &&
            (child.type as { displayName?: string }).displayName === 'TabsList'
          ) {
            return React.cloneElement(child as React.ReactElement<TabsListProps>, {
              _triggersRef: triggersRef,
            })
          }
          return child
        })}
      </div>
    </TabsContext.Provider>
  )
}

interface TabsListProps {
  children: React.ReactNode
  className?: string
  /** Internal: passed in by <Tabs>. Don't set this manually. */
  _triggersRef?: React.MutableRefObject<Map<string, HTMLButtonElement>>
}

export function TabsList({ children, className = '', _triggersRef }: TabsListProps) {
  const ctx = useTabsContext('TabsList')

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!_triggersRef) return
    const triggers: Array<[string, HTMLButtonElement]> = Array.from(
      _triggersRef.current.entries()
    )
    if (triggers.length === 0) return
    const currentIndex = triggers.findIndex(([v]) => v === ctx.value)
    let nextIndex = currentIndex
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % triggers.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + triggers.length) % triggers.length
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = triggers.length - 1
    } else {
      return
    }
    e.preventDefault()
    const [nextValue, nextEl] = triggers[nextIndex]
    ctx.onValueChange(nextValue)
    nextEl.focus()
  }

  return (
    <div
      role="tablist"
      onKeyDown={handleKeyDown}
      className={`relative inline-flex flex-wrap items-center gap-1 p-1 rounded-lg bg-surface/60 border border-border/40 backdrop-blur-sm ${className}`}
    >
      {children}
    </div>
  )
}
;(TabsList as React.FC<TabsListProps>).displayName = 'TabsList'

interface TabsTriggerProps {
  value: string
  children: React.ReactNode
  className?: string
}

export function TabsTrigger({ value, children, className = '' }: TabsTriggerProps) {
  const ctx = useTabsContext('TabsTrigger')
  const ref = useRef<HTMLButtonElement | null>(null)
  const active = ctx.value === value
  const tabId = `${ctx.rootId}-tab-${value}`
  const panelId = `${ctx.rootId}-panel-${value}`

  function setRef(el: HTMLButtonElement | null) {
    ref.current = el
    ctx.registerTrigger(value, el)
  }

  return (
    <button
      ref={setRef}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      onClick={() => ctx.onValueChange(value)}
      className={`relative whitespace-nowrap px-4 py-1.5 font-display text-xs sm:text-sm tracking-[0.18em] uppercase rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
        active
          ? 'text-foreground-strong'
          : 'text-foreground/55 hover:text-foreground/85'
      } ${className}`}
    >
      {active && (
        <motion.span
          aria-hidden
          layoutId={`tab-indicator-${ctx.rootId}`}
          className="absolute inset-0 rounded-md bg-background border border-primary/40 shadow-glow-sm"
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        />
      )}
      <span className="relative z-10">{children}</span>
    </button>
  )
}

interface TabsContentProps {
  value: string
  children: React.ReactNode
  className?: string
  /** Force-mount even when inactive. Set true if children need their state
   *  preserved across tab switches (e.g. an editor with unsaved work).
   *  Hidden via `hidden` attribute when inactive instead of unmounting. */
  forceMount?: boolean
}

export function TabsContent({
  value,
  children,
  className = '',
  forceMount = false,
}: TabsContentProps) {
  const ctx = useTabsContext('TabsContent')
  const active = ctx.value === value
  const tabId = `${ctx.rootId}-tab-${value}`
  const panelId = `${ctx.rootId}-panel-${value}`
  if (!active && !forceMount) return null
  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      hidden={!active}
      tabIndex={0}
      className={`focus-visible:outline-none ${className}`}
    >
      {children}
    </div>
  )
}
