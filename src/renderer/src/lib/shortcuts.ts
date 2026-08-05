/**
 * shortcuts.ts — the single registry of documented keyboard shortcuts.
 *
 * This is pure data + tiny pure helpers so it can be imported by both the
 * renderer UI (ShortcutsHelp) and unit tests without pulling in React or the
 * store. App.tsx's onKey handler now dispatches off this registry (via
 * matchesShortcut) for every binding it owns. Chat.tsx's find-in-session
 * handler and Sidebar.tsx's search-all-chats button still own their entries
 * independently — this file documents those two but doesn't drive them.
 */

export type ShortcutGroup = 'Session' | 'Navigation' | 'Panels' | 'Search' | 'Tools'

export type Shortcut = {
  id: string
  /** Display form, e.g. 'Ctrl+Shift+L'. */
  keys: string
  description: string
  group: ShortcutGroup
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'new-session', keys: 'Ctrl+N', description: 'New session', group: 'Session' },
  { id: 'open-folder', keys: 'Ctrl+O', description: 'Open folder', group: 'Session' },
  {
    id: 'command-palette',
    keys: 'Ctrl+P',
    description: 'Open command palette',
    group: 'Navigation'
  },
  { id: 'toggle-panel', keys: 'Ctrl+B', description: 'Toggle side panel', group: 'Panels' },
  { id: 'terminal', keys: 'Ctrl+`', description: 'Open terminal', group: 'Panels' },
  {
    id: 'model-picker',
    keys: 'Ctrl+K',
    description: 'Focus the model picker',
    group: 'Tools'
  },
  { id: 'settings', keys: 'Ctrl+,', description: 'Open settings', group: 'Tools' },
  {
    id: 'gemini-live',
    keys: 'Ctrl+Shift+L',
    description: 'Open the Gemini Live copilot window',
    group: 'Tools'
  },
  {
    id: 'find-in-session',
    keys: 'Ctrl+F',
    description: 'Find in the current session',
    group: 'Search'
  },
  {
    id: 'search-all-chats',
    keys: 'Ctrl+Shift+F',
    description: "Search across every session's messages",
    group: 'Search'
  },
  {
    id: 'shortcuts-help',
    keys: 'Ctrl+/',
    description: 'Show this keyboard shortcuts help',
    group: 'Tools'
  }
]

export type NormalizedShortcut = {
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** Lower-cased main key, e.g. 'l', ','. Empty string means "no main key" (invalid). */
  key: string
}

/** Parses a display string like 'Ctrl+Shift+L' into its modifier/key parts. Shared by
 *  matchesShortcut (runtime matching) and the collision test (static analysis) so the
 *  two can never drift apart on what "the same shortcut" means. */
export function normalizeShortcut(keys: string): NormalizedShortcut {
  const tokens = keys.split('+').map((t) => t.trim())

  let ctrl = false
  let shift = false
  let alt = false
  let mainKey = ''

  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'command' || lower === 'meta') {
      ctrl = true
    } else if (lower === 'shift') {
      shift = true
    } else if (lower === 'alt' || lower === 'option') {
      alt = true
    } else {
      mainKey = token
    }
  }

  return { ctrl, shift, alt, key: mainKey.toLowerCase() }
}

/** True when a keyboard event matches this shortcut's key + modifiers. */
export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  const wanted = normalizeShortcut(shortcut.keys)
  if (wanted.key.length === 0) return false

  // Ctrl and Cmd are treated as equivalent throughout this codebase.
  const hasCtrl = event.ctrlKey || event.metaKey
  if (hasCtrl !== wanted.ctrl) return false
  if (event.shiftKey !== wanted.shift) return false
  if (event.altKey !== wanted.alt) return false

  return event.key.toLowerCase() === wanted.key
}
