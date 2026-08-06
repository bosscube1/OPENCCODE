import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, SetState, GetState } from '../slices/types'
import type { OpencodeApi } from '../slices/api'
import type {
  GeneratedImageMeta,
  MessageWithParts,
  NanogptModelsResult,
  NanoImageModel
} from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { imageCaption, runImageCommand, rehydrateSessionImages } from '../slices/imagesSlice'

const mockApi = vi.mocked(api)

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

const notices: string[] = []

/**
 * The slice writes only through `messages` / `busy` and `addSystemNotice`, so the harness
 * supplies a real notice collector rather than a spy — most assertions here are about which
 * message the user ends up seeing.
 */
function setup(overrides: Partial<AppState> = {}): { get: GetState; set: SetState } {
  const { get, set } = createStore()
  set({
    messages: [],
    busy: false,
    activeSessionID: 'sess-1',
    appSettings: { nanogptSubscriptionOnly: false } as AppState['appSettings'],
    addSystemNotice: (text: string) => {
      notices.push(text)
    },
    ...overrides
  } as Partial<AppState>)
  return { get, set }
}

function imageModel(id: string, overrides: Partial<NanoImageModel> = {}): NanoImageModel {
  return { id, name: id, ...overrides } as NanoImageModel
}

function catalogue(overrides: Partial<NanogptModelsResult> = {}): NanogptModelsResult {
  return {
    chat: [],
    image: [imageModel('recraft/recraft-v3')],
    balanceBilled: [],
    fetchedAt: 1,
    ...overrides
  }
}

function meta(overrides: Partial<GeneratedImageMeta> = {}): GeneratedImageMeta {
  return {
    id: 'img-1',
    sessionID: 'sess-1',
    prompt: 'a red fox',
    model: 'recraft/recraft-v3',
    createdAt: 500,
    bytes: 10,
    ...overrides
  }
}

type ImagesApi = {
  models: ReturnType<typeof vi.fn>
  generate: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
}

function fakeApi(parts: Partial<ImagesApi> = {}): { api: OpencodeApi; calls: ImagesApi } {
  const calls: ImagesApi = {
    models: parts.models ?? vi.fn(async () => catalogue()),
    generate: parts.generate ?? vi.fn(async () => ({ images: [], billing: 'subscription' })),
    list: parts.list ?? vi.fn(async () => []),
    read: parts.read ?? vi.fn(async () => null)
  }
  return {
    api: {
      nanogpt: {
        models: calls.models,
        generate: calls.generate,
        images: { list: calls.list, read: calls.read }
      }
    } as unknown as OpencodeApi,
    calls
  }
}

function generated(id: string, base64 = 'AAAA') {
  return { meta: meta({ id }), base64 }
}

/**
 * `makeImageNotice` flattens each thumbnail into a `file` part carrying the data URI in `url`
 * (collections.ts:155-165); the caption is a separate leading `text` part.
 */
function imagesOf(message: MessageWithParts): Array<{ filename: string; dataUrl: string }> {
  return message.parts
    .filter((p): p is typeof p & { filename: string; url: string } => p.type === 'file')
    .map((p) => ({ filename: p.filename, dataUrl: p.url }))
}

describe('imagesSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
    notices.length = 0
  })

  describe('imageCaption', () => {
    it('marks a subscription generation without cost or balance noise', () => {
      const caption = imageCaption('a red fox', 'recraft/recraft-v3', { billing: 'subscription' })
      expect(caption).toContain('**a red fox**')
      expect(caption).toContain('`recraft/recraft-v3`')
      expect(caption).toContain('✅ subscription')
      expect(caption).not.toContain('cost')
      expect(caption).not.toContain('balance left')
    })

    it('flags a balance-billed generation and reports the remaining balance', () => {
      const caption = imageCaption('a fox', 'm', {
        billing: 'balance',
        cost: 0.04,
        remainingBalance: 1.25
      })
      expect(caption).toContain('⚠️ **billed to balance**')
      expect(caption).toContain('cost 0.04')
      expect(caption).toContain('balance left 1.25')
    })

    it('shows the cost but not a balance line when billing is unreported', () => {
      // `remainingBalance` is only meaningful for a balance charge; showing it for an
      // unreported one would imply a deduction that may not have happened.
      const caption = imageCaption('a fox', 'm', {
        billing: 'unknown',
        cost: 0.01,
        remainingBalance: 9
      })
      expect(caption).toContain('❔ billing unreported')
      expect(caption).toContain('cost 0.01')
      expect(caption).not.toContain('balance left')
    })

    it('omits the cost when the API did not report one', () => {
      const caption = imageCaption('a fox', 'm', { billing: 'balance', remainingBalance: 2 })
      expect(caption).not.toContain('cost')
      expect(caption).toContain('balance left 2')
    })
  })

  describe('runImageCommand', () => {
    it('explains the usage instead of calling the API on an empty prompt', async () => {
      const { get, set } = setup()
      await runImageCommand('', 'sess-1', set, get)
      expect(notices[0]).toContain('Usage: `/image <prompt>`')
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('reports a catalogue read failure as a notice, not the error banner', async () => {
      const { api: fake } = fakeApi({
        models: vi.fn(async () => {
          throw new Error('offline')
        })
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await runImageCommand('a fox', 'sess-1', set, get)

      expect(notices[0]).toContain('Could not read the NanoGPT image catalogue')
      expect(notices[0]).toContain('offline')
      expect(get().error).toBeUndefined()
      expect(get().busy).toBe(false)
    })

    it('points at the refresh action when no image models are cached', async () => {
      const { api: fake } = fakeApi({ models: vi.fn(async () => catalogue({ image: [] })) })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await runImageCommand('a fox', 'sess-1', set, get)

      expect(notices[0]).toContain('Providers → NanoGPT')
      expect(get().busy).toBe(false)
    })

    it('refuses when subscription-only leaves no eligible model, naming the setting', async () => {
      const { api: fake, calls } = fakeApi({
        models: vi.fn(async () =>
          catalogue({
            image: [imageModel('paid/model')],
            balanceBilled: ['paid/model']
          })
        )
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup({
        appSettings: { nanogptSubscriptionOnly: true } as AppState['appSettings']
      })

      await runImageCommand('a fox', 'sess-1', set, get)

      expect(notices[0]).toContain('Subscription images only')
      expect(calls.generate).not.toHaveBeenCalled()
      expect(get().busy).toBe(false)
    })

    it('generates, appends an image notice, and clears busy', async () => {
      const { api: fake, calls } = fakeApi({
        generate: vi.fn(async () => ({
          images: [generated('img-1'), generated('img-2')],
          billing: 'subscription',
          cost: 0.02,
          blacklisted: false
        }))
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await runImageCommand('a red fox', 'sess-1', set, get)

      expect(calls.generate).toHaveBeenCalledWith({
        prompt: 'a red fox',
        model: 'recraft/recraft-v3',
        sessionID: 'sess-1'
      })
      expect(get().busy).toBe(false)
      const message = get().messages.at(-1) as MessageWithParts
      const images = imagesOf(message)
      expect(images).toHaveLength(2)
      expect(images[0].dataUrl).toBe('data:image/png;base64,AAAA')
    })

    it('sanitises the model id into the download filename and numbers from one', async () => {
      // The model id becomes a filename on the user's disk; slashes and colons would either
      // create stray directories or fail the save outright.
      const { api: fake } = fakeApi({
        models: vi.fn(async () => catalogue({ image: [imageModel('vendor/model:v3 beta')] })),
        generate: vi.fn(async () => ({
          images: [generated('img-1'), generated('img-2')],
          billing: 'subscription',
          blacklisted: false
        }))
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await runImageCommand('a fox', 'sess-1', set, get)

      const files = imagesOf(get().messages.at(-1) as MessageWithParts).map((i) => i.filename)
      expect(files).toEqual(['vendor_model_v3_beta-1.png', 'vendor_model_v3_beta-2.png'])
    })

    it('warns when a generation turned out to bill the balance and got blacklisted', async () => {
      const { api: fake } = fakeApi({
        generate: vi.fn(async () => ({
          images: [generated('img-1')],
          billing: 'balance',
          paymentSource: 'credits',
          blacklisted: true
        }))
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await runImageCommand('a fox', 'sess-1', set, get)

      expect(notices.at(-1)).toContain('billed your NanoGPT **balance**')
      expect(notices.at(-1)).toContain('paymentSource: credits')
      expect(get().busy).toBe(false)
    })

    it('says paymentSource is unknown when the API omitted it', async () => {
      const { api: fake } = fakeApi({
        generate: vi.fn(async () => ({
          images: [generated('img-1')],
          billing: 'balance',
          blacklisted: true
        }))
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await runImageCommand('a fox', 'sess-1', set, get)

      expect(notices.at(-1)).toContain('paymentSource: unknown')
    })

    it('clears busy when generation throws', async () => {
      const { api: fake } = fakeApi({
        generate: vi.fn(async () => {
          throw new Error('rate limited')
        })
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await runImageCommand('a fox', 'sess-1', set, get)

      expect(notices.at(-1)).toContain('Image generation failed')
      expect(notices.at(-1)).toContain('rate limited')
      // The finally block is the only thing standing between a failed generation and a
      // permanently stuck composer.
      expect(get().busy).toBe(false)
      expect(get().messages).toHaveLength(0)
    })
  })

  describe('rehydrateSessionImages', () => {
    it('does nothing when the gallery cannot be read', async () => {
      const { api: fake } = fakeApi({
        list: vi.fn(async () => {
          throw new Error('index corrupt')
        })
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await rehydrateSessionImages('sess-1', get, set)

      // An unreadable gallery must never block opening a session, so this failure is silent.
      expect(get().messages).toHaveLength(0)
      expect(notices).toHaveLength(0)
    })

    it('does nothing when the session has no generated images', async () => {
      const { api: fake, calls } = fakeApi({ list: vi.fn(async () => []) })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await rehydrateSessionImages('sess-1', get, set)

      expect(calls.read).not.toHaveBeenCalled()
      expect(get().messages).toHaveLength(0)
    })

    it('restores images at their original transcript position', async () => {
      const { api: fake } = fakeApi({
        list: vi.fn(async () => [meta({ id: 'img-1', createdAt: 250 })]),
        read: vi.fn(async () => 'BBBB')
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await rehydrateSessionImages('sess-1', get, set)

      expect(get().messages).toHaveLength(1)
      const images = imagesOf(get().messages[0] as MessageWithParts)
      expect(images[0].dataUrl).toBe('data:image/png;base64,BBBB')
      expect(images[0].filename).toBe('recraft_recraft-v3.png')
    })

    it('carries a recorded cost into the restored caption and omits it when absent', async () => {
      const { api: fake } = fakeApi({
        list: vi.fn(async () => [
          meta({ id: 'priced', cost: 0.03, paymentSource: 'credits' }),
          meta({ id: 'free', paymentSource: 'subscription' })
        ]),
        read: vi.fn(async () => 'HHHH')
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await rehydrateSessionImages('sess-1', get, set)

      const captions = get().messages.map(
        (m) => (m.parts.find((p) => p.type === 'text') as { text: string } | undefined)?.text ?? ''
      )
      expect(captions.some((c) => c.includes('cost 0.03') && c.includes('⚠️'))).toBe(true)
      expect(captions.some((c) => c.includes('✅ subscription') && !c.includes('cost'))).toBe(true)
    })

    it('skips images whose bytes are missing or unreadable', async () => {
      const read = vi
        .fn<(id: string) => Promise<string | null>>()
        .mockRejectedValueOnce(new Error('gone'))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('CCCC')
      const { api: fake } = fakeApi({
        list: vi.fn(async () => [meta({ id: 'a' }), meta({ id: 'b' }), meta({ id: 'c' })]),
        read
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await rehydrateSessionImages('sess-1', get, set)

      expect(read).toHaveBeenCalledTimes(3)
      expect(get().messages).toHaveLength(1)
    })

    it('adds nothing when every image failed to read', async () => {
      const { api: fake } = fakeApi({
        list: vi.fn(async () => [meta({ id: 'a' })]),
        read: vi.fn(async () => null)
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await rehydrateSessionImages('sess-1', get, set)

      expect(get().messages).toHaveLength(0)
    })

    it('caps at 12 images and says how many were left out', async () => {
      // The cap is a memory bound — each image is held live as a base64 data URI — so the
      // transcript must not silently look complete.
      const metas = Array.from({ length: 15 }, (_, i) => meta({ id: `img-${i}` }))
      const { api: fake, calls } = fakeApi({
        list: vi.fn(async () => metas),
        read: vi.fn(async () => 'DDDD')
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await rehydrateSessionImages('sess-1', get, set)

      expect(calls.read).toHaveBeenCalledTimes(12)
      expect(get().messages).toHaveLength(13)
      const text = JSON.stringify(get().messages)
      expect(text).toContain('12 most recent generated images of 15')
      expect(text).toContain('Images view')
    })

    it('adds no cap notice when everything fits', async () => {
      const { api: fake } = fakeApi({
        list: vi.fn(async () => [meta({ id: 'a' }), meta({ id: 'b' })]),
        read: vi.fn(async () => 'EEEE')
      })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup()

      await rehydrateSessionImages('sess-1', get, set)

      expect(get().messages).toHaveLength(2)
      expect(JSON.stringify(get().messages)).not.toContain('most recent generated images')
    })

    it('abandons the reads when the user switches session mid-flight', async () => {
      // Each read is a sequential IPC round trip. Without the in-loop check these would run to
      // completion and then be written into whatever session is now open.
      const { get, set } = setup()
      const read = vi.fn(async () => {
        set({ activeSessionID: 'sess-other' })
        return 'FFFF'
      })
      const { api: fake } = fakeApi({
        list: vi.fn(async () => [meta({ id: 'a' }), meta({ id: 'b' }), meta({ id: 'c' })]),
        read
      })
      mockApi.mockReturnValue(fake)

      await rehydrateSessionImages('sess-1', get, set)

      expect(read).toHaveBeenCalledTimes(1)
      expect(get().messages).toHaveLength(0)
    })

    it('discards the whole batch if the session changed while the last read was in flight', async () => {
      const { get, set } = setup()
      const { api: fake } = fakeApi({
        list: vi.fn(async () => [meta({ id: 'a' })]),
        read: vi.fn(async () => {
          // Switch only after the final read resolves, so the in-loop guard cannot catch it and
          // the post-loop guard is the only thing left.
          queueMicrotask(() => set({ activeSessionID: 'sess-other' }))
          return 'GGGG'
        })
      })
      mockApi.mockReturnValue(fake)

      await rehydrateSessionImages('sess-1', get, set)

      expect(get().messages).toHaveLength(0)
    })
  })
})
