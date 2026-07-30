import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import {
  TIPS,
  TIPS_CHANGED_EVENT,
  dismissTip,
  loadTipsPrefs,
  nextTip,
  remainingTipCount,
  saveTipsPrefs,
  setTipsEnabled,
  tipShortcutKeys
} from '../lib/tips'
import type { TipsPrefs } from '../lib/tips'
import './tips.css'

export function TipBar(): JSX.Element | null {
  const [prefs, setPrefs] = useState<TipsPrefs>(() => loadTipsPrefs())

  // Settings' toggle and the command palette write prefs from other subtrees;
  // re-reading on the shared event is how this bar learns about it. Every
  // write below goes through `commit`, which only ever writes then sets state
  // — it never re-reads — so this handler firing off our own write is a no-op
  // re-render, not a loop.
  useEffect(() => {
    const onChanged = (): void => setPrefs(loadTipsPrefs())
    window.addEventListener(TIPS_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(TIPS_CHANGED_EVENT, onChanged)
  }, [])

  const commit = (next: TipsPrefs): void => {
    saveTipsPrefs(next)
    setPrefs(next)
  }

  const tip = nextTip(prefs)
  if (!tip) return null

  const keys = tipShortcutKeys(tip)
  // Position, not `dismissed.length`: loadTipsPrefs deliberately keeps ids that
  // are no longer in the catalogue, so counting dismissals would overstate the
  // total once a tip is removed. TIPS.length is the only honest denominator.
  const position = TIPS.length - remainingTipCount(prefs) + 1

  return (
    <div className="tip-bar" role="status" aria-live="polite">
      <div className="tip-bar__text">
        <span className="tip-bar__title">{tip.title}</span>
        <span className="tip-bar__body">{tip.body}</span>
        {keys ? <kbd className="tip-bar__kbd">{keys}</kbd> : null}
      </div>
      <div className="tip-bar__actions">
        <span className="tip-bar__count">
          Tip {position} of {TIPS.length}
        </span>
        <button
          type="button"
          className="tip-bar__btn"
          onClick={() => commit(dismissTip(prefs, tip.id))}
        >
          Got it
        </button>
        <button
          type="button"
          className="tip-bar__btn"
          onClick={() => commit(setTipsEnabled(prefs, false))}
        >
          Skip all
        </button>
        <button
          type="button"
          className="tip-bar__close"
          aria-label="Dismiss tip"
          onClick={() => commit(dismissTip(prefs, tip.id))}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
