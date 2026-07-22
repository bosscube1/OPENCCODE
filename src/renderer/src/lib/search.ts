/**
 * Pure text search and highlighting helpers.
 * No React, no side effects, no store access.
 */

/**
 * Find all case-insensitive start offsets of query string in text.
 * Returns empty array if query is empty.
 * Finds overlapping matches (e.g. 'aa' in 'aaa' returns [0, 1]).
 */
export function findMatches(text: string, query: string): number[] {
  if (!query || query.length === 0) return []

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const matches: number[] = []
  let pos = 0

  while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
    matches.push(pos)
    pos += 1 // Move by 1 to find overlapping matches
  }

  return matches
}

/**
 * Create a snippet around the first match of query in text.
 * - Collapses runs of whitespace to single spaces
 * - Adds '…' prefix/suffix when truncated
 * - If no match and empty query, returns first ~radius*2 chars
 * - If no match and non-empty query, returns first ~radius*2 chars + '…'
 */
export function makeSnippet(text: string, query: string, radius = 60): string {
  if (!text) return ''

  // Collapse whitespace
  const normalized = text.replace(/\s+/g, ' ').trim()

  // If no query, return beginning
  if (!query || query.length === 0) {
    const len = radius * 2
    if (normalized.length <= len) return normalized
    return normalized.slice(0, len) + '…'
  }

  // Find first match
  const lowerText = normalized.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const matchIndex = lowerText.indexOf(lowerQuery)

  if (matchIndex === -1) {
    // No match found
    const len = radius * 2
    if (normalized.length <= len) return normalized
    return normalized.slice(0, len) + '…'
  }

  // Match found - build snippet around it
  const matchEnd = matchIndex + query.length
  const start = Math.max(0, matchIndex - radius)
  const end = Math.min(normalized.length, matchEnd + radius)

  let snippet = normalized.slice(start, end)

  if (start > 0) snippet = '…' + snippet
  if (end < normalized.length) snippet = snippet + '…'

  return snippet
}

/**
 * Split text into segments for highlighting.
 * Returns alternating non-match/match segments so a renderer can wrap matches.
 * Case-insensitive matching.
 * Empty query → single {text, match: false} segment.
 */
export function splitHighlight(
  text: string,
  query: string
): Array<{ text: string; match: boolean }> {
  if (!query || query.length === 0) {
    return [{ text, match: false }]
  }

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const segments: Array<{ text: string; match: boolean }> = []
  let pos = 0

  while (pos < text.length) {
    const nextMatch = lowerText.indexOf(lowerQuery, pos)

    if (nextMatch === -1) {
      // No more matches
      if (pos < text.length) {
        segments.push({ text: text.slice(pos), match: false })
      }
      break
    }

    // Non-match segment before the match
    if (nextMatch > pos) {
      segments.push({ text: text.slice(pos, nextMatch), match: false })
    }

    // Match segment
    const matchEnd = nextMatch + query.length
    segments.push({ text: text.slice(nextMatch, matchEnd), match: true })
    pos = matchEnd
  }

  return segments.length === 0 ? [{ text, match: false }] : segments
}
