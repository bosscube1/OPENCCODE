import { useState, useMemo, type JSX } from 'react'
import { useStore } from '../lib/store'
import { extractArtifactsFromMessages, type Artifact } from '../lib/artifacts'
import './artifacts.css'

export function ArtifactsPanel(): JSX.Element | null {
  const messages = useStore((s) => s.messages)
  const activeArtifactID = useStore((s) => s.activeArtifactID)
  const setActiveArtifactID = useStore((s) => s.setActiveArtifactID)

  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [selectedVersionNum, setSelectedVersionNum] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  const artifacts = useMemo(() => extractArtifactsFromMessages(messages), [messages])

  const artifact: Artifact | undefined = useMemo(() => {
    if (!activeArtifactID) return undefined
    return artifacts.find((a) => a.id === activeArtifactID)
  }, [artifacts, activeArtifactID])

  if (!activeArtifactID || !artifact) {
    return null
  }

  const currentVersion = selectedVersionNum !== null
    ? artifact.versions.find((v) => v.version === selectedVersionNum) ?? artifact.versions[artifact.versions.length - 1]
    : artifact.versions[artifact.versions.length - 1]

  const displayContent = currentVersion.content

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(displayContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard write best-effort */
    }
  }

  const handleDownload = async (): Promise<void> => {
    const ext = artifact.type === 'html' ? 'html' : artifact.type === 'svg' ? 'svg' : artifact.type === 'mermaid' ? 'mmd' : artifact.language || 'txt'
    const defaultName = artifact.title.includes('.') ? artifact.title : `${artifact.title.toLowerCase().replace(/\s+/g, '-')}.${ext}`
    try {
      await window.api.saveFile({ defaultName, content: displayContent })
    } catch {
      /* save file best-effort */
    }
  }

  // Construct iframe srcDoc with strict sandboxing isolation
  let srcDoc = ''
  if (artifact.type === 'html') {
    srcDoc = displayContent.toLowerCase().includes('<!doctype html')
      ? displayContent
      : `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>body{margin:16px;font-family:system-ui,-apple-system,sans-serif;color:#1a1917;background-color:#ffffff;}</style></head><body>${displayContent}</body></html>`
  } else if (artifact.type === 'svg') {
    srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background-color:#ffffff;}</style></head><body>${displayContent}</body></html>`
  }

  return (
    <div className="artifacts" role="region" aria-label="Artifact Preview Panel">
      <div className="artifacts__head">
        <div className="artifacts__title-area">
          <span className="artifacts__title" title={artifact.title}>{artifact.title}</span>
          <span className="artifacts__type-badge">{artifact.type}</span>
        </div>

        <div className="artifacts__controls">
          {artifact.versions.length > 1 && (
            <select
              className="artifacts__ver-select"
              value={currentVersion.version}
              onChange={(e) => setSelectedVersionNum(Number(e.target.value))}
              aria-label="Select artifact version"
            >
              {artifact.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} {v.version === artifact.version ? '(latest)' : ''}
                </option>
              ))}
            </select>
          )}

          <button type="button" className="artifacts__btn" onClick={handleCopy} title="Copy code to clipboard">
            {copied ? '✓ Copied' : '📋 Copy'}
          </button>

          <button type="button" className="artifacts__btn" onClick={handleDownload} title="Download file to disk">
            ⬇ Save
          </button>

          <button
            type="button"
            className="artifacts__btn artifacts__btn--close"
            onClick={() => setActiveArtifactID(null)}
            title="Close panel"
          >
            ×
          </button>
        </div>
      </div>

      <div className="artifacts__tabs">
        <button
          type="button"
          className={`artifacts__tab ${tab === 'preview' ? 'artifacts__tab--active' : ''}`}
          onClick={() => setTab('preview')}
        >
          Preview
        </button>
        <button
          type="button"
          className={`artifacts__tab ${tab === 'code' ? 'artifacts__tab--active' : ''}`}
          onClick={() => setTab('code')}
        >
          Source Code
        </button>
      </div>

      <div className="artifacts__body">
        {tab === 'preview' ? (
          artifact.type === 'html' || artifact.type === 'svg' ? (
            /* SECURITY CRITICAL: sandbox="allow-scripts" WITHOUT allow-same-origin guarantees origin isolation */
            <iframe
              className="artifacts__iframe"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={srcDoc}
              title={artifact.title}
            />
          ) : (
            <pre className="artifacts__code-view">{displayContent}</pre>
          )
        ) : (
          <pre className="artifacts__code-view">{displayContent}</pre>
        )}
      </div>
    </div>
  )
}
