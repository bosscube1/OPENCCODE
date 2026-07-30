/**
 * Session pin/archive state — DESKTOP-LOCAL metadata.
 *
 * Sessions are owned by the opencode server and have no `pinned`/`archived` SDK field, so this
 * is persisted client-side in localStorage, mirroring the house pattern in `prefs.ts`: a load
 * function that defensively validates every field and never throws, and a save function wrapped
 * in try/catch since storage is best-effort.
 */

const SESSION_META_KEY = 'opencode-desktop:session-meta'

export type SessionMeta = { pinned: boolean; archived: boolean }

export type SessionMetaMap = Record<string, SessionMeta>

// Tests run under vitest's `node` environment, where `window` does not exist — fall back to
// `globalThis.localStorage` (which `vi.stubGlobal('localStorage', ...)` populates) so the pure
// load/save functions stay unit-testable without a DOM.
function getLocalStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  if (typeof globalThis !== 'undefined' && (globalThis as unknown as { localStorage?: Storage }).localStorage) {
    return (globalThis as unknown as { localStorage: Storage }).localStorage
  }
  return null
}

export function loadSessionMeta(): SessionMetaMap {
  try {
    const storage = getLocalStorage()
    if (!storage) return {}
    const raw = storage.getItem(SESSION_META_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const result: SessionMetaMap = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const v = value as Partial<Record<keyof SessionMeta, unknown>>
      const pinned = typeof v.pinned === 'boolean' ? v.pinned : false
      const archived = typeof v.archived === 'boolean' ? v.archived : false
      // Entries where both flags are false carry no information — drop them (garbage collection).
      if (!pinned && !archived) continue
      result[id] = { pinned, archived }
    }
    return result
  } catch {
    return {}
  }
}

export function saveSessionMeta(map: SessionMetaMap): void {
  try {
    const storage = getLocalStorage()
    if (!storage) return
    storage.setItem(SESSION_META_KEY, JSON.stringify(map))
  } catch {
    // Storage can be unavailable or full; session metadata is best-effort.
  }
}

/** Pure. Returns a new map; removes the entry entirely when both flags end up false. */
export function setSessionMeta(
  map: SessionMetaMap,
  id: string,
  patch: Partial<SessionMeta>
): SessionMetaMap {
  const current: SessionMeta = map[id] ?? { pinned: false, archived: false }
  const next: SessionMeta = { ...current, ...patch }
  const result = { ...map }
  if (!next.pinned && !next.archived) {
    delete result[id]
  } else {
    result[id] = next
  }
  return result
}

export function isPinned(map: SessionMetaMap, id: string): boolean {
  return map[id]?.pinned ?? false
}

export function isArchived(map: SessionMetaMap, id: string): boolean {
  return map[id]?.archived ?? false
}

/** Pure. Drops entries for session IDs the server no longer knows about. */
export function pruneSessionMeta(map: SessionMetaMap, liveIDs: readonly string[]): SessionMetaMap {
  const live = new Set(liveIDs)
  let changed = false
  const result: SessionMetaMap = {}
  for (const [id, meta] of Object.entries(map)) {
    if (live.has(id)) {
      result[id] = meta
    } else {
      changed = true
    }
  }
  return changed ? result : map
}

/** Pure comparator: pinned sessions first, then by stamp descending within each group. */
export function compareSessions(
  map: SessionMetaMap,
  a: { id: string; stamp: number },
  b: { id: string; stamp: number }
): number {
  const aPinned = isPinned(map, a.id)
  const bPinned = isPinned(map, b.id)
  if (aPinned !== bPinned) return aPinned ? -1 : 1
  return b.stamp - a.stamp
}
