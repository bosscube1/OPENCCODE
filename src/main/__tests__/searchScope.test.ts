import { describe, expect, it } from 'vitest'
import { parseSearchOptions, resolveSearchDirectories } from '../searchScope'

describe('parseSearchOptions', () => {
  it('defaults to project scope when options is absent', () => {
    expect(parseSearchOptions(undefined)).toEqual({ scope: 'project' })
  })

  it('defaults to project scope when scope is absent from the object', () => {
    expect(parseSearchOptions({})).toEqual({ scope: 'project' })
  })

  it('accepts explicit project and all scopes', () => {
    expect(parseSearchOptions({ scope: 'project' })).toEqual({ scope: 'project' })
    expect(parseSearchOptions({ scope: 'all' })).toEqual({ scope: 'all' })
  })

  it('rejects non-object options', () => {
    expect(() => parseSearchOptions('all')).toThrow(/options must be an object/)
    expect(() => parseSearchOptions(42)).toThrow(/options must be an object/)
    expect(() => parseSearchOptions(null)).toThrow(/options must be an object/)
  })

  it('rejects unknown scope values instead of silently defaulting', () => {
    expect(() => parseSearchOptions({ scope: 'everything' })).toThrow(/scope must be "project" or "all"/)
    expect(() => parseSearchOptions({ scope: 1 })).toThrow(/scope must be "project" or "all"/)
  })
})

describe('resolveSearchDirectories', () => {
  it('returns just the active directory for project scope', () => {
    expect(resolveSearchDirectories('/a', 'project', ['/a', '/b'])).toEqual(['/a'])
  })

  it('returns the active directory plus every known project directory for all scope', () => {
    expect(resolveSearchDirectories('/a', 'all', ['/b', '/c'])).toEqual(['/a', '/b', '/c'])
  })

  it('de-duplicates while keeping the active directory first', () => {
    expect(resolveSearchDirectories('/a', 'all', ['/b', '/a', '/b'])).toEqual(['/a', '/b'])
  })

  it('treats Windows paths differing only in case or separator as one directory', () => {
    // Searching both spellings would return every hit in that project twice.
    expect(
      resolveSearchDirectories('C:\\Work', 'all', ['c:/work', 'C:\\Work\\', 'C:\\Other'])
    ).toEqual(['C:\\Work', 'C:\\Other'])
  })

  it('keeps the original spelling of the directory it does emit', () => {
    // The folded value is a dedupe key only — the server is given what the user configured.
    expect(resolveSearchDirectories('C:\\Work', 'all', ['D:/Repos/App'])).toEqual([
      'C:\\Work',
      'D:/Repos/App'
    ])
  })

  it('handles an empty project list', () => {
    expect(resolveSearchDirectories('/a', 'all', [])).toEqual(['/a'])
  })
})
