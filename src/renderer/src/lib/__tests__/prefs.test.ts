import { describe, expect, it, beforeEach } from 'vitest'
import { loadPrefs, savePrefs, EMPTY_PREFS, type Prefs } from '../prefs'

describe('prefs — localStorage preferences round-trip', () => {
  // Setup: mock localStorage on globalThis.window for node environment
  beforeEach(() => {
    const storage: Record<string, string> = {}
    globalThis.window = {
      localStorage: {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, value: string) => {
          storage[key] = value
        },
        removeItem: (key: string) => {
          delete storage[key]
        },
        clear: () => {
          Object.keys(storage).forEach((key) => delete storage[key])
        },
        length: 0,
        key: () => null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  })

  describe('loadPrefs', () => {
    it('returns EMPTY_PREFS when localStorage is empty', () => {
      const result = loadPrefs()
      expect(result).toEqual(EMPTY_PREFS)
    })

    it('returns EMPTY_PREFS when localStorage contains malformed JSON', () => {
      window.localStorage.setItem('opencode-desktop:prefs', '{this is not valid json]')
      const result = loadPrefs()
      expect(result).toEqual(EMPTY_PREFS)
    })

    it('returns EMPTY_PREFS on any parsing error', () => {
      window.localStorage.setItem('opencode-desktop:prefs', '{"directory": null}')
      // Replace setItem to throw an error on read
      const originalGetItem = window.localStorage.getItem
      window.localStorage.getItem = () => {
        throw new Error('simulated storage error')
      }
      const result = loadPrefs()
      expect(result).toEqual(EMPTY_PREFS)
      window.localStorage.getItem = originalGetItem
    })
  })

  describe('full round-trip: savePrefs then loadPrefs', () => {
    it('saves and loads all fields exactly as provided', () => {
      const original: Prefs = {
        directory: '/some/path',
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        autoRotate: false,
        theme: 'dark',
        modelPool: ['google/gemini-3.6-flash', 'groq/llama-3.3-70b-versatile'],
        stickyModel: true,
        routingMode: 'failover',
        showPaidModels: false,
        compareTargets: ['google/gemini-3.6-flash'],
        viewMode: 'verbose',
        showBalanceInStatus: true,
      }
      savePrefs(original)
      const loaded = loadPrefs()
      expect(loaded).toEqual(original)
    })

    it('preserves null values correctly', () => {
      const prefs: Prefs = {
        directory: null,
        providerID: null,
        modelID: null,
        autoRotate: false,
        theme: 'auto',
        modelPool: null,
        stickyModel: false,
        routingMode: 'locked',
        showPaidModels: false,
        compareTargets: [],
        viewMode: 'normal',
        showBalanceInStatus: false,
      }
      savePrefs(prefs)
      const loaded = loadPrefs()
      expect(loaded.directory).toBeNull()
      expect(loaded.providerID).toBeNull()
      expect(loaded.modelID).toBeNull()
      expect(loaded.modelPool).toBeNull()
    })

    it('preserves empty arrays', () => {
      const prefs: Prefs = {
        ...EMPTY_PREFS,
        compareTargets: [],
      }
      savePrefs(prefs)
      const loaded = loadPrefs()
      expect(loaded.compareTargets).toEqual([])
    })
  })

  describe('legacy migration: autoRotate + stickyModel -> routingMode', () => {
    it('maps stickyModel=true (any autoRotate) to routingMode=failover', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        stickyModel: true,
        autoRotate: true,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.routingMode).toBe('failover')
    })

    it('maps stickyModel=false, autoRotate=false to routingMode=locked', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        stickyModel: false,
        autoRotate: false,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.routingMode).toBe('locked')
    })

    it('maps stickyModel=false, autoRotate=true to routingMode=failover', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        stickyModel: false,
        autoRotate: true,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.routingMode).toBe('failover')
    })

    it('defaults to failover when legacy fields are missing', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.routingMode).toBe('failover')
    })

    it('prefers explicit routingMode over legacy fields', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        stickyModel: true,
        autoRotate: false,
        routingMode: 'auto' as const,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.routingMode).toBe('auto')
    })

    it('loads derived autoRotate and stickyModel from routingMode', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'auto' as const,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.autoRotate).toBe(true) // auto === true
      expect(loaded.stickyModel).toBe(false) // auto !== failover
    })

    it('derives stickyModel=true from routingMode=failover', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.stickyModel).toBe(true)
      expect(loaded.autoRotate).toBe(false)
    })

    it('derives autoRotate=false from routingMode=locked', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'locked' as const,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.autoRotate).toBe(false)
      expect(loaded.stickyModel).toBe(false)
    })
  })

  describe('paid-model pruning when showPaidModels=false', () => {
    it('prunes paid providerID/modelID on load', () => {
      const raw = {
        directory: null,
        providerID: 'openai', // paid
        modelID: 'gpt-4',
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.providerID).toBeNull()
      expect(loaded.modelID).toBeNull()
    })

    it('preserves free providerID/modelID on load', () => {
      const raw = {
        directory: null,
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.providerID).toBe('google')
      expect(loaded.modelID).toBe('gemini-3.6-flash')
    })

    it('keeps providerID/modelID when showPaidModels=true', () => {
      const raw = {
        directory: null,
        providerID: 'openai',
        modelID: 'gpt-4',
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: true,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.providerID).toBe('openai')
      expect(loaded.modelID).toBe('gpt-4')
    })

    it('prunes paid models from modelPool when showPaidModels=false', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        modelPool: [
          'google/gemini-3.6-flash', // free
          'openai/gpt-4', // paid
          'groq/llama-3.3-70b-versatile', // free
          'anthropic/claude-3-sonnet', // paid
        ],
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.modelPool).toEqual([
        'google/gemini-3.6-flash',
        'groq/llama-3.3-70b-versatile',
      ])
    })

    it('keeps all models in modelPool when showPaidModels=true', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: true,
        modelPool: [
          'google/gemini-3.6-flash',
          'openai/gpt-4',
          'groq/llama-3.3-70b-versatile',
        ],
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.modelPool).toEqual([
        'google/gemini-3.6-flash',
        'openai/gpt-4',
        'groq/llama-3.3-70b-versatile',
      ])
    })

    it('sets modelPool to null if all entries are filtered out', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        modelPool: ['openai/gpt-4', 'anthropic/claude-3-sonnet'], // all paid
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.modelPool).toBeNull()
    })

    it('ignores malformed entries in modelPool', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        modelPool: [
          'google/gemini-3.6-flash',
          'no-slash', // malformed
          123, // wrong type
          'groq/llama-3.3-70b-versatile',
        ],
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.modelPool).toEqual([
        'google/gemini-3.6-flash',
        'groq/llama-3.3-70b-versatile',
      ])
    })

    it('prunes paid models from compareTargets when showPaidModels=false', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        compareTargets: [
          'google/gemini-3.6-flash', // free
          'openai/gpt-4', // paid
          'groq/llama-3.3-70b-versatile', // free
        ],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.compareTargets).toEqual([
        'google/gemini-3.6-flash',
        'groq/llama-3.3-70b-versatile',
      ])
    })

    it('keeps all targets in compareTargets when showPaidModels=true', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: true,
        compareTargets: [
          'google/gemini-3.6-flash',
          'openai/gpt-4',
          'groq/llama-3.3-70b-versatile',
        ],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.compareTargets).toEqual([
        'google/gemini-3.6-flash',
        'openai/gpt-4',
        'groq/llama-3.3-70b-versatile',
      ])
    })

    it('ignores malformed entries in compareTargets', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        compareTargets: [
          'google/gemini-3.6-flash',
          'no-slash', // lacks /
          123, // wrong type
          'groq/llama-3.3-70b-versatile',
        ],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.compareTargets).toEqual([
        'google/gemini-3.6-flash',
        'groq/llama-3.3-70b-versatile',
      ])
    })
  })

  describe('partial-save merge: savePrefs preserves unprovided fields', () => {
    it('preserves routingMode when savePrefs is called without it', () => {
      // First save with a full Prefs that includes routingMode
      const initial: Prefs = {
        ...EMPTY_PREFS,
        routingMode: 'auto',
      }
      savePrefs(initial)

      // Now save without routingMode
      const partial = {
        directory: '/new/path',
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        autoRotate: false,
        theme: 'dark' as const,
        modelPool: null,
        stickyModel: false,
        compareTargets: [],
      }
      savePrefs(partial)

      // Load and verify routingMode was preserved
      const loaded = loadPrefs()
      expect(loaded.routingMode).toBe('auto')
      expect(loaded.directory).toBe('/new/path')
    })

    it('preserves showPaidModels when savePrefs is called without it', () => {
      const initial: Prefs = {
        ...EMPTY_PREFS,
        showPaidModels: true,
      }
      savePrefs(initial)

      const partial = {
        directory: '/some/path',
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        autoRotate: false,
        theme: 'auto' as const,
        modelPool: null,
        stickyModel: false,
        compareTargets: [],
      }
      savePrefs(partial)

      const loaded = loadPrefs()
      expect(loaded.showPaidModels).toBe(true)
      expect(loaded.directory).toBe('/some/path')
    })

    it('preserves compareTargets when savePrefs is called without it', () => {
      const initial: Prefs = {
        ...EMPTY_PREFS,
        compareTargets: ['google/gemini-3.6-flash', 'groq/llama-3.3-70b-versatile'],
      }
      savePrefs(initial)

      const partial = {
        directory: '/new/dir',
        providerID: null,
        modelID: null,
        autoRotate: false,
        theme: 'auto' as const,
        modelPool: null,
        stickyModel: false,
      }
      savePrefs(partial)

      const loaded = loadPrefs()
      expect(loaded.compareTargets).toEqual([
        'google/gemini-3.6-flash',
        'groq/llama-3.3-70b-versatile',
      ])
      expect(loaded.directory).toBe('/new/dir')
    })

    it('can override routingMode explicitly', () => {
      const initial: Prefs = {
        ...EMPTY_PREFS,
        routingMode: 'auto',
      }
      savePrefs(initial)

      const partial = {
        directory: null,
        providerID: null,
        modelID: null,
        autoRotate: false,
        theme: 'auto' as const,
        modelPool: null,
        stickyModel: false,
        routingMode: 'locked' as const,
      }
      savePrefs(partial)

      const loaded = loadPrefs()
      expect(loaded.routingMode).toBe('locked')
    })
  })

  describe('known bug: savePrefs derives autoRotate from routingMode, discarding caller input', () => {
    it('autoRotate written to storage is computed from routingMode, not from input', () => {
      // This test documents a quirk in savePrefs (line ~142):
      // autoRotate: merged.routingMode === 'auto'
      // This overwrites any autoRotate value the caller passed.
      // See src/renderer/src/lib/slices/routingSlice.ts:60 for the call site.
      // The fix is scheduled for U6 and a later wave.

      // Save with explicit autoRotate=true and routingMode=failover
      const prefs = {
        directory: null,
        providerID: null,
        modelID: null,
        autoRotate: true, // explicitly set to true
        theme: 'auto' as const,
        modelPool: null,
        stickyModel: false,
        routingMode: 'failover' as const, // not 'auto'
      }
      savePrefs(prefs)

      // Load back
      const loaded = loadPrefs()

      // autoRotate is false because routingMode !== 'auto',
      // NOT true as the caller provided
      expect(loaded.autoRotate).toBe(false)
      expect(loaded.routingMode).toBe('failover')

      // Verify the raw JSON confirms savePrefs wrote autoRotate=false
      const raw = JSON.parse(window.localStorage.getItem('opencode-desktop:prefs') || '{}')
      expect(raw.autoRotate).toBe(false)
    })

    it('autoRotate is true only when routingMode is auto, regardless of input', () => {
      // Set up initial state
      const prefs1 = {
        directory: null,
        providerID: null,
        modelID: null,
        autoRotate: false, // caller says false
        theme: 'auto' as const,
        modelPool: null,
        stickyModel: false,
        routingMode: 'auto' as const, // but mode is auto
      }
      savePrefs(prefs1)
      let loaded = loadPrefs()
      expect(loaded.autoRotate).toBe(true) // auto forces true

      // Now flip to locked with autoRotate=true
      const prefs2 = {
        directory: null,
        providerID: null,
        modelID: null,
        autoRotate: true, // caller says true
        theme: 'auto' as const,
        modelPool: null,
        stickyModel: false,
        routingMode: 'locked' as const, // but mode is locked
      }
      savePrefs(prefs2)
      loaded = loadPrefs()
      expect(loaded.autoRotate).toBe(false) // locked forces false
    })
  })

  describe('edge cases and error handling', () => {
    it('ignores extra unknown fields in persisted JSON', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        compareTargets: [],
        unknownField1: 'value',
        unknownField2: 12345,
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded).toEqual({
        directory: null,
        providerID: null,
        modelID: null,
        autoRotate: false,
        theme: 'auto',
        modelPool: null,
        stickyModel: true, // derived from routingMode === 'failover'
        routingMode: 'failover',
        showPaidModels: false,
        compareTargets: [],
        viewMode: 'normal',
        showBalanceInStatus: false,
      })
    })

    it('handles invalid theme value by defaulting to auto', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'invalid-theme',
        routingMode: 'failover' as const,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.theme).toBe('auto')
    })

    it('handles invalid routingMode by defaulting based on legacy fields', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        routingMode: 'invalid-mode',
        autoRotate: true,
        stickyModel: false,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      // Falls back to legacy: stickyModel=false && autoRotate=true => failover
      expect(loaded.routingMode).toBe('failover')
    })

    it('handles empty modelPool by returning null', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        modelPool: [],
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.modelPool).toBeNull()
    })

    it('handles compareTargets being undefined', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.compareTargets).toEqual([])
    })

    it('savePrefs silently catches storage errors', () => {
      const prefs: Prefs = {
        ...EMPTY_PREFS,
        directory: '/test',
      }
      // Mock setItem to throw
      const originalSetItem = window.localStorage.setItem
      window.localStorage.setItem = () => {
        throw new Error('storage quota exceeded')
      }
      // Should not throw
      expect(() => savePrefs(prefs)).not.toThrow()
      window.localStorage.setItem = originalSetItem
    })

    it('loadPrefs catches storage errors and returns empty prefs', () => {
      const originalGetItem = window.localStorage.getItem
      window.localStorage.getItem = () => {
        throw new Error('storage access denied')
      }
      const result = loadPrefs()
      expect(result).toEqual(EMPTY_PREFS)
      window.localStorage.getItem = originalGetItem
    })
  })

  describe('type validation on loaded fields', () => {
    it('coerces non-string directory to null', () => {
      const raw = {
        directory: 12345,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.directory).toBeNull()
    })

    it('coerces non-string providerID to null', () => {
      const raw = {
        directory: null,
        providerID: true,
        modelID: 'gemini-3.6-flash',
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.providerID).toBeNull()
    })

    it('coerces non-boolean showPaidModels to false', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: 'yes',
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.showPaidModels).toBe(false)
    })

    it('defaults modelPool to null when not an array', () => {
      const raw = {
        directory: null,
        providerID: null,
        modelID: null,
        theme: 'auto',
        routingMode: 'failover' as const,
        showPaidModels: false,
        modelPool: 'not-an-array',
        compareTargets: [],
      }
      window.localStorage.setItem('opencode-desktop:prefs', JSON.stringify(raw))
      const loaded = loadPrefs()
      expect(loaded.modelPool).toBeNull()
    })
  })
})
