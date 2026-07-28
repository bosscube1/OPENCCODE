/**
 * Chrome-level state: theme, which view is showing, the pending-permission queue,
 * the error banner, and the artifacts side panel.
 */

import { savePrefs, type Theme } from '../prefs'
import { compareIds } from '../collections'
import { api, errText } from './api'
import type { AppState, SetState, GetState } from './types'
import type { PermissionResponse } from '../types'

export type UiSlice = Pick<
  AppState,
  | 'permissions'
  | 'error'
  | 'activeView'
  | 'theme'
  | 'activeArtifactID'
  | 'panelTab'
  | 'paletteOpen'
  | 'setActiveView'
  | 'setTheme'
  | 'setActiveArtifactID'
  | 'setPanelTab'
  | 'setPaletteOpen'
  | 'replyPermission'
  | 'dismissError'
>

export function createUiSlice(set: SetState, get: GetState): UiSlice {
  return {
    permissions: [],
    error: null,
    activeView: 'chats',
    theme: 'auto' as Theme,
    activeArtifactID: null,
    panelTab: null,
    paletteOpen: false,

    setActiveView(view: 'chats' | 'projects' | 'images'): void {
      set({ activeView: view })
    },

    setPanelTab(tab: AppState['panelTab']): void {
      set({ panelTab: tab })
    },

    setPaletteOpen(open: boolean): void {
      set({ paletteOpen: open })
    },

    setTheme(t: Theme): void {
      set({ theme: t })
      const { directory, providerID, modelID, autoRotate, modelPool, stickyModel } = get()
      savePrefs({ directory, providerID, modelID, autoRotate, theme: t, modelPool, stickyModel })
    },

    setActiveArtifactID(id: string | null): void {
      set({ activeArtifactID: id })
    },

    async replyPermission(id: string, response: PermissionResponse): Promise<void> {
      const { directory, permissions } = get()
      const permission = permissions.find((p) => p.id === id)
      if (!permission) return
      if (!directory) {
        set({ error: 'Pick a project folder first.' })
        return
      }

      // Optimistically dismiss; restore it if the reply fails.
      set((state) => ({ permissions: state.permissions.filter((p) => p.id !== id) }))

      try {
        await api().replyPermission({
          directory,
          sessionID: permission.sessionID,
          permissionID: id,
          response
        })
      } catch (e) {
        set((state) => ({
          error: errText(e),
          permissions: state.permissions.some((p) => p.id === id)
            ? state.permissions
            : [...state.permissions, permission].sort(
                (a, b) => a.time.created - b.time.created || compareIds(a.id, b.id)
              )
        }))
      }
    },

    dismissError(): void {
      set({ error: null })
    }
  }
}
