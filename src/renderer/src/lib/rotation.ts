/**
 * Model auto-selection, free-tier rotation, and error classification.
 *
 * Derived from the curated free-tier registry in freeTier.ts.
 */

import { isAgentModel } from './models'
import { isFreeModel, FREE_PREFERRED_MODELS, FREE_FALLBACK_PROVIDER_ORDER } from './freeTier'
import type { ErrorClass } from './attempts'
import type { Model, Provider } from './types'

// ---------------------------------------------------------------------------
// Preferred models / fallback order — derived from freeTier.ts
// ---------------------------------------------------------------------------

export const PREFERRED_MODELS: ReadonlyArray<{ providerID: string; modelID: string }> =
  FREE_PREFERRED_MODELS

export const FALLBACK_PROVIDER_ORDER: readonly string[] =
  FREE_FALLBACK_PROVIDER_ORDER

/** @deprecated Use classifyError instead. Kept for store.ts transition. */
export const FREE_ROUTING_CANDIDATES = PREFERRED_MODELS

// ---------------------------------------------------------------------------
// Error classification (replaces isRateLimitError)
// ---------------------------------------------------------------------------

/**
 * True when one request is larger than the account's tokens-per-minute limit.
 * Waiting cannot make that unchanged request fit, so failover should skip the
 * constrained provider rather than trying another model on the same account.
 */
export function isTokenThroughputLimit(errStr: string): boolean {
  const lower = errStr.toLowerCase()
  const mentionsTpm = lower.includes('tokens per minute') || /\btpm\b/.test(lower)
  const rejectsRequest = lower.includes('requested') || lower.includes('request too large')
  return mentionsTpm && lower.includes('limit') && rejectsRequest
}

/**
 * Structured error classifier. Replaces the old substring-matching
 * `isRateLimitError` with a typed classification.
 *
 * Classification rules:
 * - `rpm-wait`: 429 with short cooldown (or Retry-After ≤ 120s)
 * - `rpd-drop`: 429 with "per day"/"quota"/"RESOURCE_EXHAUSTED" + daily context
 * - `timeout`: request timed out (TTFT or stall)
 * - `transient`: 5xx, ECONNRESET, network errors
 * - `client`: 4xx (not 429), bad request, invalid key
 * - `server`: auth errors, missing key, provider config
 */
export function classifyError(
  errStr: string,
  opts?: { statusCode?: number; isRetryable?: boolean; retryAfterMs?: number },
): ErrorClass {
  const lower = errStr.toLowerCase()
  const status = opts?.statusCode

  // Explicit timeout
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('deadline exceeded')) {
    return 'timeout'
  }

  // A request larger than the account TPM allowance cannot succeed unchanged
  // on this provider. Route through the provider-drop failover path.
  if (isTokenThroughputLimit(errStr)) return 'rpd-drop'

  // Daily quota / resource exhaustion — these are always rpd-drop regardless
  // of whether "429" appears in the string
  if (
    lower.includes('resource_exhausted') ||
    lower.includes('quota') && (lower.includes('day') || lower.includes('exceeded') || lower.includes('reached') || lower.includes('exhausted'))
  ) {
    return 'rpd-drop'
  }

  // 429 / rate-limit detection — require actual rate-limit context, not just
  // generic "capacity" or "overloaded" which can be disk-full or build errors
  const is429 =
    status === 429 ||
    /\b429\b/.test(errStr) ||
    lower.includes('rate limit') ||
    lower.includes('ratelimit') ||
    lower.includes('too many requests')

  if (is429) {
    // Check if daily context is present
    if (lower.includes('per day') || lower.includes('per_day') || lower.includes('daily')) {
      return 'rpd-drop'
    }
    return 'rpm-wait'
  }

  // Transient server errors
  if (
    status !== undefined && status >= 500 ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('network') ||
    lower.includes('socket hang up') ||
    lower.includes('fetch failed') ||
    lower.includes('overloaded') ||
    lower.includes('capacity')
  ) {
    return 'transient'
  }

  // Auth / config errors
  if (
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('invalid api key') ||
    lower.includes('invalid_api_key') ||
    lower.includes('authentication') ||
    status === 401 ||
    status === 403
  ) {
    return 'server'
  }

  // Client errors (4xx not 429)
  if (status !== undefined && status >= 400 && status < 500) {
    return 'client'
  }

  // If the SDK says retryable, treat as transient
  if (opts?.isRetryable) return 'transient'

  // Default: non-retryable
  return 'client'
}

/**
 * @deprecated Use classifyError for new code. Kept for backward compatibility
 * during store.ts transition (Module 7).
 */
export function isRateLimitError(errStr: string): boolean {
  const cls = classifyError(errStr)
  return cls === 'rpm-wait' || cls === 'rpd-drop'
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Pick the best default model from linked providers.
 * Walks PREFERRED_MODELS (S→A tier from freeTier.ts), then falls back to
 * provider-order scan. Only considers free, agent-capable models.
 */
export function pickDefaultModel(providers: Provider[]): { providerID: string; modelID: string } | null {
  const byId = new Map(providers.map((p) => [p.id, p]))

  for (const { providerID, modelID } of PREFERRED_MODELS) {
    const model = byId.get(providerID)?.models?.[modelID]
    if (model && isAgentModel(model) && isFreeModel(providerID, modelID)) {
      return { providerID, modelID }
    }
  }

  for (const providerID of FALLBACK_PROVIDER_ORDER) {
    const provider = byId.get(providerID)
    if (!provider) continue
    const candidates = (Object.values(provider.models ?? {}) as Model[])
      .filter((m) => isAgentModel(m) && isFreeModel(providerID, m.id))
      .sort((a, b) => compareIds(a.id, b.id))
    if (candidates.length > 0) return { providerID, modelID: candidates[0].id }
  }

  return null
}

/**
 * True only when the restored provider/model still exists, passes
 * `isAgentModel`, AND is a free model (unless showPaidModels is on).
 */
export function restoredSelectionValid(
  providers: Provider[],
  providerID: string | null,
  modelID: string | null,
  showPaidModels?: boolean,
): boolean {
  if (!providerID || !modelID) return false
  const provider = providers.find((p) => p.id === providerID)
  const model = provider?.models?.[modelID]
  if (!model || !isAgentModel(model)) return false
  if (showPaidModels) return true
  return isFreeModel(providerID, modelID)
}
