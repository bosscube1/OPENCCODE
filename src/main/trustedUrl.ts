/**
 * Shared `will-navigate` guard for every BrowserWindow that loads the renderer
 * with a privileged preload attached.
 *
 * Extracted from index.ts and quickEntry.ts, which each carried an identical
 * copy of this check; liveWindow.ts is the third caller.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Only the renderer we load is allowed to retain a privileged preload.  Do not
 * use string-prefix checks here: `http://127.0.0.1:5173@evil.example` starts
 * with a development URL but has an attacker-controlled origin.
 *
 * @param target            the URL the renderer is trying to navigate to
 * @param rendererUrl       the dev-server URL when running `electron-vite dev`,
 *                          `undefined` in a packaged build
 * @param rendererHtmlPath  path to the packaged renderer entry HTML
 */
export function isTrustedRendererUrl(
  target: string,
  rendererUrl: string | undefined,
  rendererHtmlPath: string
): boolean {
  try {
    const parsed = new URL(target)
    if (rendererUrl) {
      const trusted = new URL(rendererUrl)
      return parsed.protocol === trusted.protocol && parsed.origin === trusted.origin
    }
    return (
      parsed.protocol === 'file:' &&
      parsed.hostname === '' &&
      fileURLToPath(parsed) === resolve(rendererHtmlPath)
    )
  } catch {
    return false
  }
}
