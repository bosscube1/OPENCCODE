/**
 * shortcuts.ts — the single registry of documented keyboard shortcuts.
 *
 * This is pure data + tiny pure helpers so it can be imported by both the
 * renderer UI (ShortcutsHelp) and unit tests without pulling in React or the
 * store. It documents bindings that live elsewhere (App.tsx's onKey handler,
 * Chat.tsx's find-in-session handler, Sidebar.tsx's search-all-chats button)
 * rather than owning them — see the comment in App.tsx for the migration plan.
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

/** True when a keyboard event matches this shortcut's key + modifiers. */
export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  const tokens = shortcut.keys.split('+').map((t) => t.trim())

  let wantCtrl = false
  let wantShift = false
  let wantAlt = false
  let mainKey = ''

  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'command' || lower === 'meta') {
      wantCtrl = true
    } else if (lower === 'shift') {
      wantShift = true
    } else if (lower === 'alt' || lower === 'option') {
      wantAlt = true
    } else {
      mainKey = token
    }
  }

  if (mainKey.length === 0) return false

  // Ctrl and Cmd are treated as equivalent throughout this codebase.
  const hasCtrl = event.ctrlKey || event.metaKey
  if (hasCtrl !== wantCtrl) return false
  if (event.shiftKey !== wantShift) return false
  if (event.altKey !== wantAlt) return false

  return event.key.toLowerCase() === mainKey.toLowerCase()
}
