import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { Provider } from '@opencode-ai/sdk'
import { useStore } from '../lib/store'

/** Shape returned by `window.api.keys.list()` (owned by the keys/preload stream). */
type KeyRow = { providerID: string; envVar: string; maskedTail: string | null }

/** The one command that connects a provider via OpenCode's own credential store. */
const AUTH_COMMAND = 'opencode auth login'

/** Providers with a usable free tier, surfaced first everywhere in the UI. */
const FREE_TIER = new Set(['groq', 'google', 'openrouter', 'cerebras', 'mistral'])

const DOCS: Record<string, string> = {
  groq: 'https://console.groq.com/docs/quickstart',
  google: 'https://ai.google.dev/gemini-api/docs',
  'google-vertex': 'https://cloud.google.com/vertex-ai/generative-ai/docs',
  openrouter: 'https://openrouter.ai/docs/quickstart',
  cerebras: 'https://inference-docs.cerebras.ai/',
  mistral: 'https://docs.mistral.ai/',
  openai: 'https://platform.openai.com/docs/overview',
  anthropic: 'https://docs.claude.com/',
  azure: 'https://learn.microsoft.com/azure/ai-services/openai/',
  'amazon-bedrock': 'https://docs.aws.amazon.com/bedrock/',
  deepseek: 'https://api-docs.deepseek.com/',
  xai: 'https://docs.x.ai/',
  'github-copilot': 'https://docs.github.com/copilot',
  'github-models': 'https://docs.github.com/github-models',
  ollama: 'https://docs.ollama.com/',
  'llama-cpp': 'https://github.com/ggml-org/llama.cpp',
  togetherai: 'https://docs.together.ai/',
  together: 'https://docs.together.ai/',
  fireworks: 'https://docs.fireworks.ai/',
  'fireworks-ai': 'https://docs.fireworks.ai/',
  perplexity: 'https://docs.perplexity.ai/',
  huggingface: 'https://huggingface.co/docs/inference-providers',
  cohere: 'https://docs.cohere.com/',
  nvidia: 'https://docs.api.nvidia.com/',
  'opencode-zen': 'https://opencode.ai/docs/zen/',
  opencode: 'https://opencode.ai/docs/'
}

const FALLBACK_DOCS = 'https://opencode.ai/docs/providers/'

/** Built-in floor of key-manageable providers so a key can be added before OpenCode knows the provider. */
const BUILTIN_PROVIDERS: { id: string; name: string }[] = [
  { id: 'google', name: 'Google' },
  { id: 'groq', name: 'Groq' },
  { id: 'cerebras', name: 'Cerebras' },
  { id: 'mistral', name: 'Mistral' },
  { id: 'cohere', name: 'Cohere' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'huggingface', name: 'Hugging Face' },
  { id: 'together', name: 'Together AI' },
  { id: 'fireworks', name: 'Fireworks AI' },
  { id: 'nvidia', name: 'NVIDIA' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'xai', name: 'xAI' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' }
]

/** Dispatched by SettingsPanel's "Manage provider keys…" entry point. */
const OPEN_PROVIDERS_EVENT = 'providers:open'

function rankID(id: string): number {
  if (FREE_TIER.has(id)) return 0
  if (id === 'anthropic') return 2
  return 1
}

/**
 * A provider counts as live-connected when OpenCode reports a stored key, or when it
 * resolved the provider from the environment / config file (which is exactly how
 * OpenCode reports satisfied `env` vars — the renderer has no process access).
 */
function isConnected(providerID: string, linkedProviderIDs: string[]): boolean {
  return linkedProviderIDs.includes(providerID)
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

function CopyCommand({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(t)
  }, [copied])

  return (
    <div className="providers__code">
      <code>{text}</code>
      <button
        type="button"
        className="providers__copy"
        onClick={() => {
          void copyText(text).then((ok) => setCopied(ok))
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

type TestOutcome = { ok: boolean; status?: number; detail?: string }

function ProviderKeyCard({
  id,
  name,
  env,
  storeProvider,
  linkedProviderIDs,
  row,
  keyValue,
  saving,
  testing,
  result,
  onKeyChange,
  onSave,
  onRemove,
  onTest
}: {
  id: string
  name: string
  env: string[]
  storeProvider?: Provider
  linkedProviderIDs: string[]
  row?: KeyRow
  keyValue: string
  saving: boolean
  testing: boolean
  result?: TestOutcome
  onKeyChange: (value: string) => void
  onSave: () => void
  onRemove: () => void
  onTest: () => void
}): JSX.Element {
  const free = FREE_TIER.has(id)
  const url = DOCS[id] ?? FALLBACK_DOCS
  const live = isConnected(id, linkedProviderIDs)
  const modelCount = storeProvider ? Object.keys(storeProvider.models).length : 0
  const envVar = row?.envVar ?? env[0]

  return (
    <div className={live ? 'providers__card providers__card--on' : 'providers__card'}>
      <div className="providers__row">
        <button
          type="button"
          className="providers__name"
          title={`Open ${name} docs — ${url}`}
          onClick={() => void window.api.openExternal(url)}
        >
          {name} <span className="providers__ext">↗</span>
        </button>
        <span className="providers__tags">
          {free && <span className="providers__tag providers__tag--free">free tier</span>}
          {live && <span className="providers__tag providers__tag--ok">connected</span>}
          {!live && row && (
            <span className="providers__tag providers__key-tag--pending">key saved · restart to apply</span>
          )}
        </span>
      </div>

      <div className="providers__meta">
        {storeProvider && (
          <span>
            {modelCount} model{modelCount === 1 ? '' : 's'}
          </span>
        )}
        {envVar && <span className="providers__envvar">{envVar}</span>}
      </div>

      <div className="providers__key-manage">
        {row ? (
          <>
            <div className="providers__key-set">
              <span className="providers__key-masked">
                Key set {row.maskedTail ? `••••${row.maskedTail}` : '••••'}
              </span>
              <div className="providers__key-actions">
                <button type="button" className="providers__key-btn" onClick={onTest} disabled={testing}>
                  {testing ? 'Testing…' : 'Test'}
                </button>
                <button
                  type="button"
                  className="providers__key-btn providers__key-btn--danger"
                  onClick={onRemove}
                >
                  Remove
                </button>
              </div>
            </div>
            {result && (
              <p
                className={
                  result.ok
                    ? 'providers__key-result providers__key-result--ok'
                    : 'providers__key-result providers__key-result--fail'
                }
              >
                {result.ok
                  ? '✓ Connection OK'
                  : `✗ ${result.status ? `HTTP ${result.status} — ` : ''}${result.detail ?? 'Test failed'}`}
              </p>
            )}
          </>
        ) : (
          <div className="providers__key-form">
            <input
              type="password"
              className="providers__key-input"
              placeholder={`Paste ${name} API key`}
              value={keyValue}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onKeyChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && keyValue.trim().length > 0 && !saving) onSave()
              }}
            />
            <button
              type="button"
              className="providers__key-btn providers__key-btn--primary"
              onClick={onSave}
              disabled={saving || keyValue.trim().length === 0}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function ProviderPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const providers = useStore((s) => s.providers)
  const linkedProviderIDs = useStore((s) => s.linkedProviderIDs)

  // Lets SettingsPanel open this panel even when it isn't the component that owns the
  // controlling `open` prop (ProviderPanel is currently mounted/controlled by Sidebar).
  const [eventOpen, setEventOpen] = useState(false)
  const visible = open || eventOpen

  useEffect(() => {
    function handler(): void {
      setEventOpen(true)
    }
    window.addEventListener(OPEN_PROVIDERS_EVENT, handler)
    return () => window.removeEventListener(OPEN_PROVIDERS_EVENT, handler)
  }, [])

  const handleClose = useCallback(() => {
    setEventOpen(false)
    onClose()
  }, [onClose])

  const [rows, setRows] = useState<KeyRow[]>([])
  const [loadingRows, setLoadingRows] = useState(false)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [savingID, setSavingID] = useState<string | null>(null)
  const [testingID, setTestingID] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({})

  const refreshRows = useCallback(async () => {
    setLoadingRows(true)
    try {
      const list = await window.api.keys.list()
      setRows(list)
    } finally {
      setLoadingRows(false)
    }
  }, [])

  useEffect(() => {
    if (visible) void refreshRows()
  }, [visible, refreshRows])

  const manageable = useMemo(() => {
    const map = new Map<string, { id: string; name: string; env: string[]; storeProvider?: Provider }>()
    for (const b of BUILTIN_PROVIDERS) {
      map.set(b.id, { id: b.id, name: b.name, env: [] })
    }
    for (const p of providers) {
      map.set(p.id, { id: p.id, name: p.name, env: p.env, storeProvider: p })
    }
    return [...map.values()].sort((a, b) => {
      const d = rankID(a.id) - rankID(b.id)
      return d !== 0 ? d : a.name.localeCompare(b.name)
    })
  }, [providers])

  const rowsByID = useMemo(() => {
    const m = new Map<string, KeyRow>()
    for (const r of rows) m.set(r.providerID, r)
    return m
  }, [rows])

  const handleSave = useCallback(
    async (providerID: string) => {
      const key = (keyInputs[providerID] ?? '').trim()
      if (!key) return
      setSavingID(providerID)
      try {
        await window.api.keys.set({ providerID, key })
        setKeyInputs((s) => {
          const next = { ...s }
          delete next[providerID]
          return next
        })
        setTestResults((s) => {
          const next = { ...s }
          delete next[providerID]
          return next
        })
        await refreshRows()
        setNeedsRestart(true)
      } catch (e) {
        setTestResults((s) => ({
          ...s,
          [providerID]: { ok: false, detail: e instanceof Error ? e.message : 'Failed to save key' }
        }))
      } finally {
        setSavingID(null)
      }
    },
    [keyInputs, refreshRows]
  )

  const handleRemove = useCallback(
    async (providerID: string) => {
      setTestResults((s) => {
        const next = { ...s }
        delete next[providerID]
        return next
      })
      try {
        await window.api.keys.remove(providerID)
      } finally {
        await refreshRows()
        setNeedsRestart(true)
      }
    },
    [refreshRows]
  )

  const handleTest = useCallback(async (providerID: string) => {
    setTestingID(providerID)
    try {
      const result = await window.api.keys.test(providerID)
      setTestResults((s) => ({ ...s, [providerID]: result }))
    } catch (e) {
      setTestResults((s) => ({
        ...s,
        [providerID]: { ok: false, detail: e instanceof Error ? e.message : 'Test failed' }
      }))
    } finally {
      setTestingID(null)
      window.setTimeout(() => {
        setTestResults((s) => {
          const next = { ...s }
          delete next[providerID]
          return next
        })
      }, 5000)
    }
  }, [])

  const handleRestart = useCallback(async () => {
    setRestarting(true)
    try {
      await window.api.restart()
      setNeedsRestart(false)
    } finally {
      setRestarting(false)
    }
  }, [])

  if (!visible) return null

  return (
    <div
      className="providers"
      role="dialog"
      aria-modal="true"
      aria-label="Provider keys"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose()
      }}
    >
      <div className="providers__panel">
        <div className="providers__head">
          <span className="providers__title">Provider Keys</span>
          <button type="button" className="providers__close" onClick={handleClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="providers__body">
          {needsRestart && (
            <div className="providers__key-restart-banner">
              <span>Changes require a restart to apply.</span>
              <button
                type="button"
                className="providers__key-restart-btn"
                onClick={() => void handleRestart()}
                disabled={restarting}
              >
                {restarting ? 'Restarting…' : 'Restart now'}
              </button>
            </div>
          )}

          <p className="providers__note providers__key-intro">
            Add a key for any provider below to use it right away — no terminal required. Keys are
            saved by OpenCode; this panel only ever shows the masked tail back.
          </p>

          <section>
            <h2 className="providers__group-title">
              Providers <span className="providers__count">{manageable.length}</span>
            </h2>
            <div className="providers__cards">
              {loadingRows && rows.length === 0 ? (
                <p className="providers__empty">Loading keys…</p>
              ) : (
                manageable.map((entry) => (
                  <ProviderKeyCard
                    key={entry.id}
                    id={entry.id}
                    name={entry.name}
                    env={entry.env}
                    storeProvider={entry.storeProvider}
                    linkedProviderIDs={linkedProviderIDs}
                    row={rowsByID.get(entry.id)}
                    keyValue={keyInputs[entry.id] ?? ''}
                    saving={savingID === entry.id}
                    testing={testingID === entry.id}
                    result={testResults[entry.id]}
                    onKeyChange={(value) =>
                      setKeyInputs((s) => ({ ...s, [entry.id]: value }))
                    }
                    onSave={() => void handleSave(entry.id)}
                    onRemove={() => void handleRemove(entry.id)}
                    onTest={() => void handleTest(entry.id)}
                  />
                ))
              )}
            </div>
          </section>

          <div className="providers__key-advanced">
            <button
              type="button"
              className="providers__key-advanced-toggle"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? '▾' : '▸'} Advanced: authenticate via terminal instead
            </button>
            {advancedOpen && (
              <div className="providers__key-advanced-body">
                <p className="providers__note">
                  Prefer OpenCode's own credential store? Run this in a terminal and pick a provider
                  from the prompt:
                </p>
                <CopyCommand text={AUTH_COMMAND} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
