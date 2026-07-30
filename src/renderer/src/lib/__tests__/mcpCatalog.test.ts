import { describe, expect, it } from 'vitest'
import { MCP_CATALOG, catalogEntryToFormValues, findCatalogEntry, searchCatalog } from '../mcpCatalog'
import { splitCommandLine } from '../mcp'

describe('MCP_CATALOG entries', () => {
  it('every command survives a round trip through the real splitCommandLine parser', () => {
    for (const entry of MCP_CATALOG) {
      if (entry.command === undefined) continue
      const argv = splitCommandLine(entry.command)
      expect(argv.length).toBeGreaterThan(0)
    }
  })

  it('has unique ids', () => {
    const ids = MCP_CATALOG.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every local entry has a command and no url', () => {
    for (const entry of MCP_CATALOG) {
      if (entry.kind !== 'local') continue
      expect(entry.command).toBeTruthy()
      expect(entry.url).toBeUndefined()
    }
  })

  it('every remote entry has a url and no command', () => {
    for (const entry of MCP_CATALOG) {
      if (entry.kind !== 'remote') continue
      expect(entry.url).toBeTruthy()
      expect(entry.command).toBeUndefined()
    }
  })

  it('no entry declares both command and url', () => {
    for (const entry of MCP_CATALOG) {
      expect(entry.command !== undefined && entry.url !== undefined).toBe(false)
    }
  })

  it('env entries ship a placeholder field and never a literal secret value', () => {
    for (const entry of MCP_CATALOG) {
      for (const row of entry.env ?? []) {
        expect(typeof row.placeholder).toBe('string')
        expect('value' in row).toBe(false)
        if (row.secret) {
          expect(row.placeholder).toBe('')
        }
      }
    }
  })
})

describe('searchCatalog', () => {
  it('returns everything on an empty query', () => {
    expect(searchCatalog('').length).toBe(MCP_CATALOG.length)
    expect(searchCatalog('   ').length).toBe(MCP_CATALOG.length)
  })

  it('is case-insensitive and matches the name', () => {
    const results = searchCatalog('FILESYSTEM')
    expect(results.some((entry) => entry.id === 'filesystem')).toBe(true)
  })

  it('matches the description as well as the name', () => {
    const results = searchCatalog('sqlite database file')
    expect(results.some((entry) => entry.id === 'sqlite')).toBe(true)
  })

  it('returns no results for an unmatched query', () => {
    expect(searchCatalog('definitely-not-a-real-server-xyz')).toEqual([])
  })
})

describe('findCatalogEntry', () => {
  it('finds an entry by id', () => {
    expect(findCatalogEntry('git')?.name).toBe('git')
  })

  it('returns undefined for a miss', () => {
    expect(findCatalogEntry('nonexistent')).toBeUndefined()
  })
})

describe('catalogEntryToFormValues', () => {
  it('prefills local entries with an empty-value env row per declared key', () => {
    const entry = findCatalogEntry('github')
    expect(entry).toBeDefined()
    const values = catalogEntryToFormValues(entry!)
    expect(values.kind).toBe('local')
    expect(values.name).toBe('github')
    expect(values.command).toBe(entry!.command)
    expect(values.url).toBe('')
    expect(values.environment).toEqual([{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '' }])
    expect(values.headers).toEqual([])
  })

  it('leaves command empty for entries without one', () => {
    const values = catalogEntryToFormValues({ id: 'x', name: 'x', description: '', kind: 'remote', url: 'https://example.com' })
    expect(values.command).toBe('')
    expect(values.url).toBe('https://example.com')
  })
})
