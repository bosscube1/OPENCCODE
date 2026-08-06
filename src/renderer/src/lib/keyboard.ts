/**
 * keyboard.ts — pure keyboard-decision helpers, dependency-free so they can
 * be unit-tested under vitest's node environment (no jsdom in this repo).
 *
 * Ownership rule (fixes the M4.1 MentionMenu/Composer collision): a keydown
 * has exactly one owner at a time. The composer's textarea is the only
 * keydown listener in the mention-menu's vicinity now — MentionMenu itself
 * no longer registers a document-level listener. Instead, whenever the
 * mention menu is open, Composer's onKeyDown asks resolveMentionMenuKey()
 * first; if it returns an action, that key is consumed and nothing else
 * (slash menu, Enter-to-submit, Chat's Escape handling) sees it. Only when
 * it returns null does the key fall through to the rest of the composer's
 * own handling.
 */

export type MentionMenuAction =
  | { type: 'move'; nextIndex: number }
  | { type: 'select' }
  | { type: 'close' }

export interface MentionMenuKeyState {
  /** Whether the mention menu is currently open at all. A closed menu owns
   *  nothing — every key falls straight through to the caller's own handling. */
  open: boolean
  /** Number of files currently shown in the menu (0 renders the "no results" panel). */
  fileCount: number
  selectedIndex: number
}

/** The subset of KeyboardEvent this module actually reads — kept minimal so tests
 *  can pass plain object literals instead of constructing real DOM events. */
export type MinimalKeyEvent = Pick<KeyboardEvent, 'key'>

/**
 * Decide what a keydown means to the mention menu, or null if this key isn't
 * one the menu claims (either because it's closed, or because the open menu
 * doesn't act on this particular key). This is the single arbiter Composer's
 * onKeyDown consults before doing anything else with a keydown — see the
 * module comment above for the ownership rule this implements.
 */
export function resolveMentionMenuKey(
  event: MinimalKeyEvent,
  state: MentionMenuKeyState
): MentionMenuAction | null {
  if (!state.open) return null

  const { fileCount, selectedIndex } = state

  // "No files found" panel: only Escape does anything, matching the old
  // MentionMenu behaviour where arrows/Enter were silently ignored.
  if (fileCount === 0) {
    return event.key === 'Escape' ? { type: 'close' } : null
  }

  switch (event.key) {
    case 'ArrowDown':
      return { type: 'move', nextIndex: (selectedIndex + 1) % fileCount }
    case 'ArrowUp':
      return { type: 'move', nextIndex: (selectedIndex - 1 + fileCount) % fileCount }
    case 'Enter':
    case 'Tab':
      return { type: 'select' }
    case 'Escape':
      return { type: 'close' }
    default:
      return null
  }
}
