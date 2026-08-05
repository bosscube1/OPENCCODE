import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, SetState, GetState } from '../slices/types'
import type { OpencodeApi } from '../slices/api'
import type { ProjectRecord, AppSettings, UpdateStatus } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createProjectsSlice, type ProjectsSlice } from '../slices/projectsSlice'

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

/** Slice defaults first, then test overrides — the reverse order clobbers the overrides. */
function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: ProjectsSlice } {
  const { get, set } = createStore()
  const slice = createProjectsSlice(set, get)
  set(slice)
  // Ensure error is initialized to null if not overridden
  set({ error: null, ...overrides })
  return { get, slice }
}

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'proj-1',
    name: 'Test Project',
    directory: '/home/user/test-proj',
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

function appSettingsResult(overrides: Partial<ReturnType<OpencodeApi['appSettings']['get']>> = {}) {
  return {
    settings: {
      closeToTray: true,
      globalShortcut: 'Ctrl+Alt+Space',
      showPaidModels: false,
      ttftMs: 20_000,
      stallMs: 90_000,
      nanogptSubscriptionOnly: true
    },
    shortcutRegistered: false,
    shortcutError: undefined,
    ...overrides
  }
}

function fakeApi(overrides: Partial<OpencodeApi> = {}): OpencodeApi {
  return {
    status: vi.fn(),
    restart: vi.fn(),
    pickDirectory: vi.fn(),
    sessions: {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      summarize: vi.fn(),
      init: vi.fn(),
      todos: vi.fn(),
      command: vi.fn()
    },
    commands: { list: vi.fn() },
    find: { files: vi.fn() },
    vcs: { get: vi.fn() },
    projects: {
      list: vi.fn(),
      create: vi.fn(),
      getInstructions: vi.fn(),
      setInstructions: vi.fn(),
      listKnowledge: vi.fn(),
      addKnowledge: vi.fn(),
      removeKnowledge: vi.fn()
    },
    appSettings: {
      get: vi.fn(),
      set: vi.fn()
    },
    config: {
      getPermission: vi.fn(),
      setPermission: vi.fn()
    },
    nanogpt: {
      models: vi.fn(),
      refresh: vi.fn(),
      usage: vi.fn(),
      balance: vi.fn(),
      weeklyUsage: vi.fn(),
      generate: vi.fn(),
      images: {
        list: vi.fn(),
        read: vi.fn(),
        remove: vi.fn(),
        today: vi.fn()
      }
    },
    messages: vi.fn(),
    revertMessage: vi.fn(),
    unrevertMessage: vi.fn(),
    forkSession: vi.fn(),
    agents: vi.fn(),
    prompt: vi.fn(),
    abort: vi.fn(),
    providers: vi.fn(),
    replyPermission: vi.fn(),
    openExternal: vi.fn(),
    fs: {
      tree: vi.fn(),
      read: vi.fn(),
      write: vi.fn()
    },
    git: {
      status: vi.fn(),
      diff: vi.fn(),
      stage: vi.fn(),
      unstage: vi.fn(),
      stageHunks: vi.fn(),
      commit: vi.fn(),
      branches: vi.fn(),
      checkout: vi.fn(),
      remoteUrl: vi.fn()
    },
    term: {
      start: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn()
    },
    openEditor: vi.fn(),
    onEvent: vi.fn(),
    onServer: vi.fn(),
    onUpdateStatus: vi.fn(),
    ...overrides
  } as unknown as OpencodeApi
}

describe('projectsSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  describe('initial state', () => {
    it('starts with empty projects, default app settings, no shortcut error, and idle update status', () => {
      const { get } = setup()
      expect(get().projects).toEqual([])
      expect(get().appSettings).toEqual({
        closeToTray: true,
        globalShortcut: 'Ctrl+Alt+Space',
        showPaidModels: false,
        ttftMs: 20_000,
        stallMs: 90_000,
        nanogptSubscriptionOnly: true
      })
      expect(get().shortcutRegistered).toBe(false)
      expect(get().shortcutError).toBeNull()
      expect(get().updateStatus).toEqual({ state: 'idle' })
    })
  })

  describe('loadProjects', () => {
    it('loads projects from the api and updates state on success', async () => {
      const proj1 = project({ id: 'proj-1' })
      const proj2 = project({ id: 'proj-2' })
      const fakeApiObj = fakeApi()
      fakeApiObj.projects.list = vi.fn(async () => [proj1, proj2])
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup()

      await slice.loadProjects()

      expect(get().projects).toEqual([proj1, proj2])
      expect(get().error).toBeNull()
    })

    it('handles null response from api as empty array', async () => {
      const fakeApiObj = fakeApi()
      fakeApiObj.projects.list = vi.fn(async () => null as unknown as ProjectRecord[])
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup()

      await slice.loadProjects()

      expect(get().projects).toEqual([])
    })

    it('sets error and leaves projects unchanged when the api call fails', async () => {
      const existingProject = project()
      const fakeApiObj = fakeApi()
      fakeApiObj.projects.list = vi.fn(async () => {
        throw new Error('network error')
      })
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup({ projects: [existingProject] })

      await slice.loadProjects()

      expect(get().error).toBe('network error')
      expect(get().projects).toEqual([existingProject])
    })

    it('handles errText normalization for non-Error exceptions', async () => {
      const fakeApiObj = fakeApi()
      fakeApiObj.projects.list = vi.fn(async () => {
        throw { code: 'ECONNREFUSED' }
      })
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup()

      await slice.loadProjects()

      expect(get().error).toMatch(/ECONNREFUSED/)
    })
  })

  describe('createProject', () => {
    it('creates a project, updates state optimistically, calls setDirectory, and returns the project', async () => {
      const newProject = project({ id: 'new-proj', name: 'My Project' })
      const fakeApiObj = fakeApi()
      fakeApiObj.projects.create = vi.fn(async () => newProject)
      mockApi.mockReturnValue(fakeApiObj)
      const mockSetDirectory = vi.fn(async () => undefined)
      const existingProject = project({ id: 'existing', name: 'Existing' })

      // Manually set the state with a mock setDirectory
      const { get: getState, set } = createStore()
      const sliceWithSetDir = createProjectsSlice(set, getState)
      set(sliceWithSetDir)
      set({
        error: null,
        projects: [existingProject],
        setDirectory: mockSetDirectory as AppState['setDirectory']
      })

      const result = await getState().createProject('My Project')

      // Should have created the project and updated projects state
      expect(getState().projects[0]).toEqual(newProject)
      expect(result).toEqual(newProject)
      expect(getState().error).toBeNull()
      expect(mockSetDirectory).toHaveBeenCalledWith(newProject.directory)
    })

    it('moves the new project to the front if it already exists in the list (idempotent)', async () => {
      const newProject = project({ id: 'proj-1', name: 'Updated Project' })
      const existingProject1 = project({ id: 'proj-1', name: 'Old Project' })
      const existingProject2 = project({ id: 'proj-2', name: 'Another Project' })
      const fakeApiObj = fakeApi()
      fakeApiObj.projects.create = vi.fn(async () => newProject)
      mockApi.mockReturnValue(fakeApiObj)

      const { get, set } = createStore()
      const slice = createProjectsSlice(set, get)
      set(slice)
      const mockSetDirectory = vi.fn(async () => undefined)
      set({
        error: null,
        projects: [existingProject1, existingProject2],
        setDirectory: mockSetDirectory as AppState['setDirectory']
      })

      await get().createProject('Updated Project')

      expect(get().projects).toEqual([newProject, existingProject2])
    })

    it('clears the error on success', async () => {
      const newProject = project()
      const fakeApiObj = fakeApi()
      fakeApiObj.projects.create = vi.fn(async () => newProject)
      mockApi.mockReturnValue(fakeApiObj)

      const { get, set } = createStore()
      const slice = createProjectsSlice(set, get)
      set(slice)
      const mockSetDirectory = vi.fn(async () => undefined)
      set({
        error: 'previous error',
        setDirectory: mockSetDirectory as AppState['setDirectory']
      })

      await get().createProject('My Project')

      expect(get().error).toBeNull()
    })

    it('sets error and throws when the api call fails', async () => {
      const fakeApiObj = fakeApi()
      fakeApiObj.projects.create = vi.fn(async () => {
        throw new Error('project creation failed')
      })
      mockApi.mockReturnValue(fakeApiObj)

      const { get, set } = createStore()
      const slice = createProjectsSlice(set, get)
      set(slice)
      set({
        error: null,
        projects: [],
        setDirectory: vi.fn() as AppState['setDirectory']
      })

      await expect(get().createProject('My Project')).rejects.toThrow('project creation failed')

      expect(get().error).toBe('project creation failed')
    })

    it('does not call setDirectory when the api call fails', async () => {
      const fakeApiObj = fakeApi()
      fakeApiObj.projects.create = vi.fn(async () => {
        throw new Error('failed')
      })
      mockApi.mockReturnValue(fakeApiObj)

      const { get, set } = createStore()
      const slice = createProjectsSlice(set, get)
      set(slice)
      const mockSetDirectory = vi.fn(async () => undefined)
      set({
        setDirectory: mockSetDirectory as AppState['setDirectory']
      })

      try {
        await get().createProject('My Project')
      } catch {
        // expected
      }

      expect(mockSetDirectory).not.toHaveBeenCalled()
    })
  })

  describe('openProject', () => {
    it('calls setDirectory with the project directory', async () => {
      const proj = project({ directory: '/home/user/my-project' })
      const mockSetDirectory = vi.fn(async () => undefined)
      const { get, set } = createStore()
      const slice = createProjectsSlice(set, get)
      set(slice)
      set({
        setDirectory: mockSetDirectory as AppState['setDirectory']
      })

      await get().openProject(proj)

      expect(mockSetDirectory).toHaveBeenCalledWith('/home/user/my-project')
    })

    it('propagates errors from setDirectory', async () => {
      const proj = project({ directory: '/home/user/my-project' })
      const mockSetDirectory = vi.fn(async () => {
        throw new Error('directory not found')
      })
      const { get, set } = createStore()
      const slice = createProjectsSlice(set, get)
      set(slice)
      set({
        setDirectory: mockSetDirectory as AppState['setDirectory']
      })

      await expect(get().openProject(proj)).rejects.toThrow('directory not found')
    })
  })

  describe('loadAppSettings', () => {
    it('loads app settings from the api and updates state on success', async () => {
      const result = {
        settings: {
          closeToTray: false,
          globalShortcut: 'Ctrl+Shift+S',
          showPaidModels: true,
          ttftMs: 30_000,
          stallMs: 120_000,
          nanogptSubscriptionOnly: false
        },
        shortcutRegistered: true,
        shortcutError: undefined as string | undefined
      }
      const fakeApiObj = fakeApi()
      fakeApiObj.appSettings.get = vi.fn(async () => result)
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup()

      await slice.loadAppSettings()

      expect(get().appSettings).toEqual(result.settings)
      expect(get().shortcutRegistered).toBe(true)
      expect(get().shortcutError).toBeNull()
      expect(get().error).toBeNull()
    })

    it('converts undefined shortcutError to null', async () => {
      const result = {
        settings: appSettingsResult().settings,
        shortcutRegistered: false,
        shortcutError: undefined as string | undefined
      }
      const fakeApiObj = fakeApi()
      fakeApiObj.appSettings.get = vi.fn(async () => result)
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup()

      await slice.loadAppSettings()

      expect(get().shortcutError).toBeNull()
    })

    it('preserves explicit shortcutError string', async () => {
      const result = {
        settings: appSettingsResult().settings,
        shortcutRegistered: false,
        shortcutError: 'global hotkey already in use' as string | undefined
      }
      const fakeApiObj = fakeApi()
      fakeApiObj.appSettings.get = vi.fn(async () => result)
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup()

      await slice.loadAppSettings()

      expect(get().shortcutError).toBe('global hotkey already in use')
    })

    it('sets error and leaves state unchanged when the api call fails', async () => {
      const existingSettings: AppSettings = {
        closeToTray: false,
        globalShortcut: 'Custom',
        showPaidModels: true,
        ttftMs: 25_000,
        stallMs: 100_000,
        nanogptSubscriptionOnly: false
      }
      const fakeApiObj = fakeApi()
      fakeApiObj.appSettings.get = vi.fn(async () => {
        throw new Error('settings service down')
      })
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup({
        appSettings: existingSettings,
        shortcutRegistered: true,
        shortcutError: 'some error'
      })

      await slice.loadAppSettings()

      expect(get().error).toBe('settings service down')
      expect(get().appSettings).toEqual(existingSettings)
      expect(get().shortcutRegistered).toBe(true)
      expect(get().shortcutError).toBe('some error')
    })
  })

  describe('updateAppSettings', () => {
    it('updates app settings with a partial patch and merges correctly', async () => {
      const existingSettings: AppSettings = {
        closeToTray: true,
        globalShortcut: 'Ctrl+Alt+Space',
        showPaidModels: false,
        ttftMs: 20_000,
        stallMs: 90_000,
        nanogptSubscriptionOnly: true
      }
      const patchResult = {
        settings: {
          ...existingSettings,
          showPaidModels: true,
          stallMs: 120_000
        },
        shortcutRegistered: true,
        shortcutError: undefined as string | undefined
      }
      const fakeApiObj = fakeApi()
      fakeApiObj.appSettings.set = vi.fn(async (patch: Partial<AppSettings>) => {
        expect(patch).toEqual({ showPaidModels: true, stallMs: 120_000 })
        return patchResult
      })
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup({
        appSettings: existingSettings,
        shortcutRegistered: false
      })

      await slice.updateAppSettings({ showPaidModels: true, stallMs: 120_000 })

      expect(get().appSettings).toEqual(patchResult.settings)
      expect(get().shortcutRegistered).toBe(true)
      expect(get().error).toBeNull()
    })

    it('updates a single field without replacing the whole object', async () => {
      const existingSettings: AppSettings = {
        closeToTray: true,
        globalShortcut: 'Ctrl+Alt+Space',
        showPaidModels: false,
        ttftMs: 20_000,
        stallMs: 90_000,
        nanogptSubscriptionOnly: true
      }
      const updatedSettings = { ...existingSettings, globalShortcut: 'Alt+Space' }
      const fakeApiObj = fakeApi()
      fakeApiObj.appSettings.set = vi.fn(async () => ({
        settings: updatedSettings,
        shortcutRegistered: false,
        shortcutError: undefined as string | undefined
      }))
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup({
        appSettings: existingSettings
      })

      await slice.updateAppSettings({ globalShortcut: 'Alt+Space' })

      expect(get().appSettings.closeToTray).toBe(true)
      expect(get().appSettings.globalShortcut).toBe('Alt+Space')
      expect(get().appSettings.showPaidModels).toBe(false)
    })

    it('sets error and leaves state unchanged when the api call fails', async () => {
      const existingSettings: AppSettings = {
        closeToTray: true,
        globalShortcut: 'Ctrl+Alt+Space',
        showPaidModels: false,
        ttftMs: 20_000,
        stallMs: 90_000,
        nanogptSubscriptionOnly: true
      }
      const fakeApiObj = fakeApi()
      fakeApiObj.appSettings.set = vi.fn(async () => {
        throw new Error('save failed')
      })
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup({
        appSettings: existingSettings,
        shortcutRegistered: true,
        shortcutError: 'error1'
      })

      await slice.updateAppSettings({ showPaidModels: true })

      expect(get().error).toBe('save failed')
      expect(get().appSettings).toEqual(existingSettings)
      expect(get().shortcutRegistered).toBe(true)
      expect(get().shortcutError).toBe('error1')
    })

    it('converts undefined shortcutError to null on success', async () => {
      const result = {
        settings: appSettingsResult().settings,
        shortcutRegistered: false,
        shortcutError: undefined as string | undefined
      }
      const fakeApiObj = fakeApi()
      fakeApiObj.appSettings.set = vi.fn(async () => result)
      mockApi.mockReturnValue(fakeApiObj)
      const { get, slice } = setup({
        shortcutError: 'previous error'
      })

      await slice.updateAppSettings({ closeToTray: false })

      expect(get().shortcutError).toBeNull()
    })
  })

  describe('setUpdateStatus', () => {
    it('sets idle status', () => {
      const { get, slice } = setup()
      const status: UpdateStatus = { state: 'idle' }

      slice.setUpdateStatus(status)

      expect(get().updateStatus).toEqual(status)
    })

    it('sets checking status', () => {
      const { get, slice } = setup()
      const status: UpdateStatus = { state: 'checking' }

      slice.setUpdateStatus(status)

      expect(get().updateStatus).toEqual(status)
    })

    it('sets available status with version', () => {
      const { get, slice } = setup()
      const status: UpdateStatus = { state: 'available', version: '1.2.3' }

      slice.setUpdateStatus(status)

      expect(get().updateStatus).toEqual(status)
    })

    it('sets progress status with percent', () => {
      const { get, slice } = setup()
      const status: UpdateStatus = { state: 'progress', percent: 45 }

      slice.setUpdateStatus(status)

      expect(get().updateStatus).toEqual(status)
    })

    it('sets error status with message', () => {
      const { get, slice } = setup()
      const status: UpdateStatus = { state: 'error', message: 'download failed' }

      slice.setUpdateStatus(status)

      expect(get().updateStatus).toEqual(status)
    })

    it('sets not-available status', () => {
      const { get, slice } = setup()
      const status: UpdateStatus = { state: 'not-available' }

      slice.setUpdateStatus(status)

      expect(get().updateStatus).toEqual(status)
    })

    it('sets downloaded status', () => {
      const { get, slice } = setup()
      const status: UpdateStatus = { state: 'downloaded' }

      slice.setUpdateStatus(status)

      expect(get().updateStatus).toEqual(status)
    })
  })
})
