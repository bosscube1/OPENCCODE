/**
 * EditorPanel — Phase 1 code surface (B2).
 *
 * A review surface, not an IDE: one open file, its working-tree diff, and
 * hunk-level accept/reject. Two modes, chosen by shape of the store state:
 *   - diff view  — `openFileDiff` has hunks: per-hunk accept/reject + apply.
 *   - edit view  — otherwise: Monaco bound to `openFile.text`.
 *
 * Monaco is lazy-imported (`await import('monaco-editor')`) so it never lands
 * in the initial bundle. Workers: monaco-editor@0.56 builds every worker
 * (editorWorkerService + the json/css/html/typescript language workers) via
 * `new Worker(new URL('<worker>.js', import.meta.url))` *inside its own
 * package source* — see esm/vs/editor/browser/services/editorWorkerService.js
 * and esm/vs/languages/features/{json,css,html,typescript}/workerManager.js.
 * Vite's asset pipeline recognizes that relative-URL-worker idiom and bundles
 * each worker as a same-origin chunk, which satisfies the CSP's
 * `worker-src 'self' blob:` with zero `MonacoEnvironment` configuration and
 * no CDN reference of any kind. Workers are therefore ENABLED, not degraded.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '../lib/store'
import type { FileDiff } from '../lib/types'
import { HunkView } from './HunkView'
import './editor.css'

type Monaco = typeof import('monaco-editor')
type StandaloneEditor = import('monaco-editor').editor.IStandaloneCodeEditor
type TextModel = import('monaco-editor').editor.ITextModel

/** One shared module promise — Monaco is loaded at most once per renderer session. */
let monacoModulePromise: Promise<Monaco> | null = null
function loadMonaco(): Promise<Monaco> {
  if (!monacoModulePromise) {
    monacoModulePromise = import('monaco-editor')
  }
  return monacoModulePromise
}

const THEME_DARK = 'oc-editor-dark'
const THEME_LIGHT = 'oc-editor-light'

/** Read a resolved CSS custom property value off <html> — never a literal hex in source. */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Build (and activate) a Monaco theme from the app's existing design tokens. */
function defineOcTheme(monaco: Monaco, isDark: boolean): string {
  const name = isDark ? THEME_DARK : THEME_LIGHT
  monaco.editor.defineTheme(name, {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': readToken('--bg'),
      'editor.foreground': readToken('--fg'),
      'editorLineNumber.foreground': readToken('--fg-dim'),
      'editorLineNumber.activeForeground': readToken('--fg'),
      'editor.lineHighlightBackground': readToken('--bg-inset'),
      'editor.selectionBackground': readToken('--accent-soft'),
      'editorCursor.foreground': readToken('--accent'),
      'editorWidget.background': readToken('--bg-alt'),
      'editorWidget.border': readToken('--border'),
      'editorGutter.background': readToken('--bg'),
      'scrollbarSlider.background': readToken('--hover'),
      focusBorder: readToken('--accent')
    }
  })
  monaco.editor.setTheme(name)
  return name
}

/** Resolve the app's `auto | dark | light` preference to a concrete boolean. */
function useIsDarkTheme(): boolean {
  const theme = useStore((s) => s.theme)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return systemDark
}

interface MonacoHostProps {
  path: string
  text: string
  language: string | null
  isDark: boolean
  onChange: (text: string) => void
  onSave: () => void
}

/** Owns exactly one Monaco editor + model instance for one file. Keyed by path by the caller. */
function MonacoHost({ path, text, language, isDark, onChange, onSave }: MonacoHostProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<StandaloneEditor | null>(null)
  const modelRef = useRef<TextModel | null>(null)
  const lastEmittedRef = useRef(text)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  // Mount/dispose exactly once per file (the caller remounts this component via `key={path}`).
  useEffect(() => {
    let cancelled = false
    let changeSub: { dispose(): void } | undefined

    loadMonaco()
      .then((monaco) => {
        if (cancelled || !containerRef.current) return

        defineOcTheme(monaco, isDark)

        const uri = monaco.Uri.from({ scheme: 'oc-file', path: `/${path}` })
        monaco.editor.getModel(uri)?.dispose()
        const model = monaco.editor.createModel(text, language ?? undefined, uri)
        modelRef.current = model
        lastEmittedRef.current = text

        const instance = monaco.editor.create(containerRef.current, {
          model,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: 'var(--mono)',
          scrollBeyondLastLine: false
        })
        editorRef.current = instance

        instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSaveRef.current()
        })

        changeSub = model.onDidChangeContent(() => {
          const value = model.getValue()
          lastEmittedRef.current = value
          onChangeRef.current(value)
        })

        setStatus('ready')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : 'Failed to load the code editor.')
        setStatus('error')
      })

    return () => {
      cancelled = true
      changeSub?.dispose()
      editorRef.current?.dispose()
      modelRef.current?.dispose()
      editorRef.current = null
      modelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one editor per `path`, by design
  }, [path])

  // Push external text changes (e.g. "reload from disk" after a save conflict) into the
  // live model, but only when the change didn't originate from the user's own typing —
  // otherwise every keystroke would fight itself via the store round-trip.
  useEffect(() => {
    const model = modelRef.current
    if (!model) return
    if (text !== lastEmittedRef.current) {
      lastEmittedRef.current = text
      model.setValue(text)
    }
  }, [text])

  // Re-theme in place on light/dark changes — no editor recreation needed.
  useEffect(() => {
    if (status !== 'ready') return
    let cancelled = false
    loadMonaco().then((monaco) => {
      if (cancelled) return
      defineOcTheme(monaco, isDark)
    })
    return () => {
      cancelled = true
    }
  }, [isDark, status])

  if (status === 'error') {
    return (
      <div className="editor__load-error">
        Could not load the code editor.{loadError ? ` ${loadError}` : ''}
      </div>
    )
  }

  return (
    <div className="editor__monaco-wrap">
      {status === 'loading' && <div className="editor__loading">Loading editor…</div>}
      <div ref={containerRef} className="editor__monaco" />
    </div>
  )
}

function DiffView({
  diff,
  acceptedHunkIds,
  onToggle
}: {
  diff: FileDiff
  acceptedHunkIds: string[]
  onToggle: (id: string) => void
}): JSX.Element {
  return (
    <div className="editor__diff">
      {diff.truncated && (
        <div className="editor__banner editor__banner--truncated" role="alert">
          <span className="editor__banner-icon" aria-hidden="true">
            ⚠
          </span>
          <span>
            <strong>This diff is INCOMPLETE.</strong> It exceeded the 5000-line cap and hunks past
            that point were dropped — they are not shown below. Do not treat what follows as the
            full change.
          </span>
        </div>
      )}
      {diff.hunks.length === 0 ? (
        <div className="panel__empty">
          <p>{diff.binary ? 'Binary file — no text diff to review.' : 'No changes to review.'}</p>
        </div>
      ) : (
        diff.hunks.map((hunk) => (
          <HunkView
            key={hunk.id}
            hunk={hunk}
            accepted={acceptedHunkIds.includes(hunk.id)}
            onToggle={() => onToggle(hunk.id)}
          />
        ))
      )}
    </div>
  )
}

export function EditorPanel(): JSX.Element {
  const openFile = useStore((s) => s.openFile)
  const openFileDirty = useStore((s) => s.openFileDirty)
  const openFileDiff = useStore((s) => s.openFileDiff)
  const acceptedHunkIds = useStore((s) => s.acceptedHunkIds)
  const setOpenFileText = useStore((s) => s.setOpenFileText)
  const saveOpenFile = useStore((s) => s.saveOpenFile)
  const toggleHunk = useStore((s) => s.toggleHunk)
  const applyAcceptedHunks = useStore((s) => s.applyAcceptedHunks)
  const closeFile = useStore((s) => s.closeFile)
  const openPath = useStore((s) => s.openPath)

  const isDark = useIsDarkTheme()

  const [conflict, setConflict] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)

  // Reset transient UI state when the open file changes.
  useEffect(() => {
    setConflict(false)
    setSaveError(null)
    setApplyError(null)
  }, [openFile?.path])

  const handleSave = useCallback(async (): Promise<void> => {
    setSaveError(null)
    setConflict(false)
    setSaving(true)
    try {
      await saveOpenFile()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Same shape the main process throws on a stale baseSha (see fsService.ts):
      // "<path> changed on disk since it was opened. Reload the file or overwrite deliberately."
      // Never auto-resolve — either "just save" or "just reload" can silently lose work.
      if (/sha|conflict|changed on disk/i.test(message)) {
        setConflict(true)
      } else {
        setSaveError(message)
      }
    } finally {
      setSaving(false)
    }
  }, [saveOpenFile])

  const handleReloadFromDisk = useCallback(async (): Promise<void> => {
    if (!openFile) return
    setConflict(false)
    await openPath(openFile.path)
  }, [openFile, openPath])

  const handleApplyAccepted = useCallback(async (): Promise<void> => {
    setApplyError(null)
    setApplying(true)
    try {
      await applyAcceptedHunks()
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'Could not apply the accepted hunks.')
    } finally {
      setApplying(false)
    }
  }, [applyAcceptedHunks])

  if (!openFile) {
    return (
      <div className="panel__empty">
        <p>No file open.</p>
        <p>Pick a file from the tree to review or edit it.</p>
      </div>
    )
  }

  const diff = openFileDiff
  const hasHunks = diff !== null && diff.hunks.length > 0

  return (
    <div className="editor">
      <div className="editor__toolbar panel__toolbar">
        <span className="editor__path" title={openFile.path}>
          {openFile.path}
        </span>
        {openFileDirty && (
          <span className="editor__dirty" title="Unsaved changes">
            ●
          </span>
        )}
        <div className="editor__toolbar-spacer" />
        {hasHunks && diff ? (
          <button
            type="button"
            className="panel__toolbar-btn"
            onClick={handleApplyAccepted}
            disabled={applying || acceptedHunkIds.length === 0}
          >
            {applying
              ? 'Applying…'
              : `Apply accepted (${acceptedHunkIds.length}/${diff.hunks.length})`}
          </button>
        ) : (
          <button
            type="button"
            className="panel__toolbar-btn"
            onClick={handleSave}
            disabled={saving || !openFileDirty}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        <button type="button" className="panel__toolbar-btn" onClick={closeFile}>
          Close
        </button>
      </div>

      {openFile.truncated && (
        <div className="editor__banner editor__banner--warn">
          <span className="editor__banner-icon" aria-hidden="true">
            ⚠
          </span>
          <span>
            This file exceeded the read size cap and was loaded truncated. Saving will write back
            only what is shown here.
          </span>
        </div>
      )}

      {applyError && <div className="editor__banner editor__banner--error">{applyError}</div>}

      {saveError && !conflict && (
        <div className="editor__banner editor__banner--error">
          <span>Save failed: {saveError}</span>
          <button type="button" className="editor__banner-btn" onClick={handleSave}>
            Retry
          </button>
        </div>
      )}

      {conflict && (
        <div className="editor__conflict" role="alert">
          <p>
            <strong>{openFile.path}</strong> changed on disk since you opened it — most likely the
            agent edited it while this was open. Saving now would overwrite that change.
          </p>
          <div className="editor__conflict-actions">
            <button type="button" className="panel__toolbar-btn" onClick={handleReloadFromDisk}>
              Reload from disk (discard my edits)
            </button>
            <button
              type="button"
              className="panel__toolbar-btn"
              onClick={() => setConflict(false)}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}

      <div className="editor__body">
        {hasHunks && diff ? (
          <DiffView diff={diff} acceptedHunkIds={acceptedHunkIds} onToggle={toggleHunk} />
        ) : (
          <MonacoHost
            key={openFile.path}
            path={openFile.path}
            text={openFile.text}
            language={openFile.language}
            isDark={isDark}
            onChange={setOpenFileText}
            onSave={handleSave}
          />
        )}
      </div>
    </div>
  )
}
