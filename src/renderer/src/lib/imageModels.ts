/**
 * Image-model ranking and default selection.
 *
 * Pure module — no store or React imports — so both the `/image` slash command and the Images view
 * choose models by the same rules, and the rules are unit-testable.
 *
 * NanoGPT's catalogue holds ~169 image models and its docs explicitly warn against hardcoding
 * capability tables, so nothing here is an allowlist: the live catalogue is the source of truth and
 * this module only ORDERS it and picks a sensible default.
 */

/** Shape this module needs from a catalogue entry; a structural subset of NanoImageModel. */
export type ImageModelLike = {
  id: string
  name?: string
  tags?: string[]
}

/**
 * NanoGPT's own "nano" family (Nano Banana and friends), matched on id or display name.
 *
 * Anchored to a `nano` word boundary so it cannot accidentally match unrelated ids that merely
 * contain the substring (e.g. `nanonymous-x`, or a vendor prefixed `nvidia/nano-ish`).
 */
const NANO_FAMILY = /(?:^|[/\s_-])nano(?:[\s_-]|$)|nano-?banana/i

/** True for a model in NanoGPT's nano family. */
export function isNanoFamily(model: ImageModelLike): boolean {
  return NANO_FAMILY.test(model.id) || (model.name !== undefined && NANO_FAMILY.test(model.name))
}

/**
 * Classify a stored generation's billing from its `paymentSource`.
 *
 * Mirrors `src/main/nanogptBilling.ts` — the two copies exist because main and renderer cannot share
 * modules, the same way the shared types are duplicated across main/preload/renderer per CONTRACTS.
 * Keep them in step: an ABSENT value is `'unknown'`, never assumed to be balance.
 */
export function classifyBilling(
  paymentSource: string | undefined | null
): 'subscription' | 'balance' | 'unknown' {
  if (typeof paymentSource !== 'string' || paymentSource.trim().length === 0) return 'unknown'
  return paymentSource.toLowerCase().includes('subscription') ? 'subscription' : 'balance'
}

/**
 * Sort order: nano family first, then alphabetically by display label. Balance-billing models sink
 * to the bottom so a subscription-covered model is always the easiest thing to pick.
 */
export function sortImageModels<T extends ImageModelLike>(
  models: readonly T[],
  balanceBilled: readonly string[] = []
): T[] {
  const billed = new Set(balanceBilled)
  return [...models].sort((a, b) => {
    const aBilled = billed.has(a.id) ? 1 : 0
    const bBilled = billed.has(b.id) ? 1 : 0
    if (aBilled !== bBilled) return aBilled - bBilled

    const aNano = isNanoFamily(a) ? 0 : 1
    const bNano = isNanoFamily(b) ? 0 : 1
    if (aNano !== bNano) return aNano - bNano

    return label(a).localeCompare(label(b))
  })
}

/** Display label for a catalogue entry. */
export function label(model: ImageModelLike): string {
  return model.name && model.name.length > 0 ? model.name : model.id
}

/**
 * Pick the default image model.
 *
 * When `subscriptionOnly`, models already observed to bill the pay-as-you-go balance are excluded
 * outright — the default must never be a model that costs money. Returns null when the catalogue is
 * empty or every entry is excluded, which the caller should surface as "refresh your model list"
 * rather than silently falling back to a hardcoded id.
 */
export function pickDefaultImageModel(
  models: readonly ImageModelLike[],
  balanceBilled: readonly string[],
  subscriptionOnly: boolean
): string | null {
  const billed = new Set(balanceBilled)
  const eligible = subscriptionOnly ? models.filter((m) => !billed.has(m.id)) : models
  if (eligible.length === 0) return null
  return sortImageModels(eligible, balanceBilled)[0].id
}

/**
 * True when the model may be generated with right now.
 * Mirrors the main-process guard in `oc:nanogpt:generate` so the UI can disable rather than fail.
 */
export function canGenerateWith(
  modelID: string,
  balanceBilled: readonly string[],
  subscriptionOnly: boolean
): boolean {
  if (!subscriptionOnly) return true
  return !balanceBilled.includes(modelID)
}
