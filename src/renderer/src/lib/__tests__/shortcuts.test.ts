import { describe, expect, it } from 'vitest'
import { matchesShortcut } from '../shortcuts'
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
})
