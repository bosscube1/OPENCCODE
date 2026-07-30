import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { SHORTCUTS } from '../lib/shortcuts'
import type { ShortcutGroup } from '../lib/shortcuts'
import './shortcuts.css'

const GROUP_ORDER: ShortcutGroup[] = ['Session', 'Navigation', 'Panels', 'Search', 'Tools']

export function ShortcutsHelp({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null
      const t = window.setTimeout(() => dialogRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }
    previouslyFocused.current?.focus?.()
    previouslyFocused.current = null
    return undefined
  }, [open])

  // Escape is bound at the window rather than as an onKeyDown on the panel.
  // A focus-scoped handler only fires while focus is inside the panel, and this
  // panel holds no focusable content of its own — it relies on the tabIndex={-1}
  // focus() above landing and holding. CommandPalette can afford the scoped
  // approach because its autofocused <input> reliably owns the key. Binding at
  // the window removes that dependency entirely.
  // (Not verified interactively: the automation used here never delivers Escape
  // to the app, so this is a robustness choice, not a fix for an observed bug.)
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const byGroup = new Map<ShortcutGroup, typeof SHORTCUTS>()
  for (const group of GROUP_ORDER) byGroup.set(group, [])
  for (const shortcut of SHORTCUTS) byGroup.get(shortcut.group)?.push(shortcut)

  return (
    <div
      className="shortcuts-help"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="shortcuts-help__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            // A single focusable element (the dialog itself) lives here while it is
            // open — trap focus on it rather than letting Tab escape to the page.
            e.preventDefault()
          }
        }}
      >
        <div className="shortcuts-help__header">
          <h2 className="shortcuts-help__title">Keyboard shortcuts</h2>
          <button
            type="button"
            className="shortcuts-help__close"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="shortcuts-help__body">
          {GROUP_ORDER.map((group) => {
            const items = byGroup.get(group)
            if (!items || items.length === 0) return null
            return (
              <div key={group} className="shortcuts-help__group">
                <div className="shortcuts-help__group-header">{group}</div>
                {items.map((s) => (
                  <div key={s.id} className="shortcuts-help__row">
                    <span className="shortcuts-help__description">{s.description}</span>
                    <kbd className="shortcuts-help__kbd">{s.keys}</kbd>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
