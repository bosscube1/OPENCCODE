import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider, Model } from '@opencode-ai/sdk'
import type { AppState, SetState, GetState } from '../slices/types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})
vi.mock('../prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prefs')>()
  return { ...actual, savePrefs: vi.fn() }
})
vi.mock('../routing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routing')>()
  return { ...actual, selectModel: vi.fn(), parseModelKey: vi.fn() }
})
vi.mock('../slices/attemptMachine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/attemptMachine')>()
  return { ...actual, getLedger: vi.fn() }
})

import { savePrefs } from '../prefs'
import { selectModel, parseModelKey } from '../routing'
import { getLedger } from '../slices/attemptMachine'
import { createRoutingSlice, type RoutingSlice } from '../slices/routingSlice'

const mockSavePrefs = vi.mocked(savePrefs)
const mockSelectModel = vi.mocked(selectModel)
const mockParseModelKey = vi.mocked(parseModelKey)
const mockGetLedger = vi.mocked(getLedger)

function createStore(): { get: GetState; set: SetState } {
  let state = {} as AppState
  const set = ((partial: unknown) => {
    const patch =
      typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  return { get, set }
}

/** Slice defaults first, then test overrides — the reverse order clobbers the overrides. */
function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: RoutingSlice } {
  const { get, set } = createStore()
  const slice = createRoutingSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    models: {},
    ...overrides
  } as Provider
}

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: 'test-model',
    name: 'Test Model',
    capabilities: {
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      toolcall: true,
      temperature: false,
      reasoning: false,
      attachment: false
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ...overrides
  } as Model
}

describe('routingSlice', () => {
  beforeEach(() => {
    mockSavePrefs.mockReset()
    mockSelectModel.mockReset()
    mockParseModelKey.mockReset()
    mockGetLedger.mockReset()
  })

  describe('initial state', () => {
    it('starts with defaults: providers empty, routing mode failover, no pinned model', () => {
      const { get } = setup()
      expect(get().providers).toEqual([])
      expect(get().defaultModels).toEqual({})
      expect(get().linkedProviderIDs).toEqual([])
      expect(get().providerID).toBeNull()
      expect(get().modelID).toBeNull()
      expect(get().pinnedProviderID).toBeNull()
      expect(get().pinnedModelID).toBeNull()
      expect(get().modelPool).toBeNull()
      expect(get().routingMode).toBe('failover')
      expect(get().showPaidModels).toBe(false)
    })
  })

  describe('toggleAutoRotate', () => {
    it('toggles from locked to failover', () => {
      const { get, slice } = setup({ routingMode: 'locked' })
      slice.toggleAutoRotate()
      expect(get().routingMode).toBe('failover')
      expect(mockSavePrefs).toHaveBeenCalledTimes(1)
    })

    it('toggles from failover to locked', () => {
      const { get, slice } = setup({ routingMode: 'failover' })
      slice.toggleAutoRotate()
      expect(get().routingMode).toBe('locked')
      expect(mockSavePrefs).toHaveBeenCalledTimes(1)
    })

    it('toggles from auto to locked (any non-locked mode toggles off)', () => {
      const { get, slice } = setup({ routingMode: 'auto' })
      slice.toggleAutoRotate()
      expect(get().routingMode).toBe('locked')
      expect(mockSavePrefs).toHaveBeenCalledTimes(1)
    })
  })

  describe('setRoutingMode', () => {
    it('sets routingMode and persists it', () => {
      const { get, slice } = setup({
        directory: '/project',
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        theme: 'dark',
        modelPool: null,
        showPaidModels: false
      })

      slice.setRoutingMode('auto')

      expect(get().routingMode).toBe('auto')
      expect(mockSavePrefs).toHaveBeenCalledTimes(1)
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({
          routingMode: 'auto',
          directory: '/project',
          providerID: 'google',
          modelID: 'gemini-3.6-flash',
          theme: 'dark',
          modelPool: null,
          showPaidModels: false
        })
      )
    })

    it('persists with modelPool if set', () => {
      const { slice } = setup({
        directory: '/project',
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        theme: 'light',
        modelPool: ['google/gemini-3.6-flash', 'groq/llama-3.3-70b-versatile'],
        showPaidModels: false
      })

      slice.setRoutingMode('locked')

      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({
          modelPool: ['google/gemini-3.6-flash', 'groq/llama-3.3-70b-versatile']
        })
      )
    })
  })

  describe('setShowPaidModels', () => {
    it('enables paid models and persists the flag', () => {
      const { get, slice } = setup({
        directory: '/project',
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        theme: 'dark',
        modelPool: null,
        routingMode: 'failover'
      })

      slice.setShowPaidModels(true)

      expect(get().showPaidModels).toBe(true)
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({
          showPaidModels: true,
          routingMode: 'failover'
        })
      )
    })

    it('disables paid models', () => {
      const { get, slice } = setup({
        directory: '/project',
        providerID: 'openai',
        modelID: 'gpt-4',
        theme: 'light',
        modelPool: null,
        routingMode: 'auto',
        showPaidModels: true
      })

      slice.setShowPaidModels(false)

      expect(get().showPaidModels).toBe(false)
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({ showPaidModels: false })
      )
    })
  })

  describe('setModelPool', () => {
    it('sets modelPool to a list and persists it', () => {
      const pool = ['google/gemini-3.6-flash', 'groq/llama-3.3-70b-versatile']
      const { get, slice } = setup({
        directory: '/project',
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        theme: 'dark',
        routingMode: 'failover'
      })

      slice.setModelPool(pool)

      expect(get().modelPool).toEqual(pool)
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({ modelPool: pool })
      )
    })

    it('clears modelPool by setting it to null', () => {
      const { get, slice } = setup({
        directory: '/project',
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        modelPool: ['google/gemini-3.6-flash'],
        routingMode: 'auto'
      })

      slice.setModelPool(null)

      expect(get().modelPool).toBeNull()
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({ modelPool: null })
      )
    })
  })

  describe('setModel', () => {
    it('sets both effective and pinned model, and persists', () => {
      const { get, slice } = setup({
        directory: '/project',
        theme: 'dark',
        modelPool: null,
        routingMode: 'failover',
        showPaidModels: false
      })

      slice.setModel('google', 'gemini-3.6-flash')

      expect(get().providerID).toBe('google')
      expect(get().modelID).toBe('gemini-3.6-flash')
      expect(get().pinnedProviderID).toBe('google')
      expect(get().pinnedModelID).toBe('gemini-3.6-flash')
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({
          providerID: 'google',
          modelID: 'gemini-3.6-flash',
          directory: '/project'
        })
      )
    })

    it('updates both pins when switching models', () => {
      const { get, slice } = setup({
        directory: '/project',
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        pinnedProviderID: 'google',
        pinnedModelID: 'gemini-3.6-flash',
        theme: 'light',
        routingMode: 'auto'
      })

      slice.setModel('groq', 'llama-3.3-70b-versatile')

      expect(get().providerID).toBe('groq')
      expect(get().modelID).toBe('llama-3.3-70b-versatile')
      expect(get().pinnedProviderID).toBe('groq')
      expect(get().pinnedModelID).toBe('llama-3.3-70b-versatile')
    })
  })

  describe('revertToPinned', () => {
    it('reverts effective model back to pinned', () => {
      const { get, slice } = setup({
        providerID: 'groq',
        modelID: 'llama-3.3-70b-versatile',
        pinnedProviderID: 'google',
        pinnedModelID: 'gemini-3.6-flash'
      })

      slice.revertToPinned()

      expect(get().providerID).toBe('google')
      expect(get().modelID).toBe('gemini-3.6-flash')
      expect(get().pinnedProviderID).toBe('google')
      expect(get().pinnedModelID).toBe('gemini-3.6-flash')
    })

    it('is a no-op when no pinned model is set', () => {
      const { get, slice } = setup({
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        pinnedProviderID: null,
        pinnedModelID: null
      })

      slice.revertToPinned()

      // Effective model stays unchanged
      expect(get().providerID).toBe('google')
      expect(get().modelID).toBe('gemini-3.6-flash')
    })

    it('is a no-op when only one of pinned values is set', () => {
      const { get, slice } = setup({
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        pinnedProviderID: 'groq',
        pinnedModelID: null
      })

      slice.revertToPinned()

      expect(get().providerID).toBe('google')
      expect(get().modelID).toBe('gemini-3.6-flash')
    })
  })

  describe('rotateToNextFreeModel', () => {
    it('returns null when no providers', () => {
      const { slice } = setup({ providers: [] })

      const result = slice.rotateToNextFreeModel()

      expect(result).toBeNull()
      expect(mockSelectModel).not.toHaveBeenCalled()
    })

    it('returns null when selectModel chooses nothing (all exhausted)', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue(null)

      const { slice } = setup({
        providers: [
          provider({ id: 'google', models: { 'gemini-3.6-flash': model() } })
        ],
        linkedProviderIDs: ['google']
      })

      const result = slice.rotateToNextFreeModel()

      expect(result).toBeNull()
    })

    it('returns null when no models are agent-capable', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue(null)

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            models: {
              'embedding-model': model({
                id: 'embedding-model',
                capabilities: {
                  input: { text: true, audio: false, image: false, video: false, pdf: false },
                  output: { text: false, audio: false, image: false, video: false, pdf: false }, // Not an agent model
                  toolcall: false,
                  temperature: false,
                  reasoning: false,
                  attachment: false
                }
              })
            }
          })
        ],
        linkedProviderIDs: ['google']
      })

      const result = slice.rotateToNextFreeModel()

      expect(result).toBeNull()
    })

    it('picks a healthy free model and returns its details', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('google/gemini-3.6-flash')
      mockParseModelKey.mockReturnValue({ providerID: 'google', modelID: 'gemini-3.6-flash' })

      const testModel = model({ id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' })
      const testProvider = provider({
        id: 'google',
        name: 'Google',
        models: { 'gemini-3.6-flash': testModel }
      })

      const { get, slice } = setup({
        providers: [testProvider],
        linkedProviderIDs: ['google'],
        providerID: null,
        modelID: null,
        modelPool: null
      })

      const result = slice.rotateToNextFreeModel()

      expect(result).toEqual({
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        providerName: 'Google',
        modelName: 'Gemini 3.6 Flash'
      })
      expect(get().providerID).toBe('google')
      expect(get().modelID).toBe('gemini-3.6-flash')
    })

    it('does not change pinned model when rotating', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('groq/llama-3.3-70b-versatile')
      mockParseModelKey.mockReturnValue({ providerID: 'groq', modelID: 'llama-3.3-70b-versatile' })

      const { get, slice } = setup({
        providers: [
          provider({
            id: 'google',
            name: 'Google',
            models: { 'gemini-3.6-flash': model() }
          }),
          provider({
            id: 'groq',
            name: 'Groq',
            models: { 'llama-3.3-70b-versatile': model({ id: 'llama-3.3-70b-versatile' }) }
          })
        ],
        linkedProviderIDs: ['google', 'groq'],
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        pinnedProviderID: 'google',
        pinnedModelID: 'gemini-3.6-flash'
      })

      slice.rotateToNextFreeModel()

      // Effective model changed
      expect(get().providerID).toBe('groq')
      expect(get().modelID).toBe('llama-3.3-70b-versatile')
      // Pinned model NOT changed
      expect(get().pinnedProviderID).toBe('google')
      expect(get().pinnedModelID).toBe('gemini-3.6-flash')
    })

    it('does NOT save prefs (R4: effective-only rotation)', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('groq/llama-3.3-70b-versatile')
      mockParseModelKey.mockReturnValue({ providerID: 'groq', modelID: 'llama-3.3-70b-versatile' })

      const { slice } = setup({
        providers: [
          provider({
            id: 'groq',
            name: 'Groq',
            models: { 'llama-3.3-70b-versatile': model({ id: 'llama-3.3-70b-versatile' }) }
          })
        ],
        linkedProviderIDs: ['groq']
      })

      slice.rotateToNextFreeModel()

      expect(mockSavePrefs).not.toHaveBeenCalled()
    })

    it('returns null when selectModel chooses the current model (no change)', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('google/gemini-3.6-flash')

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            name: 'Google',
            models: { 'gemini-3.6-flash': model() }
          })
        ],
        linkedProviderIDs: ['google'],
        providerID: 'google',
        modelID: 'gemini-3.6-flash'
      })

      const result = slice.rotateToNextFreeModel()

      expect(result).toBeNull()
    })

    it('excludes a specific model key when provided', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('groq/llama-3.3-70b-versatile')
      mockParseModelKey.mockReturnValue({ providerID: 'groq', modelID: 'llama-3.3-70b-versatile' })

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            name: 'Google',
            models: { 'gemini-3.6-flash': model({ id: 'gemini-3.6-flash' }) }
          }),
          provider({
            id: 'groq',
            name: 'Groq',
            models: { 'llama-3.3-70b-versatile': model({ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }) }
          })
        ],
        linkedProviderIDs: ['google', 'groq']
      })

      const result = slice.rotateToNextFreeModel('google/gemini-3.6-flash')

      expect(result).toEqual({
        providerID: 'groq',
        modelID: 'llama-3.3-70b-versatile',
        providerName: 'Groq',
        modelName: 'Llama 3.3 70B'
      })
      // Verify selectModel was called with available set not containing the excluded key
      const callArgs = mockSelectModel.mock.calls[0]
      const availableSet = callArgs[4]?.available as Set<string>
      expect(availableSet.has('google/gemini-3.6-flash')).toBe(false)
    })

    it('excludes all models from a provider when excludeProviderID is provided', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('mistral/devstral-latest')
      mockParseModelKey.mockImplementation((key) => {
        const sep = key.indexOf('/')
        if (sep <= 0 || sep === key.length - 1) return null
        return { providerID: key.slice(0, sep), modelID: key.slice(sep + 1) }
      })

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            name: 'Google',
            models: { 'gemini-3.6-flash': model({ id: 'gemini-3.6-flash' }) }
          }),
          provider({
            id: 'mistral',
            name: 'Mistral',
            models: { 'devstral-latest': model({ id: 'devstral-latest', name: 'Devstral Latest' }) }
          })
        ],
        linkedProviderIDs: ['google', 'mistral']
      })

      const result = slice.rotateToNextFreeModel(undefined, 'google')

      expect(result).toEqual({
        providerID: 'mistral',
        modelID: 'devstral-latest',
        providerName: 'Mistral',
        modelName: 'Devstral Latest'
      })
      // Verify selectModel was called with available set not containing any google models
      const callArgs = mockSelectModel.mock.calls[0]
      const availableSet = callArgs[4]?.available as Set<string>
      expect(availableSet.has('google/gemini-3.6-flash')).toBe(false)
    })

    it('returns null when parseModelKey fails', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('invalid-model-key')
      mockParseModelKey.mockReturnValue(null)

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            models: { 'gemini-3.6-flash': model() }
          })
        ],
        linkedProviderIDs: ['google']
      })

      const result = slice.rotateToNextFreeModel()

      expect(result).toBeNull()
    })

    it('returns null when provider or model not found in state', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('nonexistent/nonexistent')
      mockParseModelKey.mockReturnValue({ providerID: 'nonexistent', modelID: 'nonexistent' })

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            models: { 'gemini-3.6-flash': model() }
          })
        ],
        linkedProviderIDs: ['google']
      })

      const result = slice.rotateToNextFreeModel()

      expect(result).toBeNull()
    })

    it('uses current effective model as the "sticky" baseline', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('groq/llama-3.3-70b-versatile')
      mockParseModelKey.mockReturnValue({ providerID: 'groq', modelID: 'llama-3.3-70b-versatile' })

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            name: 'Google',
            models: { 'gemini-3.6-flash': model({ id: 'gemini-3.6-flash' }) }
          }),
          provider({
            id: 'groq',
            name: 'Groq',
            models: { 'llama-3.3-70b-versatile': model({ id: 'llama-3.3-70b-versatile' }) }
          })
        ],
        linkedProviderIDs: ['google', 'groq'],
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        modelPool: null
      })

      slice.rotateToNextFreeModel()

      // Verify selectModel received the current model as current
      const callArgs = mockSelectModel.mock.calls[0]
      expect(callArgs[4]?.current).toBe('google/gemini-3.6-flash')
    })

    it('uses model name from model.name when available', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('google/gemini-3.6-flash')
      mockParseModelKey.mockReturnValue({ providerID: 'google', modelID: 'gemini-3.6-flash' })

      const testModel = model({ id: 'gemini-3.6-flash', name: 'Custom Model Name' })
      const testProvider = provider({
        id: 'google',
        name: 'Google',
        models: { 'gemini-3.6-flash': testModel }
      })

      const { slice } = setup({
        providers: [testProvider],
        linkedProviderIDs: ['google']
      })

      const result = slice.rotateToNextFreeModel()

      expect(result?.modelName).toBe('Custom Model Name')
    })

    it('falls back to modelID when model.name is absent', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue('groq/llama-3.3-70b-versatile')
      mockParseModelKey.mockReturnValue({ providerID: 'groq', modelID: 'llama-3.3-70b-versatile' })

      const testModel = model({
        id: 'llama-3.3-70b-versatile',
        name: undefined as unknown as string
      })
      const testProvider = provider({
        id: 'groq',
        name: 'Groq',
        models: { 'llama-3.3-70b-versatile': testModel }
      })

      const { slice } = setup({
        providers: [testProvider],
        linkedProviderIDs: ['groq']
      })

      const result = slice.rotateToNextFreeModel()

      expect(result?.modelName).toBe('llama-3.3-70b-versatile')
    })

    it('only considers agent-capable models', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue(null)

      const agentModel = model({
        id: 'gemini-3.6-flash',
        capabilities: {
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          toolcall: true,
          temperature: false,
          reasoning: false,
          attachment: false
        }
      })
      const nonAgentModel = model({
        id: 'embedding-model',
        capabilities: {
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: false, audio: false, image: false, video: false, pdf: false },
          toolcall: false,
          temperature: false,
          reasoning: false,
          attachment: false
        }
      })

      const testProvider = provider({
        id: 'google',
        name: 'Google',
        models: {
          'gemini-3.6-flash': agentModel,
          'embedding-model': nonAgentModel
        }
      })

      const { slice } = setup({
        providers: [testProvider],
        linkedProviderIDs: ['google']
      })

      slice.rotateToNextFreeModel()

      // Verify selectModel was called with available set only containing the agent model
      const callArgs = mockSelectModel.mock.calls[0]
      const availableSet = callArgs[4]?.available as Set<string>
      expect(availableSet.has('google/gemini-3.6-flash')).toBe(true)
      expect(availableSet.has('google/embedding-model')).toBe(false)
    })

    it('only considers linked (authenticated) providers', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue(null)

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            name: 'Google',
            models: { 'gemini-3.6-flash': model({ id: 'gemini-3.6-flash' }) }
          }),
          provider({
            id: 'anthropic',
            name: 'Anthropic',
            models: { 'claude-3.5-sonnet': model({ id: 'claude-3.5-sonnet' }) }
          })
        ],
        linkedProviderIDs: ['google'] // Only google is linked
      })

      slice.rotateToNextFreeModel()

      // Verify selectModel was called with available set only containing google models
      const callArgs = mockSelectModel.mock.calls[0]
      const availableSet = callArgs[4]?.available as Set<string>
      expect(availableSet.has('google/gemini-3.6-flash')).toBe(true)
      expect(availableSet.has('anthropic/claude-3.5-sonnet')).toBe(false)
    })

    it('passes the correct options to selectModel', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue(null)

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            models: { 'gemini-3.6-flash': model({ id: 'gemini-3.6-flash' }) }
          })
        ],
        linkedProviderIDs: ['google'],
        providerID: 'google',
        modelID: 'gemini-3.6-flash',
        modelPool: ['google/gemini-3.6-flash', 'groq/llama-3.3-70b-versatile']
      })

      slice.rotateToNextFreeModel()

      const callArgs = mockSelectModel.mock.calls[0]
      expect(callArgs[0]).toEqual(['google/gemini-3.6-flash', 'groq/llama-3.3-70b-versatile']) // pool
      expect(callArgs[4]).toMatchObject({
        sticky: false,
        current: 'google/gemini-3.6-flash',
        authenticatedProviders: expect.any(Set)
      })
    })

    it('handles providers with undefined models property', () => {
      mockGetLedger.mockReturnValue({})
      mockSelectModel.mockReturnValue(null)

      const { slice } = setup({
        providers: [
          provider({
            id: 'google',
            models: undefined as unknown as Record<string, Model>
          })
        ],
        linkedProviderIDs: ['google']
      })

      const result = slice.rotateToNextFreeModel()

      expect(result).toBeNull()
    })
  })
})
