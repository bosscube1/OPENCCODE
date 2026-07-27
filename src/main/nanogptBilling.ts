/**
 * How a completed NanoGPT generation was billed.
 *
 * Deliberately a standalone, dependency-free module: this rule decides whether the app will spend
 * the user's money again on a given model, so it must be directly unit-testable without dragging in
 * Electron or the IPC surface.
 */

export type ImageBilling = 'subscription' | 'balance' | 'unknown'

/**
 * Classify a generation from its `paymentSource`.
 *
 * `paymentSource` is the ONLY documented machine-readable billing signal — NanoGPT exposes no
 * per-image-model "included in subscription" flag, and its help page states the included set varies.
 *
 * Three-valued on purpose. An ABSENT field returns `'unknown'` rather than being assumed to be
 * balance: assuming the worst would blacklist every model after a single generation and break image
 * support outright should NanoGPT ever stop sending the field. Only positive evidence — a present
 * value that is not a subscription marker — blacklists a model.
 */
export function classifyBilling(paymentSource: string | undefined | null): ImageBilling {
  if (typeof paymentSource !== 'string' || paymentSource.trim().length === 0) return 'unknown'
  return paymentSource.toLowerCase().includes('subscription') ? 'subscription' : 'balance'
}
