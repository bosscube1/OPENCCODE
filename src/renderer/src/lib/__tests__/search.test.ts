import { describe, expect, it } from 'vitest'
import { findMatches, makeSnippet, splitHighlight } from '../search'

describe('search helpers', () => {
  describe('findMatches', () => {
    it('finds all case-insensitive occurrences', () => {
      expect(findMatches('Hello World Hello', 'hello')).toEqual([0, 12])
      expect(findMatches('hello HELLO hello', 'hello')).toEqual([0, 6, 12])
    })

    it('finds single match', () => {
      expect(findMatches('The quick brown fox', 'quick')).toEqual([4])
    })

    it('finds no matches', () => {
      expect(findMatches('Hello World', 'xyz')).toEqual([])
    })

    it('returns empty array for empty query', () => {
      expect(findMatches('Hello World', '')).toEqual([])
    })

    it('returns empty array for empty text', () => {
      expect(findMatches('', 'hello')).toEqual([])
    })

    it('handles overlapping matches correctly', () => {
      expect(findMatches('aaa', 'aa')).toEqual([0, 1])
    })
  })

  describe('makeSnippet', () => {
    it('returns full text when it fits within radius*2', () => {
      const short = 'Hello World'
      expect(makeSnippet(short, 'hello', 60)).toBe('Hello World')
    })

    it('truncates and adds ellipsis when text exceeds radius*2', () => {
      const long = 'The quick brown fox jumps over the lazy dog and runs far away'
      const snippet = makeSnippet(long, '', 30)
      expect(snippet).toContain('…')
    })

    it('creates snippet around first match', () => {
      const text = 'The quick brown fox jumps over'
      const snippet = makeSnippet(text, 'brown', 5)
      expect(snippet).toContain('brown')
      expect(snippet).toContain('…')
    })

    it('handles match at the start', () => {
      const text = 'Hello World, nice to meet you'
      const snippet = makeSnippet(text, 'hello', 10)
      expect(snippet.startsWith('Hello')).toBe(true)
      expect(snippet.endsWith('…')).toBe(true)
    })

    it('handles match near the end', () => {
      const text = 'The quick brown fox jumps'
      const snippet = makeSnippet(text, 'jumps', 10)
      expect(snippet).toContain('jumps')
      expect(snippet.startsWith('…')).toBe(true)
    })

    it('collapses multiple whitespace to single space', () => {
      const text = 'Hello   \n\n  World'
      const snippet = makeSnippet(text, 'hello', 60)
      expect(snippet).toBe('Hello World')
    })

    it('collapses whitespace in match context', () => {
      const text = 'The   quick   brown   fox'
      const snippet = makeSnippet(text, 'quick', 10)
      expect(snippet).toContain('The quick brown')
    })

    it('returns beginning when no match found', () => {
      const text = 'Hello World, nice to meet you'
      const snippet = makeSnippet(text, 'xyz', 10)
      expect(snippet.length).toBeGreaterThan(0)
      expect(snippet).toContain('Hello')
    })

    it('returns beginning with ellipsis when no match and text is long', () => {
      const text = 'Hello World this is a very long text that goes on and on'
      const snippet = makeSnippet(text, 'notfound', 10)
      expect(snippet).toContain('…')
    })

    it('handles empty text', () => {
      expect(makeSnippet('', 'query', 60)).toBe('')
    })

    it('handles empty query', () => {
      const text = 'Hello World this is text'
      const snippet = makeSnippet(text, '', 20)
      expect(snippet).toContain('Hello')
    })

    it('case-insensitive match finding', () => {
      const text = 'The QUICK brown fox'
      const snippet = makeSnippet(text, 'quick', 5)
      expect(snippet).toContain('QUICK')
    })
  })

  describe('splitHighlight', () => {
    it('returns single non-match segment for empty query', () => {
      const result = splitHighlight('Hello World', '')
      expect(result).toEqual([{ text: 'Hello World', match: false }])
    })

    it('splits text with single match', () => {
      const result = splitHighlight('Hello World', 'world')
      expect(result).toEqual([
        { text: 'Hello ', match: false },
        { text: 'World', match: true }
      ])
    })

    it('handles multiple matches', () => {
      const result = splitHighlight('Hello hello HELLO', 'hello')
      expect(result).toEqual([
        { text: 'Hello', match: true },
        { text: ' ', match: false },
        { text: 'hello', match: true },
        { text: ' ', match: false },
        { text: 'HELLO', match: true }
      ])
    })

    it('case-insensitive matching', () => {
      const result = splitHighlight('HeLLo WoRLd', 'hello')
      expect(result).toEqual([{ text: 'HeLLo', match: true }, { text: ' WoRLd', match: false }])
    })

    it('reassembling segments equals original text', () => {
      const original = 'The quick brown fox jumps'
      const result = splitHighlight(original, 'quick')
      const reassembled = result.map((seg) => seg.text).join('')
      expect(reassembled).toBe(original)
    })

    it('match at start', () => {
      const result = splitHighlight('Quick fox', 'quick')
      expect(result[0]).toEqual({ text: 'Quick', match: true })
    })

    it('match at end', () => {
      const result = splitHighlight('The fox', 'fox')
      const last = result[result.length - 1]
      expect(last).toEqual({ text: 'fox', match: true })
    })

    it('adjacent matches', () => {
      const result = splitHighlight('testtest', 'test')
      expect(result).toEqual([
        { text: 'test', match: true },
        { text: 'test', match: true }
      ])
    })

    it('no matches', () => {
      const result = splitHighlight('Hello World', 'xyz')
      expect(result).toEqual([{ text: 'Hello World', match: false }])
    })

    it('multiple reassembly tests', () => {
      const tests = [
        'The quick brown fox',
        'aaa',
        'test',
        'Hello World, this is a test.',
        '   spaces   everywhere   '
      ]
      for (const text of tests) {
        const result = splitHighlight(text, 'test')
        const reassembled = result.map((seg) => seg.text).join('')
        expect(reassembled).toBe(text)
      }
    })

    it('handles empty text', () => {
      const result = splitHighlight('', 'query')
      expect(result).toEqual([{ text: '', match: false }])
    })
  })
})
