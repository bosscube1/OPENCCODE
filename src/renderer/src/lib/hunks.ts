/**
 * Hunk-level accept / reject arithmetic for the code-review surface.
 *
 * PURE MODULE. No React, no store, no IPC, no `node:` imports, no filesystem. Only string
 * and number logic — safe to unit-test in isolation and safe to call during render.
 *
 * Why this file is dangerous, and how it defends itself
 * -----------------------------------------------------
 * Everything here decides what actually lands in the user's source files. A wrong line
 * offset does not crash — it produces plausible-looking output that still compiles and is
 * silently wrong. So:
 *
 *  - `applyHunksToText` VERIFIES every context and deletion line against the real file text
 *    before consuming it, and THROWS on mismatch rather than applying to the wrong place.
 *  - `selectedHunksToPatch` recomputes the new-side line numbers of every emitted hunk from
 *    scratch, so dropping a hunk can never leave a stale `@@` header behind.
 *  - Both functions derive their line counts from `hunk.lines` (the body we actually emit /
 *    consume) rather than from the declared `oldLines`/`newLines`, so a hunk's header can
 *    never disagree with its body. That shared derivation is what keeps the two functions
 *    in lock-step.
 *
 * Line endings
 * ------------
 * A unified diff separates its own structural lines with LF. A CRLF source file therefore
 * shows up as content lines that each END WITH `\r`, and that `\r` is part of `DiffLine.text`.
 * We never strip it and never normalise it: split on `\n`, join on `\n`, and CRLF survives
 * byte-for-byte. This is a Windows-first app; CRLF files are the normal case.
 *
 * Hunk identity
 * -------------
 * `id` is `` `${oldStart}-${newStart}` `` — byte-identical to the scheme in
 * `src/main/gitService.ts`, because the renderer selects hunk ids that are then reconciled
 * against main-side diffs. This module deliberately does NOT import from `src/main/**`
 * (that process boundary may not be crossed); the schemes are kept in sync by contract.
 */

import type { DiffLine, FileDiff, Hunk } from '../../../preload'

/* ------------------------------------------------------------------ */
/* no-newline-at-EOF bookkeeping                                       */
/* ------------------------------------------------------------------ */

const NO_NEWLINE_MARKER = '\\ No newline at end of file'

/**
 * `Hunk` (locked by CONTRACTS.md) has nowhere to record "this side of the file does not end
 * with a newline", but the information is load-bearing: without it, accepting the final hunk
 * of a file that lacks a trailing newline silently adds one.
 *
 * So `parseUnifiedDiff` attaches these two optional flags to the hunks it produces. They are
 * structurally compatible with `Hunk` (extra properties), survive `structuredClone` across
 * IPC, and are read defensively — a `FileDiff` produced elsewhere (e.g. the main-process
 * parser, which drops `\ No newline at end of file` lines) simply has neither flag.
 *
 * Fallback when a flag is absent: standard unified-diff semantics — no marker means the side
 * DOES end with a newline. `selectedHunksToPatch` and `applyHunksToText` share that fallback,
 * so they agree with each other even on a diff that lost its markers.
 */
export type HunkEofFlags = {
  /** The old side's last line had no trailing newline. */
  oldNoEofNewline?: boolean
  /** The new side's last line has no trailing newline. */
  newNoEofNewline?: boolean
}

/** A hunk as produced by this module's parser. */
export type ParsedHunk = Hunk & HunkEofFlags

function eofFlags(hunk: Hunk): Required<HunkEofFlags> {
  const candidate = hunk as ParsedHunk
  return {
    oldNoEofNewline: candidate.oldNoEofNewline === true,
    newNoEofNewline: candidate.newNoEofNewline === true
  }
}

/* ------------------------------------------------------------------ */
/* line splitting                                                      */
/* ------------------------------------------------------------------ */

export type SplitText = { lines: string[]; trailingNewline: boolean }

/**
 * Split on LF only. `\r` stays attached to the line it belongs to, so CRLF round-trips.
 * The final newline is recorded as a flag rather than as a phantom empty last line.
 */
export function splitLines(text: string): SplitText {
  if (text.length === 0) return { lines: [], trailingNewline: false }
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') {
    parts.pop()
    return { lines: parts, trailingNewline: true }
  }
  return { lines: parts, trailingNewline: false }
}

function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) return ''
  return lines.join('\n') + (trailingNewline ? '\n' : '')
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

function stripPrefix(p: string): string {
  if (p === '/dev/null') return p
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2)
  return p
}

/** `--- a/foo.ts\t2024-01-01` → `foo.ts`. */
function headerPath(rest: string): string {
  const untabbed = rest.split('\t')[0] as string
  return stripPrefix(untabbed.trim())
}

/**
 * Parse a unified diff for a single file.
 *
 * `truncated` is always `false`: the renderer never caps a diff. Only the main process does
 * (at MAX_DIFF_LINES), and it sets the flag on the `FileDiff` it sends.
 */
export function parseUnifiedDiff(text: string): FileDiff {
  const diff: FileDiff = { path: '', binary: false, truncated: false, hunks: [] }
  let current: ParsedHunk | null = null
  /** Kind of the most recent body line, so a `\ No newline` marker can be attributed. */
  let lastKind: DiffLine['kind'] | null = null

  const body = text.endsWith('\n') ? text.slice(0, -1) : text

  for (const line of body.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null
      lastKind = null
      // `a/<old> b/<new>`. The lazy first group finds the earliest ` b/` split, which is
      // correct even for paths containing spaces or a literal `b/` segment.
      const pair = /^a\/(.*?) b\/(.*)$/.exec(line.slice('diff --git '.length))
      if (pair) {
        diff.oldPath = pair[1] as string
        diff.path = pair[2] as string
      }
      continue
    }
    if (line.startsWith('rename from ')) {
      diff.oldPath = stripPrefix(line.slice('rename from '.length))
      continue
    }
    if (line.startsWith('rename to ')) {
      diff.path = stripPrefix(line.slice('rename to '.length))
      continue
    }
    if (line.startsWith('copy from ')) {
      diff.oldPath = stripPrefix(line.slice('copy from '.length))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      diff.binary = true
      diff.hunks = []
      if (diff.oldPath === diff.path) delete diff.oldPath
      return diff
    }
    if (line.startsWith('--- ')) {
      const p = headerPath(line.slice(4))
      if (p !== '/dev/null' && diff.oldPath === undefined) diff.oldPath = p
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = headerPath(line.slice(4))
      if (p !== '/dev/null') diff.path = p
      continue
    }
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!match) continue
      const oldStart = Number(match[1])
      const oldLines = match[2] === undefined ? 1 : Number(match[2])
      const newStart = Number(match[3])
      const newLines = match[4] === undefined ? 1 : Number(match[4])
      current = {
        id: `${oldStart}-${newStart}`,
        header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: []
      }
      lastKind = null
      diff.hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" annotates the line immediately above it.
      if (lastKind === 'del' || lastKind === 'ctx') current.oldNoEofNewline = true
      if (lastKind === 'add' || lastKind === 'ctx') current.newNoEofNewline = true
      continue
    }
    const marker = line[0]
    if (marker === '+') {
      current.lines.push({ kind: 'add', text: line.slice(1) })
      lastKind = 'add'
    } else if (marker === '-') {
      current.lines.push({ kind: 'del', text: line.slice(1) })
      lastKind = 'del'
    } else if (marker === ' ' || line.length === 0) {
      current.lines.push({ kind: 'ctx', text: line.slice(1) })
      lastKind = 'ctx'
    }
    // Anything else (index lines, mode lines, "similarity index", trailing junk) is ignored.
  }

  if (diff.oldPath === diff.path) delete diff.oldPath
  return diff
}

/* ------------------------------------------------------------------ */
/* shared derivation — the reason the two functions below agree        */
/* ------------------------------------------------------------------ */

type HunkCounts = {
  /** Lines this hunk consumes from the old file (ctx + del). */
  oldCount: number
  /** Lines this hunk contributes to the new file (ctx + add). */
  newCount: number
}

function countHunk(hunk: Hunk): HunkCounts {
  let oldCount = 0
  let newCount = 0
  for (const line of hunk.lines) {
    if (line.kind === 'ctx') {
      oldCount += 1
      newCount += 1
    } else if (line.kind === 'del') {
      oldCount += 1
    } else {
      newCount += 1
    }
  }
  return { oldCount, newCount }
}

/**
 * 0-based index into the OLD file where this hunk's block begins.
 *
 * Unified diffs use two conventions for the start field and getting this wrong is exactly
 * the off-by-one that silently corrupts files:
 *  - a non-empty old range `-a,n` starts at 1-based line `a`      → index `a - 1`
 *  - an EMPTY old range `-a,0` means "insert AFTER old line `a`"  → index `a`
 *    (so a whole-file creation is `-0,0`, i.e. index 0)
 */
function oldIndexOf(hunk: Hunk, oldCount: number): number {
  return oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1
}

/** Hunks of `diff` whose id is in `hunkIds`, in diff order, deduped, empty bodies dropped. */
function pickHunks(diff: FileDiff, hunkIds: readonly string[]): Hunk[] {
  const wanted = new Set(hunkIds)
  return diff.hunks.filter((h) => wanted.has(h.id) && h.lines.length > 0)
}

/** A whole-file creation: one hunk, nothing on the old side. */
function isCreation(diff: FileDiff): boolean {
  if (diff.hunks.length !== 1) return false
  const only = diff.hunks[0] as Hunk
  return only.oldStart === 0 && countHunk(only).oldCount === 0
}

/** A whole-file deletion: one hunk, nothing on the new side. */
function isDeletion(diff: FileDiff): boolean {
  if (diff.hunks.length !== 1) return false
  const only = diff.hunks[0] as Hunk
  return only.newStart === 0 && countHunk(only).newCount === 0
}

/* ------------------------------------------------------------------ */
/* patch emission                                                      */
/* ------------------------------------------------------------------ */

/**
 * Emit a unified diff containing ONLY the selected hunks, suitable for `git apply --cached -`.
 *
 * **Header recomputation.** The old side is untouched — the patch is applied against the
 * unmodified original, so every emitted `-a,b` keeps the hunk's original `oldStart`. The new
 * side is rebuilt: a running `delta` accumulates `newCount - oldCount` over the SELECTED
 * hunks only, and each emitted `newStart` is that hunk's old index shifted by `delta`.
 * Dropping a hunk therefore removes its contribution to every later header, which is exactly
 * what keeps the patch appliable.
 *
 * Returns `''` for a binary diff or an empty selection.
 * Throws when the diff has no path (there is nothing safe to name in the patch header).
 */
export function selectedHunksToPatch(diff: FileDiff, hunkIds: string[]): string {
  if (diff.binary) return ''
  const picked = pickHunks(diff, hunkIds)
  if (picked.length === 0) return ''
  if (diff.path.length === 0) {
    throw new Error('selectedHunksToPatch: FileDiff.path is empty; refusing to emit a patch.')
  }

  const oldPath = diff.oldPath ?? diff.path
  const creation = isCreation(diff)
  const deletion = isDeletion(diff)
  const out: string[] = [`diff --git a/${oldPath} b/${diff.path}`]
  // git apply only honours a `/dev/null` side when the extended header declares the
  // create/delete. Without it, `-p1` strips `/dev/null` to `dev/null` and git creates a
  // stray `dev/` directory instead of adding or removing the file. `FileDiff` carries no
  // file mode, so the ubiquitous 100644 is assumed; a mode mismatch is only a git warning.
  if (creation) out.push('new file mode 100644')
  if (deletion) out.push('deleted file mode 100644')
  out.push(creation ? '--- /dev/null' : `--- a/${oldPath}`)
  out.push(deletion ? '+++ /dev/null' : `+++ b/${diff.path}`)

  let delta = 0
  for (const hunk of picked) {
    const { oldCount, newCount } = countHunk(hunk)
    const oldIndex = oldIndexOf(hunk, oldCount)
    const newIndex = oldIndex + delta
    // Mirror of `oldIndexOf`: an empty new range names the line BEFORE the insertion point.
    const newStart = newCount === 0 ? newIndex : newIndex + 1
    out.push(`@@ -${hunk.oldStart},${oldCount} +${newStart},${newCount} @@`)

    // A `\ No newline at end of file` marker annotates the LAST line of the side it applies
    // to, which may be a different line for the old and the new side.
    let lastOldIdx = -1
    let lastNewIdx = -1
    hunk.lines.forEach((line, i) => {
      if (line.kind !== 'add') lastOldIdx = i
      if (line.kind !== 'del') lastNewIdx = i
    })
    const flags = eofFlags(hunk)

    hunk.lines.forEach((line, i) => {
      const prefix = line.kind === 'ctx' ? ' ' : line.kind === 'add' ? '+' : '-'
      out.push(prefix + line.text)
      const markOld = i === lastOldIdx && flags.oldNoEofNewline
      const markNew = i === lastNewIdx && flags.newNoEofNewline
      // One marker even when a single context line carries both sides.
      if (markOld || markNew) out.push(NO_NEWLINE_MARKER)
    })

    delta += newCount - oldCount
  }

  return out.map((line) => line + '\n').join('')
}

/* ------------------------------------------------------------------ */
/* in-memory application                                               */
/* ------------------------------------------------------------------ */

/**
 * Apply only the selected hunks to `original` and return the resulting text.
 *
 * Byte-for-byte equivalent to running `selectedHunksToPatch(diff, hunkIds)` through
 * `git apply` against the same `original`. That mutual consistency is the whole point:
 * "accept these hunks in the editor" and "stage these hunks" must never diverge.
 *
 * Returns `original` unchanged for a binary diff or an empty selection.
 *
 * @throws if a hunk's context/deletion lines do not match `original`, if hunks overlap or
 *   are out of order, or if a hunk runs past the end of `original`. Refusing loudly is the
 *   point — applying a stale hunk to the wrong offset corrupts the file silently.
 */
export function applyHunksToText(original: string, diff: FileDiff, hunkIds: string[]): string {
  if (diff.binary) return original
  const picked = pickHunks(diff, hunkIds)
  if (picked.length === 0) return original

  const { lines: origLines, trailingNewline } = splitLines(original)
  const out: string[] = []
  let cursor = 0

  for (const hunk of picked) {
    const { oldCount } = countHunk(hunk)
    const start = oldIndexOf(hunk, oldCount)
    if (start < cursor) {
      throw new Error(
        `applyHunksToText: hunk ${hunk.id} starts at old line ${start + 1}, before the previous ` +
          `hunk ended (line ${cursor + 1}). Hunks must be non-overlapping and in order.`
      )
    }
    if (start + oldCount > origLines.length) {
      throw new Error(
        `applyHunksToText: hunk ${hunk.id} needs old lines ${start + 1}..${start + oldCount} ` +
          `but the file has ${origLines.length}. The diff is stale.`
      )
    }

    for (let i = cursor; i < start; i += 1) out.push(origLines[i] as string)

    let oi = start
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        out.push(line.text)
        continue
      }
      const actual = origLines[oi] as string
      if (actual !== line.text) {
        throw new Error(
          `applyHunksToText: hunk ${hunk.id} does not match the file at line ${oi + 1}. ` +
            'The diff is stale; refusing to apply.'
        )
      }
      if (line.kind === 'ctx') out.push(line.text)
      oi += 1
    }

    cursor = start + oldCount
  }

  const reachedEof = cursor === origLines.length
  for (let i = cursor; i < origLines.length; i += 1) out.push(origLines[i] as string)
  if (out.length === 0) return ''

  const last = picked[picked.length - 1] as Hunk
  // If the final selected hunk owns the end of the file, the diff decides whether the result
  // ends with a newline. Absent a `\ No newline` marker, unified-diff semantics say it does —
  // and that is exactly what `git apply` would do with the patch we emit.
  const trailing = reachedEof ? !eofFlags(last).newNoEofNewline : trailingNewline
  return joinLines(out, trailing)
}
