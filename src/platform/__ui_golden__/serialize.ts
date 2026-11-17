// Stable plain-text serializer for characterisation snapshots.
//
// Emits what a user can perceive and operate: visible text in DOM order and,
// for every interactive control, its role, accessible name and state. It never
// emits class names, ids, data attributes or tag names, so a refactor that
// restyles or re-nests markup without changing what the user sees or can do
// leaves the output byte-identical.

import { computeAccessibleName } from 'dom-accessibility-api'

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'label',
])

const SKIP_TAGS = new Set(['script', 'style', 'svg', 'noscript', 'template', 'canvas', 'head'])

function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true
  if (el.getAttribute('aria-hidden') === 'true') return true
  const style = (el as HTMLElement).style
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return true
  return false
}

function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit.split(/\s+/)[0]
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'button':
      return 'button'
    case 'a':
      return el.hasAttribute('href') ? 'link' : null
    case 'select':
      return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    case 'textarea':
      return 'textbox'
    case 'summary':
      return 'summary'
    case 'progress':
      return 'progressbar'
    case 'input': {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
      switch (type) {
        case 'checkbox':
          return 'checkbox'
        case 'radio':
          return 'radio'
        case 'range':
          return 'slider'
        case 'number':
          return 'spinbutton'
        case 'search':
          return 'searchbox'
        case 'button':
        case 'submit':
        case 'reset':
          return 'button'
        case 'file':
          return 'file-input'
        case 'hidden':
          return null
        default:
          return 'textbox'
      }
    }
    default:
      return null
  }
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'combobox', 'listbox', 'textbox', 'searchbox', 'checkbox', 'radio',
  'slider', 'spinbutton', 'tab', 'switch', 'menuitem', 'option', 'file-input',
  'progressbar', 'summary',
])

function nameOf(el: Element): string {
  try {
    return computeAccessibleName(el).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

function describeControl(el: Element, role: string): string {
  const parts: string[] = [role]
  const name = nameOf(el)
  if (name) parts.push(JSON.stringify(name))
  const tag = el.tagName.toLowerCase()
  const state: string[] = []

  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const input = el as HTMLInputElement
    const type = (input.type || 'text').toLowerCase()
    if (tag === 'select') {
      const sel = el as HTMLSelectElement
      const chosen = Array.from(sel.selectedOptions).map((o) => o.textContent?.trim() ?? '')
      state.push(`value=${JSON.stringify(chosen.join(' | '))}`)
      const opts = Array.from(sel.options).map((o) => (o.textContent ?? '').trim())
      state.push(`options=${JSON.stringify(opts)}`)
    } else if (type === 'checkbox' || type === 'radio') {
      state.push(input.checked ? 'checked' : 'unchecked')
    } else if (type === 'file') {
      if (input.accept) state.push(`accept=${JSON.stringify(input.accept)}`)
      if (input.multiple) state.push('multiple')
    } else if (type === 'password') {
      state.push(`value=${input.value ? '<set>' : '<empty>'}`)
    } else {
      state.push(`value=${JSON.stringify(input.value)}`)
      if (input.placeholder) state.push(`placeholder=${JSON.stringify(input.placeholder)}`)
      if (type !== 'text' && tag === 'input') state.push(`type=${type}`)
    }
    if (input.readOnly) state.push('readonly')
    if (input.required) state.push('required')
  }
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? ''
    state.push(`href=${JSON.stringify(href)}`)
  }
  if ((el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true') {
    state.push('disabled')
  }
  for (const attr of ['aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-current', 'aria-invalid']) {
    const v = el.getAttribute(attr)
    if (v !== null && !(attr === 'aria-checked' && (tag === 'input'))) {
      state.push(`${attr.slice(5)}=${v}`)
    }
  }
  if (el.getAttribute('aria-busy') === 'true') state.push('busy')
  if (tag === 'progress' || role === 'progressbar') {
    const v = el.getAttribute('aria-valuenow') ?? (el as HTMLProgressElement).value
    if (v !== undefined && v !== null && v !== '') state.push(`now=${v}`)
  }
  if (tag === 'summary') {
    const d = el.parentElement
    if (d && d.tagName.toLowerCase() === 'details') {
      state.push((d as HTMLDetailsElement).open ? 'open' : 'closed')
    }
  }
  if (state.length) parts.push(state.join(' '))
  return `[${parts.join(' ')}]`
}

type Ctx = { lines: string[]; cur: string; depth: number }

function flush(ctx: Ctx): void {
  const text = ctx.cur.replace(/\s+/g, ' ').trim()
  if (text) ctx.lines.push('  '.repeat(Math.min(ctx.depth, 8)) + text)
  ctx.cur = ''
}

function walk(node: Node, ctx: Ctx): void {
  if (node.nodeType === Node.TEXT_NODE) {
    ctx.cur += node.textContent ?? ''
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (SKIP_TAGS.has(tag) || isHidden(el)) return
  if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') return

  const role = roleOf(el)
  const interactive = role !== null && INTERACTIVE_ROLES.has(role)
  const block = BLOCK_TAGS.has(tag) || role === 'tabpanel' || role === 'tablist' || role === 'dialog'
  const isDetails = tag === 'details'

  if (block) flush(ctx)

  if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'progress') {
    ctx.cur += ' ' + describeControl(el, role ?? tag) + ' '
    return
  }
  if (tag === 'br') {
    flush(ctx)
    return
  }
  if (tag === 'img') {
    const alt = el.getAttribute('alt')
    if (alt) ctx.cur += ` [img ${JSON.stringify(alt)}] `
    return
  }

  if (interactive && tag !== 'summary') {
    // Leaf-ish controls: the accessible name carries the visible text, so do
    // not also emit the subtree as loose text.
    ctx.cur += ' ' + describeControl(el, role!) + ' '
    if (block) flush(ctx)
    return
  }

  if (tag === 'summary') {
    ctx.cur += ' ' + describeControl(el, 'summary') + ' '
    for (const child of Array.from(el.childNodes)) walk(child, ctx)
    flush(ctx)
    return
  }

  if (isDetails) ctx.depth += 1
  for (const child of Array.from(el.childNodes)) walk(child, ctx)
  if (block) flush(ctx)
  if (isDetails) ctx.depth -= 1
}

/** Dates, clocks and versions vary by machine; the user-visible fact being
 *  pinned is "a date is shown here", not which one. */
export function normalise(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<iso>')
    .replace(/\d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?/g, '<datetime>')
    .replace(/\d{1,2}:\d{2}:\d{2}(?:\s?[APap][Mm])?/g, '<time>')
    .replace(/\b\d+ (?:seconds?|minutes?|hours?|days?|weeks?|months?|years?) ago\b/g, '<relative> ago')
}

/** Serialise an element (and its subtree) to stable plain text. */
export function serialize(root: Element): string {
  const ctx: Ctx = { lines: [], cur: '', depth: 0 }
  // Serialise a root's children rather than the root itself so a hidden root
  // is reported as empty instead of silently dropped.
  walk(root, ctx)
  flush(ctx)
  return normalise(ctx.lines.join('\n'))
}
