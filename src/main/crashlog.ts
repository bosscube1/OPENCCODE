/**
 * Crash log: appends uncaught exceptions and unhandled rejections to a file in
 * userData so a post-mortem is possible even when the renderer never got a
 * chance to show anything. Size-capped and rotated so it can't grow unbounded.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 1_000_000 // 1 MB — rotate once the active log exceeds this
const KEEP_TAIL_BYTES = 512_000 // 512 KB kept (most recent) in crash.log.old after rotation

/** Cap for the bounded read served over `oc:crashlog:read` — tail bytes, never the whole file. */
export const CRASH_LOG_TAIL_BYTES = 64 * 1024 // 64 KiB

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

/* ------------------------------------------------------------------ */
/* read path — bounded, never throws                                   */
/* ------------------------------------------------------------------ */

/** Bounded snapshot of the crash log, served over `oc:crashlog:read`. */
export type CrashLogReport = {
  /** Absolute path to the active log. Empty until `initCrashLog` has run. */
  path: string
  /** True when crash.log exists (regardless of size). */
  exists: boolean
  /** On-disk size of crash.log in bytes (0 when absent). */
  sizeBytes: number
  /** True when a rotated crash.log.old exists alongside the active log. */
  hasOld: boolean
  /** Entry headers observed in the returned tail — a lower bound once `truncated`. */
  entryCount: number
  /** The most recent bytes of crash.log, at most `maxBytes` (see `truncated`). */
  tail: string
  /** True when the file was larger than the cap and `tail` is only the end of it. */
  truncated: boolean
}

/** Count entry headers (`[2026-08-04T…] scope: message`) in a log fragment. */
export function countCrashEntries(text: string): number {
  const matches = text.match(/^\[\d{4}-\d{2}-\d{2}T/gm)
  return matches === null ? 0 : matches.length
}

/** Read the last `maxBytes` bytes of a file without loading the whole file. */
function readTailBytes(path: string, size: number, maxBytes: number): string {
  const length = Math.min(size, maxBytes)
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Bounded read of the crash log for the settings UI. Returns an empty report when
 * the log does not exist, and never throws — a crash-adjacent read must not itself
 * crash the IPC handler.
 */
export function readCrashLog(maxBytes: number = CRASH_LOG_TAIL_BYTES): CrashLogReport {
  const empty: CrashLogReport = {
    path: logPath,
    exists: false,
    sizeBytes: 0,
    hasOld: false,
    entryCount: 0,
    tail: '',
    truncated: false
  }
  if (!logPath) return empty
  try {
    const hasOld = existsSync(`${logPath}.old`)
    if (!existsSync(logPath)) return { ...empty, hasOld }
    const { size } = statSync(logPath)
    const tail = size === 0 ? '' : readTailBytes(logPath, size, maxBytes)
    return {
      path: logPath,
      exists: true,
      sizeBytes: size,
      hasOld,
      entryCount: countCrashEntries(tail),
      tail,
      truncated: size > maxBytes
    }
  } catch (readErr) {
    console.error('[crashlog] failed to read crash log', readErr)
    return empty
  }
}
