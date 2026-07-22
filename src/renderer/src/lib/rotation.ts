/**
 * Model auto-selection and free-tier rotation — extracted from store.ts.
 */

import { isAgentModel } from './models'
import type { Model, Provider } from './types'

/** Exact provider/model pairs verified working end-to-end. Keep IDs verbatim. */
export const PREFERRED_MODELS: ReadonlyArray<{ providerID: string; modelID: string }> = [
  { providerID: 'google', modelID: 'gemini-3.6-flash' },
  { providerID: 'google', modelID: 'gemini-3.5-flash' },
  { providerID: 'google', modelID: 'gemini-2.5-flash' },
  { providerID: 'cerebras', modelID: 'gpt-oss-120b' },
  { providerID: 'mistral', modelID: 'ministral-8b-latest' },
  { providerID: 'cohere', modelID: 'command-r-08-2024' },
  { providerID: 'openrouter', modelID: 'nvidia/nemotron-nano-9b-v2:free' }
]

/** Provider priority for the fallback scan when none of the preferred pairs are available. */
export const FALLBACK_PROVIDER_ORDER = ['google', 'cerebras', 'mistral', 'cohere', 'openrouter', 'groq']

export const FREE_ROUTING_CANDIDATES: ReadonlyArray<{ providerID: string; modelID: string }> = [
  { providerID: 'google', modelID: 'gemini-2.5-flash' },
  { providerID: 'google', modelID: 'gemini-3.6-flash' },
  { providerID: 'groq', modelID: 'llama-3.3-70b-versatile' },
  { providerID: 'groq', modelID: 'openai/gpt-oss-120b' },
  { providerID: 'cerebras', modelID: 'gpt-oss-120b' },
  { providerID: 'openrouter', modelID: 'nvidia/nemotron-nano-9b-v2:free' },
  { providerID: 'openrouter', modelID: 'qwen/qwen3-coder:free' },
  { providerID: 'mistral', modelID: 'ministral-8b-latest' },
  { providerID: 'cohere', modelID: 'command-r-08-2024' }
]

export function isRateLimitError(errStr: string): boolean {
  const lower = errStr.toLowerCase()
  return (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('ratelimit') ||
    lower.includes('quota') ||
    lower.includes('resource_exhausted') ||
    lower.includes('too many requests') ||
    lower.includes('overloaded') ||
    lower.includes('capacity')
  )
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function pickDefaultModel(providers: Provider[]): { providerID: string; modelID: string } | null {
  const byId = new Map(providers.map((p) => [p.id, p]))

  for (const { providerID, modelID } of PREFERRED_MODELS) {
    const model = byId.get(providerID)?.models?.[modelID]
    if (model && isAgentModel(model)) return { providerID, modelID }
  }

  for (const providerID of FALLBACK_PROVIDER_ORDER) {
    const provider = byId.get(providerID)
    if (!provider) continue
    const candidates = Object.values(provider.models ?? {})
      .filter(isAgentModel)
      .sort((a: Model, b: Model) => compareIds(a.id, b.id))
    if (candidates.length > 0) return { providerID, modelID: candidates[0].id }
  }

  return null
}

/** True only when the restored provider/model still exists AND still passes `isAgentModel`. */
export function restoredSelectionValid(
  providers: Provider[],
  providerID: string | null,
  modelID: string | null
): boolean {
  if (!providerID || !modelID) return false
  const provider = providers.find((p) => p.id === providerID)
  const model = provider?.models?.[modelID]
  return Boolean(model && isAgentModel(model))
}
