/**
 * Crash log: appends uncaught exceptions and unhandled rejections to a file in
 * userData so a post-mortem is possible even when the renderer never got a
 * chance to show anything. Size-capped and rotated so it can't grow unbounded.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 1_000_000 // 1 MB — rotate once the active log exceeds this
const KEEP_TAIL_BYTES = 512_000 // 512 KB kept (most recent) in crash.log.old after rotation

let logPath = ''
let logging = false

/**
 * Resolve and remember the crash log path. Call once, from `app.whenReady()`,
 * before any window is created.
 */
export function initCrashLog(app: Electron.App): void {
  const dir = app.getPath('userData')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* best-effort — appendFileSync below will surface any real problem */
  }
  logPath = join(dir, 'crash.log')
}

/** Absolute path to the active crash log. Empty until `initCrashLog` has run. */
export function getCrashLogPath(): string {
  return logPath
}

function rotateIfNeeded(): void {
  if (!logPath || !existsSync(logPath)) return
  const { size } = statSync(logPath)
  if (size <= MAX_LOG_BYTES) return
  const content = readFileSync(logPath, 'utf8')
  const tail = content.length > KEEP_TAIL_BYTES ? content.slice(-KEEP_TAIL_BYTES) : content
  writeFileSync(`${logPath}.old`, tail, 'utf8')
  writeFileSync(logPath, '', 'utf8')
}

/**
 * Append `scope: err` to the crash log, synchronously. Never throws — a
 * failure to log falls back to `console.error` and is otherwise swallowed,
 * since this is called from crash handlers that must not themselves crash.
 */
export function logCrash(scope: string, err: unknown): void {
  if (logging) {
    // Re-entrant call — e.g. the write below itself threw. Never recurse.
    console.error(`[crashlog] re-entrant logCrash during "${scope}"`, err)
    return
  }
  logging = true
  try {
    rotateIfNeeded()
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? message : message
    const entry = `\n[${new Date().toISOString()}] ${scope}: ${message}\n${stack}\n`
    const target = logPath || join(process.cwd(), 'crash.log') // fallback if init hasn't run yet
    appendFileSync(target, entry, 'utf8')
  } catch (writeErr) {
    console.error('[crashlog] failed to write crash log', writeErr)
  } finally {
    logging = false
  }
}
