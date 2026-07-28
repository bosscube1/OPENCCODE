/**
 * Single-file review/edit surface (Phase 1 code surface). This is a review surface,
 * not an IDE: one open file, its working-tree diff, and hunk-level accept/reject.
 *
 * NOTE on `applyAcceptedHunks`: it depends on the pure `src/renderer/src/lib/hunks.ts`
 * module (`parseUnifiedDiff` / `applyHunksToText`), which is being written concurrently
 * by another workstream and does not exist yet. Rather than import a module that would
 * break typecheck for everyone, the action is stubbed below — see TODO(hunks).
 */

import { api, errText } from './api'
import { applyHunksToText } from '../hunks'
import type { AppState, SetState, GetState } from './types'

export type EditorSlice = Pick<
  AppState,
  | 'openFile'
  | 'openFileDirty'
  | 'openFileDiff'
  | 'acceptedHunkIds'
  | 'openPath'
  | 'setOpenFileText'
  | 'saveOpenFile'
  | 'toggleHunk'
  | 'applyAcceptedHunks'
  | 'closeFile'
>

export function createEditorSlice(set: SetState, get: GetState): EditorSlice {
  return {
    openFile: null,
    openFileDirty: false,
    openFileDiff: null,
    acceptedHunkIds: [],

    async openPath(path: string, _line?: number): Promise<void> {
      const { directory } = get()
      if (!directory) {
        set({ error: 'Pick a project folder first.' })
        return
      }

      try {
        const content = await api().fs.read(directory, path)
        set({ openFile: content, openFileDirty: false, acceptedHunkIds: [] })
      } catch (e) {
        set({ error: errText(e) })
        return
      }

      try {
        const diff = await api().git.diff({ directory, path })
        set({ openFileDiff: diff })
      } catch {
        // No diff (e.g. untracked/clean file) is not an error condition here.
        set({ openFileDiff: null })
      }
    },

    setOpenFileText(text: string): void {
      set((state) =>
        state.openFile
          ? { openFile: { ...state.openFile, text }, openFileDirty: text !== state.openFile.text }
          : {}
      )
    },

    async saveOpenFile(): Promise<void> {
      const { directory, openFile } = get()
      if (!directory || !openFile) return
      try {
        // `baseSha` is the concurrency gate: main throws rather than clobber a file
        // the agent edited while it was open here. Surface that as a real choice
        // instead of a generic failure — silently winning either way loses work.
        const { sha } = await api().fs.write({
          directory,
          path: openFile.path,
          text: openFile.text,
          baseSha: openFile.sha
        })
        set((state) =>
          state.openFile ? { openFile: { ...state.openFile, sha }, openFileDirty: false } : {}
        )
      } catch (e) {
        const message = errText(e)
        set({
          error: /sha|conflict|changed on disk/i.test(message)
            ? `${openFile.path} changed on disk since you opened it — reload to see the new version, or your edit will overwrite it.`
            : message
        })
        throw e
      }
      void get().refreshGit()
    },

    toggleHunk(id: string): void {
      set((state) => ({
        acceptedHunkIds: state.acceptedHunkIds.includes(id)
          ? state.acceptedHunkIds.filter((h) => h !== id)
          : [...state.acceptedHunkIds, id]
      }))
    },

    async applyAcceptedHunks(): Promise<void> {
      const { directory, openFile, openFileDiff, acceptedHunkIds } = get()
      if (!directory || !openFile || !openFileDiff || acceptedHunkIds.length === 0) return

      // A truncated diff is missing hunks entirely, so "apply the accepted ones"
      // cannot mean what the user thinks it means. Refuse rather than write a
      // partial result that looks deliberate.
      if (openFileDiff.truncated) {
        set({
          error: `${openFile.path} has a partial diff (too large to show in full). Applying individual hunks is disabled for it — stage the whole file instead.`
        })
        return
      }

      let text: string
      try {
        // Throws on stale context rather than landing a hunk at the wrong offset.
        text = applyHunksToText(openFile.text, openFileDiff, acceptedHunkIds)
      } catch (e) {
        set({
          error: `Could not apply those hunks — the file changed since this diff was taken. Reopen ${openFile.path} and try again. (${errText(e)})`
        })
        return
      }

      try {
        const { sha } = await api().fs.write({
          directory,
          path: openFile.path,
          text,
          baseSha: openFile.sha
        })
        set({ openFile: { ...openFile, text, sha }, openFileDirty: false, acceptedHunkIds: [] })
      } catch (e) {
        set({ error: errText(e) })
        return
      }

      await get().openPath(openFile.path)
      void get().refreshGit()
    },

    closeFile(): void {
      set({ openFile: null, openFileDirty: false, openFileDiff: null, acceptedHunkIds: [] })
    }
  }
}
