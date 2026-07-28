import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../lib/store'
import type { TermId } from '../lib/types'
import './term.css'

/** Bounded scrollback — the backend caps its own backlog at 1,000,000 chars,
 * this bounds renderer-side memory independently of that. */
const SCROLLBACK_LINES = 5000
/** Coalesce ResizeObserver churn (window drags, panel resizes) before telling
 * the PTY to reflow — resizing on every observer tick is wasteful and can
 * momentarily desync cols/rows from what the observer last saw. */
const RESIZE_DEBOUNCE_MS = 80

/**
 * Reads the current design tokens from computed style so the xterm palette
 * always matches the active app theme (dark/light/auto) without ever
 * hardcoding a hex. Per the terminal's warm palette, ANSI blue is remapped to
 * the terracotta accent token (no blue token exists in the design system);
 * ANSI green stays mapped to the existing `--ok` success token rather than a
 * new hardcoded green, since real-world output (git status, ls colors) still
 * needs a red/green distinction to read correctly.
 */
function readTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string): string => {
    const v = style.getPropertyValue(name).trim()
    return v.length > 0 ? v : fallback
  }

  const bg = token('--bg', '#1f1e1d')
  const fg = token('--fg', '#f5f4ee')
  const fgDim = token('--fg-dim', '#9a968c')
  const accent = token('--accent', '#d97757')
  const accentFg = token('--accent-fg', '#1a1917')
  const selection = token('--accent-soft', 'rgba(217, 119, 87, 0.14)')
  const danger = token('--danger', '#e5695a')
  const warn = token('--warn', '#d4a24c')
  const ok = token('--ok', '#7fb56a')
  const sunken = token('--bg-sunken', '#1a1917')

  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: accentFg,
    selectionBackground: selection,
    selectionForeground: fg,
    black: sunken,
    brightBlack: fgDim,
    red: danger,
    brightRed: danger,
    green: ok,
    brightGreen: ok,
    yellow: warn,
    brightYellow: warn,
    blue: accent,
    brightBlue: accent,
    magenta: accent,
    brightMagenta: accent,
    cyan: fgDim,
    brightCyan: fgDim,
    white: fg,
    brightWhite: fg
  }
}

/** Ticks whenever the app theme changes (data-theme attribute flip, or the
 * OS-level color-scheme in 'auto' mode) so consumers can re-read tokens. */
function useThemeTick(): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const bump = (): void => setTick((n) => n + 1)

    const observer = new MutationObserver(bump)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', bump)

    return () => {
      observer.disconnect()
      media.removeEventListener('change', bump)
    }
  }, [])

  return tick
}

type ExitState = { dead: boolean; code: number | null }

function TerminalInstance({
  id,
  active,
  theme
}: {
  id: TermId
  active: boolean
  theme: ITheme
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [exit, setExit] = useState<ExitState>({ dead: false, code: null })

  // Create the xterm instance once per terminal id and tear it down on unmount.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: 'var(--mono)',
      fontSize: 13,
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
      theme: readTerminalTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    termRef.current = term
    fitRef.current = fit

    let disposed = false

    const unsubData = window.api.term.onData((e) => {
      if (disposed || e.id !== id) return
      term.write(e.data)
    })

    const unsubExit = window.api.term.onExit((e) => {
      if (disposed || e.id !== id) return
      setExit({ dead: true, code: e.code })
    })

    const dataDisposable = term.onData((data) => {
      if (disposed) return
      void window.api.term.write(id, data)
    })

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const doFit = (): void => {
      if (disposed) return
      try {
        fit.fit()
      } catch {
        return
      }
      void window.api.term.resize(id, term.cols, term.rows)
    }

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doFit, RESIZE_DEBOUNCE_MS)
    })
    resizeObserver.observe(host)

    // Initial fit once the host has real dimensions.
    resizeTimer = setTimeout(doFit, 0)

    return () => {
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      unsubData()
      unsubExit()
      dataDisposable.dispose()
      fit.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Track theme changes without recreating the terminal.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = theme
  }, [theme])

  // Re-fit whenever this instance becomes the active tab (its container may
  // have been zero-sized while hidden, so the last fit could be stale).
  useEffect(() => {
    if (!active) return
    const fit = fitRef.current
    const term = termRef.current
    if (!fit || !term) return
    try {
      fit.fit()
    } catch {
      return
    }
    void window.api.term.resize(id, term.cols, term.rows)
  }, [active, id])

  return (
    <div className={`term__instance ${active ? '' : 'term__instance--hidden'}`}>
      <div className="term__host" ref={hostRef} />
      {exit.dead && (
        <div className={`term__exit-banner ${exit.code === 0 ? 'term__exit-banner--ok' : 'term__exit-banner--err'}`}>
          Process exited with code {exit.code}
        </div>
      )}
    </div>
  )
}

export function TerminalPanel(): JSX.Element {
  const terminals = useStore((s) => s.terminals)
  const storeActiveTermID = useStore((s) => s.activeTermID)
  const startTerminal = useStore((s) => s.startTerminal)
  const killTerminal = useStore((s) => s.killTerminal)

  // The store's terminal slice deliberately exposes no tab-switch action (it
  // only tracks which PTYs exist, see terminalSlice.ts) — track the selected
  // tab locally, resyncing whenever the store's own notion of "active" moves
  // (a new terminal starts, or the active one is killed and another takes
  // its place).
  const [localActiveTermID, setLocalActiveTermID] = useState<TermId | null>(storeActiveTermID)
  useEffect(() => {
    setLocalActiveTermID(storeActiveTermID)
  }, [storeActiveTermID])
  const activeTermID = localActiveTermID

  const themeTick = useThemeTick()
  const theme = useMemo(() => readTerminalTheme(), [themeTick])

  if (terminals.length === 0) {
    return (
      <div className="term">
        <div className="panel__empty">
          <span>No terminals open.</span>
          <button type="button" className="panel__toolbar-btn" onClick={() => void startTerminal()}>
            New Terminal
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="term">
      <div className="term__tabs">
        <div className="panel__tabs">
          {terminals.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`panel__tab ${t.id === activeTermID ? 'panel__tab--active' : ''}`}
              onClick={() => setLocalActiveTermID(t.id)}
            >
              {t.title}
              <span
                className="term__tab-close"
                role="button"
                aria-label={`Close ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void killTerminal(t.id)
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="term__new-btn"
          title="New terminal"
          onClick={() => void startTerminal()}
        >
          +
        </button>
      </div>
      <div className="term__body">
        {terminals.map((t) => (
          <TerminalInstance key={t.id} id={t.id} active={t.id === activeTermID} theme={theme} />
        ))}
      </div>
    </div>
  )
}
