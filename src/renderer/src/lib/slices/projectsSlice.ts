/**
 * Desktop-managed projects, main-process app settings, and updater status.
 */

import { api, errText } from './api'
import type { AppState, SetState, GetState } from './types'
import type { AppSettings, ProjectRecord, UpdateStatus } from '../types'

export type ProjectsSlice = Pick<
  AppState,
  | 'projects'
  | 'appSettings'
  | 'shortcutRegistered'
  | 'shortcutError'
  | 'updateStatus'
  | 'loadProjects'
  | 'createProject'
  | 'openProject'
  | 'loadAppSettings'
  | 'updateAppSettings'
  | 'setUpdateStatus'
>

export function createProjectsSlice(set: SetState, get: GetState): ProjectsSlice {
  return {
    projects: [],
    appSettings: { closeToTray: true, globalShortcut: 'Ctrl+Alt+Space', showPaidModels: false, ttftMs: 20_000, stallMs: 90_000, nanogptSubscriptionOnly: true },
    shortcutRegistered: false,
    shortcutError: null,
    updateStatus: { state: 'idle' },

    async loadProjects(): Promise<void> {
      try {
        const projects = await api().projects.list()
        set({ projects: projects ?? [] })
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async createProject(name: string): Promise<ProjectRecord> {
      try {
        const project = await api().projects.create(name)
        set((state) => ({
          projects: [project, ...state.projects.filter((row) => row.id !== project.id)],
          error: null
        }))
        await get().setDirectory(project.directory)
        return project
      } catch (e) {
        const message = errText(e)
        set({ error: message })
        throw new Error(message)
      }
    },

    async openProject(project: ProjectRecord): Promise<void> {
      await get().setDirectory(project.directory)
    },

    async loadAppSettings(): Promise<void> {
      try {
        const result = await api().appSettings.get()
        set({
          appSettings: result.settings,
          shortcutRegistered: result.shortcutRegistered,
          shortcutError: result.shortcutError ?? null
        })
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
      try {
        const result = await api().appSettings.set(patch)
        set({
          appSettings: result.settings,
          shortcutRegistered: result.shortcutRegistered,
          shortcutError: result.shortcutError ?? null
        })
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    setUpdateStatus(status: UpdateStatus): void {
      set({ updateStatus: status })
    }
  }
}
