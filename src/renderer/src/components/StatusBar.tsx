import { useMemo } from 'react'
import type { JSX } from 'react'
import { useStore } from '../lib/store'

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
  const server = useStore((s) => s.server)
  const providers = useStore((s) => s.providers)
  const providerID = useStore((s) => s.providerID)
  const modelID = useStore((s) => s.modelID)
  const sessions = useStore((s) => s.sessions)
  const activeSessionID = useStore((s) => s.activeSessionID)
  const busy = useStore((s) => s.busy)
  const pending = useStore((s) => s.permissions.length)

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
    </footer>
  )
}
