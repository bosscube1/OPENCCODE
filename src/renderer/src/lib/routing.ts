/**
 * Smart routing v2 — proactive health-ledger router for model selection.
 *
 * Pure module, no store import, no React.
 */

export type ModelKey = string // format "providerID/modelID"

/**
 * Split a model key on its first slash only. Model IDs may themselves contain
 * slashes (for example, `openrouter/qwen/qwen3-coder:free`).
 */
export function parseModelKey(key: ModelKey): { providerID: string; modelID: string } | null {
  const separator = key.indexOf('/')
  if (separator <= 0 || separator === key.length - 1) return null
  return { providerID: key.slice(0, separator), modelID: key.slice(separator + 1) }
}

export type ModelHealth = {
  cooldownUntil: number
  cooldownMs: number
  success: number
  error: number
  last429: number | null
  latencyEwma: number | null
  sends: number[] // epoch-ms timestamps, pruned to last 24h
}

export type Ledger = Record<ModelKey, ModelHealth>

export type ProviderCaps = { rpm?: number; rpd?: number }
export type ModelCapsMap = Record<string, ProviderCaps>

export const LEDGER_STORAGE_KEY = 'opencode-desktop:routing-ledger'

/**
 * Conservative estimates for free-tier per-provider rate caps.
 * Documented as non-authoritative fallback bounds.
 */
export const DEFAULT_PROVIDER_CAPS: ModelCapsMap = {
  groq: { rpm: 30 },
  google: { rpm: 10, rpd: 250 },
  cerebras: { rpm: 30 },
  mistral: { rpm: 5, rpd: 50 },
  cohere: { rpm: 10, rpd: 100 },
  openrouter: { rpm: 20, rpd: 200 }
}

const DEFAULT_HEALTH: ModelHealth = {
  cooldownUntil: 0,
  cooldownMs: 30000,
  success: 0,
  error: 0,
  last429: null,
  latencyEwma: null,
  sends: []
}

/**
 * Record a 429 rate-limit error.
 * Implements exponential cooldown starting at 30s, doubling per consecutive 429, capped at 30 minutes.
 */
export function record429(ledger: Ledger, key: ModelKey, now: number): Ledger {
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  const isConsecutive = existing.cooldownUntil > now || (existing.last429 !== null && now - existing.last429 <= existing.cooldownMs + 60000)
  const newCooldownMs = isConsecutive ? Math.min(1800000, existing.cooldownMs * 2) : 30000

  return {
    ...ledger,
    [key]: {
      ...existing,
      cooldownUntil: now + newCooldownMs,
      cooldownMs: newCooldownMs,
      last429: now
    }
  }
}

/**
 * Reserve an outbound attempt before it is sent. Rate caps count attempts,
 * including calls that fail or never complete.
 */
export function reserveAttempt(ledger: Ledger, key: ModelKey, now: number): Ledger {
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  const sends = existing.sends.filter((t) => now - t <= 86400000)
  sends.push(now)

  return {
    ...ledger,
    [key]: {
      ...existing,
      sends
    }
  }
}

/**
 * Record a successful request completion. Attempts must be reserved with
 * `reserveAttempt` before dispatch so completion timing cannot bypass caps.
 */
export function recordSuccess(ledger: Ledger, key: ModelKey, latencyMs: number, _now: number): Ledger {
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  const newCooldownMs = Math.max(30000, Math.floor(existing.cooldownMs / 2))
  const newEwma = existing.latencyEwma === null ? latencyMs : 0.3 * latencyMs + 0.7 * existing.latencyEwma

  return {
    ...ledger,
    [key]: {
      ...existing,
      cooldownUntil: 0,
      cooldownMs: newCooldownMs,
      success: existing.success + 1,
      latencyEwma: newEwma
    }
  }
}

/**
 * Record a non-429 request failure.
 * Increments error count without modifying cooldowns.
 */
export function recordFailure(ledger: Ledger, key: ModelKey, _now: number): Ledger {
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  return {
    ...ledger,
    [key]: {
      ...existing,
      error: existing.error + 1
    }
  }
}

/**
 * Check if a model is under conservative rate caps (RPM / RPD).
 */
export function underRateCaps(ledger: Ledger, key: ModelKey, caps: ModelCapsMap, now: number): boolean {
  const parsed = parseModelKey(key)
  if (!parsed) return false
  const { providerID } = parsed
  const cap = caps[providerID]
  if (!cap) return true

  const sends = Object.entries(ledger)
    .filter(([modelKey]) => parseModelKey(modelKey)?.providerID === providerID)
    .flatMap(([, health]) => health.sends)
  if (sends.length === 0) return true

  if (cap.rpm !== undefined) {
    const rpmSends = sends.filter((t) => now - t <= 60000).length
    if (rpmSends >= cap.rpm) return false
  }

  if (cap.rpd !== undefined) {
    const rpdSends = sends.filter((t) => now - t <= 86400000).length
    if (rpdSends >= cap.rpd) return false
  }

  return true
}

/**
 * Score and select the optimal model from a pool based on health ledger statistics.
 */
export function selectModel(
  pool: ModelKey[] | null,
  ledger: Ledger,
  caps: ModelCapsMap,
  now: number,
  opts: { sticky: boolean; current: ModelKey | null; available: ReadonlySet<ModelKey>; authenticatedProviders: ReadonlySet<string> }
): ModelKey | null {
  // A configured pool is a hard user constraint. Without one, only consider
  // server-available models from providers that are actually authenticated.
  const candidatePool = pool && pool.length > 0 ? pool : Array.from(opts.available)
  const isAuthenticatedCandidate = (key: ModelKey): boolean => {
    const parsed = parseModelKey(key)
    return Boolean(parsed && opts.authenticatedProviders.has(parsed.providerID))
  }

  // Sticky model preference: if sticky mode is enabled and current model is healthy, stay put.
  if (opts.sticky && opts.current && opts.available.has(opts.current) && isAuthenticatedCandidate(opts.current)) {
    const health = ledger[opts.current]
    const isOutofCooldown = !health || health.cooldownUntil <= now
    if (isOutofCooldown && underRateCaps(ledger, opts.current, caps, now)) {
      return opts.current
    }
  }

  // Filter healthy candidates available on server
  const healthyCandidates = candidatePool.filter((key) => {
    if (!opts.available.has(key) || !isAuthenticatedCandidate(key)) return false
    const health = ledger[key]
    const isOutofCooldown = !health || health.cooldownUntil <= now
    return isOutofCooldown && underRateCaps(ledger, key, caps, now)
  })

  if (healthyCandidates.length === 0) return null

  const scored = healthyCandidates.map((key, poolIndex) => {
    const h = ledger[key] ?? DEFAULT_HEALTH
    const total = h.success + h.error
    const successRatio = total > 0 ? h.success / total : 1.0
    const latencyPenalty = h.latencyEwma !== null ? Math.min(1.0, h.latencyEwma / 5000) : 0.0
    const recent429Penalty = h.last429 !== null ? Math.max(0, 1 - (now - h.last429) / 3600000) : 0.0

    // Health remains dominant; quality breaks close calls in favour of models
    // intended for coding. The model ID is the final stable tie-breaker.
    const healthScore = successRatio - latencyPenalty * 0.3 - recent429Penalty * 0.5
    const score = healthScore + codingQuality(key) * 0.2
    const deterministicRank = codingQuality(key)

    return { key, score, deterministicRank, poolIndex }
  })

  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-6) {
      return b.score - a.score // highest score first
    }
    if (a.deterministicRank !== b.deterministicRank) return b.deterministicRank - a.deterministicRank
    return a.key < b.key ? -1 : a.key > b.key ? 1 : a.poolIndex - b.poolIndex
  })

  return scored[0].key
}

/** Higher values indicate a stronger likely coding model, using provider/model IDs only. */
export function codingQuality(key: ModelKey): number {
  const parsed = parseModelKey(key)
  if (!parsed) return 0
  const id = `${parsed.providerID}/${parsed.modelID}`.toLowerCase()

  if (/(gpt-5\.[45]|codex)/.test(id)) return 6
  if (/(gpt-5|claude.*opus)/.test(id)) return 5
  if (/claude.*sonnet/.test(id)) return 4
  if (/(claude|gemini.*pro|deepseek.*(coder|reasoner))/.test(id)) return 4
  if (/(coder|gpt-oss|qwen3|gemini)/.test(id)) return 3
  if (/(deepseek|llama|mistral|command-r)/.test(id)) return 2
  return 1
}

function getLocalStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  if (typeof globalThis !== 'undefined' && (globalThis as unknown as { localStorage?: Storage }).localStorage) {
    return (globalThis as unknown as { localStorage: Storage }).localStorage
  }
  return null
}

/**
 * Load and prune routing ledger from localStorage.
 */
export function loadLedger(): Ledger {
  try {
    const storage = getLocalStorage()
    if (!storage) return {}
    const raw = storage.getItem(LEDGER_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Ledger
    const now = Date.now()
    const pruned: Ledger = {}

    for (const [key, health] of Object.entries(parsed)) {
      if (!health || typeof health !== 'object') continue
      const sends = Array.isArray(health.sends) ? health.sends.filter((t) => typeof t === 'number' && now - t <= 86400000) : []
      const cooldownUntil = typeof health.cooldownUntil === 'number' && health.cooldownUntil > now ? health.cooldownUntil : 0
      const success = typeof health.success === 'number' ? health.success : 0
      const error = typeof health.error === 'number' ? health.error : 0

      // Omit empty useless entries
      if (sends.length === 0 && success === 0 && error === 0 && cooldownUntil === 0) continue

      pruned[key] = {
        cooldownUntil,
        cooldownMs: typeof health.cooldownMs === 'number' ? health.cooldownMs : 30000,
        success,
        error,
        last429: typeof health.last429 === 'number' ? health.last429 : null,
        latencyEwma: typeof health.latencyEwma === 'number' ? health.latencyEwma : null,
        sends
      }
    }

    return pruned
  } catch {
    return {}
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Save routing ledger to localStorage with ~500ms debounce.
 */
export function saveLedger(ledger: Ledger): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const storage = getLocalStorage()
      if (storage) {
        storage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger))
      }
    } catch {
      // Storage write best-effort
    }
  }, 500)
}
