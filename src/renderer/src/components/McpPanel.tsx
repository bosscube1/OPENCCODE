import { useEffect, useId, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import { useStore } from '../lib/store'
import { rowsToRecord, splitCommandLine, type KeyValueRow } from '../lib/mcp'
import type { McpConfig, McpSnapshot, McpStatus } from '../lib/types'
import './mcp.css'

type ConnectorKind = 'local' | 'remote'

interface McpApi {
  status(directory: string): Promise<McpSnapshot>
  add(args: { directory: string; name: string; config: McpConfig }): Promise<McpSnapshot>
  remove(directory: string, name: string): Promise<McpSnapshot>
  connect(directory: string, name: string): Promise<McpSnapshot>
  disconnect(directory: string, name: string): Promise<McpSnapshot>
  auth(directory: string, name: string): Promise<McpSnapshot>
}

function mcpApi(): McpApi {
  return (window.api as typeof window.api & { mcp: McpApi }).mcp
}

const EMPTY_SNAPSHOT: McpSnapshot = { configs: {}, statuses: {} }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseTimeout(value: string): number | undefined {
  if (!value.trim()) return undefined
  const timeout = Number(value)
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error('Timeout must be a positive whole number of milliseconds.')
  return timeout
}

function validateRemoteUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid remote server URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Remote server URL must use HTTP or HTTPS.')
  return url.toString()
}

function statusLabel(status: McpStatus | undefined): string {
  if (!status) return 'Unknown'
  return status.status.replaceAll('_', ' ')
}

function RowEditor({
  label,
  rows,
  onChange
}: {
  label: string
  rows: KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
}): JSX.Element {
  const id = useId()
  const update = (index: number, field: keyof KeyValueRow, value: string): void => {
    onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row))
  }

  return (
    <fieldset className="mcp__rows">
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div className="mcp__row" key={`${id}-${index}`}>
          <label className="mcp__visually-hidden" htmlFor={`${id}-key-${index}`}>{label} key</label>
          <input id={`${id}-key-${index}`} value={row.key} onChange={(event) => update(index, 'key', event.target.value)} placeholder="Key" autoComplete="off" />
          <span aria-hidden="true">=</span>
          <label className="mcp__visually-hidden" htmlFor={`${id}-value-${index}`}>{label} value</label>
          <input id={`${id}-value-${index}`} value={row.value} onChange={(event) => update(index, 'value', event.target.value)} placeholder="Value" autoComplete="off" />
          <button type="button" className="mcp__icon-button" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))} aria-label={`Remove ${label.toLowerCase()} row`}>×</button>
        </div>
      ))}
      <button type="button" className="mcp__text-button" onClick={() => onChange([...rows, { key: '', value: '' }])}>+ Add {label.toLowerCase()}</button>
    </fieldset>
  )
}

export function McpPanel(): JSX.Element {
  const directory = useStore((state) => state.directory)
  const [snapshot, setSnapshot] = useState<McpSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [kind, setKind] = useState<ConnectorKind>('local')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [url, setUrl] = useState('')
  const [timeout, setTimeoutValue] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [oauth, setOauth] = useState(true)
  const [environment, setEnvironment] = useState<KeyValueRow[]>([])
  const [headers, setHeaders] = useState<KeyValueRow[]>([])

  useEffect(() => {
    if (!directory) {
      setSnapshot(EMPTY_SNAPSHOT)
      return
    }
    let current = true
    const refresh = async (initial: boolean): Promise<void> => {
      if (initial) {
        setLoading(true)
        setError(null)
      }
      try {
        const next = await mcpApi().status(directory)
        if (current) setSnapshot(next)
      } catch (reason) {
        if (current && initial) setError(errorText(reason))
      } finally {
        if (current && initial) setLoading(false)
      }
    }
    void refresh(true)
    // OAuth completes outside the renderer; periodic refresh makes the status
    // badge update after the browser callback without requiring the panel to reopen.
    const interval = window.setInterval(() => void refresh(false), 5_000)
    return () => {
      current = false
      window.clearInterval(interval)
    }
  }, [directory])

  async function run(nameToLock: string, operation: () => Promise<McpSnapshot>): Promise<void> {
    setBusyName(nameToLock)
    setError(null)
    try {
      setSnapshot(await operation())
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusyName(null)
    }
  }

  function resetForm(): void {
    setName('')
    setCommand('')
    setUrl('')
    setTimeoutValue('')
    setEnabled(true)
    setOauth(true)
    setEnvironment([])
    setHeaders([])
    setShowAdd(false)
  }

  async function addConnector(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!directory || busyName) return
    try {
      const connectorName = name.trim()
      if (!connectorName) throw new Error('Enter a connector name.')
      const parsedTimeout = parseTimeout(timeout)
      let config: McpConfig
      if (kind === 'local') {
        config = {
          type: 'local',
          command: splitCommandLine(command),
          environment: rowsToRecord(environment, 'Environment'),
          enabled,
          timeout: parsedTimeout
        }
      } else {
        config = {
          type: 'remote',
          url: validateRemoteUrl(url),
          headers: rowsToRecord(headers, 'Header'),
          oauth: oauth ? {} : false,
          enabled,
          timeout: parsedTimeout
        }
      }
      setBusyName(connectorName)
      setError(null)
      setSnapshot(await mcpApi().add({ directory, name: connectorName, config }))
      resetForm()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusyName(null)
    }
  }

  const entries = Object.entries(snapshot.configs).sort(([left], [right]) => left.localeCompare(right))

  if (!directory) {
    return <div className="mcp__empty">Open a workspace to manage its MCP connectors.</div>
  }

  return (
    <div className="mcp" aria-busy={loading || busyName !== null}>
      <div className="mcp__intro">
        <p>Connect local tools or remote services to this workspace.</p>
        <button type="button" className="mcp__button mcp__button--primary" onClick={() => setShowAdd((visible) => !visible)} aria-expanded={showAdd}>
          {showAdd ? 'Cancel' : 'Add connector'}
        </button>
      </div>

      {error && <div className="mcp__message mcp__message--error" role="alert">{error}</div>}
      {loading && <div className="mcp__message" role="status">Loading connectors…</div>}

      {showAdd && (
        <form className="mcp__form" onSubmit={(event) => void addConnector(event)}>
          <h3>Add MCP connector</h3>
          <label className="mcp__field">
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="filesystem" autoFocus />
          </label>
          <div className="mcp__kind" role="group" aria-label="Connector type">
            {(['local', 'remote'] as const).map((value) => (
              <label key={value}><input type="radio" name="mcp-kind" checked={kind === value} onChange={() => setKind(value)} /> {value === 'local' ? 'Local command' : 'Remote URL'}</label>
            ))}
          </div>
          {kind === 'local' ? (
            <>
              <label className="mcp__field">
                <span>Command</span>
                <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={'npx -y "@modelcontextprotocol/server-filesystem" "C:\\Work"'} spellCheck={false} />
                <small>Quoted arguments and Windows paths are supported. The command is run directly, without a shell.</small>
              </label>
              <RowEditor label="Environment" rows={environment} onChange={setEnvironment} />
            </>
          ) : (
            <>
              <label className="mcp__field">
                <span>Server URL</span>
                <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com" />
              </label>
              <RowEditor label="Headers" rows={headers} onChange={setHeaders} />
              <label className="mcp__check"><input type="checkbox" checked={oauth} onChange={(event) => setOauth(event.target.checked)} /> Allow OAuth discovery</label>
            </>
          )}
          <label className="mcp__field mcp__field--short">
            <span>Timeout (milliseconds)</span>
            <input type="number" min="1" step="1" value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} placeholder="Optional" />
          </label>
          <label className="mcp__check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable after adding</label>
          <div className="mcp__form-actions">
            <button type="submit" className="mcp__button mcp__button--primary" disabled={busyName !== null}>{busyName ? 'Adding…' : 'Add connector'}</button>
          </div>
        </form>
      )}

      {!loading && entries.length === 0 && !showAdd && <div className="mcp__empty">No MCP connectors configured for this workspace.</div>}

      <div className="mcp__list">
        {entries.map(([connectorName, config]) => {
          const status = snapshot.statuses[connectorName]
          const working = busyName === connectorName
          const canAuth = status?.status === 'needs_auth' || status?.status === 'needs_client_registration'
          const connected = status?.status === 'connected'
          return (
            <article className="mcp__card" key={connectorName}>
              <div className="mcp__card-head">
                <div><h3>{connectorName}</h3><span className="mcp__type">{config.type}</span></div>
                <span className={`mcp__status mcp__status--${status?.status ?? 'unknown'}`}>{statusLabel(status)}</span>
              </div>
              <code className="mcp__summary">{config.type === 'local' ? config.command.join(' ') : config.url}</code>
              {status && 'error' in status && <p className="mcp__error">{status.error}</p>}
              <div className="mcp__actions">
                {canAuth && <button type="button" className="mcp__button mcp__button--primary" disabled={working} onClick={() => void run(connectorName, () => mcpApi().auth(directory, connectorName))}>Authorize</button>}
                <button type="button" className="mcp__button" disabled={working} onClick={() => void run(connectorName, () => connected ? mcpApi().disconnect(directory, connectorName) : mcpApi().connect(directory, connectorName))}>
                  {working ? 'Working…' : connected ? 'Disconnect' : 'Connect'}
                </button>
                <button type="button" className="mcp__button mcp__button--danger" disabled={working} onClick={() => {
                  if (window.confirm(`Remove MCP connector “${connectorName}”?`)) void run(connectorName, () => mcpApi().remove(directory, connectorName))
                }}>Remove</button>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
