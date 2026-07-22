import { useEffect, useState } from 'react'

interface MentionMenuProps {
  query: string
  directory: string
  onSelect: (filepath: string) => void
  onClose: () => void
}

export function MentionMenu({ query, directory, onSelect, onClose }: MentionMenuProps) {
  const [files, setFiles] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      const q = query.trim()
      if (window.api && window.api.find) {
        window.api.find
          .files(directory, q)
          .then((result) => {
            if (cancelled) return
            setFiles(Array.isArray(result) ? result.slice(0, 10) : [])
            setSelectedIndex(0)
          })
          .catch(() => {
            if (cancelled) return
            setFiles([])
          })
      }
    }, 150)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, directory])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (files.length === 0) {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % files.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + files.length) % files.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (files[selectedIndex]) {
          onSelect(files[selectedIndex])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [files, selectedIndex, onSelect, onClose])

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
          onMouseEnter={() => setSelectedIndex(idx)}
        >
          <span className="composer__mention-name">{file}</span>
        </button>
      ))}
    </div>
  )
}
