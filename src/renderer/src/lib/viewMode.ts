/**
 * Transcript view modes — Normal / Verbose / Summary.
 *
 * These are a control surface over machinery that already existed: `ToolCall` has always
 * honoured a `collapsed` default-open hint, and `Chat` has always computed that hint from
 * how far a message sits from the tail. The mode decides how that hint is derived, and
 * whether tool cards are rendered at all.
 *
 * Kept as pure functions in `lib/` so they are unit-testable — there is no component test
 * harness in this project, so anything that lives only inside a `.tsx` ships unverified.
 */

export type ViewMode = 'normal' | 'verbose' | 'summary'

export const VIEW_MODES: readonly ViewMode[] = ['normal', 'verbose', 'summary'] as const

export function isViewMode(value: unknown): value is ViewMode {
  return value === 'normal' || value === 'verbose' || value === 'summary'
}

/**
 * Whether a tool card should START collapsed, given how many messages separate it from the
 * tail of the transcript.
 *
 * `normal` reproduces the pre-existing behaviour exactly: collapse once a message is further
 * than `expandedTail` from the end. `verbose` never collapses. `summary` returns true, but
 * the value is moot — `shouldHideTools` removes the cards before this is consulted; it is
 * kept truthful rather than arbitrary so a caller that only checks one of the two predicates
 * still degrades sensibly.
 *
 * Note this is only a DEFAULT. `ToolCall` tracks an explicit user override separately, so a
 * card the user opened by hand stays open when the mode changes.
 */
export function shouldCollapseTools(
  mode: ViewMode,
  distanceFromEnd: number,
  expandedTail: number
): boolean {
  if (mode === 'verbose') return false
  if (mode === 'summary') return true
  return distanceFromEnd > expandedTail
}

/** Whether tool cards are omitted from the transcript entirely. */
export function shouldHideTools(mode: ViewMode): boolean {
  return mode === 'summary'
}

/** Short label for the mode switcher. */
export function viewModeLabel(mode: ViewMode): string {
  if (mode === 'verbose') return 'Verbose'
  if (mode === 'summary') return 'Summary'
  return 'Normal'
}

/** Longer description, for the switcher's `title` tooltip. */
export function describeViewMode(mode: ViewMode): string {
  if (mode === 'verbose') return 'Verbose — every tool call expanded, however old'
  if (mode === 'summary') return 'Summary — prose only; tool calls hidden'
  return 'Normal — recent tool calls expanded, older ones collapsed'
}
