import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { Provider } from '@opencode-ai/sdk'
import { useStore } from '../lib/store'

/** The one command that connects a provider. This app never touches credentials. */
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
  'opencode-zen': 'https://opencode.ai/docs/zen/',
  opencode: 'https://opencode.ai/docs/'
}

const FALLBACK_DOCS = 'https://opencode.ai/docs/providers/'

function docsUrl(p: Provider): string {
  return DOCS[p.id] ?? FALLBACK_DOCS
}

/**
 * A provider counts as connected when OpenCode reports a stored key, or when it
 * resolved the provider from the environment / config file (which is exactly how
 * OpenCode reports satisfied `env` vars — the renderer has no process access).
 */
function isConnected(p: Provider): boolean {
  if (typeof p.key === 'string' && p.key.length > 0) return true
  return p.source === 'env' || p.source === 'config'
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

function ProviderCard({ provider, connected }: { provider: Provider; connected: boolean }): JSX.Element {
  const modelCount = Object.keys(provider.models).length
  const free = FREE_TIER.has(provider.id)
  const url = docsUrl(provider)

  return (
    <div className={connected ? 'providers__card providers__card--on' : 'providers__card'}>
      <div className="providers__row">
        <button
          type="button"
          className="providers__name"
          title={`Open ${provider.name} docs — ${url}`}
          onClick={() => void window.api.openExternal(url)}
        >
          {provider.name} <span className="providers__ext">↗</span>
        </button>
        <span className="providers__tags">
          {free && <span className="providers__tag providers__tag--free">free tier</span>}
          {connected && <span className="providers__tag providers__tag--ok">connected</span>}
          <span className="providers__tag">{provider.source}</span>
        </span>
      </div>

      <div className="providers__meta">
        <span>
          {modelCount} model{modelCount === 1 ? '' : 's'}
        </span>
        <span className="providers__envvar">{provider.id}</span>
      </div>

      {!connected && (
        <>
          {provider.env.length > 0 && (
            <div className="providers__env">
              <span>Reads:</span>
              {provider.env.map((v) => (
                <span className="providers__envvar" key={v}>
                  {v}
                </span>
              ))}
            </div>
          )}
          <div className="providers__env">
            <span>Authenticate in a terminal:</span>
          </div>
          <CopyCommand text={AUTH_COMMAND} />
          <p className="providers__note">
            Pick <strong>{provider.name}</strong> in the prompt and paste your key there. OpenCode
            stores the credential itself — opencode-desktop never sees, holds, or writes it.
          </p>
        </>
      )}
    </div>
  )
}

export function ProviderPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const providers = useStore((s) => s.providers)

  const [connected, available] = useMemo(() => {
    const rank = (p: Provider): number => {
      if (FREE_TIER.has(p.id)) return 0
      if (p.id === 'anthropic') return 2
      return 1
    }
    const sorted = [...providers].sort((a, b) => {
      const d = rank(a) - rank(b)
      return d !== 0 ? d : a.name.localeCompare(b.name)
    })
    return [sorted.filter(isConnected), sorted.filter((p) => !isConnected(p))]
  }, [providers])

  if (!open) return null

  return (
    <div
      className="providers"
      role="dialog"
      aria-modal="true"
      aria-label="Model providers"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="providers__panel">
        <div className="providers__head">
          <span className="providers__title">Providers</span>
          <button type="button" className="providers__close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="providers__body">
          <section>
            <h2 className="providers__group-title">
              Connected <span className="providers__count">{connected.length}</span>
            </h2>
            <div className="providers__cards">
              {connected.length === 0 ? (
                <p className="providers__empty">
                  Nothing connected yet. Pick a free provider below and run{' '}
                  <code>{AUTH_COMMAND}</code>.
                </p>
              ) : (
                connected.map((p) => <ProviderCard key={p.id} provider={p} connected />)
              )}
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">
              Available <span className="providers__count">{available.length}</span>
            </h2>
            <div className="providers__cards">
              {available.length === 0 ? (
                <p className="providers__empty">Every known provider is connected.</p>
              ) : (
                available.map((p) => <ProviderCard key={p.id} provider={p} connected={false} />)
              )}
            </div>
          </section>

          <p className="providers__foot">
            opencode-desktop deliberately has no place to type an API key. Credentials live wherever
            OpenCode keeps them — environment variables, your shell profile, or the auth store
            written by <code>{AUTH_COMMAND}</code>. Restart opencode-desktop after connecting a
            provider so its models show up here.
          </p>
        </div>
      </div>
    </div>
  )
}
