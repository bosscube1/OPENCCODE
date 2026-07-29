/**
 * Transcript accumulation for the Gemini Live screen copilot.
 * Pure (no store/React/IPC) so it stays unit-testable.
 */

export type LiveTranscriptEntry = {
  /** Stable React key — from a monotonically increasing counter, never index+text. */
  id: number
  role: 'you' | 'gemini' | 'system'
  text: string
  /** Epoch ms, for the saved markdown transcript. */
  at: number
}

/**
 * Append a chunk, merging consecutive same-role fragments (streaming
 * transcription arrives in pieces). Fragments carry no separator, so merges
 * join with a single space — naive concatenation garbles words. 'system'
 * entries never merge.
 */
export function appendTranscriptChunk(
  items: LiveTranscriptEntry[],
  entry: LiveTranscriptEntry
): LiveTranscriptEntry[] {
  if (!entry.text.trim()) return items
  const previous = items.at(-1)
  if (previous && previous.role === entry.role && entry.role !== 'system') {
    const text = `${previous.text} ${entry.text.trim()}`.replace(/ {2,}/g, ' ')
    return [...items.slice(0, -1), { ...previous, text, at: entry.at }]
  }
  return [...items, entry]
}
