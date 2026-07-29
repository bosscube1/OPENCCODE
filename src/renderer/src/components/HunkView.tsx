/**
 * One diff hunk, rendered identically wherever a diff appears.
 *
 * Two surfaces use it: EditorPanel (one file, hunks accepted individually then
 * applied) and ChangesPanel (every changed file at once, read-only). Passing
 * `onToggle` opts into the accept checkbox — without it the hunk renders as a
 * plain read-only block, which is the difference between the two callers.
 */

import type { JSX } from 'react'
import type { Hunk } from '../lib/types'
import './editor.css'

export function HunkView({
  hunk,
  accepted = false,
  onToggle
}: {
  hunk: Hunk
  accepted?: boolean
  onToggle?: () => void
}): JSX.Element {
  return (
    <div className={`editor__hunk${accepted ? ' editor__hunk--accepted' : ''}`}>
      <div className="editor__hunk-head">
        <span className="editor__hunk-header">{hunk.header}</span>
        {onToggle && (
          <label className="editor__hunk-toggle">
            <input type="checkbox" checked={accepted} onChange={onToggle} />
            {accepted ? 'Accepted' : 'Accept'}
          </label>
        )}
      </div>
      <pre className="editor__hunk-lines">
        {hunk.lines.map((line, i) => (
          <div key={i} className={`editor__line editor__line--${line.kind}`}>
            <span className="editor__line-marker">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
            </span>
            <span className="editor__line-text">{line.text}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}
