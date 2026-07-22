import { describe, it, expect } from 'vitest'
import { PROVIDER_CATALOG, catalogByProvider, catalogByEnvVar } from '../providerCatalog'

describe('providerCatalog', () => {
  it('every entry has non-empty required fields', () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.providerID).toBeTruthy()
      expect(entry.envVar).toBeTruthy()
      expect(entry.label).toBeTruthy()
      expect(entry.docsUrl).toBeTruthy()
    }
  })

  it('no duplicate providerIDs', () => {
    const ids = PROVIDER_CATALOG.map((e) => e.providerID)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('no duplicate envVars', () => {
    const vars = PROVIDER_CATALOG.map((e) => e.envVar)
    const unique = new Set(vars)
    expect(unique.size).toBe(vars.length)
  })

  it('catalogByProvider resolves groq correctly', () => {
    const entry = catalogByProvider('groq')
    expect(entry).toBeDefined()
    expect(entry?.envVar).toBe('GROQ_API_KEY')
    expect(entry?.label).toBe('Groq')
  })

  it('catalogByEnvVar resolves GEMINI_API_KEY correctly', () => {
    const entry = catalogByEnvVar('GEMINI_API_KEY')
    expect(entry).toBeDefined()
    expect(entry?.providerID).toBe('google')
    expect(entry?.label).toBe('Google Gemini')
  })

  it('unknown lookups return undefined', () => {
    expect(catalogByProvider('unknown-provider')).toBeUndefined()
    expect(catalogByEnvVar('UNKNOWN_API_KEY')).toBeUndefined()
  })

  it('lookups are case-sensitive', () => {
    expect(catalogByProvider('GROQ')).toBeUndefined()
    expect(catalogByEnvVar('groq_api_key')).toBeUndefined()
  })

  it('all entries with test config have required test fields', () => {
    for (const entry of PROVIDER_CATALOG) {
      if (entry.test) {
        expect(entry.test.url).toBeTruthy()
        expect(entry.test.authHeader).toBeTruthy()
      }
    }
  })
})
