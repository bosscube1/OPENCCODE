/**
 * Free-tier model registry — curated ranked list, identity predicate, sub-pools.
 *
 * Pure data module, no store/React imports.
 * Source: models.dev + provider docs, verified 2026-07-22.
 */

import type { ModelCapsMap } from './routing'

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

export type Tier = 'S' | 'A' | 'B' | 'C'

export type TaskKind = 'code' | 'title' | 'summary' | 'commit'

export interface FreeTierEntry {
  providerID: string
  modelID: string
  tier: Tier
  rpm: number
  rpd: number | null // null = opaque / unknown
  note: string
}

export const FREE_MODEL_TIERS: readonly FreeTierEntry[] = [
  // S-tier — best free agentic
  { providerID: 'google', modelID: 'gemini-3.6-flash', tier: 'S', rpm: 10, rpd: null, note: 'best free agentic; opaque daily cap' },
  { providerID: 'google', modelID: 'gemini-3.5-flash', tier: 'S', rpm: 10, rpd: null, note: 'strong; some accounts get 0 RPD immediately' },

  // A-tier — strong alternatives
  { providerID: 'groq', modelID: 'openai/gpt-oss-120b', tier: 'A', rpm: 30, rpd: 1000, note: '8K TPM bottleneck; no parallel tool calls' },
  { providerID: 'cerebras', modelID: 'gpt-oss-120b', tier: 'A', rpm: 5, rpd: null, note: 'only GA Cerebras free; card required' },
  { providerID: 'mistral', modelID: 'devstral-latest', tier: 'A', rpm: 60, rpd: null, note: 'purpose-built agentic coding' },
  { providerID: 'mistral', modelID: 'mistral-medium-latest', tier: 'A', rpm: 60, rpd: null, note: 'frontier general/agentic' },

  // B-tier — stable fallbacks
  { providerID: 'groq', modelID: 'llama-3.3-70b-versatile', tier: 'B', rpm: 30, rpd: 1000, note: '12K TPM, parallel tools' },
  { providerID: 'google', modelID: 'gemini-2.5-flash', tier: 'B', rpm: 10, rpd: null, note: 'stable fallback' },
  { providerID: 'mistral', modelID: 'ministral-8b-latest', tier: 'B', rpm: 60, rpd: null, note: 'routine steps' },

  // C-tier — subtasks / chores only
  { providerID: 'groq', modelID: 'llama-3.1-8b-instant', tier: 'C', rpm: 30, rpd: 14400, note: 'subtasks only' },
  { providerID: 'openrouter', modelID: 'nvidia/nemotron-nano-9b-v2:free', tier: 'C', rpm: 20, rpd: 50, note: 'RPD scales with lifetime credit' },
  { providerID: 'cohere', modelID: 'command-r7b-12-2024', tier: 'C', rpm: 20, rpd: 33, note: 'trial only' },
] as const

// ---------------------------------------------------------------------------
// Free-model identity predicate
// ---------------------------------------------------------------------------

type FreeVerdict = 'quota' | 'zero-price' | 'subscription' | 'never'

const QUOTA_PROVIDERS = new Set(['google', 'groq', 'cerebras', 'mistral', 'cohere'])
const ZERO_PRICE_PROVIDERS = new Set(['openrouter', 'huggingface'])

/**
 * Providers whose ENTIRE exposed catalogue is covered by a flat-rate subscription the user already
 * pays for — free at the point of use, so they belong in the default (non-"show paid") picker and
 * are safe failover targets.
 *
 * `nanogpt` qualifies only because of how main constructs it: `nanogptConfig.ts` builds the
 * provider with `baseURL` pinned to `/api/subscription/v1` and populates `models` solely from
 * `/api/subscription/v1/models`. Both the catalogue and the billing path are subscription-scoped,
 * so no model reachable under `nanogpt/` can bill per token. Do NOT add a provider here unless
 * that same property holds — a provider with a mixed paid catalogue must not be listed.
 */
const SUBSCRIPTION_PROVIDERS = new Set(['nanogpt'])

/** True when the provider's whole catalogue is covered by a flat-rate subscription. */
export function isSubscriptionProvider(providerID: string): boolean {
  return SUBSCRIPTION_PROVIDERS.has(providerID)
}
const NEVER_FREE_PROVIDERS = new Set([
  'openai', 'anthropic', 'xai', 'deepseek', 'together', 'fireworks', 'nvidia', 'opencode',
])

const FREE_MODEL_IDS = new Set(
  FREE_MODEL_TIERS.map((e) => `${e.providerID}/${e.modelID}`)
)

/**
 * Providers whose free plans expose more models than our small, hand-ranked
 * registry.  The registry decides the default order; these matchers keep a
 * newly-added live model from disappearing from the free picker or failover
 * pool before the next desktop release.
 *
 * This deliberately does not treat every model from every provider as free.
 * A provider with a paid catalogue still needs an explicit, conservative
 * family match or a `:free` model ID.
 */
const LIVE_FREE_MODEL_FAMILIES: Readonly<Record<string, RegExp>> = {
  groq: /^(?:llama-|meta-llama\/llama-|qwen\/qwen|openai\/gpt-oss-(?!safeguard))/i,
  google: /^gemini-(?:\d+(?:\.\d+)?-)?flash(?:-lite)?(?:-|$)/i,
  cerebras: /^(?:gpt-oss|qwen|llama|zai\/glm)/i,
  mistral: /^(?:devstral|ministral)/i,
  cohere: /^command-r/i,
}

/**
 * Three-valued free check. Rejects the broken `cost==0` predicate — SDK
 * `Model.cost` defaults to 0 for unknowns, false-positiving image/auto-router
 * models, while every real free model has a nonzero list price with a $0 quota.
 *
 * @param providerID  e.g. "google"
 * @param modelID     e.g. "gemini-3.6-flash"
 * @param modelCost   optional { input: number; output: number } from SDK Model
 */
export function isFreeModel(
  providerID: string,
  modelID: string,
  modelCost?: { input: number; output: number } | null,
): boolean {
  const verdict = classifyProvider(providerID)

  switch (verdict) {
    case 'quota':
      return (
        FREE_MODEL_IDS.has(`${providerID}/${modelID}`) ||
        LIVE_FREE_MODEL_FAMILIES[providerID]?.test(modelID) === true
      )

    case 'zero-price':
      if (modelCost && modelCost.input === 0 && modelCost.output === 0) return true
      return modelID.endsWith(':free') || FREE_MODEL_IDS.has(`${providerID}/${modelID}`)

    case 'subscription':
      // Every model in the exposed catalogue is subscription-covered — see SUBSCRIPTION_PROVIDERS.
      // Deliberately not gated on modelID: the catalogue is fetched live and changes without a
      // desktop release, so an allowlist here would hide new subscription models.
      return true

    case 'never':
      return false
  }
}

function classifyProvider(providerID: string): FreeVerdict {
  if (SUBSCRIPTION_PROVIDERS.has(providerID)) return 'subscription'
  if (QUOTA_PROVIDERS.has(providerID)) return 'quota'
  if (ZERO_PRICE_PROVIDERS.has(providerID)) return 'zero-price'
  if (NEVER_FREE_PROVIDERS.has(providerID)) return 'never'
  return 'never' // fail closed
}

// ---------------------------------------------------------------------------
// Sub-pools by task kind
// ---------------------------------------------------------------------------

const CODE_TIERS: ReadonlySet<Tier> = new Set<Tier>(['S', 'A'])
const CHORE_TIERS: ReadonlySet<Tier> = new Set<Tier>(['C', 'B'])

/**
 * Return the subset of FREE_MODEL_TIERS appropriate for a given task kind.
 * 'code' → S+A tiers (best models for agentic work).
 * 'title'/'summary'/'commit' → C+B tiers (save good models' quota for code).
 */
export function poolForTask(task: TaskKind): readonly FreeTierEntry[] {
  const tiers = task === 'code' ? CODE_TIERS : CHORE_TIERS
  return FREE_MODEL_TIERS.filter((e) => tiers.has(e.tier))
}

// ---------------------------------------------------------------------------
// Provider caps — authoritative seed for the ledger, replaces routing.ts values
// ---------------------------------------------------------------------------

export const FREE_PROVIDER_CAPS: ModelCapsMap = {
  // GUESS: NanoGPT publishes no per-minute/per-day request limits. 60 rpm is a deliberately
  // conservative placeholder so the ledger has something to throttle against; tune from observed
  // 429s. Subscription quota is enforced server-side and surfaced separately via nanogpt.usage().
  nanogpt: { rpm: 60 },
  groq: { rpm: 30, rpd: 1000 },
  google: { rpm: 10 },
  cerebras: { rpm: 5 },
  mistral: { rpm: 60 },
  cohere: { rpm: 20, rpd: 33 },
  openrouter: { rpm: 20, rpd: 50 },
}

// ---------------------------------------------------------------------------
// Derived lists (consumed by rotation.ts replacements)
// ---------------------------------------------------------------------------

/** Preferred models for auto-pick, S-tier first then A-tier. */
export const FREE_PREFERRED_MODELS: ReadonlyArray<{ providerID: string; modelID: string }> =
  FREE_MODEL_TIERS
    .filter((e) => e.tier === 'S' || e.tier === 'A')
    .map(({ providerID, modelID }) => ({ providerID, modelID }))

/**
 * Provider priority order for fallback scanning. `nanogpt` leads: a paid flat-rate subscription is
 * materially more reliable than a free quota tier, so it is the best first failover target.
 */
export const FREE_FALLBACK_PROVIDER_ORDER: readonly string[] = [
  'nanogpt', 'google', 'groq', 'cerebras', 'mistral', 'cohere', 'openrouter',
]

// ---------------------------------------------------------------------------
// Coding-quality scores anchored to tiers (replaces regex guesswork)
// ---------------------------------------------------------------------------

/**
 * Deterministic coding-quality score for a known free model.
 * Returns null for unknown models (caller should fall back to regex scoring).
 */
export function freeCodingQuality(providerID: string, modelID: string): number | null {
  const key = `${providerID}/${modelID}`
  const entry = FREE_MODEL_TIERS.find((e) => `${e.providerID}/${e.modelID}` === key)
  if (!entry) return null
  const tierScore: Record<Tier, number> = { S: 5, A: 4, B: 3, C: 2 }
  return tierScore[entry.tier]
}
