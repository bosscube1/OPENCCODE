/**
 * Persisted preferences — extracted from store.ts.
 */

import { isFreeModel } from './freeTier'

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
export function savePrefs(prefs: Omit<Prefs, 'routingMode' | 'showPaidModels' | 'compareTargets'> & Partial<Pick<Prefs, 'routingMode' | 'showPaidModels' | 'compareTargets'>>): void {
  try {
    const current = loadPrefs()
    const merged: Prefs = {
      ...prefs,
      routingMode: prefs.routingMode ?? current.routingMode,
      showPaidModels: prefs.showPaidModels ?? current.showPaidModels,
      compareTargets: prefs.compareTargets ?? current.compareTargets,
    }
    // Write both new and legacy keys for one-release downgrade safety
    const toWrite = {
      ...merged,
      autoRotate: merged.routingMode === 'auto',
      stickyModel: merged.routingMode === 'failover',
    }
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(toWrite))
  } catch {
    // Storage can be unavailable or full; preferences are best-effort.
  }
}

function isRoutingMode(v: string): v is RoutingMode {
  return v === 'locked' || v === 'failover' || v === 'auto'
}
