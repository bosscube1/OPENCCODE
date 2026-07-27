/**
 * Detects file references (and optional line/column) inside arbitrary agent output text, so the
 * UI can turn them into clickable links that open the user's real external editor.
 *
 * PURE MODULE. No React, no store, no IPC. Only string/regex logic — safe to unit-test in
 * isolation and safe to call during render.
 */

export type FileRef = {
  /** POSIX-separated path, relative to `directory` when the source text used an absolute path. */
  path: string
  line?: number
  column?: number
  /** Character offset into the original `text` where the match starts (inclusive). */
  start: number
  /** Character offset into the original `text` where the match ends (exclusive). */
  end: number
}

/**
 * Extensions we treat as "this looks like source/config, not prose." Deliberately excludes things
 * like `.com`, `.log`, `.io` etc. so URLs and stray words never masquerade as file references.
 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'hh', 'cpp', 'cc', 'cxx', 'hpp', 'hxx', 'cs',
  'rb', 'php', 'swift', 'scala',
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'md', 'mdx', 'txt',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg',
  'sql', 'vue', 'svelte', 'graphql', 'proto', 'lock', 'env'
])

// A single path segment: letters, digits, dot, underscore, hyphen. Dots are allowed so
// multi-dot filenames (`foo.test.ts`) still parse — the trailing extension is validated
// separately against CODE_EXTENSIONS.
const SEGMENT = String.raw`[A-Za-z0-9_.-]+`

// A path with at least one directory separator, optionally starting with "./" or ".\".
const PATH_WITH_DIR = String.raw`(?:\.[\\/])?(?:${SEGMENT}[\\/])+${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,9}`

// A bare filename with a known extension and no directory component.
const PATH_BARE = String.raw`${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,9}`

const LINE_COL = String.raw`(?::(\d+)(?::(\d+))?)?`

const RELATIVE_RE = new RegExp(`(?:${PATH_WITH_DIR}|${PATH_BARE})${LINE_COL}`, 'g')

// Windows drive-letter absolute paths, e.g. `C:\Users\me\foo.ts` or `C:/Users/me/foo.ts`.
const WINDOWS_ABS_RE = new RegExp(
  String.raw`[A-Za-z]:[\\/](?:${SEGMENT}[\\/])*${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,9}${LINE_COL}`,
  'g'
)

// POSIX absolute paths, e.g. `/home/me/foo.ts`.
const POSIX_ABS_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_./\\-])/(?:${SEGMENT}/)*${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,9}${LINE_COL}`,
  'g'
)

type Range = { start: number; end: number }

function overlapsAny(start: number, end: number, ranges: readonly Range[]): boolean {
  return ranges.some((r) => start < r.end && end > r.start)
}

/** Backslashes -> forward slashes, so returned paths are always POSIX-separated. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function stripTrailingSlashes(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

/**
 * If `absPath` lies strictly inside `directory`, returns the POSIX-separated path relative to
 * `directory`. Otherwise returns null. Comparison is case-insensitive (Windows paths) and works
 * purely on strings — no filesystem access, so this stays safe to run in the renderer.
 */
function relativeIfContained(absPath: string, directory: string): string | null {
  if (!directory) return null
  const normAbs = toPosix(absPath)
  const normDir = stripTrailingSlashes(toPosix(directory))
  if (normDir.length === 0) return null
  const lowerAbs = normAbs.toLowerCase()
  const lowerDir = normDir.toLowerCase()
  if (!lowerAbs.startsWith(`${lowerDir}/`)) return null
  const rel = normAbs.slice(normDir.length + 1)
  return rel.length > 0 ? rel : null
}

function parseLineCol(match: RegExpExecArray): { line?: number; column?: number } {
  const line = match[1] !== undefined ? Number(match[1]) : undefined
  const column = match[2] !== undefined ? Number(match[2]) : undefined
  return {
    ...(line !== undefined && Number.isFinite(line) ? { line } : {}),
    ...(column !== undefined && Number.isFinite(column) ? { column } : {})
  }
}

/** Strips a trailing `:line` / `:line:col` suffix off a raw regex match, returning the bare path text. */
function stripLineCol(raw: string): string {
  return raw.replace(/(?::\d+){1,2}$/, '')
}

function hasKnownExtension(pathText: string): boolean {
  const dot = pathText.lastIndexOf('.')
  if (dot < 0 || dot === pathText.length - 1) return false
  const ext = pathText.slice(dot + 1).toLowerCase()
  return CODE_EXTENSIONS.has(ext)
}

/** True when `text[0..start)` ends in a URL scheme immediately preceding the candidate match. */
function precededByUrlScheme(text: string, start: number): boolean {
  const before = text.slice(0, start)
  return /:\/\/[^\s]*$/.test(before)
}

export function findFileRefs(text: string, directory: string): FileRef[] {
  if (typeof text !== 'string' || text.length === 0) return []

  const refs: FileRef[] = []
  const consumed: Range[] = []

  // Pass 1: absolute paths (Windows drive-letter and POSIX). Every span here — whether it
  // resolves inside `directory` or not — is marked consumed so pass 2 never re-matches a
  // trailing fragment of it (e.g. the "System32\foo.ts" tail of an outside-project path).
  for (const re of [WINDOWS_ABS_RE, POSIX_ABS_RE]) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      const raw = match[0]
      const start = match.index
      const end = start + raw.length
      if (overlapsAny(start, end, consumed)) continue
      consumed.push({ start, end })

      if (precededByUrlScheme(text, start)) continue

      const pathText = stripLineCol(raw)
      if (!hasKnownExtension(pathText)) continue

      const rel = relativeIfContained(pathText, directory)
      if (rel === null) continue // outside the project directory — never linkified

      refs.push({ path: toPosix(rel), ...parseLineCol(match), start, end })
    }
  }

  // Pass 2: relative paths (./foo, src/foo.ts, bare foo.ts).
  RELATIVE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = RELATIVE_RE.exec(text)) !== null) {
    const raw = match[0]
    const start = match.index
    const end = start + raw.length
    if (overlapsAny(start, end, consumed)) continue

    if (precededByUrlScheme(text, start)) continue

    const pathText = stripLineCol(raw)
    if (!hasKnownExtension(pathText)) continue

    refs.push({ path: toPosix(pathText), ...parseLineCol(match), start, end })
  }

  refs.sort((a, b) => a.start - b.start)
  return refs
}
