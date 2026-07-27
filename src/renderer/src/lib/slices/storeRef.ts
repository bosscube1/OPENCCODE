/**
 * A late-bound handle on the created store.
 *
 * The attempt machine's watchdog timers fire outside any slice closure, so they need
 * `getState`/`setState` without importing the store module (which would make the
 * store ↔ attempt-machine cycle load-order sensitive). `store.ts` registers the handle
 * immediately after `create()`, before any action or timer can run.
 */

import type { AppState } from './types'

export interface StoreHandle {
  getState(): AppState
  setState(partial: Partial<AppState>): void
}

let handle: StoreHandle | null = null

export function registerStore(next: StoreHandle): void {
  handle = next
}

export function store(): StoreHandle {
  if (!handle) throw new Error('Store handle used before the store was created.')
  return handle
}
