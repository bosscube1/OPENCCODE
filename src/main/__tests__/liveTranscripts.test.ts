import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mutable state read by the mocked electron module below. Declared via vi.hoisted so it exists
// before the hoisted vi.mock factory runs (see https://vitest.dev/api/vi.html#vi-hoisted).
const state = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataPath }
}))

import { formatTranscriptMarkdown, saveLiveTranscript, validateTranscriptMessages } from '../liveTranscripts'

describe('validateTranscriptMessages', () => {
  it('accepts a valid transcript and preserves role/text/at', () => {
    const input = [
      { role: 'system', text: 'Connected.' },
      { role: 'you', text: 'What is on my screen?', at: 1722250000000 },
      { role: 'gemini', text: 'A code editor.' }
    ]
    expect(validateTranscriptMessages(input)).toEqual([
      { role: 'system', text: 'Connected.' },
      { role: 'you', text: 'What is on my screen?', at: 1722250000000 },
      { role: 'gemini', text: 'A code editor.' }
    ])
  })

  it('rejects non-arrays and empty transcripts', () => {
    expect(() => validateTranscriptMessages(undefined)).toThrow(/non-empty array/)
    expect(() => validateTranscriptMessages('you: hi')).toThrow(/non-empty array/)
    expect(() => validateTranscriptMessages([])).toThrow(/non-empty array/)
  })

  it('caps the message count', () => {
    const tooMany = Array.from({ length: 5001 }, () => ({ role: 'you', text: 'hi' }))
    expect(() => validateTranscriptMessages(tooMany)).toThrow(/may not exceed 5000/)
  })

  it('rejects entries with a bad shape, role, text or timestamp', () => {
    expect(() => validateTranscriptMessages([null])).toThrow(/message 0 must be an object/)
    expect(() => validateTranscriptMessages([['you', 'hi']])).toThrow(/message 0 must be an object/)
    expect(() => validateTranscriptMessages([{ role: 'assistant', text: 'hi' }])).toThrow(/invalid role/)
    expect(() => validateTranscriptMessages([{ role: 'you', text: '' }])).toThrow(/text must be/)
    expect(() => validateTranscriptMessages([{ role: 'you', text: 'x'.repeat(32_001) }])).toThrow(/text must be/)
    expect(() => validateTranscriptMessages([{ role: 'you', text: 5 }])).toThrow(/text must be/)
    expect(() => validateTranscriptMessages([{ role: 'you', text: 'hi', at: 'now' }])).toThrow(/at must be/)
    expect(() => validateTranscriptMessages([{ role: 'you', text: 'hi', at: Number.NaN }])).toThrow(/at must be/)
  })

  it('reports the index of the offending entry', () => {
    const input = [
      { role: 'you', text: 'fine' },
      { role: 'gemini', text: 'fine too' },
      { role: 'you' }
    ]
    expect(() => validateTranscriptMessages(input)).toThrow(/message 2 text must be/)
  })
})

describe('formatTranscriptMarkdown', () => {
  it('renders role headers with ISO timestamps', () => {
    const markdown = formatTranscriptMarkdown(
      [
        { role: 'system', text: 'Connected.' },
        { role: 'you', text: 'What is this?', at: Date.UTC(2026, 6, 29, 12, 0, 0) },
        { role: 'gemini', text: 'A dashboard.' }
      ],
      new Date(Date.UTC(2026, 6, 29, 12, 5, 0))
    )
    expect(markdown).toBe(
      [
        '# Gemini Live transcript — 2026-07-29T12:05:00.000Z',
        '',
        '## Status',
        '',
        'Connected.',
        '',
        '## You — 2026-07-29T12:00:00.000Z',
        '',
        'What is this?',
        '',
        '## Gemini',
        '',
        'A dashboard.',
        ''
      ].join('\n')
    )
  })
})

describe('saveLiveTranscript', () => {
  beforeEach(() => {
    state.userDataPath = mkdtempSync(join(tmpdir(), 'live-transcripts-test-'))
  })

  afterEach(() => {
    rmSync(state.userDataPath, { recursive: true, force: true })
  })

  it('writes markdown under userData/live-transcripts and returns the path', () => {
    const saved = saveLiveTranscript([
      { role: 'you', text: 'Hello', at: Date.UTC(2026, 6, 29, 12, 0, 0) },
      { role: 'gemini', text: 'Hi there.' }
    ])
    expect(saved.startsWith(join(state.userDataPath, 'live-transcripts'))).toBe(true)
    expect(saved.endsWith('.md')).toBe(true)
    // Windows filenames cannot carry `:` — the timestamp name must be sanitized.
    expect(saved).not.toMatch(/[:.]\w+\.md$/)
    const written = readFileSync(saved, 'utf8')
    expect(written).toContain('## You — 2026-07-29T12:00:00.000Z')
    expect(written).toContain('Hello')
    expect(written).toContain('## Gemini')
  })

  it('propagates validation errors instead of writing', () => {
    expect(() => saveLiveTranscript([{ role: 'nobody', text: 'hi' }])).toThrow(/invalid role/)
  })
})
