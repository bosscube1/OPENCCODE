/**
 * tips.ts — the new-user tip catalogue and its persisted state.
 *
 * Renderer-only on purpose: tips are cosmetic onboarding, so they live in
 * localStorage next to `prefs.ts` rather than in the main-process appSettings.
 * That keeps them off the IPC contract surface entirely (no CONTRACTS.md entry,
 * nothing for check:contracts to police) and means the Quick Entry and Gemini
 * Live renderer roots read the same state for free, same-origin.
 *
 * Pure helpers take and return `TipsPrefs` instead of touching storage so they
 * can be unit-tested without a DOM. Only load/save reach for `window`.
 */

import { SHORTCUTS } from './shortcuts'

const TIPS_KEY = 'opencode-desktop:tips'

/**
 * Dispatched on `window` by `saveTipsPrefs` after every write. The tip bar and
 * the Settings toggle are in different subtrees with no shared React state, and
 * localStorage fires no `storage` event for same-document writes — without this
 * the bar would ignore the toggle until the next remount.
 */
export const TIPS_CHANGED_EVENT = 'opencode-desktop:tips-changed'

export type Tip = {
  id: string
  title: string
  body: string
  /**
   * Optional id from `SHORTCUTS`. The key combo is looked up rather than
   * written out here — a duplicated key string is exactly how CommandPalette's
   * panel list drifted out of sync with App.tsx's, and one source of truth
   * costs nothing.
   */
  shortcutId?: string
}

/**
 * Shown one at a time, in this order. Ordered roughly by when a new user needs
 * them: pick a folder before anything else works, then the everyday keys, then
 * the features that are genuinely hard to discover by clicking around.
 */
export const TIPS: Tip[] = [
  {
    id: 'open-folder',
    title: 'Start by opening a folder',
    body:
      'OpenCode works inside a project directory. Open one and the agent can read files, run git and use the terminal.',
    shortcutId: 'open-folder'
  },
  {
    id: 'command-palette',
    title: 'Everything is in the command palette',
    body:
      'Sessions, panels, git actions, model routing and slash commands are all searchable from one place.',
    shortcutId: 'command-palette'
  },
  {
    id: 'shortcuts-help',
    title: 'Press F1 for the shortcut list',
    body: 'Every documented keybinding, grouped. Ctrl+/ opens the same sheet.',
    shortcutId: 'shortcuts-help'
  },
  {
    id: 'code-surface',
    title: 'The right-hand panel is a code surface',
    body:
      'Files, editor, changes, git and a real terminal share that column. Ctrl+B toggles it, Ctrl+` jumps straight to the terminal.',
    shortcutId: 'toggle-panel'
  },
  {
    id: 'mention-files',
    title: 'Type @ to attach a file',
    body:
      'In the composer, @ opens a file picker and attaches the file as context. Dragging a file from the tree does the same thing.'
  },
  {
    id: 'gemini-live',
    title: 'Gemini Live is a second window',
    body:
      'The screen copilot opens in its own floating always-on-top window, so it can watch you work — including watching OpenCode itself. Its answers can be handed straight to the agent.',
    shortcutId: 'gemini-live'
  },
  {
    id: 'find-in-session',
    title: 'Two kinds of search',
    body:
      'Ctrl+F finds inside the open session — long transcripts load older messages on demand as it searches. Ctrl+Shift+F searches every session you have.',
    shortcutId: 'find-in-session'
  },
  {
    id: 'model-routing',
    title: 'Models can fail over on their own',
    body:
      'Routing defaults to failover: your chosen model is used until it rate-limits or stalls, then a pool model takes over. Settings → Routing controls the pool.'
  }
]

export type TipsPrefs = {
  /** Master on/off. False hides the tip bar without forgetting progress. */
  enabled: boolean
  /** Tip ids the user has already acknowledged. */
  dismissed: string[]
}

export const DEFAULT_TIPS_PREFS: TipsPrefs = {
  enabled: true,
  dismissed: []
}

/** Display keys for a tip's shortcut, or null when it has none / is unknown. */
export function tipShortcutKeys(tip: Tip): string | null {
  if (!tip.shortcutId) return null
  return SHORTCUTS.find((s) => s.id === tip.shortcutId)?.keys ?? null
}

/**
 * The tip to show right now, or null when tips are off or all are dismissed.
 * `tips` is injectable so tests don't depend on the live catalogue's contents.
 */
export function nextTip(prefs: TipsPrefs, tips: Tip[] = TIPS): Tip | null {
  if (!prefs.enabled) return null
  const seen = new Set(prefs.dismissed)
  return tips.find((tip) => !seen.has(tip.id)) ?? null
}

/**
 * Tips not yet acknowledged, regardless of whether tips are switched on. This
 * is the count to show in Settings: gating it on `enabled` would report "0 of 8"
 * the moment the toggle goes off, which reads as "all done" rather than "off".
 */
export function unacknowledgedTipCount(prefs: TipsPrefs, tips: Tip[] = TIPS): number {
  const seen = new Set(prefs.dismissed)
  return tips.filter((tip) => !seen.has(tip.id)).length
}

/**
 * Tips still to be shown — `unacknowledgedTipCount`, but 0 when tips are off.
 * This is the count the tip bar uses, where "off" and "none left" both mean
 * nothing more will appear.
 */
export function remainingTipCount(prefs: TipsPrefs, tips: Tip[] = TIPS): number {
  if (!prefs.enabled) return 0
  return unacknowledgedTipCount(prefs, tips)
}

/** Mark one tip acknowledged. Idempotent — dismissing twice is not an error. */
export function dismissTip(prefs: TipsPrefs, id: string): TipsPrefs {
  if (prefs.dismissed.includes(id)) return prefs
  return { ...prefs, dismissed: [...prefs.dismissed, id] }
}

export function setTipsEnabled(prefs: TipsPrefs, enabled: boolean): TipsPrefs {
  return { ...prefs, enabled }
}

/**
 * Bring every tip back and turn tips on. Re-enabling matters: the usual way to
 * reach this is "show me those again" after switching tips off, and leaving
 * `enabled: false` would clear the list to no visible effect.
 */
export function resetTips(prefs: TipsPrefs): TipsPrefs {
  return { ...prefs, enabled: true, dismissed: [] }
}

export function loadTipsPrefs(): TipsPrefs {
  try {
    const raw = window.localStorage.getItem(TIPS_KEY)
    if (!raw) return { ...DEFAULT_TIPS_PREFS }
    const parsed = JSON.parse(raw) as Partial<Record<keyof TipsPrefs, unknown>>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_TIPS_PREFS.enabled,
      // Unknown ids are kept rather than pruned against TIPS: a tip removed in
      // one version and restored in the next should stay dismissed.
      dismissed: Array.isArray(parsed.dismissed)
        ? parsed.dismissed.filter((id): id is string => typeof id === 'string')
        : []
    }
  } catch {
    return { ...DEFAULT_TIPS_PREFS }
  }
}

export function saveTipsPrefs(prefs: TipsPrefs): void {
  try {
    window.localStorage.setItem(TIPS_KEY, JSON.stringify(prefs))
  } catch {
    // Storage can be unavailable or full; tips are best-effort.
  }
  // Dispatched even if the write failed, so the in-memory UI still agrees with
  // itself for this session.
  try {
    window.dispatchEvent(new Event(TIPS_CHANGED_EVENT))
  } catch {
    /* no window (non-DOM test env) — nothing to notify */
  }
}
