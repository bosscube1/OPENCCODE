/**
 * Shared model-selection helpers.
 *
 * Used by both `store.ts` (default-model picking) and `ModelPicker.tsx`
 * (list filtering). Lives here — not in either of those files — so neither
 * has to import the other and create a component -> store -> component
 * import cycle (ModelPicker already imports the store).
 */

import type { Model } from './types'

const NON_CHAT = /whisper|tts|embed|image|video|guard|rerank|moderation/i

/** A model that can actually drive a coding-agent turn: text in, text out, tool calls. */
export function isAgentModel(m: Model): boolean {
  return (
    Boolean(m.capabilities.toolcall && m.capabilities.input.text && m.capabilities.output.text) &&
    !NON_CHAT.test(m.id)
  )
}
