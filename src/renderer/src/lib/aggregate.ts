/**
 * Session cost and context gauge computations — pure functions, no store dependency.
 */

import { isAssistant } from './types'
import type { MessageWithParts, Provider } from './types'

/** Total USD cost across all assistant messages in a session. */
export function sessionCost(messages: MessageWithParts[]): number {
  let total = 0
  for (const m of messages) {
    if (isAssistant(m.info) && typeof m.info.cost === 'number') {
      total += m.info.cost
    }
  }
  return total
}

/** Total input + output tokens of the most recent assistant message (approximate context used). */
export function contextUsed(messages: MessageWithParts[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (isAssistant(info) && info.tokens) {
      return info.tokens.input + info.tokens.output
    }
  }
  return 0
}

/** The model's context window limit in tokens. Returns 0 if not found. */
export function contextLimit(
  providers: Provider[],
  providerID: string | null,
  modelID: string | null
): number {
  if (!providerID || !modelID) return 0
  const provider = providers.find((p) => p.id === providerID)
  const model = provider?.models?.[modelID]
  return model?.limit?.context ?? 0
}
