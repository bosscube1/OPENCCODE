import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@opencode-ai/sdk'
import type { AppState, SetState, GetState } from '../slices/types'
import type { OpencodeApi } from '../slices/api'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})
vi.mock('../prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prefs')>()
  return { ...actual, savePrefs: vi.fn() }
})

import { api } from '../slices/api'
import { savePrefs } from '../prefs'
import { createUiSlice, type UiSlice } from '../slices/uiSlice'

const mockApi = vi.mocked(api)
const mockSavePrefs = vi.mocked(savePrefs)

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
function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: UiSlice } {
  const { get, set } = createStore()
  const slice = createUiSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

function permission(overrides: Partial<Permission> = {}): Permission {
  return {
    id: 'perm-1',
    type: 'bash',
    sessionID: 'sess-1',
    messageID: 'msg-1',
    title: 'Run a command',
    metadata: {},
    time: { created: 100 },
    ...overrides
  }
}

function fakeApi(replyPermission = vi.fn(async () => undefined)): OpencodeApi {
  return { replyPermission } as unknown as OpencodeApi
}

describe('uiSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
    mockSavePrefs.mockReset()
  })

  describe('initial state', () => {
    it('starts on the chats view with no error, no permissions and the palette closed', () => {
      const { get } = setup()
      expect(get().activeView).toBe('chats')
      expect(get().permissions).toEqual([])
      expect(get().error).toBeNull()
      expect(get().theme).toBe('auto')
      expect(get().activeArtifactID).toBeNull()
      expect(get().panelTab).toBeNull()
      expect(get().paletteOpen).toBe(false)
      expect(get().viewMode).toBe('normal')
    })
  })

  describe('plain setters', () => {
    it('setActiveView switches the view without persisting', () => {
      const { get, slice } = setup()
      slice.setActiveView('projects')
      expect(get().activeView).toBe('projects')
      slice.setActiveView('images')
      expect(get().activeView).toBe('images')
      expect(mockSavePrefs).not.toHaveBeenCalled()
    })

    it('setPanelTab and setActiveArtifactID accept null to close', () => {
      const { get, slice } = setup()
      slice.setPanelTab('artifacts')
      expect(get().panelTab).toBe('artifacts')
      slice.setPanelTab(null)
      expect(get().panelTab).toBeNull()

      slice.setActiveArtifactID('art-1')
      expect(get().activeArtifactID).toBe('art-1')
      slice.setActiveArtifactID(null)
      expect(get().activeArtifactID).toBeNull()
    })

    it('setPaletteOpen toggles both ways', () => {
      const { get, slice } = setup()
      slice.setPaletteOpen(true)
      expect(get().paletteOpen).toBe(true)
      slice.setPaletteOpen(false)
      expect(get().paletteOpen).toBe(false)
    })

    it('dismissError clears the banner', () => {
      const { get, slice } = setup({ error: 'boom' })
      slice.dismissError()
      expect(get().error).toBeNull()
    })
  })

  describe('persisted setters', () => {
    it('setTheme updates state and persists the new theme', () => {
      const { get, slice } = setup({
        directory: '/project',
        providerID: 'openai',
        modelID: 'gpt-4',
        modelPool: ['gpt-4'],
        routingMode: 'locked'
      })

      slice.setTheme('dark')

      expect(get().theme).toBe('dark')
      expect(mockSavePrefs).toHaveBeenCalledTimes(1)
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark', directory: '/project', routingMode: 'locked' })
      )
    })

    it('setTheme omits viewMode, relying on savePrefs to backfill it', () => {
      // Deliberate: savePrefs fills omitted fields from the persisted values, so leaving
      // viewMode out here cannot clobber it. Pinned because silently overwriting a
      // sibling pref is exactly the defect savePrefs was hardened against.
      const { slice } = setup({ viewMode: 'verbose' })
      slice.setTheme('light')
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.not.objectContaining({ viewMode: expect.anything() })
      )
    })

    it('setViewMode updates state and persists the mode explicitly', () => {
      const { get, slice } = setup({
        directory: '/project',
        providerID: 'openai',
        modelID: 'gpt-4',
        theme: 'dark',
        modelPool: [],
        routingMode: 'auto'
      })

      slice.setViewMode('summary')

      expect(get().viewMode).toBe('summary')
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({ viewMode: 'summary', theme: 'dark', routingMode: 'auto' })
      )
    })
  })

  describe('replyPermission', () => {
    it('is a no-op when the id is not in the queue', async () => {
      const { get, slice } = setup({ directory: '/project', permissions: [permission()] })
      await slice.replyPermission('missing', 'once')
      expect(get().permissions).toHaveLength(1)
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('refuses without a directory and leaves the permission queued', async () => {
      const { get, slice } = setup({ directory: '', permissions: [permission()] })

      await slice.replyPermission('perm-1', 'once')

      expect(get().error).toBe('Pick a project folder first.')
      expect(get().permissions).toHaveLength(1)
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('dismisses the permission and forwards the reply', async () => {
      const replyPermission = vi.fn(async () => undefined)
      mockApi.mockReturnValue(fakeApi(replyPermission))
      const { get, slice } = setup({ directory: '/project', permissions: [permission()] })

      await slice.replyPermission('perm-1', 'always')

      expect(get().permissions).toEqual([])
      expect(get().error).toBeNull()
      expect(replyPermission).toHaveBeenCalledWith({
        directory: '/project',
        sessionID: 'sess-1',
        permissionID: 'perm-1',
        response: 'always'
      })
    })

    it('restores the permission and surfaces the error when the reply fails', async () => {
      const replyPermission = vi.fn(async () => {
        throw new Error('network down')
      })
      mockApi.mockReturnValue(fakeApi(replyPermission))
      const { get, slice } = setup({ directory: '/project', permissions: [permission()] })

      await slice.replyPermission('perm-1', 'reject')

      expect(get().error).toContain('network down')
      expect(get().permissions.map((p) => p.id)).toEqual(['perm-1'])
    })

    it('restores a failed permission in created-time order, not at the end', async () => {
      const replyPermission = vi.fn(async () => {
        throw new Error('nope')
      })
      mockApi.mockReturnValue(fakeApi(replyPermission))
      const early = permission({ id: 'perm-early', time: { created: 50 } })
      const late = permission({ id: 'perm-late', time: { created: 300 } })
      const { get, slice } = setup({ directory: '/project', permissions: [early, late] })

      await slice.replyPermission('perm-early', 'once')

      expect(get().permissions.map((p) => p.id)).toEqual(['perm-early', 'perm-late'])
    })

    it('falls back to id order when two permissions share a created timestamp', async () => {
      const replyPermission = vi.fn(async () => {
        throw new Error('nope')
      })
      mockApi.mockReturnValue(fakeApi(replyPermission))
      // Same `time.created`, so the subtraction yields 0 and compareIds decides the order.
      const b = permission({ id: 'perm-b', time: { created: 100 } })
      const c = permission({ id: 'perm-c', time: { created: 100 } })
      const { get, slice } = setup({ directory: '/project', permissions: [b, c] })

      await slice.replyPermission('perm-b', 'once')

      expect(get().permissions.map((p) => p.id)).toEqual(['perm-b', 'perm-c'])
    })

    it('does not duplicate the permission if it was re-queued while the reply was in flight', async () => {
      const requeued = permission()
      let resolveReply: () => void = () => {}
      const replyPermission = vi.fn(
        () =>
          new Promise<undefined>((_resolve, reject) => {
            resolveReply = () => reject(new Error('failed'))
          })
      )
      mockApi.mockReturnValue(fakeApi(replyPermission as never))
      const { get, set } = createStore()
      const slice = createUiSlice(set, get)
      set(slice)
      set({ directory: '/project', permissions: [requeued] })

      const pending = slice.replyPermission('perm-1', 'once')
      // A fresh event re-adds the same permission before the failure lands.
      set({ permissions: [requeued] })
      resolveReply()
      await pending

      expect(get().permissions.filter((p) => p.id === 'perm-1')).toHaveLength(1)
    })
  })
})
