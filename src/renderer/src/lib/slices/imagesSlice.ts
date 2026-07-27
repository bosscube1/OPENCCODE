/**
 * NanoGPT image generation (`/image`, `/img`) and gallery rehydration.
 *
 * Holds no state of its own: generated images live on disk (the main-process gallery index)
 * and are surfaced as synthetic transcript messages, so everything here writes into
 * `messages` / `busy` through the shared setter.
 */

import { classifyBilling, pickDefaultImageModel } from '../imageModels'
import { sortMessages, makeNotice, makeImageNotice, type NoticeImage } from '../collections'
import { api, errText } from './api'
import type { GetState, SetState } from './types'
import type { GeneratedImageMeta, MessageWithParts, NanogptModelsResult } from '../types'

/**
 * Most recent generated images restored into a transcript on session open.
 *
 * Each one is held live as a base64 `data:` URI, so this is a memory bound, not a display
 * preference. Older generations remain available in the Images view, which loads lazily.
 */
const MAX_REHYDRATED_IMAGES = 12

/** Compact caption line rendered above the generated thumbnails. */
export function imageCaption(
  prompt: string,
  model: string,
  result: { billing: string; cost?: number; remainingBalance?: number }
): string {
  const badge =
    result.billing === 'subscription'
      ? '✅ subscription'
      : result.billing === 'balance'
        ? '⚠️ **billed to balance**'
        : '❔ billing unreported'
  const bits = [`\`${model}\``, badge]
  if (typeof result.cost === 'number') bits.push(`cost ${result.cost}`)
  if (result.billing === 'balance' && typeof result.remainingBalance === 'number') {
    bits.push(`balance left ${result.remainingBalance}`)
  }
  return `🖼️ **${prompt}**\n\n${bits.join(' · ')}`
}

/**
 * Run `/image <prompt>`: pick a model, generate, and append the results to the transcript.
 *
 * Model choice comes from the cached catalogue via `pickDefaultImageModel`, which excludes
 * balance-billing models while `nanogptSubscriptionOnly` is on. Any failure becomes a system notice
 * rather than the global error banner, so it stays attached to the command that caused it.
 */
export async function runImageCommand(
  prompt: string,
  sessionID: string,
  set: SetState,
  get: GetState
): Promise<void> {
  if (prompt.length === 0) {
    get().addSystemNotice('Usage: `/image <prompt>` — for example `/image a red fox in snow, cinematic`.')
    return
  }

  const subscriptionOnly = get().appSettings.nanogptSubscriptionOnly

  let catalogue: NanogptModelsResult
  try {
    catalogue = await api().nanogpt.models()
  } catch (e) {
    get().addSystemNotice(`Could not read the NanoGPT image catalogue: ${errText(e)}`)
    return
  }

  if (catalogue.image.length === 0) {
    get().addSystemNotice(
      'No NanoGPT image models are cached yet. Open **Providers → NanoGPT** and choose **Refresh models**.'
    )
    return
  }

  const model = pickDefaultImageModel(catalogue.image, catalogue.balanceBilled, subscriptionOnly)
  if (model === null) {
    get().addSystemNotice(
      'Every cached NanoGPT image model is known to bill your balance. Turn off **Subscription images only** in Settings to use one.'
    )
    return
  }

  set({ busy: true })
  get().addSystemNotice(`🖼️ Generating with \`${model}\`…`)

  try {
    const result = await api().nanogpt.generate({ prompt, model, sessionID })
    const images: NoticeImage[] = result.images.map((image, index) => ({
      id: image.meta.id,
      dataUrl: `data:image/png;base64,${image.base64}`,
      filename: `${model.replace(/[^a-zA-Z0-9._-]/g, '_')}-${index + 1}.png`
    }))
    set({
      messages: sortMessages([
        ...get().messages,
        makeImageNotice(sessionID, imageCaption(prompt, model, result), images)
      ])
    })
    if (result.blacklisted) {
      get().addSystemNotice(
        `⚠️ \`${model}\` billed your NanoGPT **balance**, not your subscription (\`paymentSource: ${result.paymentSource ?? 'unknown'}\`). It has been marked and will be refused while **Subscription images only** is on.`
      )
    }
  } catch (e) {
    get().addSystemNotice(`Image generation failed: ${errText(e)}`)
  } finally {
    set({ busy: false })
  }
}

/**
 * Rebuild image messages for a session from the on-disk index.
 *
 * Generated images are appended as synthetic messages with no server-side counterpart, so a session
 * reload would otherwise drop them. Bytes are read lazily per image and the original `createdAt` is
 * preserved so each lands back in its original transcript position.
 */
export async function rehydrateSessionImages(
  sessionID: string,
  get: GetState,
  set: SetState
): Promise<void> {
  let metas: GeneratedImageMeta[]
  try {
    metas = await api().nanogpt.images.list(sessionID)
  } catch {
    return // an unreadable gallery must never block opening a session
  }
  if (metas.length === 0) return

  // Bound the memory this can pull in. Each image becomes a base64 `data:` URI held live in the
  // transcript, and a busy session can hold dozens — reading them all would spike renderer memory on
  // every session open. `list()` is newest-first, so this keeps the most recent ones.
  const recent = metas.slice(0, MAX_REHYDRATED_IMAGES)

  const notices: MessageWithParts[] = []
  for (const meta of recent) {
    // Re-check inside the loop: these reads are sequential IPC round trips, so a user who switches
    // session mid-flight should stop the work rather than let it run to completion and be discarded.
    if (get().activeSessionID !== sessionID) return
    let base64: string | null = null
    try {
      base64 = await api().nanogpt.images.read(meta.id)
    } catch {
      continue
    }
    if (base64 === null) continue
    notices.push(
      makeImageNotice(
        sessionID,
        imageCaption(meta.prompt, meta.model, {
          billing: classifyBilling(meta.paymentSource),
          ...(meta.cost !== undefined ? { cost: meta.cost } : {})
        }),
        [{
          id: meta.id,
          dataUrl: `data:image/png;base64,${base64}`,
          filename: `${meta.model.replace(/[^a-zA-Z0-9._-]/g, '_')}.png`
        }],
        meta.createdAt
      )
    )
  }
  if (notices.length === 0) return
  // Guard against the user having switched sessions while the reads were in flight.
  if (get().activeSessionID !== sessionID) return

  // Never let the cap misrepresent the transcript as complete — say what was left out and where to
  // find it.
  if (metas.length > recent.length) {
    notices.unshift(
      makeNotice(
        sessionID,
        `🖼️ Showing the ${recent.length} most recent generated images of ${metas.length} in this session. The rest are in the Images view.`
      )
    )
  }
  set({ messages: sortMessages([...get().messages, ...notices]) })
}
