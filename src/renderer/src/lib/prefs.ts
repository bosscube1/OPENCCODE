/**
 * Persisted preferences — extracted from store.ts.
 */

import { isFreeModel } from './freeTier'
import { isViewMode, type ViewMode } from './viewMode'

const PREFS_KEY = 'opencode-desktop:prefs'

export type Theme = 'auto' | 'dark' | 'light'

/**
 * Routing behavior:
 * - locked:   never change model; surface errors only
 * - failover: REACTIVE default; use chosen, swap only on 429/stall
 * - auto:     proactive pre-send selection (legacy, opt-in for power users)
 */
export type RoutingMode = 'locked' | 'failover' | 'auto'

export type Prefs = {
  directory: string | null
  providerID: string | null
  modelID: string | null
  autoRotate: boolean
  theme: Theme
  modelPool: string[] | null
  stickyModel: boolean
  routingMode: RoutingMode
  showPaidModels: boolean
  /** `"providerID/modelID"` targets for multi-model fan-out. */
  compareTargets: string[]
  /** Transcript density: Normal / Verbose / Summary. */
  viewMode: ViewMode
  /** Show NanoGPT account balance in status bar. Default false. */
  showBalanceInStatus: boolean
}

export const EMPTY_PREFS: Prefs = {
  directory: null,
  providerID: null,
  modelID: null,
  autoRotate: false,
  theme: 'auto',
  modelPool: null,
  stickyModel: false,
  routingMode: 'failover',
  showPaidModels: false,
  compareTargets: [],
  viewMode: 'normal',
  showBalanceInStatus: false,
}

/** Raw shape that may exist in localStorage (legacy or current). */
type RawPrefs = Partial<Record<string, unknown>>

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...EMPTY_PREFS }
    const parsed = JSON.parse(raw) as RawPrefs

    // --- Migrate routingMode from legacy autoRotate + stickyModel ---
    let routingMode: RoutingMode = 'failover'
    if (typeof parsed.routingMode === 'string' && isRoutingMode(parsed.routingMode)) {
      routingMode = parsed.routingMode
    } else {
      const legacyStickyModel = typeof parsed.stickyModel === 'boolean' ? parsed.stickyModel : false
      const legacyAutoRotate = typeof parsed.autoRotate === 'boolean' ? parsed.autoRotate : true
      if (legacyStickyModel) {
        routingMode = 'failover'
      } else if (!legacyAutoRotate) {
        routingMode = 'locked'
      } else {
        routingMode = 'failover'
      }
    }

    const showPaidModels = typeof parsed.showPaidModels === 'boolean' ? parsed.showPaidModels : false

    // --- Prune paid models from persisted selection unless showPaidModels ---
    let providerID = typeof parsed.providerID === 'string' ? parsed.providerID : null
    let modelID = typeof parsed.modelID === 'string' ? parsed.modelID : null
    if (providerID && modelID && !showPaidModels && !isFreeModel(providerID, modelID)) {
      providerID = null
      modelID = null
    }

    // --- Prune non-free entries from modelPool unless showPaidModels ---
    let modelPool: string[] | null = Array.isArray(parsed.modelPool)
      ? (parsed.modelPool.filter((x) => typeof x === 'string') as string[])
      : null
    if (modelPool && !showPaidModels) {
      modelPool = modelPool.filter((key) => {
        const sep = key.indexOf('/')
        if (sep <= 0) return false
        return isFreeModel(key.slice(0, sep), key.slice(sep + 1))
      })
      if (modelPool.length === 0) modelPool = null
    }

    // Derive legacy fields from routingMode for backward compatibility
    const autoRotate = routingMode === 'auto'
    const stickyModel = routingMode === 'failover'

    return {
      directory: typeof parsed.directory === 'string' ? parsed.directory : null,
      providerID,
      modelID,
      autoRotate,
      theme: parsed.theme === 'dark' || parsed.theme === 'light' ? parsed.theme : 'auto',
      modelPool,
      stickyModel,
      routingMode,
      showPaidModels,
      // Pruned by the same rule as providerID/modelID: a persisted paid target must not silently
      // come back as a fan-out column when paid models are hidden.
      compareTargets: Array.isArray(parsed.compareTargets)
        ? (parsed.compareTargets as unknown[])
            .filter((key): key is string => typeof key === 'string' && key.includes('/'))
            .filter((key) => {
              if (showPaidModels) return true
              const sep = key.indexOf('/')
              return isFreeModel(key.slice(0, sep), key.slice(sep + 1))
            })
        : [],
      viewMode: isViewMode(parsed.viewMode) ? parsed.viewMode : 'normal',
      showBalanceInStatus: typeof parsed.showBalanceInStatus === 'boolean' ? parsed.showBalanceInStatus : false,
    }
  } catch {
    return { ...EMPTY_PREFS }
  }
}

/**
 * Save preferences. Accepts a full or partial Prefs object — missing new
 * fields are filled from the currently persisted values so callers that
 * haven't been updated yet don't clobber routingMode/showPaidModels.
 */
export function savePrefs(
  prefs: Omit<
    Prefs,
    'routingMode' | 'showPaidModels' | 'compareTargets' | 'autoRotate' | 'stickyModel' | 'viewMode' | 'showBalanceInStatus'
  > &
    Partial<Pick<Prefs, 'routingMode' | 'showPaidModels' | 'compareTargets' | 'viewMode' | 'showBalanceInStatus'>>
): void {
  try {
    const current = loadPrefs()
    const routingMode = prefs.routingMode ?? current.routingMode
    // `autoRotate`/`stickyModel` are DERIVED, never accepted from callers — passing them was
    // the original defect: the store held its own copy, savePrefs silently overwrote it, and
    // no failover gate ever read either one. They are still written so a one-release
    // downgrade can migrate back out of `routingMode`.
    const toWrite: Prefs = {
      ...prefs,
      routingMode,
      showPaidModels: prefs.showPaidModels ?? current.showPaidModels,
      compareTargets: prefs.compareTargets ?? current.compareTargets,
      viewMode: prefs.viewMode ?? current.viewMode,
      showBalanceInStatus: prefs.showBalanceInStatus ?? current.showBalanceInStatus,
      autoRotate: routingMode === 'auto',
      stickyModel: routingMode === 'failover',
    }
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(toWrite))
  } catch {
    // Storage can be unavailable or full; preferences are best-effort.
  }
}

function isRoutingMode(v: string): v is RoutingMode {
  return v === 'locked' || v === 'failover' || v === 'auto'
}

/* --- Gemini Live screen-copilot prefs ---------------------------------------
 * Separate key from PREFS_KEY: the live session settings change independently
 * of chat routing, and this keeps the Prefs migration machinery untouched. */

const LIVE_PREFS_KEY = 'opencode-desktop:live-prefs'

/** Keep in sync with GEMINI_LIVE_VOICES in src/main/geminiLiveConfig.ts (main enforces this list). */
export const LIVE_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
] as const

export type LivePrefs = {
  voice: string
  model: string
  systemInstruction: string
}

/** Mirrors DEFAULT_GEMINI_LIVE_CONFIG in src/main/geminiLiveConfig.ts. */
export const DEFAULT_LIVE_PREFS: LivePrefs = {
  voice: 'Kore',
  model: 'gemini-3.1-flash-live-preview',
  systemInstruction:
    'You are a concise visual copilot. Watch the shared screen, answer spoken or typed questions, ' +
    'and proactively mention important visible changes. Never claim to click or change the screen.'
}

export function loadLivePrefs(): LivePrefs {
  try {
    const raw = window.localStorage.getItem(LIVE_PREFS_KEY)
    if (!raw) return { ...DEFAULT_LIVE_PREFS }
    const parsed = JSON.parse(raw) as Partial<Record<keyof LivePrefs, unknown>>
    return {
      voice:
        typeof parsed.voice === 'string' && (LIVE_VOICES as readonly string[]).includes(parsed.voice)
          ? parsed.voice
          : DEFAULT_LIVE_PREFS.voice,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_LIVE_PREFS.model,
      systemInstruction:
        typeof parsed.systemInstruction === 'string' ? parsed.systemInstruction : DEFAULT_LIVE_PREFS.systemInstruction
    }
  } catch {
    return { ...DEFAULT_LIVE_PREFS }
  }
}

export function saveLivePrefs(prefs: LivePrefs): void {
  try {
    window.localStorage.setItem(LIVE_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Storage can be unavailable or full; preferences are best-effort.
  }
}
