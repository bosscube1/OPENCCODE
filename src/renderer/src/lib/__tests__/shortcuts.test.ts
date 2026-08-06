import { describe, expect, it } from 'vitest'
import { SHORTCUTS, matchesShortcut, normalizeShortcut } from '../shortcuts'
import type { Shortcut } from '../shortcuts'

function makeEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false
  } as KeyboardEvent
}

const findInSession: Shortcut = {
  id: 'find-in-session',
  keys: 'Ctrl+F',
  description: 'Find in the current session',
  group: 'Search'
}

const searchAllChats: Shortcut = {
  id: 'search-all-chats',
  keys: 'Ctrl+Shift+F',
  description: "Search across every session's messages",
  group: 'Search'
}

describe('matchesShortcut', () => {
  it('matches an exact key + modifier combination', () => {
    const event = makeEvent({ key: 'f', ctrlKey: true })
    expect(matchesShortcut(event, findInSession)).toBe(true)
  })

  it('treats Ctrl and Cmd (meta) as equivalent', () => {
    const event = makeEvent({ key: 'f', metaKey: true })
    expect(matchesShortcut(event, findInSession)).toBe(true)
  })

  it('rejects a non-Shift shortcut when the event has Shift held', () => {
    const event = makeEvent({ key: 'f', ctrlKey: true, shiftKey: true })
    expect(matchesShortcut(event, findInSession)).toBe(false)
  })

  it('matches a Shift shortcut only when Shift is held', () => {
    const withShift = makeEvent({ key: 'f', ctrlKey: true, shiftKey: true })
    const withoutShift = makeEvent({ key: 'f', ctrlKey: true })
    expect(matchesShortcut(withShift, searchAllChats)).toBe(true)
    expect(matchesShortcut(withoutShift, searchAllChats)).toBe(false)
  })

  it('rejects a mismatched key', () => {
    const event = makeEvent({ key: 'g', ctrlKey: true })
    expect(matchesShortcut(event, findInSession)).toBe(false)
  })

  it('rejects when Alt is held but the shortcut does not require it', () => {
    const event = makeEvent({ key: 'f', ctrlKey: true, altKey: true })
    expect(matchesShortcut(event, findInSession)).toBe(false)
  })

  it('is case-insensitive on the main key', () => {
    const event = makeEvent({ key: 'F', ctrlKey: true })
    expect(matchesShortcut(event, findInSession)).toBe(true)
  })

  it('never matches a shortcut whose keys string has no main key', () => {
    const modifierOnly: Shortcut = { id: 'y', keys: 'Ctrl+Shift', description: '', group: 'Tools' }
    const event = makeEvent({ key: 'Control', ctrlKey: true, shiftKey: true })
    expect(matchesShortcut(event, modifierOnly)).toBe(false)
  })
})

describe('normalizeShortcut', () => {
  it('parses a plain Ctrl+letter combo', () => {
    expect(normalizeShortcut('Ctrl+N')).toEqual({ ctrl: true, shift: false, alt: false, key: 'n' })
  })

  it('parses Ctrl+Shift combos', () => {
    expect(normalizeShortcut('Ctrl+Shift+L')).toEqual({ ctrl: true, shift: true, alt: false, key: 'l' })
  })

  it('treats Cmd/Command/Meta as Ctrl', () => {
    expect(normalizeShortcut('Cmd+O').ctrl).toBe(true)
    expect(normalizeShortcut('Command+O').ctrl).toBe(true)
    expect(normalizeShortcut('Meta+O').ctrl).toBe(true)
  })

  it('treats Option as Alt', () => {
    expect(normalizeShortcut('Option+X').alt).toBe(true)
  })

  it('lower-cases the main key and preserves symbol keys', () => {
    expect(normalizeShortcut('Ctrl+,').key).toBe(',')
    expect(normalizeShortcut('Ctrl+`').key).toBe('`')
  })

  it('returns an empty key for a modifier-only string', () => {
    expect(normalizeShortcut('Ctrl+Shift').key).toBe('')
  })
})

describe('SHORTCUTS registry', () => {
  it('has no two entries that normalise to the same key + modifier combination', () => {
    // Deliberately reuses normalizeShortcut — the same parser matchesShortcut calls —
    // rather than hand-rolling a second parser here, so a bug in normalizeShortcut
    // itself can't make this test pass for the wrong reason.
    const seen = new Map<string, string>()
    for (const shortcut of SHORTCUTS) {
      const n = normalizeShortcut(shortcut.keys)
      const signature = `${n.ctrl}|${n.shift}|${n.alt}|${n.key}`
      const collidesWith = seen.get(signature)
      if (collidesWith) {
        throw new Error(
          `Shortcut '${shortcut.id}' (${shortcut.keys}) collides with '${collidesWith}' — both normalise to ${signature}`
        )
      }
      seen.set(signature, shortcut.id)
    }
    expect(seen.size).toBe(SHORTCUTS.length)
  })

  it('gives every entry a non-empty main key', () => {
    for (const shortcut of SHORTCUTS) {
      expect(normalizeShortcut(shortcut.keys).key.length).toBeGreaterThan(0)
    }
  })
})
