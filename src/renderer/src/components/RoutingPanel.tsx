import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../lib/store'
import { loadLedger, capsFor, rpdWindowStart, type Ledger, type ModelHealth } from '../lib/routing'
import { FREE_MODEL_TIERS, FREE_PROVIDER_CAPS, OPAQUE_RPM_PROVIDERS } from '../lib/freeTier'

function formatSecondsAgo(then: number, now: number): string {
  const secs = Math.round((now - then) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  return `${Math.round(secs / 3600)}h ago`
}

function cooldownRemaining(h: ModelHealth, now: number): number {
  return Math.max(0, h.cooldownUntil - now)
}

export function RoutingPanel(): JSX.Element {
  const providers = useStore((s) => s.providers)
  const linkedProviderIDs = useStore((s) => s.linkedProviderIDs)
  const [ledger, setLedger] = useState<Ledger>(() => loadLedger())
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const tick = setInterval(() => {
      setLedger(loadLedger())
      setNow(Date.now())
    }, 2000)
    return () => clearInterval(tick)
  }, [])

  const linked = new Set(linkedProviderIDs)
  const rows = FREE_MODEL_TIERS.filter((e) => linked.has(e.providerID))

  if (rows.length === 0) {
    return (
      <div style={{ fontSize: '11.5px', color: 'var(--fg-dim)', padding: '10px 0' }}>
        No linked free-model providers. Add a Google, Groq, Mistral, Cohere, Cerebras, or OpenRouter key
        under Provider Keys to see per-model health here.
      </div>
    )
  }

  // Counted exactly the way the router counts, so this panel and the throttle can
  // never disagree: the scope and the daily window both come from capsFor.
  const usage = new Map<string, { used: number; cap: number | null }>()
  for (const e of rows) {
    const key = `${e.providerID}/${e.modelID}`
    const resolved = capsFor(FREE_PROVIDER_CAPS, key)
    const cap = resolved?.caps.rpd ?? null
    const windowStart = rpdWindowStart(now, resolved?.caps.rpdWindow)
    const sends =
      resolved?.scope === 'provider'
        ? Object.entries(ledger)
            .filter(([k]) => k.startsWith(`${e.providerID}/`))
            .flatMap(([, h]) => h.sends)
        : (ledger[key]?.sends ?? [])
    usage.set(key, { used: sends.filter((t) => t >= windowStart).length, cap })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {rows.map((e) => {
        const key = `${e.providerID}/${e.modelID}`
        const health = ledger[key]
        const provider = providers.find((p) => p.id === e.providerID)
        const modelObj = provider?.models?.[e.modelID]
        const label = provider ? `${provider.name} · ${modelObj?.name ?? e.modelID}` : key
        const total = (health?.success ?? 0) + (health?.error ?? 0)
        const successRatio = total > 0 ? Math.round((health!.success / total) * 100) : null
        const latency = health?.latencyEwma !== undefined && health?.latencyEwma !== null
          ? Math.round(health.latencyEwma)
          : null
        const cooldown = health ? cooldownRemaining(health, now) : 0
        const modelUsage = usage.get(key) ?? { used: 0, cap: null }
        const rpdTodayProvider = modelUsage.used
        const rpdCap = modelUsage.cap ?? e.rpd ?? null

        return (
          <div key={key} style={{
            padding: '6px 8px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            fontSize: '11.5px',
            background: cooldown > 0 ? 'rgba(180, 83, 9, 0.06)' : 'transparent',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span style={{ fontWeight: 500 }}>
                <span style={{
                  display: 'inline-block',
                  padding: '1px 5px',
                  fontSize: '10px',
                  background: 'var(--border)',
                  borderRadius: '3px',
                  marginRight: '6px',
                }}>{e.tier}</span>
                {label}
              </span>
              <span style={{ color: 'var(--fg-dim)', fontSize: '10.5px' }}>
                {rpdCap ? `${rpdTodayProvider}/${rpdCap}` : `${rpdTodayProvider} today`}
                {' · '}
                {OPAQUE_RPM_PROVIDERS.has(e.providerID) ? 'rpm unpublished' : `${e.rpm} rpm`}
              </span>
            </div>

            <div style={{ marginTop: '3px', display: 'flex', gap: '10px', color: 'var(--fg-dim)', fontSize: '10.5px' }}>
              <span title="Successful requests">✓ {health?.success ?? 0}</span>
              <span title="Failed requests">✗ {health?.error ?? 0}</span>
              {successRatio !== null && <span>{successRatio}% ok</span>}
              {latency !== null && <span>{latency}ms avg</span>}
              {health?.last429 !== null && health?.last429 !== undefined && (
                <span>last 429: {formatSecondsAgo(health.last429, now)}</span>
              )}
              {cooldown > 0 && (
                <span style={{ color: 'var(--warn, #b45309)', fontWeight: 500 }}>
                  cooling {Math.round(cooldown / 1000)}s
                </span>
              )}
            </div>
          </div>
        )
      })}
      <p style={{ fontSize: '10.5px', color: 'var(--fg-dim)', marginTop: '4px' }}>
        RPD counters aggregate all models per provider (auto-refreshes every 2s).
      </p>
    </div>
  )
}
