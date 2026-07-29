import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent
} from 'react'
import { Chat } from './components/Chat'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { ArtifactsPanel } from './components/ArtifactsPanel'
import { ProjectView } from './components/ProjectView'
import { ImagesView } from './components/ImagesView'
import { LiveScreenAssistant } from './components/LiveScreenAssistant'
import { FileTree } from './components/FileTree'
import { EditorPanel } from './components/EditorPanel'
import { GitPanel } from './components/GitPanel'
import { ChangesPanel } from './components/ChangesPanel'
import { TerminalPanel } from './components/TerminalPanel'
import { CommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useStore } from './lib/store'
import type { AppState } from './lib/slices/types'
import './components/panels.css'
import './index.css'

type PanelTab = AppState['panelTab']

/** Tab order in the right-hand code-surface panel. */
const PANEL_TABS = ['files', 'editor', 'changes', 'git', 'terminal', 'artifacts'] as const
const PANEL_LABELS: Record<(typeof PANEL_TABS)[number], string> = {
  files: 'Files',
  editor: 'Editor',
  changes: 'Changes',
  git: 'Git',
  terminal: 'Terminal',
  artifacts: 'Artifacts'
}

/** localStorage key for the persisted sidebar width. */
const SIDEBAR_KEY = 'opencode-desktop:sidebar'
/** Window events used to reach components that take no props (contract-fixed props). */
const FOCUS_MODEL_EVENT = 'opencode-desktop:focus-model'
const CLOSE_PROVIDERS_EVENT = 'opencode-desktop:close-providers'
const TOGGLE_SETTINGS_EVENT = 'opencode-desktop:toggle-settings'

const MIN_W = 200
const MAX_W = 520
const DEFAULT_W = 264

const INSTALL_HINT = 'npm i -g opencode-ai'

function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_W
  return Math.min(MAX_W, Math.max(MIN_W, Math.round(n)))
}

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_KEY)
    if (raw === null) return DEFAULT_W
    return clampWidth(Number.parseInt(raw, 10))
  } catch {
    return DEFAULT_W
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function CopyLine({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(t)
  }, [copied])

  return (
    <div className="app__code">
      <code>{text}</code>
      <button
        type="button"
        className="app__copy"
        onClick={() => {
          void copyText(text).then((ok) => setCopied(ok))
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

export function App(): JSX.Element {
  const server = useStore((s) => s.server)
  const error = useStore((s) => s.error)
  const dismissError = useStore((s) => s.dismissError)
  const theme = useStore((s) => s.theme)
  const activeArtifactID = useStore((s) => s.activeArtifactID)
  const activeView = useStore((s) => s.activeView)
  const panelTab = useStore((s) => s.panelTab)
  const setPanelTab = useStore((s) => s.setPanelTab)
  const setActiveArtifactID = useStore((s) => s.setActiveArtifactID)

  const [width, setWidth] = useState<number>(() => readStoredWidth())
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [liveScreenOpen, setLiveScreenOpen] = useState(false)

  const widthRef = useRef(width)
  const draggingRef = useRef(false)

  widthRef.current = width

  /* ---- one-time boot ---------------------------------------------------- */
  useEffect(() => {
    if (import.meta.env.DEV) document.title = 'OpenCode Desktop (Dev)'
    void useStore.getState().init()
  }, [])

  useEffect(() => {
    return window.api.onQuickEntryPrompt((text) => {
      void useStore.getState().send(text)
    })
  }, [])

  /* ---- theme sync ------------------------------------------------------- */
  useEffect(() => {
    if (theme === 'auto') {
      delete document.documentElement.dataset.theme
    } else {
      document.documentElement.dataset.theme = theme
    }
  }, [theme])

  /* ---- sidebar resize --------------------------------------------------- */
  const persistWidth = useCallback((value: number) => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, String(value))
    } catch {
      /* storage unavailable — width simply won't persist */
    }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return
      e.preventDefault()
      setWidth(clampWidth(e.clientX))
    }
    const onUp = (): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.classList.remove('app--resizing')
      persistWidth(widthRef.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('app--resizing')
    }
  }, [persistWidth])

  const startResize = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    draggingRef.current = true
    document.body.classList.add('app--resizing')
  }, [])

  const resizeByKey = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 32 : 12
      let next: number | null = null
      if (e.key === 'ArrowLeft') next = widthRef.current - step
      else if (e.key === 'ArrowRight') next = widthRef.current + step
      else if (e.key === 'Home') next = MIN_W
      else if (e.key === 'End') next = MAX_W
      if (next === null) return
      e.preventDefault()
      const clamped = clampWidth(next)
      setWidth(clamped)
      persistWidth(clamped)
    },
    [persistWidth]
  )

  /* ---- global shortcuts ------------------------------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        window.dispatchEvent(new Event(CLOSE_PROVIDERS_EVENT))
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'n') {
        e.preventDefault()
        if (useStore.getState().directory) void useStore.getState().newSession()
      } else if (key === 'o') {
        e.preventDefault()
        void useStore.getState().pickDirectory()
      } else if (key === 'k') {
        // Ctrl+K stays on the model picker. The command palette takes Ctrl+P /
        // Ctrl+Shift+P instead: rebinding a shortcut that is already in the
        // user's fingers costs more than it gains.
        e.preventDefault()
        window.dispatchEvent(new Event(FOCUS_MODEL_EVENT))
      } else if (key === 'p') {
        e.preventDefault()
        useStore.getState().setPaletteOpen(!useStore.getState().paletteOpen)
      } else if (key === 'b') {
        e.preventDefault()
        const { panelTab, setPanelTab } = useStore.getState()
        setPanelTab(panelTab === null ? 'editor' : null)
      } else if (key === '`') {
        e.preventDefault()
        useStore.getState().setPanelTab('terminal')
      } else if (key === ',') {
        e.preventDefault()
        window.dispatchEvent(new Event(TOGGLE_SETTINGS_EVENT))
      }
    }
    window.addEventListener('keydown', onKey)
    const unsubscribeMenu = window.api.onMainMenuNewSession(() => {
      if (useStore.getState().directory) void useStore.getState().newSession()
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      unsubscribeMenu()
    }
  }, [])

  /* ---- retry ------------------------------------------------------------ */
  const retry = useCallback(async () => {
    setRestarting(true)
    setRestartError(null)
    try {
      await window.api.restart()
    } catch (e) {
      setRestartError(e instanceof Error ? e.message : String(e))
    } finally {
      setRestarting(false)
    }
  }, [])

  /* ---- connection gates ------------------------------------------------- */
  if (!server.running) {
    const failure = server.error ?? restartError
    if (failure && !restarting) {
      return (
        <div className="app__boot">
          <div className="app__card">
            <div className="app__card-title">Could not start the OpenCode server</div>
            <p className="app__card-text">
              opencode-desktop runs <code>opencode serve</code> in the background and talks to it
              locally. The server did not come up.
            </p>
            <pre className="app__err">{failure}</pre>
            <div className="app__steps">
              <span>Install the OpenCode CLI globally, then retry:</span>
              <CopyLine text={INSTALL_HINT} />
              <span>
                After installing, make sure <code>opencode</code> is on your PATH — open a new
                terminal and run <code>opencode --version</code>.
              </span>
            </div>
            <div className="app__card-actions">
              <button type="button" className="app__btn app__btn--primary" onClick={() => void retry()}>
                Retry
              </button>
              <button
                type="button"
                className="app__btn"
                onClick={() => void window.api.openExternal('https://opencode.ai/docs/')}
              >
                OpenCode docs
              </button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="app__boot">
        <div className="app__spinner" />
        <div className="app__boot-title">
          {restarting ? 'Restarting OpenCode…' : 'Starting the OpenCode server…'}
        </div>
        <p className="app__boot-sub">
          Launching <code>opencode serve</code> and connecting to its event stream. This takes a
          moment the first time.
        </p>
      </div>
    )
  }

  // The right column hosts the Phase 1 code surface as well as the original
  // Artifacts panel. `panelTab` is the explicit selection; an artifact opening
  // still implies the artifacts tab, preserving the pre-Phase-1 behaviour.
  const effectivePanelTab: PanelTab =
    panelTab ?? (activeArtifactID !== null ? 'artifacts' : null)
  const panelOpen = activeView === 'chats' && effectivePanelTab !== null

  if (liveScreenOpen) return <LiveScreenAssistant onClose={() => setLiveScreenOpen(false)} />

  return (
    <div
      className={panelOpen ? 'app app--panel' : 'app'}
      style={{ '--sidebar-w': `${width}px` } as CSSProperties}
    >
      <div className="app__sidebar">
        <Sidebar onOpenLiveScreen={() => setLiveScreenOpen(true)} />
      </div>

      <div
        className="app__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={resizeByKey}
        onDoubleClick={() => {
          setWidth(DEFAULT_W)
          persistWidth(DEFAULT_W)
        }}
      />

      <main className="app__main">
        {error !== null && (
          <div className="banner banner--error" role="alert">
            <span className="banner__icon" aria-hidden="true">
              !
            </span>
            <span className="banner__text">{error}</span>
            <button type="button" className="banner__close" onClick={dismissError} title="Dismiss">
              ×
            </button>
          </div>
        )}
        {/* Keyed on the view so switching away from a crashed one remounts the
            boundary — without this the error state outlives the view that threw. */}
        <ErrorBoundary
          key={activeView}
          label={activeView === 'projects' ? 'Projects' : activeView === 'images' ? 'Images' : 'Chat'}
        >
          {activeView === 'projects' ? (
            <ProjectView />
          ) : activeView === 'images' ? (
            <ImagesView />
          ) : (
            <Chat />
          )}
        </ErrorBoundary>
      </main>

      {panelOpen && (
        <div className="app__panel panel">
          <div className="panel__tabs" role="tablist" aria-label="Code surface">
            {PANEL_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={effectivePanelTab === tab}
                className={
                  effectivePanelTab === tab ? 'panel__tab panel__tab--active' : 'panel__tab'
                }
                onClick={() => setPanelTab(tab)}
              >
                {PANEL_LABELS[tab]}
              </button>
            ))}
            <button
              type="button"
              className="panel__tab panel__tab--close"
              onClick={() => {
                setPanelTab(null)
                setActiveArtifactID(null)
              }}
              title="Close panel (Ctrl+B)"
              aria-label="Close panel"
            >
              ×
            </button>
          </div>
          <div className="panel__body">
            {effectivePanelTab === 'files' && (
              <ErrorBoundary label="Files">
                <FileTree />
              </ErrorBoundary>
            )}
            {effectivePanelTab === 'editor' && (
              <ErrorBoundary label="Editor">
                <EditorPanel />
              </ErrorBoundary>
            )}
            {effectivePanelTab === 'changes' && (
              <ErrorBoundary label="Changes">
                <ChangesPanel />
              </ErrorBoundary>
            )}
            {effectivePanelTab === 'git' && (
              <ErrorBoundary label="Git">
                <GitPanel />
              </ErrorBoundary>
            )}
            {effectivePanelTab === 'terminal' && (
              <ErrorBoundary label="Terminal">
                <TerminalPanel />
              </ErrorBoundary>
            )}
            {effectivePanelTab === 'artifacts' && (
              <ErrorBoundary label="Artifacts">
                <ArtifactsPanel />
              </ErrorBoundary>
            )}
          </div>
        </div>
      )}

      <CommandPalette />
      <StatusBar />
    </div>
  )
}
