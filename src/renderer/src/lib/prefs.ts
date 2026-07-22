/**
 * Persisted preferences — extracted from store.ts.
 */

const PREFS_KEY = 'opencode-desktop:prefs'

export type Theme = 'auto' | 'dark' | 'light'

export type Prefs = {
  directory: string | null
  providerID: string | null
  modelID: string | null
  autoRotate: boolean
  theme: Theme
  modelPool: string[] | null
  stickyModel: boolean
}

export const EMPTY_PREFS: Prefs = {
  directory: null,
  providerID: null,
  modelID: null,
  autoRotate: true,
  theme: 'auto',
  modelPool: null,
  stickyModel: false
}

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...EMPTY_PREFS }
    const parsed = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>
    return {
      directory: typeof parsed.directory === 'string' ? parsed.directory : null,
      providerID: typeof parsed.providerID === 'string' ? parsed.providerID : null,
      modelID: typeof parsed.modelID === 'string' ? parsed.modelID : null,
      autoRotate: typeof parsed.autoRotate === 'boolean' ? parsed.autoRotate : true,
      theme: parsed.theme === 'dark' || parsed.theme === 'light' ? parsed.theme : 'auto',
      modelPool: Array.isArray(parsed.modelPool) ? (parsed.modelPool.filter((x) => typeof x === 'string') as string[]) : null,
      stickyModel: typeof parsed.stickyModel === 'boolean' ? parsed.stickyModel : false
    }
  } catch {
    return { ...EMPTY_PREFS }
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Storage can be unavailable or full; preferences are best-effort.
  }
}
