import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mutable state read by the mocked electron module below. Declared via vi.hoisted so it exists
// before the hoisted vi.mock factory runs (see https://vitest.dev/api/vi.html#vi-hoisted).
const state = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataPath }
}))

// No real network call can happen: ./nanogpt is fully mocked.
vi.mock('../nanogpt', () => ({
  fetchSubscriptionModels: vi.fn(),
  fetchImageModels: vi.fn()
}))

import {
  buildConfigContent,
  clearBalanceBilled,
  markBalanceBilled,
  nanogptEnv,
  readCache,
  readCacheSync,
  refreshCatalogs,
  writeCache,
  type NanogptCache
} from '../nanogptConfig'
import { fetchImageModels, fetchSubscriptionModels } from '../nanogpt'
import type { NanoChatModel } from '../nanogpt'

function cacheFilePath(): string {
  return join(state.userDataPath, 'nanogpt-models.json')
}

describe('nanogptConfig', () => {
  beforeEach(() => {
    state.userDataPath = mkdtempSync(join(tmpdir(), 'opencode-nanogpt-'))
    vi.mocked(fetchSubscriptionModels).mockReset()
    vi.mocked(fetchImageModels).mockReset()
  })

  afterEach(() => {
    rmSync(state.userDataPath, { recursive: true, force: true })
  })

  describe('buildConfigContent', () => {
    it('returns null for an empty model list', () => {
      expect(buildConfigContent([])).toBeNull()
    })

    it('produces a provider.nanogpt block with the expected npm/baseURL/apiKey placeholder', () => {
      const content = buildConfigContent([{ id: 'model-a' }])
      expect(content).not.toBeNull()
      const parsed = JSON.parse(content as string)
      expect(parsed.provider.nanogpt.npm).toBe('@ai-sdk/openai-compatible')
      expect(parsed.provider.nanogpt.options.baseURL).toBe('https://nano-gpt.com/api/subscription/v1')
      expect(parsed.provider.nanogpt.options.apiKey).toBe('{env:NANOGPT_API_KEY}')
    })

    it('never embeds the actual API key value, only the placeholder (security)', () => {
      const sentinel = 'sk-test-sentinel-should-never-appear-9f8e7d6c5b4a'
      const previous = process.env.NANOGPT_API_KEY
      process.env.NANOGPT_API_KEY = sentinel
      try {
        const content = buildConfigContent([{ id: 'model-a' }]) as string
        expect(content).toContain('{env:NANOGPT_API_KEY}')
        expect(content).not.toContain(sentinel)
      } finally {
        if (previous === undefined) delete process.env.NANOGPT_API_KEY
        else process.env.NANOGPT_API_KEY = previous
      }
    })

    it('maps vision:true to attachment:true and an image input modality', () => {
      const content = buildConfigContent([{ id: 'model-a', capabilities: { vision: true } }]) as string
      const model = JSON.parse(content).provider.nanogpt.models['model-a']
      expect(model.attachment).toBe(true)
      expect(model.modalities.input).toContain('image')
    })

    it('maps a model without vision to attachment:false and text-only input modality', () => {
      const content = buildConfigContent([{ id: 'model-a' }]) as string
      const model = JSON.parse(content).provider.nanogpt.models['model-a']
      expect(model.attachment).toBe(false)
      expect(model.modalities.input).toEqual(['text'])
    })

    it('defaults tool_call (snake_case) to true when tool_calling is undefined', () => {
      const content = buildConfigContent([{ id: 'model-a' }]) as string
      const model = JSON.parse(content).provider.nanogpt.models['model-a']
      expect(model.tool_call).toBe(true)
      expect(model).not.toHaveProperty('toolcall')
    })

    it('sets tool_call to false only when capabilities.tool_calling is explicitly false', () => {
      const content = buildConfigContent([
        { id: 'model-a', capabilities: { tool_calling: false } }
      ]) as string
      const model = JSON.parse(content).provider.nanogpt.models['model-a']
      expect(model.tool_call).toBe(false)
    })

    it('falls back to default context/output limits when the catalogue omits them', () => {
      const content = buildConfigContent([{ id: 'model-a' }]) as string
      const model = JSON.parse(content).provider.nanogpt.models['model-a']
      expect(model.limit.context).toBe(128000)
      expect(model.limit.output).toBe(16384)
    })

    it('uses the catalogue-provided context_length/max_output_tokens when present', () => {
      const content = buildConfigContent([
        { id: 'model-a', context_length: 200000, max_output_tokens: 8192 }
      ]) as string
      const model = JSON.parse(content).provider.nanogpt.models['model-a']
      expect(model.limit.context).toBe(200000)
      expect(model.limit.output).toBe(8192)
    })
  })

  describe('readCache', () => {
    it('returns the empty cache shape when the file is missing', async () => {
      expect(await readCache()).toEqual({ version: 1, fetchedAt: 0, chat: [], image: [], balanceBilled: [] })
    })

    it('returns the empty cache and does not throw when the file is corrupt', async () => {
      writeFileSync(cacheFilePath(), '{ not json', 'utf8')
      await expect(readCache()).resolves.not.toThrow()
      expect(await readCache()).toEqual({ version: 1, fetchedAt: 0, chat: [], image: [], balanceBilled: [] })
    })

    it('drops malformed model entries and keeps well-formed ones', async () => {
      const raw = {
        version: 1,
        fetchedAt: 123,
        chat: [{ id: '' }, { nope: 1 }, { id: 'ok' }],
        image: [],
        balanceBilled: []
      }
      writeFileSync(cacheFilePath(), JSON.stringify(raw), 'utf8')
      const cache = await readCache()
      expect(cache.chat).toHaveLength(1)
      expect(cache.chat[0].id).toBe('ok')
    })
  })

  describe('readCacheSync', () => {
    it('returns the empty cache shape when the file is missing', () => {
      expect(readCacheSync()).toEqual({ version: 1, fetchedAt: 0, chat: [], image: [], balanceBilled: [] })
    })

    it('returns the empty cache and does not throw when the file is corrupt', () => {
      writeFileSync(cacheFilePath(), '{ not json', 'utf8')
      expect(() => readCacheSync()).not.toThrow()
      expect(readCacheSync()).toEqual({ version: 1, fetchedAt: 0, chat: [], image: [], balanceBilled: [] })
    })

    it('drops malformed model entries and keeps well-formed ones', () => {
      const raw = {
        version: 1,
        fetchedAt: 123,
        chat: [{ id: '' }, { nope: 1 }, { id: 'ok' }],
        image: [],
        balanceBilled: []
      }
      writeFileSync(cacheFilePath(), JSON.stringify(raw), 'utf8')
      const cache = readCacheSync()
      expect(cache.chat).toHaveLength(1)
      expect(cache.chat[0].id).toBe('ok')
    })
  })

  describe('writeCache / readCache round trip', () => {
    it('round-trips a populated cache', async () => {
      const cache: NanogptCache = {
        version: 1,
        fetchedAt: 1700000000000,
        chat: [{ id: 'model-a', name: 'Model A' }],
        image: [{ id: 'image-a', name: 'Image A' }],
        balanceBilled: ['image-a']
      }
      await writeCache(cache)
      expect(await readCache()).toEqual(cache)
    })
  })

  describe('balance-billed tracking', () => {
    it('markBalanceBilled adds the id and is idempotent', async () => {
      await markBalanceBilled('model-x')
      expect((await readCache()).balanceBilled).toEqual(['model-x'])

      await markBalanceBilled('model-x')
      expect((await readCache()).balanceBilled).toEqual(['model-x'])
    })

    it('clearBalanceBilled removes the id', async () => {
      await markBalanceBilled('model-x')
      await clearBalanceBilled('model-x')
      expect((await readCache()).balanceBilled).toEqual([])
    })
  })

  describe('nanogptEnv', () => {
    it('returns {} when no key is linked', () => {
      expect(nanogptEnv(false)).toEqual({})
    })

    it('returns {} when hasKey is true but the cache holds no chat models', () => {
      expect(nanogptEnv(true)).toEqual({})
    })

    it('returns an object whose only key is OPENCODE_CONFIG_CONTENT when the cache is populated', async () => {
      await writeCache({ version: 1, fetchedAt: 1, chat: [{ id: 'model-a' }], image: [], balanceBilled: [] })
      const env = nanogptEnv(true)
      expect(Object.keys(env)).toEqual(['OPENCODE_CONFIG_CONTENT'])
    })
  })

  describe('refreshCatalogs', () => {
    it('sets restartRequired true on a first fetch from an empty cache', async () => {
      vi.mocked(fetchSubscriptionModels).mockResolvedValueOnce([{ id: 'model-a' }, { id: 'model-b' }])
      vi.mocked(fetchImageModels).mockResolvedValueOnce([])

      const result = await refreshCatalogs()

      expect(result.restartRequired).toBe(true)
      expect(result.chatCount).toBe(2)
      expect(result.imageCount).toBe(0)
    })

    it('sets restartRequired false when re-fetching an identical id set', async () => {
      await writeCache({
        version: 1,
        fetchedAt: 1,
        chat: [{ id: 'model-a' }, { id: 'model-b' }],
        image: [],
        balanceBilled: []
      })
      // Same ids, different order — set comparison must be order-insensitive.
      vi.mocked(fetchSubscriptionModels).mockResolvedValueOnce([{ id: 'model-b' }, { id: 'model-a' }])
      vi.mocked(fetchImageModels).mockResolvedValueOnce([])

      const result = await refreshCatalogs()

      expect(result.restartRequired).toBe(false)
    })

    it('flips restartRequired back to true when the id set changes', async () => {
      await writeCache({
        version: 1,
        fetchedAt: 1,
        chat: [{ id: 'model-a' }, { id: 'model-b' }],
        image: [],
        balanceBilled: []
      })
      vi.mocked(fetchSubscriptionModels).mockResolvedValueOnce([{ id: 'model-a' }, { id: 'model-c' }])
      vi.mocked(fetchImageModels).mockResolvedValueOnce([])

      const result = await refreshCatalogs()

      expect(result.restartRequired).toBe(true)
    })

    it('preserves balanceBilled across a refresh', async () => {
      await writeCache({
        version: 1,
        fetchedAt: 1,
        chat: [{ id: 'model-a' }],
        image: [],
        balanceBilled: ['image-x']
      })
      vi.mocked(fetchSubscriptionModels).mockResolvedValueOnce([{ id: 'model-a' }])
      vi.mocked(fetchImageModels).mockResolvedValueOnce([])

      await refreshCatalogs()

      expect((await readCache()).balanceBilled).toEqual(['image-x'])
    })

    it('leaves the previously-written cache untouched when the fetch rejects', async () => {
      const original: NanogptCache = {
        version: 1,
        fetchedAt: 111,
        chat: [{ id: 'model-a' } as NanoChatModel],
        image: [],
        balanceBilled: []
      }
      await writeCache(original)
      vi.mocked(fetchSubscriptionModels).mockRejectedValueOnce(new Error('network down'))
      vi.mocked(fetchImageModels).mockResolvedValueOnce([])

      await expect(refreshCatalogs()).rejects.toThrow('network down')

      expect(await readCache()).toEqual(original)
    })
  })
})
