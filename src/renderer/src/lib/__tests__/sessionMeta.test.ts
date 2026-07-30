import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadSessionMeta,
  saveSessionMeta,
  setSessionMeta,
  isPinned,
  isArchived,
  pruneSessionMeta,
  compareSessions,
  type SessionMetaMap
} from '../sessionMeta'

const SESSION_META_KEY = 'opencode-desktop:session-meta'

describe('sessionMeta', () => {
  let mockStorage: Record<string, string> = {}

  beforeEach(() => {
    mockStorage = {}
    const localStorageMock = {
      getItem: (k: string) => mockStorage[k] || null,
      setItem: (k: string, v: string) => {
        mockStorage[k] = v
      },
      removeItem: (k: string) => {
        delete mockStorage[k]
      },
      clear: () => {
        mockStorage = {}
      }
    }
    vi.stubGlobal('localStorage', localStorageMock)
  })

  describe('loadSessionMeta', () => {
    it('returns an empty map when nothing is stored', () => {
      expect(loadSessionMeta()).toEqual({})
    })

    it('returns an empty map on corrupt JSON', () => {
      mockStorage[SESSION_META_KEY] = '{not json'
      expect(loadSessionMeta()).toEqual({})
    })

    it('returns an empty map when the stored value is not an object', () => {
      mockStorage[SESSION_META_KEY] = JSON.stringify(['a', 'b'])
      expect(loadSessionMeta()).toEqual({})
      mockStorage[SESSION_META_KEY] = JSON.stringify('hello')
      expect(loadSessionMeta()).toEqual({})
      mockStorage[SESSION_META_KEY] = JSON.stringify(42)
      expect(loadSessionMeta()).toEqual({})
    })

    it('drops entries that are not objects', () => {
      mockStorage[SESSION_META_KEY] = JSON.stringify({
        a: { pinned: true, archived: false },
        b: 'not-an-object',
        c: null,
        d: ['array']
      })
      expect(loadSessionMeta()).toEqual({ a: { pinned: true, archived: false } })
    })

    it('coerces missing/partial booleans to false (legacy partial data)', () => {
      mockStorage[SESSION_META_KEY] = JSON.stringify({
        a: { pinned: true },
        b: { archived: true },
        c: {}
      })
      const result = loadSessionMeta()
      expect(result.a).toEqual({ pinned: true, archived: false })
      expect(result.b).toEqual({ pinned: false, archived: true })
      // c has both false after coercion, so it is dropped
      expect(result.c).toBeUndefined()
    })

    it('drops entries where both flags are false', () => {
      mockStorage[SESSION_META_KEY] = JSON.stringify({
        a: { pinned: false, archived: false },
        b: { pinned: true, archived: false }
      })
      expect(loadSessionMeta()).toEqual({ b: { pinned: true, archived: false } })
    })

    it('ignores garbage non-boolean field values', () => {
      mockStorage[SESSION_META_KEY] = JSON.stringify({
        a: { pinned: 'yes', archived: 1 }
      })
      // both coerce to false -> dropped
      expect(loadSessionMeta()).toEqual({})
    })
  })

  describe('saveSessionMeta', () => {
    it('persists the map as JSON', () => {
      const map: SessionMetaMap = { a: { pinned: true, archived: false } }
      saveSessionMeta(map)
      expect(JSON.parse(mockStorage[SESSION_META_KEY])).toEqual(map)
    })

    it('does not throw when storage is unavailable', () => {
      vi.stubGlobal('localStorage', {
        setItem: () => {
          throw new Error('quota exceeded')
        }
      })
      expect(() => saveSessionMeta({ a: { pinned: true, archived: false } })).not.toThrow()
    })
  })

  describe('setSessionMeta', () => {
    it('is pure: does not mutate the input map', () => {
      const map: SessionMetaMap = { a: { pinned: false, archived: false } }
      const frozen = Object.freeze({ ...map })
      const result = setSessionMeta(frozen as SessionMetaMap, 'a', { pinned: true })
      expect(result).not.toBe(frozen)
      expect(frozen.a).toEqual({ pinned: false, archived: false })
      expect(result.a).toEqual({ pinned: true, archived: false })
    })

    it('creates a new entry for an unknown id', () => {
      const result = setSessionMeta({}, 'x', { pinned: true })
      expect(result).toEqual({ x: { pinned: true, archived: false } })
    })

    it('removes the entry entirely when both flags end up false', () => {
      const map: SessionMetaMap = { a: { pinned: true, archived: false } }
      const result = setSessionMeta(map, 'a', { pinned: false })
      expect(result).toEqual({})
      expect(result.a).toBeUndefined()
    })

    it('merges a patch onto the existing entry', () => {
      const map: SessionMetaMap = { a: { pinned: true, archived: false } }
      const result = setSessionMeta(map, 'a', { archived: true })
      expect(result.a).toEqual({ pinned: true, archived: true })
    })
  })

  describe('isPinned / isArchived', () => {
    it('reflects stored flags and defaults to false for unknown ids', () => {
      const map: SessionMetaMap = { a: { pinned: true, archived: false }, b: { pinned: false, archived: true } }
      expect(isPinned(map, 'a')).toBe(true)
      expect(isArchived(map, 'a')).toBe(false)
      expect(isPinned(map, 'b')).toBe(false)
      expect(isArchived(map, 'b')).toBe(true)
      expect(isPinned(map, 'missing')).toBe(false)
      expect(isArchived(map, 'missing')).toBe(false)
    })
  })

  describe('pruneSessionMeta', () => {
    it('drops entries for session ids the server no longer knows about', () => {
      const map: SessionMetaMap = {
        a: { pinned: true, archived: false },
        b: { pinned: false, archived: true },
        c: { pinned: true, archived: true }
      }
      const result = pruneSessionMeta(map, ['a', 'c'])
      expect(result).toEqual({
        a: { pinned: true, archived: false },
        c: { pinned: true, archived: true }
      })
    })

    it('is pure and does not mutate the input', () => {
      const map: SessionMetaMap = { a: { pinned: true, archived: false } }
      const result = pruneSessionMeta(map, [])
      expect(map).toEqual({ a: { pinned: true, archived: false } })
      expect(result).toEqual({})
    })

    it('returns the same reference when nothing changes', () => {
      const map: SessionMetaMap = { a: { pinned: true, archived: false } }
      const result = pruneSessionMeta(map, ['a'])
      expect(result).toBe(map)
    })
  })

  describe('compareSessions', () => {
    it('puts pinned sessions before unpinned ones regardless of stamp', () => {
      const map: SessionMetaMap = { old: { pinned: true, archived: false } }
      const a = { id: 'old', stamp: 1 }
      const b = { id: 'new', stamp: 100 }
      expect(compareSessions(map, a, b)).toBeLessThan(0)
      expect(compareSessions(map, b, a)).toBeGreaterThan(0)
    })

    it('orders by stamp descending within the pinned group', () => {
      const map: SessionMetaMap = {
        p1: { pinned: true, archived: false },
        p2: { pinned: true, archived: false }
      }
      const a = { id: 'p1', stamp: 50 }
      const b = { id: 'p2', stamp: 100 }
      expect(compareSessions(map, a, b)).toBeGreaterThan(0)
      expect(compareSessions(map, b, a)).toBeLessThan(0)
    })

    it('orders by stamp descending within the unpinned group', () => {
      const map: SessionMetaMap = {}
      const a = { id: 'x', stamp: 50 }
      const b = { id: 'y', stamp: 100 }
      expect(compareSessions(map, a, b)).toBeGreaterThan(0)
      expect(compareSessions(map, b, a)).toBeLessThan(0)
    })

    it('returns 0 for equal stamps in the same group', () => {
      const map: SessionMetaMap = {}
      const a = { id: 'x', stamp: 50 }
      const b = { id: 'y', stamp: 50 }
      expect(compareSessions(map, a, b)).toBe(0)
    })
  })
})
