import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Model, Provider } from '@opencode-ai/sdk'
import { useStore } from '../lib/store'
import { isAgentModel } from '../lib/models'
import { isFreeModel, isSubscriptionProvider } from '../lib/freeTier'
import { isAutoRoutingActive } from '../lib/routing'
import { getLedger } from '../lib/slices/attemptMachine'

/** Dispatched by App.tsx on Ctrl+K. */
const FOCUS_MODEL_EVENT = 'opencode-desktop:focus-model'

/**
 * Providers that cost the user nothing extra per request surface first, in this order.
 * `nanogpt` leads: a flat-rate subscription is the most reliable of the group. Anything unknown
 * sorts alphabetically after them; anthropic always sinks to the bottom.
 */
const FREE_FIRST = ['nanogpt', 'groq', 'google', 'openrouter', 'cerebras', 'mistral'] as const
const FREE_SET = new Set<string>(FREE_FIRST)

function providerRank(id: string): number {
  const i = FREE_FIRST.indexOf(id as (typeof FREE_FIRST)[number])
  if (i !== -1) return i
  if (id === 'anthropic') return 1000
  return 100
}

function formatContext(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/**
 * Whole-turn latency at or above which a model is flagged as slow rather than merely
 * measured. Picked off observed data: free/subscription chat models land under ~10s,
 * while `:thinking` and reasoning-heavy relays run 60-90s. 30s sits in the empty gap
 * between the two clusters.
 */
const SLOW_TURN_MS = 30_000

/**
 * The ledger stores whole-turn latency (send → `session.idle`), so this includes tool
 * round-trips, not just token generation. Rounded coarsely on purpose — it is a triage
 * signal for "which of these is going to make me wait", not a benchmark.
 */
function formatLatency(ms: number): string {
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = ms / 60_000
  return `${minutes >= 10 ? Math.round(minutes) : Math.round(minutes * 10) / 10}m`
}

/** Label shown beside a provider group header, or null for providers that bill per request. */
type GroupBadge = 'subscription' | 'free tier' | null
type Group = { provider: Provider; badge: GroupBadge; models: Model[] }
type Flat = { providerID: string; modelID: string }

function groupBadge(providerID: string): GroupBadge {
  if (isSubscriptionProvider(providerID)) return 'subscription'
  return FREE_SET.has(providerID) ? 'free tier' : null
}

export function ModelPicker({ compact = false }: { compact?: boolean } = {}): JSX.Element {
  const providers = useStore((s) => s.providers)
  const providerID = useStore((s) => s.providerID)
  const modelID = useStore((s) => s.modelID)
  const setModel = useStore((s) => s.setModel)
  // Derived from routingMode, never a separate flag — the badge must not be able to claim
  // auto-routing is on while `locked` suppresses every failover.
  const autoRotate = useStore((s) => isAutoRoutingActive(s.routingMode))
  const toggleAutoRotate = useStore((s) => s.toggleAutoRotate)
  const showPaidModels = useStore((s) => s.showPaidModels)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [showAll, setShowAll] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const groups: Group[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...providers].sort((a, b) => {
      const d = providerRank(a.id) - providerRank(b.id)
      return d !== 0 ? d : a.name.localeCompare(b.name)
    })

    const out: Group[] = []
    for (const p of sorted) {
      const providerHit =
        q.length === 0 || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
      const models = Object.values(p.models)
        .filter((m) => showAll || isAgentModel(m))
        .filter((m) => showPaidModels || isFreeModel(p.id, m.id))
        .filter(
          (m) => providerHit || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
        )
        .sort((a, b) => {
          const ad = a.status === 'deprecated' ? 1 : 0
          const bd = b.status === 'deprecated' ? 1 : 0
          return ad !== bd ? ad - bd : a.name.localeCompare(b.name)
        })
      if (models.length > 0) out.push({ provider: p, badge: groupBadge(p.id), models })
    }
    return out
  }, [providers, query, showAll, showPaidModels])

  const flat: Flat[] = useMemo(
    () => groups.flatMap((g) => g.models.map((m) => ({ providerID: g.provider.id, modelID: m.id }))),
    [groups]
  )

  /**
   * Snapshot of measured latency per model key, taken when the picker opens.
   *
   * The ledger is a module singleton outside React, so it cannot be subscribed to — but it
   * only changes when a turn completes, and no turn can complete between opening this
   * dropdown and choosing from it. Re-reading on each open is therefore always current.
   */
  const latencyByKey = useMemo(() => {
    if (!open) return {} as Record<string, number>
    const out: Record<string, number> = {}
    for (const [key, health] of Object.entries(getLedger())) {
      if (typeof health.latencyEwma === 'number' && health.latencyEwma > 0) {
        out[key] = health.latencyEwma
      }
    }
    return out
  }, [open])

  const current = useMemo(() => {
    if (!providerID || !modelID) return null
    const p = providers.find((x) => x.id === providerID)
    if (!p) return { providerName: providerID, modelName: modelID }
    const m = p.models[modelID]
    return { providerName: p.name, modelName: m ? m.name : modelID }
  }, [providers, providerID, modelID])

  /* ---- open / close ----------------------------------------------------- */
  const openPicker = useCallback(() => {
    setOpen(true)
    setQuery('')
    const idx = flat.findIndex((f) => f.providerID === providerID && f.modelID === modelID)
    setCursor(idx >= 0 ? idx : 0)
  }, [flat, providerID, modelID])

  const closePicker = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  useEffect(() => {
    const focus = (): void => {
      openPicker()
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
    window.addEventListener(FOCUS_MODEL_EVENT, focus)
    return () => window.removeEventListener(FOCUS_MODEL_EVENT, focus)
  }, [openPicker])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const el = rootRef.current
      if (el && e.target instanceof Node && !el.contains(e.target)) closePicker()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, closePicker])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const prevFlatRef = useRef(flat)
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  useEffect(() => {
    const prev = prevFlatRef.current
    prevFlatRef.current = flat
    if (flat.length === 0) {
      setCursor(0)
      return
    }
    const currentCursor = cursorRef.current
    const old = prev[currentCursor >= 0 && currentCursor < prev.length ? currentCursor : 0]
    if (old) {
      setCursor((c) => {
        const next = flat.findIndex(
          (f) => f.providerID === old.providerID && f.modelID === old.modelID
        )
        return next >= 0 ? next : Math.min(c, flat.length - 1)
      })
    } else {
      setCursor((c) => Math.min(c, flat.length - 1))
    }
  }, [flat])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const choose = useCallback(
    (pid: string, mid: string) => {
      setModel(pid, mid)
      closePicker()
    },
    [setModel, closePicker]
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closePicker()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (flat.length > 0) setCursor((c) => (c + 1) % flat.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (flat.length > 0) setCursor((c) => (c - 1 + flat.length) % flat.length)
      } else if (e.key === 'Home') {
        e.preventDefault()
        setCursor(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        setCursor(Math.max(0, flat.length - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const pick = flat[cursor]
        if (pick) choose(pick.providerID, pick.modelID)
      }
    },
    [flat, cursor, choose, closePicker]
  )

  let index = -1

  return (
    <div className={compact ? 'modelpicker modelpicker--compact' : 'modelpicker'} ref={rootRef}>
      <button
        type="button"
        className={compact ? 'modelpicker__trigger modelpicker__trigger--compact' : 'modelpicker__trigger'}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? `${current.providerName} · ${current.modelName} (Ctrl+K)` : 'Pick a model (Ctrl+K)'}
        onClick={() => (open ? closePicker() : openPicker())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            openPicker()
          }
        }}
      >
        {compact ? (
          <span className="modelpicker__trigger-text modelpicker__trigger-text--compact">
            {current ? (
              <span className="modelpicker__value">
                {current.modelName}
                {autoRotate && <span className="modelpicker__badge" style={{ marginLeft: '6px', fontSize: '10px' }} title="Smart Auto-Routing Enabled">⚡ auto</span>}
              </span>
            ) : (
              <span className="modelpicker__value modelpicker__value--empty">Select a model…</span>
            )}
          </span>
        ) : (
          <span className="modelpicker__trigger-text">
            <span className="modelpicker__label">Model</span>
            {current ? (
              <span className="modelpicker__value">
                {current.modelName} <span className="modelpicker__ctx">· {current.providerName}</span>
                {autoRotate && <span className="modelpicker__badge" style={{ marginLeft: '6px', fontSize: '10px' }} title="Smart Auto-Routing Enabled">⚡ auto</span>}
              </span>
            ) : (
              <span className="modelpicker__value modelpicker__value--empty">Select a model…</span>
            )}
          </span>
        )}
        <span className="modelpicker__chev" aria-hidden="true">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className={compact ? 'modelpicker__pop modelpicker__pop--up' : 'modelpicker__pop'} onKeyDown={onKeyDown}>
          <input
            ref={inputRef}
            className="modelpicker__search"
            type="text"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search provider or model…"
            aria-label="Search models"
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
          />

          <div className="modelpicker__list" role="listbox" ref={listRef}>
            {groups.length === 0 && (
              <div className="modelpicker__empty">
                {providers.length === 0
                  ? 'No providers configured. Open Providers to connect one.'
                  : !showPaidModels && query.length === 0
                    ? 'No free model available — add a NanoGPT / Google / Groq / Mistral key in Settings, or enable "Show paid models".'
                    : `No model matches “${query}”.`}
              </div>
            )}

            {groups.map((g) => (
              <div className="modelpicker__group" key={g.provider.id}>
                <div className="modelpicker__group-head">
                  <span>{g.provider.name}</span>
                  {g.badge !== null && <span className="modelpicker__free">{g.badge}</span>}
                </div>
                {g.models.map((m) => {
                  index += 1
                  const idx = index
                  const selected = g.provider.id === providerID && m.id === modelID
                  const ctx = formatContext(m.limit.context)
                  const latency = latencyByKey[`${g.provider.id}/${m.id}`]
                  const cls = [
                    'modelpicker__opt',
                    idx === cursor ? 'modelpicker__opt--active' : '',
                    selected ? 'modelpicker__opt--selected' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <button
                      type="button"
                      key={`${g.provider.id}/${m.id}`}
                      className={cls}
                      data-idx={idx}
                      role="option"
                      aria-selected={selected}
                      title={`${g.provider.id}/${m.id}`}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => choose(g.provider.id, m.id)}
                    >
                      <span className="modelpicker__opt-main">
                        <span className="modelpicker__opt-name">{m.name}</span>
                        <span className="modelpicker__badges">
                          {latency !== undefined && (
                            <span
                              className={
                                latency >= SLOW_TURN_MS
                                  ? 'modelpicker__badge modelpicker__badge--warn'
                                  : 'modelpicker__badge'
                              }
                              title={`Average whole-turn time measured on this machine: ${Math.round(latency / 1000)}s (includes tool calls).`}
                            >
                              ~{formatLatency(latency)}
                            </span>
                          )}
                          {m.capabilities.reasoning && (
                            <span className="modelpicker__badge">reasoning</span>
                          )}
                          {m.capabilities.toolcall && <span className="modelpicker__badge">tools</span>}
                          {m.capabilities.input.image && (
                            <span className="modelpicker__badge">vision</span>
                          )}
                          {m.status === 'deprecated' && (
                            <span className="modelpicker__badge modelpicker__badge--warn">
                              deprecated
                            </span>
                          )}
                          {(m.status === 'alpha' || m.status === 'beta') && (
                            <span className="modelpicker__badge">{m.status}</span>
                          )}
                          {!isAgentModel(m) && (
                            <span className="modelpicker__badge modelpicker__badge--warn">
                              non-chat
                            </span>
                          )}
                        </span>
                      </span>
                      {ctx && <span className="modelpicker__ctx">{ctx}</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>

          <div className="modelpicker__footer">
            <label className="modelpicker__toggle">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              Show all models
            </label>
            <label className="modelpicker__toggle modelpicker__toggle--autorotate" title="Automatically cycle free models when 429 rate limit errors occur">
              <input
                type="checkbox"
                checked={autoRotate}
                onChange={() => toggleAutoRotate()}
              />
              ⚡ Auto-Rotate (Free Models)
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
