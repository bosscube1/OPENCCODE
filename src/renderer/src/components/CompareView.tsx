import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../lib/store'
import { isAssistant, isTextPart } from '../lib/types'
import { columnKey, isCompareBusy, type CompareColumn } from '../lib/compare'
import { formatCost, formatDuration, formatTokens } from '../lib/format'
import { MessageView } from './MessageView'
import './compare.css'

/** Matches the copy-to-clipboard pattern in App.tsx / ProviderPanel.tsx. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** Concatenated assistant text for a column, for the per-column "Copy" button. */
function columnAssistantText(column: CompareColumn): string {
  return column.messages
    .filter((m) => isAssistant(m.info))
    .map((m) => m.parts.filter(isTextPart).map((p) => p.text).join('\n\n'))
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}

/** Token / cost totals summed across a column's assistant messages. */
function columnTotals(column: CompareColumn): { inputTokens: number; outputTokens: number; cost: number } {
  let inputTokens = 0
  let outputTokens = 0
  let cost = 0
  for (const m of column.messages) {
    if (!isAssistant(m.info)) continue
    inputTokens += m.info.tokens.input
    outputTokens += m.info.tokens.output
    cost += m.info.cost
  }
  return { inputTokens, outputTokens, cost }
}

/** Display name resolution: providers -> fall back to the raw id when unresolved. */
function resolveNames(
  providers: ReturnType<typeof useStore.getState>['providers'],
  providerID: string,
  modelID: string
): { providerName: string; modelName: string } {
  const provider = providers.find((p) => p.id === providerID)
  if (!provider) return { providerName: providerID, modelName: modelID }
  const model = provider.models?.[modelID]
  return { providerName: provider.name, modelName: model?.name ?? modelID }
}

function CompareColumnCard({
  column,
  index,
  elapsedMs,
  registerScrollRef,
  onColumnScroll
}: {
  column: CompareColumn
  index: number
  elapsedMs: number
  registerScrollRef: (index: number, el: HTMLDivElement | null) => void
  onColumnScroll: (index: number) => void
}): JSX.Element {
  const providers = useStore((s) => s.providers)
  const promoteCompareColumn = useStore((s) => s.promoteCompareColumn)
  const [copied, setCopied] = useState(false)

  const { providerName, modelName } = useMemo(
    () => resolveNames(providers, column.providerID, column.modelID),
    [providers, column.providerID, column.modelID]
  )
  const totals = useMemo(() => columnTotals(column), [column])
  const visibleMessages = useMemo(
    () => column.messages.filter((m) => m.info.role !== 'user'),
    [column.messages]
  )

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(t)
  }, [copied])

  return (
    <div className="compare__col">
      <div className="compare__colhead">
        <div className="compare__colheadtop">
          <span className="compare__modelname" title={`${column.providerID}/${column.modelID}`}>
            {modelName}
          </span>
          {column.busy ? <span className="compare__spinner" role="status" aria-label="Working" /> : null}
        </div>
        <div className="compare__colheadmeta">
          <span className="compare__providername">{providerName}</span>
          <span className="compare__sep" aria-hidden="true">·</span>
          <span className="compare__elapsed" title="Elapsed since the run started">
            {formatDuration(elapsedMs)}
          </span>
        </div>
        <div className="compare__colheadstats">
          <span title="input / output tokens">
            {formatTokens(totals.inputTokens)} in · {formatTokens(totals.outputTokens)} out
          </span>
          <span className="compare__sep" aria-hidden="true">·</span>
          <span>{formatCost(totals.cost)}</span>
        </div>
        <div className="compare__colactions">
          <button
            type="button"
            className="compare__colbtn"
            disabled={!column.sessionID}
            title={column.sessionID ? 'Adopt this session with full tools' : 'Waiting for the session to start'}
            onClick={() => void promoteCompareColumn(index)}
          >
            Promote to session
          </button>
          <button
            type="button"
            className="compare__colbtn"
            onClick={() => {
              void copyText(columnAssistantText(column)).then((ok) => setCopied(ok))
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div
        className="compare__colbody"
        ref={(el) => registerScrollRef(index, el)}
        onScroll={() => onColumnScroll(index)}
      >
        {visibleMessages.map((message) => (
          <div key={message.info.id} className="compare__msgwrap">
            <MessageView message={message} />
          </div>
        ))}

        {column.error !== null ? (
          <div className="compare__error" role="alert">
            <span className="compare__errorlabel">Error</span>
            <span className="compare__errortext">{column.error}</span>
          </div>
        ) : null}

        {visibleMessages.length === 0 && column.error === null && column.busy ? (
          <div className="compare__pending">Waiting for a response…</div>
        ) : null}
      </div>
    </div>
  )
}

export function CompareView(): JSX.Element | null {
  const compare = useStore((s) => s.compare)
  const abortCompare = useStore((s) => s.abortCompare)
  const clearCompare = useStore((s) => s.clearCompare)
  const discardCompare = useStore((s) => s.discardCompare)

  const [syncScroll, setSyncScroll] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  const scrollRefs = useRef<Array<HTMLDivElement | null>>([])
  // Set while a synced scroll is being applied programmatically, so the resulting `scroll`
  // events on the OTHER columns don't re-enter this handler and ping-pong forever.
  const syncingRef = useRef(false)

  const busy = isCompareBusy(compare)

  // Reset the clock the instant a fresh run starts (its columns all show ~0s, not a stale value
  // left over from the previous run), then tick once a second only while something is busy.
  useEffect(() => {
    setNow(Date.now())
  }, [compare?.id])

  useEffect(() => {
    if (!busy) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [busy])

  const registerScrollRef = useCallback((index: number, el: HTMLDivElement | null) => {
    scrollRefs.current[index] = el
  }, [])

  const onColumnScroll = useCallback(
    (index: number) => {
      if (!syncScroll || syncingRef.current) return
      const source = scrollRefs.current[index]
      if (!source) return
      syncingRef.current = true
      const top = source.scrollTop
      for (let i = 0; i < scrollRefs.current.length; i++) {
        if (i === index) continue
        const el = scrollRefs.current[i]
        if (el) el.scrollTop = top
      }
      // Programmatic `scrollTop` writes dispatch their `scroll` events asynchronously; releasing
      // the guard across two animation frames gives them time to land (and be ignored) first.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          syncingRef.current = false
        })
      })
    },
    [syncScroll]
  )

  if (compare === null) return null

  const elapsedMs = Math.max(0, now - compare.startedAt)

  return (
    <div className="compare">
      <div className="compare__toolbar">
        <div className="compare__prompt">{compare.prompt}</div>
        <div className="compare__toolbaractions">
          <label className="compare__syncrow" title="Scroll every column together">
            <input
              type="checkbox"
              checked={syncScroll}
              onChange={(e) => setSyncScroll(e.target.checked)}
            />
            Sync scroll
          </label>
          {busy ? (
            <button
              type="button"
              className="compare__btn compare__btn--stop"
              onClick={() => void abortCompare()}
            >
              Stop all
            </button>
          ) : null}
          <button type="button" className="compare__btn" onClick={() => clearCompare()}>
            Close
          </button>
          <button
            type="button"
            className="compare__btn compare__btn--danger"
            onClick={() => {
              const count = compare.columns.length
              if (
                window.confirm(
                  `Discard this comparison and delete its ${count} session${count === 1 ? '' : 's'}? This cannot be undone.`
                )
              ) {
                void discardCompare()
              }
            }}
          >
            Discard run
          </button>
        </div>
      </div>

      <div className="compare__note">
        Comparison columns run <strong>read-only</strong> — no file writes, no shell commands. Use
        “Promote to session” on the column you want to keep so it continues with full tools.
      </div>

      <div className="compare__row">
        {compare.columns.map((column, index) => (
          <CompareColumnCard
            key={columnKey(column)}
            column={column}
            index={index}
            elapsedMs={elapsedMs}
            registerScrollRef={registerScrollRef}
            onColumnScroll={onColumnScroll}
          />
        ))}
      </div>
    </div>
  )
}
