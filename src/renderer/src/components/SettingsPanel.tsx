import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { UpdateStatus } from '../lib/types'
import { useStore } from '../lib/store'
import { FREE_ROUTING_CANDIDATES } from '../lib/rotation'
import { McpPanel } from './McpPanel'
import { RoutingPanel } from './RoutingPanel'

/** Listened for by ProviderPanel (mounted separately, in Sidebar) to open itself. */
const OPEN_PROVIDERS_EVENT = 'providers:open'

function updateStatusText(status: UpdateStatus): string {
  switch (status.state) {
    case 'idle':
      return 'Updates are checked automatically.'
    case 'checking':
      return 'Checking for updates...'
    case 'not-available':
      return 'OpenCode Desktop is up to date.'
    case 'available':
      return `Version ${status.version} is available.`
    case 'progress':
      return `Downloading update... ${Math.round(status.percent)}%`
    case 'downloaded':
      return 'Update downloaded. You will be asked before the app restarts.'
    case 'error':
      return `Update check failed: ${status.message}`
  }
}

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const routingMode = useStore((s) => s.routingMode)
  const setRoutingMode = useStore((s) => s.setRoutingMode)
  const showPaidModels = useStore((s) => s.showPaidModels)
  const setShowPaidModels = useStore((s) => s.setShowPaidModels)
  const modelPool = useStore((s) => s.modelPool)
  const setModelPool = useStore((s) => s.setModelPool)
  const providers = useStore((s) => s.providers)
  const server = useStore((s) => s.server)
  const appSettings = useStore((s) => s.appSettings)
  const shortcutRegistered = useStore((s) => s.shortcutRegistered)
  const shortcutError = useStore((s) => s.shortcutError)
  const updateStatus = useStore((s) => s.updateStatus)
  const updateAppSettings = useStore((s) => s.updateAppSettings)
  const [shortcutDraft, setShortcutDraft] = useState(appSettings.globalShortcut)
  const [applyingShortcut, setApplyingShortcut] = useState(false)

  useEffect(() => {
    setShortcutDraft(appSettings.globalShortcut)
  }, [appSettings.globalShortcut])

  const applyShortcut = (): void => {
    const globalShortcut = shortcutDraft.trim()
    if (applyingShortcut || globalShortcut.length === 0) return
    setApplyingShortcut(true)
    void updateAppSettings({ globalShortcut }).finally(() => {
      setApplyingShortcut(false)
    })
  }

  if (!open) return null

  const candidateKeys = FREE_ROUTING_CANDIDATES.map((c) => `${c.providerID}/${c.modelID}`)
  const activePoolKeys = new Set(modelPool ?? candidateKeys)

  const togglePoolCandidate = (key: string): void => {
    let next: string[]
    if (activePoolKeys.has(key)) {
      next = candidateKeys.filter((k) => k !== key && activePoolKeys.has(k))
    } else {
      next = [...Array.from(activePoolKeys), key]
    }
    // If all candidates are selected, revert to default null pool
    if (next.length === candidateKeys.length && candidateKeys.every((k) => next.includes(k))) {
      setModelPool(null)
    } else {
      setModelPool(next)
    }
  }

  return (
    <div
      className="providers"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="providers__panel">
        <div className="providers__head">
          <span className="providers__title">Settings</span>
          <button type="button" className="providers__close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="providers__body">
          <section>
            <h2 className="providers__group-title">Appearance</h2>
            <div className="providers__card">
              <div className="providers__row">
                <span className="providers__name">Theme</span>
              </div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                {(['auto', 'dark', 'light'] as const).map((t) => (
                  <label key={t} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="theme"
                      checked={theme === t}
                      onChange={() => setTheme(t)}
                    />
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">NanoGPT Images</h2>
            <div className="providers__card">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={appSettings.nanogptSubscriptionOnly}
                  onChange={(event) => {
                    void updateAppSettings({ nanogptSubscriptionOnly: event.target.checked })
                  }}
                />
                Subscription images only
              </label>
              <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', margin: '6px 0 0' }}>
                NanoGPT does not publish which image models its subscription covers, so a model&apos;s
                billing is only known once it has generated: the response reports a
                {' '}<code>paymentSource</code>. With this on, any model found to bill your
                pay-as-you-go balance is refused from then on. The first generation on an
                untested model is what reveals it.
              </p>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Desktop Integration</h2>
            <div className="providers__card">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={appSettings.closeToTray}
                  onChange={(event) => {
                    void updateAppSettings({ closeToTray: event.target.checked })
                  }}
                />
                Keep OpenCode Desktop running in the tray when its window closes
              </label>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', marginTop: '4px' }}>
                <label htmlFor="global-shortcut" className="providers__name">
                  Quick Entry shortcut
                </label>
                <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', margin: '4px 0 8px' }}>
                  Use an Electron accelerator such as Ctrl+Alt+Space.
                </p>
                <div className="providers__row">
                  <input
                    id="global-shortcut"
                    className="providers__key-input"
                    value={shortcutDraft}
                    onChange={(event) => setShortcutDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        applyShortcut()
                      }
                    }}
                    aria-invalid={shortcutError !== null}
                    aria-describedby="global-shortcut-status"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="providers__key-btn providers__key-btn--primary"
                    disabled={applyingShortcut || shortcutDraft.trim().length === 0}
                    onClick={applyShortcut}
                  >
                    {applyingShortcut ? 'Applying...' : 'Apply'}
                  </button>
                </div>
                {shortcutError ? (
                  <p id="global-shortcut-status" role="alert" style={{ marginTop: '7px', fontSize: '11.5px', color: 'var(--danger)' }}>
                    Shortcut conflict: {shortcutError}
                  </p>
                ) : (
                  <p id="global-shortcut-status" style={{ marginTop: '7px', fontSize: '11.5px', color: shortcutRegistered ? 'var(--ok)' : 'var(--fg-dim)' }}>
                    {shortcutRegistered ? 'Shortcut registered.' : 'Shortcut is not currently registered.'}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Updates</h2>
            <div
              className="providers__card"
              role="status"
              aria-live="polite"
              style={updateStatus.state === 'error' ? { borderColor: 'var(--danger)' } : undefined}
            >
              <span style={{ color: updateStatus.state === 'error' ? 'var(--danger)' : 'var(--fg)' }}>
                {updateStatusText(updateStatus)}
              </span>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Model Preferences & Smart Routing</h2>
            <div className="providers__card">
              <div className="providers__row">
                <span className="providers__name">Routing Mode</span>
              </div>
              <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', marginTop: '4px', marginBottom: '8px' }}>
                How OpenCode Desktop chooses which model runs each turn.
              </p>
              <div role="radiogroup" aria-label="Routing mode" style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                {(['locked', 'failover', 'auto'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={routingMode === mode}
                    onClick={() => setRoutingMode(mode)}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      fontSize: '12px',
                      cursor: 'pointer',
                      background: routingMode === mode ? 'var(--accent)' : 'transparent',
                      color: routingMode === mode ? 'var(--bg)' : 'var(--fg)',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      fontWeight: routingMode === mode ? 600 : 400,
                    }}
                    title={
                      mode === 'locked' ? 'Never change model. Surface errors only.'
                      : mode === 'failover' ? 'Use your model. Swap only on 429/timeout. (Recommended)'
                      : 'Proactively pick best healthy model each send. (Legacy)'
                    }
                  >
                    {mode === 'locked' ? '🔒 Locked' : mode === 'failover' ? '⚡ Failover' : '🎯 Auto'}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: '11px', color: 'var(--fg-dim)', marginBottom: '12px' }}>
                {routingMode === 'locked' && 'Your chosen model runs every turn. Errors surface immediately.'}
                {routingMode === 'failover' && 'Your chosen model stays pinned. On 429 or stall, auto-fails over to a healthy free model — your chosen pin is never overwritten.'}
                {routingMode === 'auto' && 'Legacy: pre-selects the healthiest model on every send. May override your pick for this session.'}
              </p>

              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer', marginBottom: '10px' }}>
                <input
                  type="checkbox"
                  checked={showPaidModels}
                  onChange={(e) => setShowPaidModels(e.target.checked)}
                />
                Show paid models in picker
              </label>
              <p style={{ fontSize: '11px', color: 'var(--fg-dim)', marginTop: '-6px', marginBottom: '12px' }}>
                Paid models still require manual selection — auto-failover never routes to a paid model.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span>TTFT (ms) — time to first token</span>
                  <input
                    type="number"
                    min={5000}
                    step={1000}
                    value={appSettings.ttftMs}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (Number.isFinite(v) && v >= 5000) void updateAppSettings({ ttftMs: v })
                    }}
                    style={{ padding: '4px 6px', fontSize: '12px' }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span>Stall (ms) — max gap between parts</span>
                  <input
                    type="number"
                    min={10000}
                    step={5000}
                    value={appSettings.stallMs}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (Number.isFinite(v) && v >= 10000) void updateAppSettings({ stallMs: v })
                    }}
                    style={{ padding: '4px 6px', fontSize: '12px' }}
                  />
                </label>
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', marginTop: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span className="providers__name" style={{ fontSize: '12px' }}>Candidate Model Pool</span>
                  {modelPool !== null && (
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer', padding: 0 }}
                      onClick={() => setModelPool(null)}
                    >
                      Reset to Default
                    </button>
                  )}
                </div>
                <p style={{ fontSize: '11px', color: 'var(--fg-dim)', marginBottom: '8px' }}>
                  Select candidate models allowed in the rotation pool:
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '180px', overflowY: 'auto' }}>
                  {FREE_ROUTING_CANDIDATES.map(({ providerID, modelID }) => {
                    const key = `${providerID}/${modelID}`
                    const isChecked = activePoolKeys.has(key)
                    const provider = providers.find((p) => p.id === providerID)
                    const modelObj = provider?.models?.[modelID]
                    const label = provider ? `${provider.name} · ${modelObj?.name ?? modelID}` : key

                    return (
                      <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => togglePoolCandidate(key)}
                        />
                        <span>{label}</span>
                        {!provider && <span style={{ fontSize: '10px', color: 'var(--fg-dim)', fontStyle: 'italic' }}>(provider offline)</span>}
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Live Model Health</h2>
            <div className="providers__card">
              <RoutingPanel />
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Provider Keys</h2>
            <div className="providers__card">
              <div className="providers__row">
                <span className="providers__name">API Keys (BYOK)</span>
              </div>
              <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', marginTop: '4px', marginBottom: '8px' }}>
                Add, test, or remove your own API key for any provider.
              </p>
              <button
                type="button"
                className="providers__key-btn providers__key-btn--primary"
                onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PROVIDERS_EVENT))}
              >
                Manage provider keys…
              </button>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">MCP Connectors</h2>
            <div className="providers__card">
              <McpPanel />
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Server Info</h2>
            <div className="providers__card">
              <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div><strong>Status:</strong> {server.running ? 'Running' : 'Offline'}</div>
                <div><strong>URL:</strong> {server.url || 'N/A'}</div>
                {server.error && <div><strong>Error:</strong> {server.error}</div>}
              </div>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Shortcuts</h2>
            <div className="providers__card">
              <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
                <tbody>
                  <tr>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>New Session</td>
                    <td style={{ textAlign: 'right', padding: '6px 0', borderBottom: '1px solid var(--border)' }}><kbd className="providers__envvar">Ctrl+N</kbd></td>
                  </tr>
                  <tr>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>Open Folder</td>
                    <td style={{ textAlign: 'right', padding: '6px 0', borderBottom: '1px solid var(--border)' }}><kbd className="providers__envvar">Ctrl+O</kbd></td>
                  </tr>
                  <tr>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>Clear</td>
                    <td style={{ textAlign: 'right', padding: '6px 0', borderBottom: '1px solid var(--border)' }}><kbd className="providers__envvar">Ctrl+K</kbd></td>
                  </tr>
                  <tr>
                    <td style={{ padding: '6px 0' }}>Settings</td>
                    <td style={{ textAlign: 'right', padding: '6px 0' }}><kbd className="providers__envvar">Ctrl+,</kbd></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
