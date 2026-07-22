import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../lib/store'
import { sessionCost, contextUsed, contextLimit } from '../lib/aggregate'
import { formatCost, formatTokens } from '../lib/format'
import { SettingsPanel } from './SettingsPanel'

function hostLabel(url: string | null): string {
  if (!url) return 'no url'
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return url
  }
}

export function StatusBar(): JSX.Element {
  const [showSettings, setShowSettings] = useState(false)
  const server = useStore((s) => s.server)
  const providers = useStore((s) => s.providers)
  const providerID = useStore((s) => s.providerID)
  const modelID = useStore((s) => s.modelID)
  const sessions = useStore((s) => s.sessions)
  const activeSessionID = useStore((s) => s.activeSessionID)
  const busy = useStore((s) => s.busy)
  const pending = useStore((s) => s.permissions.length)
  const autoRotate = useStore((s) => s.autoRotate)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const branch = useStore((s) => s.branch)
  const messages = useStore((s) => s.messages)

  useEffect(() => {
    const onToggleSettings = () => setShowSettings((prev) => !prev)
    window.addEventListener('opencode-desktop:toggle-settings', onToggleSettings)
    return () => window.removeEventListener('opencode-desktop:toggle-settings', onToggleSettings)
  }, [])

  const modelLabel = useMemo(() => {
    if (!providerID || !modelID) return 'no model selected'
    const p = providers.find((x) => x.id === providerID)
    if (!p) return `${providerID}/${modelID}`
    const m = p.models[modelID]
    return `${p.name} · ${m ? m.name : modelID}`
  }, [providers, providerID, modelID])

  const sessionLabel = useMemo(() => {
    if (!activeSessionID) return 'no session'
    const s = sessions.find((x) => x.id === activeSessionID)
    if (!s) return 'no session'
    return s.title || 'Untitled'
  }, [sessions, activeSessionID])

  const dotClass = server.running ? 'app__dot app__dot--ok' : 'app__dot app__dot--bad'
  const serverText = server.running ? hostLabel(server.url) : server.error ? 'server error' : 'offline'

  const ctxUsed = contextUsed(messages)
  const ctxLimit = contextLimit(providers, providerID, modelID)
  const ctxPct = ctxLimit > 0 ? Math.round((ctxUsed / ctxLimit) * 100) : 0
  const ctxText = ctxLimit > 0 ? `Context: ${formatTokens(ctxUsed)} / ${formatTokens(ctxLimit)} (${ctxPct}%)` : `Context: ${formatTokens(ctxUsed)}`

  const costText = `Cost: ${formatCost(sessionCost(messages))}`

  const cycleTheme = () => {
    if (theme === 'auto') setTheme('dark')
    else if (theme === 'dark') setTheme('light')
    else setTheme('auto')
  }
  const themeIcon = theme === 'light' ? '☀' : theme === 'dark' ? '☽' : '◐'

  return (
    <footer className="app__status">
      <span
        className="app__status-item"
        title={server.error ? server.error : (server.url ?? 'OpenCode server not running')}
      >
        <span className={dotClass} aria-hidden="true" />
        <span className="app__status-url">{serverText}</span>
      </span>

      <span className="app__status-sep" aria-hidden="true" />

      <span className="app__status-item" title={providerID && modelID ? `${providerID}/${modelID}` : 'Pick a model with Ctrl+K'}>
        <span className="app__status-strong">{modelLabel}</span>
      </span>

      <span className="app__status-sep" aria-hidden="true" />

      <span className="app__status-item app__status-item--grow" title={sessionLabel}>
        <span className="app__status-strong">{sessionLabel}</span>
      </span>

      {autoRotate && (
        <span className="app__status-item app__autorotate" title="Free Model Auto-Routing enabled (cycles models on 429 rate limit)">
          ⚡ Auto-Route
        </span>
      )}

      {branch && (
        <span className="app__status-item" title="Current git branch">
          ⎇ {branch}
        </span>
      )}

      <span className="app__status-sep" aria-hidden="true" />

      <span className="app__status-item" title="Context usage">
        {ctxText}
      </span>

      <span className="app__status-sep" aria-hidden="true" />

      <span className="app__status-item" title="Session cost">
        {costText}
      </span>

      <span className="app__status-sep" aria-hidden="true" />

      <button
        type="button"
        className="app__status-item"
        title="Settings (Ctrl+,)"
        onClick={() => setShowSettings(true)}
      >
        ⚙
      </button>

      <button
        type="button"
        className="app__status-item"
        title="Toggle Theme (auto/dark/light)"
        onClick={cycleTheme}
      >
        {themeIcon}
      </button>

      {busy && (
        <span className="app__status-item app__busy" title="The assistant is working">
          <span className="app__spinner app__spinner--sm" aria-hidden="true" />
          <span>working…</span>
        </span>
      )}

      {pending > 0 && (
        <span className="app__status-item app__pending" title="Permission requests waiting on you">
          {pending} permission{pending === 1 ? '' : 's'} pending
        </span>
      )}

      <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
    </footer>
  )
}
