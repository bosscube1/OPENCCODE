import { describe, it, expect } from 'vitest'
import { findFileRefs } from '../filelinks'

const DIR = 'C:/Users/Hp/Dev/opencode-desktop'

describe('findFileRefs — positive matches', () => {
  it('matches path:line', () => {
    const text = 'error thrown at src/foo.ts:42 during build'
    const refs = findFileRefs(text, DIR)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ path: 'src/foo.ts', line: 42 })
    expect(text.slice(refs[0].start, refs[0].end)).toBe('src/foo.ts:42')
  })

  it('matches path:line:column', () => {
    const text = 'src/foo.ts:42:7'
    const refs = findFileRefs(text, DIR)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ path: 'src/foo.ts', line: 42, column: 7 })
    expect(text.slice(refs[0].start, refs[0].end)).toBe('src/foo.ts:42:7')
  })

  it('matches "at src/foo.ts:42" stack-trace style, excluding the "at" prefix', () => {
    const text = 'at src/foo.ts:42'
    const refs = findFileRefs(text, DIR)
    expect(refs).toHaveLength(1)
    expect(refs[0].path).toBe('src/foo.ts')
    expect(refs[0].line).toBe(42)
    expect(refs[0].start).toBe(text.indexOf('src/foo.ts'))
    expect(text.slice(refs[0].start, refs[0].end)).toBe('src/foo.ts:42')
  })

  it('matches "./src/foo.ts" relative paths without a line number', () => {
    const text = 'see ./src/foo.ts for details'
    const refs = findFileRefs(text, DIR)
    expect(refs).toHaveLength(1)
    expect(refs[0].path).toBe('./src/foo.ts')
    expect(refs[0].line).toBeUndefined()
  })

  it('matches bare repo-relative paths with a known code extension', () => {
    const text = 'modified utils.ts and README.md'
    const refs = findFileRefs(text, DIR)
    expect(refs.map((r) => r.path)).toEqual(['utils.ts', 'README.md'])
  })

  it('normalises Windows backslashes to POSIX separators in the returned path', () => {
    const text = 'touched src\\components\\Foo.tsx:10'
    const refs = findFileRefs(text, DIR)
    expect(refs).toHaveLength(1)
    expect(refs[0].path).toBe('src/components/Foo.tsx')
    expect(refs[0].line).toBe(10)
  })

  it('matches multiple refs in one string with correct offsets', () => {
    const text = 'Changed src/a.ts:1 and src/b.ts:2'
    const refs = findFileRefs(text, DIR)
    expect(refs).toHaveLength(2)
    expect(refs[0].path).toBe('src/a.ts')
    expect(refs[1].path).toBe('src/b.ts')
    for (const ref of refs) {
      expect(text.slice(ref.start, ref.end)).toContain(ref.path.split('/').pop() as string)
    }
  })

  it('matches a Windows absolute path that lies inside the project directory', () => {
    const text = `open ${DIR}/src/foo.ts:5`
    const refs = findFileRefs(text, DIR)
    expect(refs).toHaveLength(1)
    expect(refs[0].path).toBe('src/foo.ts')
    expect(refs[0].line).toBe(5)
  })
})

describe('findFileRefs — negative matches (must not match)', () => {
  it('does not match http(s) URLs, even with a port number', () => {
    const text = 'fetch https://example.com:443 for the payload'
    const refs = findFileRefs(text, DIR)
    expect(refs).toEqual([])
  })

  it('does not match a URL with a path that ends in a code-like extension', () => {
    const text = 'see https://example.com/docs/foo.ts for the source'
    const refs = findFileRefs(text, DIR)
    expect(refs).toEqual([])
  })

  it('does not match bare numbers', () => {
    const text = 'retried 42 times before giving up, budget was 100'
    const refs = findFileRefs(text, DIR)
    expect(refs).toEqual([])
  })

  it('does not match clock times', () => {
    const text = 'the meeting is at 12:30 today'
    const refs = findFileRefs(text, DIR)
    expect(refs).toEqual([])
  })

  it('does not match version strings', () => {
    const text = 'upgraded to node 1.2.3 successfully'
    const refs = findFileRefs(text, DIR)
    expect(refs).toEqual([])
  })

  it('does not match a Windows absolute path outside the project directory', () => {
    const text = 'crash log at C:\\Windows\\System32\\foo.dll'
    const refs = findFileRefs(text, DIR)
    expect(refs).toEqual([])
  })

  it('does not match an absolute path under a different project root', () => {
    const text = 'file at C:/Users/Hp/Dev/other-project/src/foo.ts:12'
    const refs = findFileRefs(text, DIR)
    expect(refs).toEqual([])
  })

  it('does not match a file with an unknown extension', () => {
    const text = 'downloaded archive.zip and photo.png'
    const refs = findFileRefs(text, DIR)
    expect(refs).toEqual([])
  })

  it('returns an empty array for empty input', () => {
    expect(findFileRefs('', DIR)).toEqual([])
  })

  it('returns an empty array when there is no directory context and only an absolute path is present', () => {
    const text = 'C:\\Users\\Hp\\Dev\\opencode-desktop\\src\\foo.ts:1'
    expect(findFileRefs(text, '')).toEqual([])
  })
})
