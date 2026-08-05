interface MentionMenuProps {
  query: string
  files: string[]
  selectedIndex: number
  onSelect: (filepath: string) => void
  onHoverIndex: (index: number) => void
}

/**
 * Purely presentational. File fetching and keyboard handling both live in
 * Composer.tsx now — see lib/keyboard.ts for why. This component only
 * renders the list `files`/`selectedIndex` it is handed and reports mouse
 * interaction back up.
 */
export function MentionMenu({ query, files, selectedIndex, onSelect, onHoverIndex }: MentionMenuProps) {
  if (files.length === 0) {
    return (
      <div className="composer__mention-menu" role="listbox">
        <div className="composer__mention-head">{query.trim() ? `Files matching "${query}"` : 'Select a file'}</div>
        <div className="composer__mention-item composer__mention-item--empty">No files found</div>
      </div>
    )
  }

  return (
    <div className="composer__mention-menu" role="listbox">
      <div className="composer__mention-head">{query.trim() ? `Files matching "${query}"` : 'Select a file'}</div>
      {files.map((file, idx) => (
        <button
          type="button"
          key={file}
          className={`composer__mention-item${idx === selectedIndex ? ' composer__mention-item--active' : ''}`}
          onClick={() => onSelect(file)}
          onMouseEnter={() => onHoverIndex(idx)}
        >
          <span className="composer__mention-name">{file}</span>
        </button>
      ))}
    </div>
  )
}
