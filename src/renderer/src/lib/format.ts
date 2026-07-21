/**
 * Small pure formatting helpers shared by the UI.
 * No imports, no store access, no side effects — safe to call during render.
 */

const TOKEN_UNITS = ['', 'k', 'M', 'B', 'T'] as const

/**
 * Format a USD cost. Keeps enough precision for sub-cent model calls.
 *   0        -> "$0.00"
 *   0.000412 -> "$0.0004"
 *   0.0234   -> "$0.0234"
 *   0.42     -> "$0.420"
 *   12.5     -> "$12.50"
 */
export function formatCost(n: number): string {
  if (!Number.isFinite(n)) return '$0.00'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs === 0) return '$0.00'
  if (abs < 0.0001) return `${sign}$<0.0001`
  if (abs < 0.1) return `${sign}$${abs.toFixed(4)}`
  if (abs < 1) return `${sign}$${abs.toFixed(3)}`
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/**
 * Compact token counts.
 *   842     -> "842"
 *   1234    -> "1.2k"
 *   123456  -> "123k"
 *   999999  -> "1M"
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const sign = n < 0 ? '-' : ''
  let value = Math.abs(n)
  let unit = 0
  while (value >= 1000 && unit < TOKEN_UNITS.length - 1) {
    value = value / 1000
    unit += 1
  }
  const rounded =
    unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  if (rounded >= 1000 && unit < TOKEN_UNITS.length - 1) {
    return `${sign}1${TOKEN_UNITS[unit + 1]}`
  }
  return `${sign}${rounded}${TOKEN_UNITS[unit]}`
}

/**
 * Human duration from milliseconds.
 *   412     -> "412ms"
 *   4200    -> "4.2s"
 *   192000  -> "3m 12s"
 *   3900000 -> "1h 05m"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`

  const totalSeconds = ms / 1000
  if (totalSeconds < 10) return `${(Math.round(totalSeconds * 10) / 10).toFixed(1)}s`
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    const seconds = Math.round(totalSeconds - totalMinutes * 60)
    // Rounding can spill into the next minute.
    if (seconds === 60) return `${totalMinutes + 1}m 0s`
    return `${totalMinutes}m ${seconds}s`
  }

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes - hours * 60
  if (hours < 24) return `${hours}h ${String(minutes).padStart(2, '0')}m`

  const days = Math.floor(hours / 24)
  return `${days}d ${String(hours - days * 24).padStart(2, '0')}h`
}

/**
 * "just now" / "5m ago" / "3h ago" / "2d ago", falling back to a short date
 * once something is more than a week old.
 */
export function relativeTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return ''
  const diff = Date.now() - epochMs

  if (diff < 0) {
    const ahead = -diff
    if (ahead < 60_000) return 'just now'
    if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)}m`
    if (ahead < 86_400_000) return `in ${Math.round(ahead / 3_600_000)}h`
    return new Date(epochMs).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    })
  }

  if (diff < 45_000) return 'just now'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`

  const date = new Date(epochMs)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

/**
 * Collapse the middle of a long string so both ends stay readable.
 *   truncateMiddle('abcdefghij', 7) -> 'abc…hij'
 */
export function truncateMiddle(s: string, max: number): string {
  if (typeof s !== 'string') return ''
  if (!Number.isFinite(max) || max <= 0) return ''
  if (s.length <= max) return s
  if (max === 1) return '…'
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ''}`
}

/**
 * Last two path segments of a Windows (or POSIX) absolute path.
 *   'C:\\Users\\Hp\\Dev\\opencode-desktop' -> 'Dev\\opencode-desktop'
 *   'C:\\'                                 -> 'C:\\'
 */
export function shortPath(absPath: string): string {
  if (typeof absPath !== 'string' || absPath.length === 0) return ''
  const cleaned = absPath.replace(/[\\/]+$/, '')
  const segments = cleaned.split(/[\\/]+/).filter((seg) => seg.length > 0)
  if (segments.length === 0) return absPath
  if (segments.length === 1) {
    const only = segments[0] as string
    return /^[A-Za-z]:$/.test(only) ? `${only}\\` : only
  }
  return segments.slice(-2).join('\\')
}
