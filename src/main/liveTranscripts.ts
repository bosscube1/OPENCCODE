/**
 * Persists finished Gemini Live transcripts as markdown under
 * `userData/live-transcripts/<timestamp>.md` (`oc:live:saveTranscript`).
 * Validation and formatting are pure and exported for tests; only
 * `saveLiveTranscript` touches Electron/fs.
 */
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type LiveTranscriptMessage = {
  role: 'you' | 'gemini' | 'system'
  text: string
  /** Epoch ms when the entry was produced; rendered as an ISO timestamp when present. */
  at?: number
}

const MAX_MESSAGES = 5000
const MAX_TEXT_LENGTH = 32_000
const ROLES: ReadonlySet<string> = new Set(['you', 'gemini', 'system'])

/** Validate the renderer-supplied message list; throws a readable Error on any bad entry. */
export function validateTranscriptMessages(input: unknown): LiveTranscriptMessage[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('messages must be a non-empty array')
  if (input.length > MAX_MESSAGES) throw new Error(`messages may not exceed ${MAX_MESSAGES} entries`)
  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`message ${index} must be an object`)
    }
    const raw = entry as Record<string, unknown>
    if (typeof raw.role !== 'string' || !ROLES.has(raw.role)) throw new Error(`message ${index} has an invalid role`)
    if (typeof raw.text !== 'string' || raw.text.length === 0 || raw.text.length > MAX_TEXT_LENGTH) {
      throw new Error(`message ${index} text must be 1-${MAX_TEXT_LENGTH} characters`)
    }
    if (raw.at !== undefined && (typeof raw.at !== 'number' || !Number.isFinite(raw.at))) {
      throw new Error(`message ${index} at must be a finite number`)
    }
    return {
      role: raw.role as LiveTranscriptMessage['role'],
      text: raw.text,
      ...(raw.at !== undefined ? { at: raw.at } : {})
    }
  })
}

/** Markdown with one role header per entry; `at` timestamps render as ISO. */
export function formatTranscriptMarkdown(messages: LiveTranscriptMessage[], now: Date = new Date()): string {
  const lines = [`# Gemini Live transcript — ${now.toISOString()}`, '']
  for (const message of messages) {
    const label = message.role === 'you' ? 'You' : message.role === 'gemini' ? 'Gemini' : 'Status'
    const stamp = message.at === undefined ? '' : ` — ${new Date(message.at).toISOString()}`
    lines.push(`## ${label}${stamp}`, '', message.text, '')
  }
  return lines.join('\n')
}

/** Write the transcript to disk and return the saved file path. */
export function saveLiveTranscript(input: unknown): string {
  const messages = validateTranscriptMessages(input)
  const dir = join(app.getPath('userData'), 'live-transcripts')
  mkdirSync(dir, { recursive: true })
  // `:` and `.` are illegal/noisy in Windows filenames.
  const filePath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
  writeFileSync(filePath, formatTranscriptMarkdown(messages), 'utf8')
  return filePath
}
