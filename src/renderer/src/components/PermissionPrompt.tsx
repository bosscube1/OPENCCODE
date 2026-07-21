import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Permission, PermissionResponse } from '../lib/types'

/**
 * Mounted prompts, oldest first. Only the oldest one answers keyboard
 * shortcuts, so stacked prompts never fire together.
 */
const mounted: HTMLElement[] = []

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

function patternList(pattern: Permission['pattern']): string[] {
  if (typeof pattern === 'string') return pattern.length > 0 ? [pattern] : []
  if (Array.isArray(pattern)) return pattern.filter((entry) => typeof entry === 'string' && entry.length > 0)
  return []
}

export function PermissionPrompt({
  permission,
  onRespond
}: {
  permission: Permission
  onRespond: (r: PermissionResponse) => void
}): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const answeredRef = useRef<PermissionResponse | null>(null)
  const [answered, setAnswered] = useState<PermissionResponse | null>(null)

  const respond = useCallback(
    (response: PermissionResponse) => {
      if (answeredRef.current !== null) return
      answeredRef.current = response
      setAnswered(response)
      onRespond(response)
    },
    [onRespond]
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    mounted.push(root)
    return () => {
      const index = mounted.indexOf(root)
      if (index >= 0) mounted.splice(index, 1)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (mounted[0] !== rootRef.current) return

      const key = event.key.toLowerCase()
      if (key === 'a') {
        event.preventDefault()
        respond(event.shiftKey ? 'always' : 'once')
      } else if (key === 'd') {
        event.preventDefault()
        respond('reject')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [respond])

  const patterns = patternList(permission.pattern)
  const settled = answered !== null

  return (
    <div
      ref={rootRef}
      className={`perm${settled ? ' perm--settled' : ''}`}
      role="alertdialog"
      aria-label="Permission required"
    >
      <div className="perm__head">
        <span className="perm__badge" aria-hidden="true">
          !
        </span>
        <span className="perm__title">{permission.title}</span>
        <span className="perm__type">{permission.type}</span>
      </div>

      {patterns.length > 0 ? (
        <div className="perm__patterns">
          {patterns.map((pattern) => (
            <code className="perm__pattern" key={pattern}>
              {pattern}
            </code>
          ))}
        </div>
      ) : null}

      <div className="perm__actions">
        <button
          type="button"
          className="perm__btn perm__btn--primary"
          disabled={settled}
          onClick={() => respond('once')}
        >
          Allow once <kbd className="perm__kbd">A</kbd>
        </button>
        <button
          type="button"
          className="perm__btn perm__btn--always"
          disabled={settled}
          onClick={() => respond('always')}
        >
          Always allow <kbd className="perm__kbd">⇧A</kbd>
        </button>
        <button
          type="button"
          className="perm__btn perm__btn--deny"
          disabled={settled}
          onClick={() => respond('reject')}
        >
          Deny <kbd className="perm__kbd">D</kbd>
        </button>
      </div>

      {settled ? (
        <div className="perm__settledmsg">
          {answered === 'reject' ? 'Denied' : answered === 'always' ? 'Always allowed' : 'Allowed once'}
        </div>
      ) : null}
    </div>
  )
}
