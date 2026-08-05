import { describe, expect, it } from 'vitest'
import { resolveMentionMenuKey } from '../keyboard'

describe('resolveMentionMenuKey — M4.1 regression', () => {
  // These are exactly the keys the old capture-phase document listener in
  // MentionMenu.tsx used to intercept unconditionally, racing Composer.tsx and
  // Chat.tsx's own handlers for the same keys.
  const claimedKeys = ['Escape', 'ArrowUp', 'ArrowDown', 'Enter']

  it('claims (consumes) Escape/ArrowUp/ArrowDown/Enter when the menu is open with results', () => {
    for (const key of claimedKeys) {
      const action = resolveMentionMenuKey({ key }, { open: true, fileCount: 3, selectedIndex: 0 })
      expect(action, `expected '${key}' to be consumed while open`).not.toBeNull()
    }
  })

  it('does NOT claim the same keys when the menu is closed — they fall through to the composer/chat path', () => {
    for (const key of claimedKeys) {
      const action = resolveMentionMenuKey({ key }, { open: false, fileCount: 3, selectedIndex: 0 })
      expect(action, `expected '${key}' to fall through while closed`).toBeNull()
    }
  })

  it('ArrowDown/ArrowUp wrap the selection within the current file count', () => {
    expect(resolveMentionMenuKey({ key: 'ArrowDown' }, { open: true, fileCount: 3, selectedIndex: 2 })).toEqual({
      type: 'move',
      nextIndex: 0
    })
    expect(resolveMentionMenuKey({ key: 'ArrowUp' }, { open: true, fileCount: 3, selectedIndex: 0 })).toEqual({
      type: 'move',
      nextIndex: 2
    })
  })

  it('Enter and Tab both resolve to select', () => {
    expect(resolveMentionMenuKey({ key: 'Enter' }, { open: true, fileCount: 1, selectedIndex: 0 })).toEqual({
      type: 'select'
    })
    expect(resolveMentionMenuKey({ key: 'Tab' }, { open: true, fileCount: 1, selectedIndex: 0 })).toEqual({
      type: 'select'
    })
  })

  it('Escape resolves to close', () => {
    expect(resolveMentionMenuKey({ key: 'Escape' }, { open: true, fileCount: 1, selectedIndex: 0 })).toEqual({
      type: 'close'
    })
  })

  it('with zero files, only Escape is claimed — arrows/Enter are silently ignored, matching the old "no results" panel', () => {
    expect(resolveMentionMenuKey({ key: 'Escape' }, { open: true, fileCount: 0, selectedIndex: 0 })).toEqual({
      type: 'close'
    })
    expect(resolveMentionMenuKey({ key: 'ArrowDown' }, { open: true, fileCount: 0, selectedIndex: 0 })).toBeNull()
    expect(resolveMentionMenuKey({ key: 'Enter' }, { open: true, fileCount: 0, selectedIndex: 0 })).toBeNull()
  })

  it('ignores unrelated keys entirely, open or not', () => {
    expect(resolveMentionMenuKey({ key: 'a' }, { open: true, fileCount: 3, selectedIndex: 0 })).toBeNull()
    expect(resolveMentionMenuKey({ key: 'a' }, { open: false, fileCount: 3, selectedIndex: 0 })).toBeNull()
  })
})
