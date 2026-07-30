import { describe, expect, it } from 'vitest'
import { appendTranscriptChunk, type LiveTranscriptEntry } from '../liveTranscript'

let nextId = 1
function entry(role: LiveTranscriptEntry['role'], text: string, at = 1000): LiveTranscriptEntry {
  return { id: nextId++, role, text, at }
}

describe('appendTranscriptChunk', () => {
  it('appends a new entry when the role changes', () => {
    const items = appendTranscriptChunk([], entry('you', 'hello'))
    const next = appendTranscriptChunk(items, entry('gemini', 'hi there'))
    expect(next).toHaveLength(2)
    expect(next[1].text).toBe('hi there')
  })

  it('merges consecutive same-role fragments with a single space', () => {
    let items = appendTranscriptChunk([], entry('gemini', 'Sure,'))
    items = appendTranscriptChunk(items, entry('gemini', 'I can see a browser window'))
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('Sure, I can see a browser window')
  })

  it('collapses the join when the fragment already carries whitespace', () => {
    let items = appendTranscriptChunk([], entry('you', 'what is '))
    items = appendTranscriptChunk(items, entry('you', ' this?'))
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('what is this?')
  })

  it('keeps the first entry id and refreshes the timestamp on merge', () => {
    const first = entry('you', 'hello', 1000)
    let items = appendTranscriptChunk([], first)
    items = appendTranscriptChunk(items, entry('you', 'world', 2000))
    expect(items[0].id).toBe(first.id)
    expect(items[0].at).toBe(2000)
  })

  it('never merges system entries', () => {
    let items = appendTranscriptChunk([], entry('system', 'Connected.'))
    items = appendTranscriptChunk(items, entry('system', 'Reconnecting…'))
    expect(items).toHaveLength(2)
  })

  it('ignores blank fragments', () => {
    const items = appendTranscriptChunk([], entry('you', 'hello'))
    expect(appendTranscriptChunk(items, entry('gemini', '   '))).toBe(items)
    expect(appendTranscriptChunk(items, entry('gemini', ''))).toBe(items)
  })
})
