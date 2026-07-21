import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { Session } from '@opencode-ai/sdk'
import { useStore } from '../lib/store'
import { relativeTime, shortPath } from '../lib/format'
import { ModelPicker } from './ModelPicker'
import { ProviderPanel } from './ProviderPanel'

/** Dispatched by App.tsx when Escape is pressed. */
const CLOSE_PROVIDERS_EVENT = 'opencode-desktop:close-providers'

function stamp(s: Session): number {
  return s.time.updated || s.time.created || 0
}

function fullStamp(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString()
}

export function Sidebar(): JSX.Element {
  const directory = useStore((s) => s.directory)
  const sessions = useStore((s) => s.sessions)
  const activeSessionID = useStore((s) => s.activeSessionID)
  const pickDirectory = useStore((s) => s.pickDirectory)
  const newSession = useStore((s) => s.newSession)
  const selectSession = useStore((s) => s.selectSession)
  const deleteSession = useStore((s) => s.deleteSession)

  const [providersOpen, setProvidersOpen] = useState(false)
  const [confirmID, setConfirmID] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  /* keep relative timestamps honest without a per-second re-render */
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const close = (): void => setProvidersOpen(false)
    window.addEventListener(CLOSE_PROVIDERS_EVENT, close)
    return () => window.removeEventListener(CLOSE_PROVIDERS_EVENT, close)
  }, [])

  /* the pending delete confirmation must not survive a list change */
  useEffect(() => {
    if (confirmID !== null && !sessions.some((s) => s.id === confirmID)) setConfirmID(null)
  }, [sessions, confirmID])

  const ordered = useMemo(() => {
    void tick
    return sessions.filter((s) => !s.parentID).sort((a, b) => stamp(b) - stamp(a))
  }, [sessions, tick])

  return (
    <div className="sidebar">
      <div className="titlebar">
        <span className="titlebar__mark" aria-hidden="true" />
        <span className="titlebar__name">opencode desktop</span>
        <span className="titlebar__sub">any model</span>
      </div>

      <div className="sidebar__project">
        <span className="sidebar__label">Project</span>
        {directory ? (
          <div className="sidebar__path" title={directory}>
            <span>{shortPath(directory)}</span>
          </div>
        ) : (
          <div className="sidebar__path sidebar__path--empty">
            <span>No folder open</span>
          </div>
        )}
        <button
          type="button"
          className="sidebar__btn"
          onClick={() => void pickDirectory()}
          title="Choose the project folder OpenCode works in (Ctrl+O)"
        >
          Open folder…
          <span className="sidebar__kbd">Ctrl+O</span>
        </button>
      </div>

      {directory === null ? (
        <div className="sidebar__empty">
          <span className="sidebar__empty-title">No project open</span>
          <p>
            Pick a folder to start. OpenCode reads and edits files inside it, and every session
            belongs to that folder.
          </p>
          <button type="button" className="sidebar__btn sidebar__btn--primary" onClick={() => void pickDirectory()}>
            Open folder…
          </button>
        </div>
      ) : (
        <>
          <div className="sidebar__new">
            <button
              type="button"
              className="sidebar__btn sidebar__btn--primary"
              onClick={() => void newSession()}
              title="Start a new session (Ctrl+N)"
            >
              New session
              <span className="sidebar__kbd">Ctrl+N</span>
            </button>
          </div>

          <div className="sidebar__listhead">
            <span className="sidebar__label">Sessions</span>
            <span className="sidebar__count">{ordered.length}</span>
          </div>

          <div className="sidebar__list">
            {ordered.length === 0 && (
              <div className="sidebar__empty">
                <p>No sessions yet. Create one to start coding.</p>
              </div>
            )}

            {ordered.map((s) =>
              confirmID === s.id ? (
                <div className="sidebar__confirm" key={s.id}>
                  <span className="sidebar__confirm-text">Delete this session?</span>
                  <button
                    type="button"
                    className="sidebar__btn sidebar__btn--sm sidebar__btn--danger"
                    onClick={() => {
                      setConfirmID(null)
                      void deleteSession(s.id)
                    }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="sidebar__btn sidebar__btn--sm"
                    onClick={() => setConfirmID(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="sidebar__row" key={s.id}>
                  <button
                    type="button"
                    className={
                      s.id === activeSessionID
                        ? 'sidebar__session sidebar__session--active'
                        : 'sidebar__session'
                    }
                    onClick={() => {
                      if (s.id !== activeSessionID) void selectSession(s.id)
                    }}
                    title={`${s.title || 'Untitled'}\n${fullStamp(stamp(s))}`}
                  >
                    <span className="sidebar__session-main">
                      <span className="sidebar__session-title">{s.title || 'Untitled'}</span>
                      <span className="sidebar__session-meta">{relativeTime(stamp(s))}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="sidebar__del"
                    aria-label={`Delete session ${s.title || 'Untitled'}`}
                    title="Delete session"
                    onClick={() => setConfirmID(s.id)}
                  >
                    ×
                  </button>
                </div>
              )
            )}
          </div>
        </>
      )}

      <div className="sidebar__foot">
        <ModelPicker />
        <button
          type="button"
          className="sidebar__btn"
          onClick={() => setProvidersOpen(true)}
          title="See which model providers are connected"
        >
          Providers
        </button>
      </div>

      <ProviderPanel open={providersOpen} onClose={() => setProvidersOpen(false)} />
    </div>
  )
}
