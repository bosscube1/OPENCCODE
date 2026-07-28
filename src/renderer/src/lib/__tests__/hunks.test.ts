import { describe, it, expect } from 'vitest'
import type { FileDiff } from '../../../../preload'
import { parseUnifiedDiff, selectedHunksToPatch, applyHunksToText } from '../hunks'

/* ================================================================== *
 * Reference patch applier — deliberately INDEPENDENT of hunks.ts.
 *
 * It re-derives everything from the emitted patch text alone and asserts
 * the two things git would assert:
 *   1. every hunk header's counts match its own body, and
 *   2. every hunk's `newStart` describes the position it actually lands
 *      at in the output being built.
 *
 * (2) is the stale-offset check. If `selectedHunksToPatch` forgot to
 * recompute a header after dropping a hunk, this throws.
 * ================================================================== */

function applyPatchText(original: string, patch: string): string {
  if (patch.length === 0) return original

  const orig = original.length === 0 ? [] : original.split('\n')
  let origTrailing = false
  if (orig.length > 0 && orig[orig.length - 1] === '') {
    orig.pop()
    origTrailing = true
  }

  const patchLines = patch.split('\n')
  if (patchLines[patchLines.length - 1] === '') patchLines.pop()

  const out: string[] = []
  let cursor = 0
  let trailing = origTrailing

  let i = 0
  while (i < patchLines.length && !(patchLines[i] as string).startsWith('@@')) i += 1
  if (i === patchLines.length) throw new Error('patch has no hunks')

  while (i < patchLines.length) {
    const header = patchLines[i] as string
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(header)
    if (!m) throw new Error(`malformed hunk header: ${header}`)
    const oldStart = Number(m[1])
    const oldCount = Number(m[2])
    const newStart = Number(m[3])
    const newCount = Number(m[4])
    i += 1

    const body: string[] = []
    while (i < patchLines.length && !(patchLines[i] as string).startsWith('@@')) {
      body.push(patchLines[i] as string)
      i += 1
    }

    const content = body.filter((b) => !b.startsWith('\\'))
    const bodyOld = content.filter((b) => b.startsWith(' ') || b.startsWith('-')).length
    const bodyNew = content.filter((b) => b.startsWith(' ') || b.startsWith('+')).length
    if (bodyOld !== oldCount) throw new Error(`header says -${oldCount} but body has ${bodyOld}`)
    if (bodyNew !== newCount) throw new Error(`header says +${newCount} but body has ${bodyNew}`)

    const start = oldCount === 0 ? oldStart : oldStart - 1
    if (start < cursor) throw new Error(`hunk at -${oldStart} goes backwards`)
    const expectedNewStart = out.length + (start - cursor) + (newCount === 0 ? 0 : 1)
    if (newStart !== expectedNewStart) {
      throw new Error(`stale newStart in "${header}": expected +${expectedNewStart}`)
    }

    for (let k = cursor; k < start; k += 1) out.push(orig[k] as string)

    let oi = start
    let newNoEof = false
    for (let k = 0; k < body.length; k += 1) {
      const b = body[k] as string
      if (b.startsWith('\\')) continue
      const marked = typeof body[k + 1] === 'string' && (body[k + 1] as string).startsWith('\\')
      const prefix = b[0]
      const text = b.slice(1)
      if (prefix === '+') {
        out.push(text)
        if (marked) newNoEof = true
      } else if (prefix === '-') {
        if (orig[oi] !== text) throw new Error(`patch context mismatch at old line ${oi + 1}`)
        oi += 1
      } else if (prefix === ' ') {
        if (orig[oi] !== text) throw new Error(`patch context mismatch at old line ${oi + 1}`)
        oi += 1
        out.push(text)
        if (marked) newNoEof = true
      } else {
        throw new Error(`malformed patch body line: ${JSON.stringify(b)}`)
      }
    }

    cursor = start + oldCount
    if (cursor === orig.length) trailing = !newNoEof
  }

  for (let k = cursor; k < orig.length; k += 1) out.push(orig[k] as string)
  if (out.length === 0) return ''
  return out.join('\n') + (trailing ? '\n' : '')
}

/** The property that matters most: the two functions must describe the same file. */
function expectConsistent(original: string, diff: FileDiff, ids: string[]): string {
  const applied = applyHunksToText(original, diff, ids)
  const patch = selectedHunksToPatch(diff, ids)
  expect(applyPatchText(original, patch)).toBe(applied)
  return applied
}

/** Every subset of `ids`, including the empty set and the full set. */
function subsets(ids: string[]): string[][] {
  const all: string[][] = []
  for (let mask = 0; mask < 1 << ids.length; mask += 1) {
    const pick: string[] = []
    ids.forEach((id, i) => {
      if (mask & (1 << i)) pick.push(id)
    })
    all.push(pick)
  }
  return all
}

/* ================================================================== *
 * Fixtures — captured verbatim from real `git diff` output.
 * ================================================================== */

const MULTI_ORIGINAL = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n'

const MULTI_DIFF = [
  'diff --git a/multi.txt b/multi.txt',
  'index 86bba90..78c91c8 100644',
  '--- a/multi.txt',
  '+++ b/multi.txt',
  '@@ -1,4 +1,4 @@',
  '-l1',
  '+L1-changed',
  ' l2',
  ' l3',
  ' l4',
  '@@ -7,8 +7,9 @@ l6',
  ' l7',
  ' l8',
  ' l9',
  '-l10',
  '-l11',
  '+L10-changed',
  '+inserted-a',
  '+inserted-b',
  ' l12',
  ' l13',
  ' l14',
  '@@ -17,4 +18,4 @@ l16',
  ' l17',
  ' l18',
  ' l19',
  '-l20',
  '+L20-changed',
  ''
].join('\n')

const MULTI_NEW =
  ['L1-changed', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9']
    .concat(['L10-changed', 'inserted-a', 'inserted-b'])
    .concat(['l12', 'l13', 'l14', 'l15', 'l16', 'l17', 'l18', 'l19', 'L20-changed'])
    .join('\n') + '\n'

/** Pure-addition hunk, then a mixed hunk, then a pure-deletion hunk. */
const SHIFT_ORIGINAL = Array.from({ length: 24 }, (_, i) => `l${i + 1}`).join('\n') + '\n'

const SHIFT_DIFF = [
  'diff --git a/shift.txt b/shift.txt',
  'index d487215..966f43d 100644',
  '--- a/shift.txt',
  '+++ b/shift.txt',
  '@@ -1,4 +1,6 @@',
  ' l1',
  '+add-a',
  '+add-b',
  ' l2',
  ' l3',
  ' l4',
  '@@ -7,7 +9,8 @@ l6',
  ' l7',
  ' l8',
  ' l9',
  '-l10',
  '+L10-changed',
  '+extra',
  ' l11',
  ' l12',
  ' l13',
  '@@ -17,8 +20,6 @@ l16',
  ' l17',
  ' l18',
  ' l19',
  '-l20',
  '-l21',
  ' l22',
  ' l23',
  ' l24',
  ''
].join('\n')

/** Same change as SHIFT_DIFF, emitted with -U0: adjacent, zero-context hunks. */
const SHIFT_DIFF_U0 = [
  'diff --git a/shift.txt b/shift.txt',
  '--- a/shift.txt',
  '+++ b/shift.txt',
  '@@ -1,0 +2,2 @@ l1',
  '+add-a',
  '+add-b',
  '@@ -10 +12,2 @@ l9',
  '-l10',
  '+L10-changed',
  '+extra',
  '@@ -20,2 +22,0 @@ l19',
  '-l20',
  '-l21',
  ''
].join('\n')

const CREATED_DIFF = [
  'diff --git a/created.txt b/created.txt',
  'new file mode 100644',
  'index 0000000..1b02cb2',
  '--- /dev/null',
  '+++ b/created.txt',
  '@@ -0,0 +1,3 @@',
  '+new1',
  '+new2',
  '+new3',
  ''
].join('\n')

const DELETED_DIFF = [
  'diff --git a/del.txt b/del.txt',
  'deleted file mode 100644',
  'index 6c542ab..0000000',
  '--- a/del.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-only',
  ''
].join('\n')

const NOEOL_ORIGINAL = 'x\ny\nz'
const NOEOL_DIFF = [
  'diff --git a/noeol.txt b/noeol.txt',
  'index 66455a1..19e07a9 100644',
  '--- a/noeol.txt',
  '+++ b/noeol.txt',
  '@@ -1,3 +1,3 @@',
  ' x',
  ' y',
  '-z',
  '\\ No newline at end of file',
  '+ZZZ',
  '\\ No newline at end of file',
  ''
].join('\n')

const CRLF_ORIGINAL = 'a\r\nb\r\nc\r\nd\r\ne\r\n'
const CRLF_DIFF = [
  'diff --git a/crlf.txt b/crlf.txt',
  '--- a/crlf.txt',
  '+++ b/crlf.txt',
  '@@ -1,5 +1,5 @@',
  ' a\r',
  '-b\r',
  '+B-CHANGED\r',
  ' c\r',
  ' d\r',
  ' e\r',
  ''
].join('\n')

/* ================================================================== *
 * parseUnifiedDiff
 * ================================================================== */

describe('parseUnifiedDiff', () => {
  it('returns an empty FileDiff for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual({
      path: '',
      binary: false,
      truncated: false,
      hunks: []
    })
  })

  it('never sets truncated — the renderer does not cap', () => {
    expect(parseUnifiedDiff(MULTI_DIFF).truncated).toBe(false)
    expect(parseUnifiedDiff(CREATED_DIFF).truncated).toBe(false)
  })

  it('parses path, hunk count, ids and headers', () => {
    const diff = parseUnifiedDiff(MULTI_DIFF)
    expect(diff.path).toBe('multi.txt')
    expect(diff.oldPath).toBeUndefined()
    expect(diff.binary).toBe(false)
    expect(diff.hunks.map((h) => h.id)).toEqual(['1-1', '7-7', '17-18'])
    expect(diff.hunks.map((h) => h.header)).toEqual([
      '@@ -1,4 +1,4 @@',
      '@@ -7,8 +7,9 @@',
      '@@ -17,4 +18,4 @@'
    ])
  })

  it('uses the same id scheme as the main-process parser (`oldStart-newStart`)', () => {
    for (const h of parseUnifiedDiff(SHIFT_DIFF).hunks) {
      expect(h.id).toBe(`${h.oldStart}-${h.newStart}`)
    }
  })

  it('classifies ctx/add/del lines and strips the marker column', () => {
    const hunk = parseUnifiedDiff(MULTI_DIFF).hunks[1]!
    expect(hunk.lines.slice(0, 5)).toEqual([
      { kind: 'ctx', text: 'l7' },
      { kind: 'ctx', text: 'l8' },
      { kind: 'ctx', text: 'l9' },
      { kind: 'del', text: 'l10' },
      { kind: 'del', text: 'l11' }
    ])
  })

  it('defaults an omitted range length to 1', () => {
    const diff = parseUnifiedDiff(SHIFT_DIFF_U0)
    expect(diff.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 0, 2, 2],
      [10, 1, 12, 2],
      [20, 2, 22, 0]
    ])
  })

  it('detects binary diffs and empties the hunks', () => {
    const diff = parseUnifiedDiff(
      ['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ', ''].join(
        '\n'
      )
    )
    expect(diff.binary).toBe(true)
    expect(diff.hunks).toEqual([])
    expect(diff.path).toBe('logo.png')
  })

  it('detects a GIT binary patch', () => {
    const diff = parseUnifiedDiff(
      ['diff --git a/x.bin b/x.bin', 'GIT binary patch', 'literal 4', ''].join('\n')
    )
    expect(diff.binary).toBe(true)
    expect(diff.hunks).toEqual([])
  })

  it('records oldPath for a rename and keeps the hunks', () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git a/old/name.ts b/new/name.ts',
        'similarity index 88%',
        'rename from old/name.ts',
        'rename to new/name.ts',
        '--- a/old/name.ts',
        '+++ b/new/name.ts',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-before',
        '+after',
        ''
      ].join('\n')
    )
    expect(diff.oldPath).toBe('old/name.ts')
    expect(diff.path).toBe('new/name.ts')
    expect(diff.hunks).toHaveLength(1)
  })

  it('does not set oldPath when the path is unchanged', () => {
    expect(parseUnifiedDiff(SHIFT_DIFF).oldPath).toBeUndefined()
    expect(parseUnifiedDiff(CREATED_DIFF).oldPath).toBeUndefined()
    expect(parseUnifiedDiff(DELETED_DIFF).oldPath).toBeUndefined()
  })

  it('splits `diff --git` correctly for paths containing spaces and b/ segments', () => {
    const spaced = parseUnifiedDiff('diff --git a/my dir/f.ts b/my dir/f.ts\n')
    expect(spaced.path).toBe('my dir/f.ts')
    expect(spaced.oldPath).toBeUndefined()

    const nested = parseUnifiedDiff('diff --git a/b/x.ts b/b/x.ts\n')
    expect(nested.path).toBe('b/x.ts')
    expect(nested.oldPath).toBeUndefined()
  })

  it('ignores /dev/null in the --- and +++ headers', () => {
    expect(parseUnifiedDiff(CREATED_DIFF).path).toBe('created.txt')
    expect(parseUnifiedDiff(DELETED_DIFF).path).toBe('del.txt')
  })

  it('strips a trailing tab-separated timestamp from --- / +++', () => {
    const diff = parseUnifiedDiff(
      ['--- a/t.ts\t2024-01-01 00:00:00', '+++ b/t.ts\t2024-01-02 00:00:00', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join(
        '\n'
      )
    )
    expect(diff.path).toBe('t.ts')
  })

  it('does not turn "\\ No newline at end of file" into a content line', () => {
    const hunk = parseUnifiedDiff(NOEOL_DIFF).hunks[0]!
    expect(hunk.lines).toEqual([
      { kind: 'ctx', text: 'x' },
      { kind: 'ctx', text: 'y' },
      { kind: 'del', text: 'z' },
      { kind: 'add', text: 'ZZZ' }
    ])
  })

  it('keeps the \\r of a CRLF file inside the line text', () => {
    const hunk = parseUnifiedDiff(CRLF_DIFF).hunks[0]!
    expect(hunk.lines.map((l) => l.text)).toEqual([
      'a\r',
      'b\r',
      'B-CHANGED\r',
      'c\r',
      'd\r',
      'e\r'
    ])
  })

  it('treats a bare empty line inside a hunk as empty context', () => {
    const diff = parseUnifiedDiff(['@@ -1,2 +1,2 @@', '', '-a', '+b', ''].join('\n'))
    expect(diff.hunks[0]!.lines[0]).toEqual({ kind: 'ctx', text: '' })
  })

  it('tolerates input with no trailing newline', () => {
    expect(parseUnifiedDiff(MULTI_DIFF.replace(/\n$/, ''))).toEqual(parseUnifiedDiff(MULTI_DIFF))
  })
})

/* ================================================================== *
 * round trip: parse -> select all -> apply
 * ================================================================== */

describe('round trip (select every hunk)', () => {
  const cases: Array<[string, string, string]> = [
    ['multi-hunk', MULTI_DIFF, MULTI_ORIGINAL],
    ['shift (add / mixed / delete)', SHIFT_DIFF, SHIFT_ORIGINAL],
    ['zero-context (-U0)', SHIFT_DIFF_U0, SHIFT_ORIGINAL],
    ['creation', CREATED_DIFF, ''],
    ['deletion', DELETED_DIFF, 'only\n'],
    ['no trailing newline', NOEOL_DIFF, NOEOL_ORIGINAL],
    ['CRLF', CRLF_DIFF, CRLF_ORIGINAL]
  ]

  for (const [name, text, original] of cases) {
    it(`${name}: applying all hunks reproduces the new side`, () => {
      const diff = parseUnifiedDiff(text)
      const ids = diff.hunks.map((h) => h.id)
      const applied = expectConsistent(original, diff, ids)
      // The emitted patch must also reproduce the ORIGINAL headers when nothing is dropped.
      const patch = selectedHunksToPatch(diff, ids)
      const emitted = patch.split('\n').filter((l) => l.startsWith('@@'))
      expect(emitted).toEqual(diff.hunks.map((h) => h.header))
      expect(applied).not.toBe(original)
    })
  }

  it('multi-hunk produces exactly the expected new text', () => {
    const diff = parseUnifiedDiff(MULTI_DIFF)
    expect(applyHunksToText(MULTI_ORIGINAL, diff, diff.hunks.map((h) => h.id))).toBe(MULTI_NEW)
  })

  it('-U3 and -U0 forms of the same change agree', () => {
    const u3 = parseUnifiedDiff(SHIFT_DIFF)
    const u0 = parseUnifiedDiff(SHIFT_DIFF_U0)
    expect(applyHunksToText(SHIFT_ORIGINAL, u0, u0.hunks.map((h) => h.id))).toBe(
      applyHunksToText(SHIFT_ORIGINAL, u3, u3.hunks.map((h) => h.id))
    )
  })
})

/* ================================================================== *
 * empty selection
 * ================================================================== */

describe('empty selection', () => {
  it('leaves the text untouched and emits an empty patch', () => {
    const diff = parseUnifiedDiff(MULTI_DIFF)
    expect(applyHunksToText(MULTI_ORIGINAL, diff, [])).toBe(MULTI_ORIGINAL)
    expect(selectedHunksToPatch(diff, [])).toBe('')
  })

  it('ignores hunk ids that are not in the diff', () => {
    const diff = parseUnifiedDiff(MULTI_DIFF)
    expect(applyHunksToText(MULTI_ORIGINAL, diff, ['999-999'])).toBe(MULTI_ORIGINAL)
    expect(selectedHunksToPatch(diff, ['999-999'])).toBe('')
  })

  it('returns the original for a binary diff even when ids are passed', () => {
    const diff = parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')
    expect(applyHunksToText('whatever', diff, ['1-1'])).toBe('whatever')
    expect(selectedHunksToPatch(diff, ['1-1'])).toBe('')
  })
})

/* ================================================================== *
 * header recomputation
 * ================================================================== */

describe('recomputed @@ headers when hunks are dropped', () => {
  const diff = parseUnifiedDiff(SHIFT_DIFF)
  const headersOf = (ids: string[]): string[] =>
    selectedHunksToPatch(diff, ids)
      .split('\n')
      .filter((l) => l.startsWith('@@'))

  it('the fixture is the shape the tests below assume', () => {
    expect(diff.hunks.map((h) => h.id)).toEqual(['1-1', '7-9', '17-20'])
  })

  it('middle hunk only: the +side rewinds by the dropped leading hunk', () => {
    // Hunk 1 adds 2 lines. Dropping it must pull hunk 2 back from +9 to +7.
    expect(headersOf(['7-9'])).toEqual(['@@ -7,7 +7,8 @@'])
  })

  it('middle + trailing: the trailing hunk shifts by the middle hunk only', () => {
    expect(headersOf(['7-9', '17-20'])).toEqual(['@@ -7,7 +7,8 @@', '@@ -17,8 +18,6 @@'])
  })

  it('leading + trailing: the trailing hunk shifts by the leading hunk only', () => {
    expect(headersOf(['1-1', '17-20'])).toEqual(['@@ -1,4 +1,6 @@', '@@ -17,8 +19,6 @@'])
  })

  it('trailing hunk alone keeps its old start and loses all accumulated shift', () => {
    expect(headersOf(['17-20'])).toEqual(['@@ -17,8 +17,6 @@'])
  })

  it('selecting everything reproduces the headers git emitted', () => {
    expect(headersOf(['1-1', '7-9', '17-20'])).toEqual(diff.hunks.map((h) => h.header))
  })

  it('selection order does not matter — diff order always wins', () => {
    expect(headersOf(['17-20', '7-9'])).toEqual(headersOf(['7-9', '17-20']))
  })

  it('duplicate ids are applied once', () => {
    const applied = applyHunksToText(SHIFT_ORIGINAL, diff, ['7-9', '7-9'])
    expect(applied).toBe(applyHunksToText(SHIFT_ORIGINAL, diff, ['7-9']))
  })

  it('zero-context headers keep the "-a,0 means after line a" convention', () => {
    const u0 = parseUnifiedDiff(SHIFT_DIFF_U0)
    const only = selectedHunksToPatch(u0, ['1-2'])
      .split('\n')
      .filter((l) => l.startsWith('@@'))
    expect(only).toEqual(['@@ -1,0 +2,2 @@'])

    const tail = selectedHunksToPatch(u0, ['20-22'])
      .split('\n')
      .filter((l) => l.startsWith('@@'))
    // Pure deletion: the +side names the line BEFORE the removed block, i.e. 19 lines
    // precede it in the new file. Verified against real `git diff -U0` output.
    expect(tail).toEqual(['@@ -20,2 +19,0 @@'])
  })
})

/* ================================================================== *
 * THE consistency property
 * ================================================================== */

describe('applyHunksToText and selectedHunksToPatch agree', () => {
  const corpus: Array<[string, string, string]> = [
    ['multi', MULTI_DIFF, MULTI_ORIGINAL],
    ['shift -U3', SHIFT_DIFF, SHIFT_ORIGINAL],
    ['shift -U0 (adjacent hunks)', SHIFT_DIFF_U0, SHIFT_ORIGINAL],
    ['creation', CREATED_DIFF, ''],
    ['deletion', DELETED_DIFF, 'only\n'],
    ['no trailing newline', NOEOL_DIFF, NOEOL_ORIGINAL],
    ['CRLF', CRLF_DIFF, CRLF_ORIGINAL]
  ]

  for (const [name, text, original] of corpus) {
    it(`${name}: every subset of hunks agrees`, () => {
      const diff = parseUnifiedDiff(text)
      const ids = diff.hunks.map((h) => h.id)
      expect(ids.length).toBeGreaterThan(0)
      for (const subset of subsets(ids)) {
        const applied = applyHunksToText(original, diff, subset)
        const patch = selectedHunksToPatch(diff, subset)
        expect(applyPatchText(original, patch), `subset ${JSON.stringify(subset)}`).toBe(applied)
      }
    })
  }

  it('a stale patch is caught by the reference applier (the check has teeth)', () => {
    const diff = parseUnifiedDiff(SHIFT_DIFF)
    // Hand-forge the "forgot to recompute" bug: keep git's original +9 for hunk 2 alone.
    const stale = selectedHunksToPatch(diff, ['7-9']).replace('@@ -7,7 +7,8 @@', '@@ -7,7 +9,8 @@')
    expect(() => applyPatchText(SHIFT_ORIGINAL, stale)).toThrow(/stale newStart/)
  })
})

/* ================================================================== *
 * boundaries: file start, file end, adjacent hunks
 * ================================================================== */

describe('boundary hunks', () => {
  it('a hunk at the very start of the file', () => {
    const diff = parseUnifiedDiff(MULTI_DIFF)
    const applied = expectConsistent(MULTI_ORIGINAL, diff, ['1-1'])
    expect(applied.startsWith('L1-changed\nl2\n')).toBe(true)
    expect(applied.endsWith('l19\nl20\n')).toBe(true)
  })

  it('a hunk at the very end of the file', () => {
    const diff = parseUnifiedDiff(MULTI_DIFF)
    const applied = expectConsistent(MULTI_ORIGINAL, diff, ['17-18'])
    expect(applied.startsWith('l1\nl2\n')).toBe(true)
    expect(applied.endsWith('l18\nl19\nL20-changed\n')).toBe(true)
  })

  it('inserting at the top of a non-empty file (-0,0 style)', () => {
    const diff = parseUnifiedDiff(
      ['--- a/f.txt', '+++ b/f.txt', '@@ -0,0 +1,2 @@', '+top-a', '+top-b', ''].join('\n')
    )
    expect(expectConsistent('a\nb\n', diff, ['0-1'])).toBe('top-a\ntop-b\na\nb\n')
  })

  it('adjacent hunks that touch without shared context', () => {
    // Old lines 2 and 3 are changed by two separate zero-context hunks.
    const diff = parseUnifiedDiff(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -2 +2 @@',
        '-b',
        '+B',
        '@@ -3 +3 @@',
        '-c',
        '+C',
        ''
      ].join('\n')
    )
    const original = 'a\nb\nc\nd\n'
    expect(expectConsistent(original, diff, ['2-2', '3-3'])).toBe('a\nB\nC\nd\n')
    expect(expectConsistent(original, diff, ['3-3'])).toBe('a\nb\nC\nd\n')
    expect(expectConsistent(original, diff, ['2-2'])).toBe('a\nB\nc\nd\n')
  })

  it('a pure insertion between two adjacent lines with no context at all', () => {
    const diff = parseUnifiedDiff(
      ['--- a/f.txt', '+++ b/f.txt', '@@ -1,0 +2 @@', '+mid', '@@ -2,0 +4 @@', '+end', ''].join('\n')
    )
    const original = 'a\nb\n'
    expect(expectConsistent(original, diff, ['1-2', '2-4'])).toBe('a\nmid\nb\nend\n')
    expect(expectConsistent(original, diff, ['2-4'])).toBe('a\nb\nend\n')
    expect(expectConsistent(original, diff, ['1-2'])).toBe('a\nmid\nb\n')
  })
})

/* ================================================================== *
 * pure additions / pure deletions / mixed
 * ================================================================== */

describe('addition-only, deletion-only and mixed hunks', () => {
  const diff = parseUnifiedDiff(SHIFT_DIFF)

  it('the addition-only hunk adds and removes nothing', () => {
    const applied = expectConsistent(SHIFT_ORIGINAL, diff, ['1-1'])
    expect(applied).toBe('l1\nadd-a\nadd-b\n' + Array.from({ length: 23 }, (_, i) => `l${i + 2}`).join('\n') + '\n')
  })

  it('the deletion-only hunk removes exactly two lines', () => {
    const applied = expectConsistent(SHIFT_ORIGINAL, diff, ['17-20'])
    expect(applied).not.toContain('l20\n')
    expect(applied).not.toContain('l21\n')
    expect(applied).toContain('l19\nl22\n')
    expect(applied.split('\n')).toHaveLength(SHIFT_ORIGINAL.split('\n').length - 2)
  })

  it('the mixed hunk swaps one line for two', () => {
    const applied = expectConsistent(SHIFT_ORIGINAL, diff, ['7-9'])
    expect(applied).toContain('l9\nL10-changed\nextra\nl11\n')
  })

  it('deleting the whole file yields empty text', () => {
    const del = parseUnifiedDiff(DELETED_DIFF)
    expect(expectConsistent('only\n', del, ['1-0'])).toBe('')
    // Without the extended header git strips `/dev/null` to `dev/null` and makes a stray
    // directory instead of deleting the file.
    expect(selectedHunksToPatch(del, ['1-0']).split('\n').slice(0, 4)).toEqual([
      'diff --git a/del.txt b/del.txt',
      'deleted file mode 100644',
      '--- a/del.txt',
      '+++ /dev/null'
    ])
  })

  it('creating a file from empty text', () => {
    const created = parseUnifiedDiff(CREATED_DIFF)
    expect(expectConsistent('', created, ['0-1'])).toBe('new1\nnew2\nnew3\n')
    expect(selectedHunksToPatch(created, ['0-1']).split('\n').slice(0, 4)).toEqual([
      'diff --git a/created.txt b/created.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/created.txt'
    ])
  })

  it('does not claim create/delete for an ordinary multi-hunk diff', () => {
    const patch = selectedHunksToPatch(diff, diff.hunks.map((h) => h.id))
    expect(patch).not.toContain('new file mode')
    expect(patch).not.toContain('deleted file mode')
    expect(patch).not.toContain('/dev/null')
  })
})

/* ================================================================== *
 * line endings and trailing newlines
 * ================================================================== */

describe('line endings', () => {
  it('CRLF survives a partial application untouched', () => {
    const diff = parseUnifiedDiff(CRLF_DIFF)
    const applied = expectConsistent(CRLF_ORIGINAL, diff, ['1-1'])
    expect(applied).toBe('a\r\nB-CHANGED\r\nc\r\nd\r\ne\r\n')
    expect(applied).not.toMatch(/[^\r]\n/)
  })

  it('CRLF is not normalised in the emitted patch', () => {
    const diff = parseUnifiedDiff(CRLF_DIFF)
    const patch = selectedHunksToPatch(diff, ['1-1'])
    expect(patch).toContain('+B-CHANGED\r\n')
    expect(patch).toContain(' a\r\n')
  })

  it('a mixed-ending file keeps each line exactly as it was', () => {
    const original = 'lf\ncrlf\r\nlf2\n'
    const diff = parseUnifiedDiff(
      ['--- a/m.txt', '+++ b/m.txt', '@@ -1 +1 @@', '-lf', '+LF', ''].join('\n')
    )
    expect(expectConsistent(original, diff, ['1-1'])).toBe('LF\ncrlf\r\nlf2\n')
  })

  it('a file with no trailing newline keeps none', () => {
    const diff = parseUnifiedDiff(NOEOL_DIFF)
    expect(expectConsistent(NOEOL_ORIGINAL, diff, ['1-1'])).toBe('x\ny\nZZZ')
  })

  it('the emitted patch carries both \\ No newline markers', () => {
    const diff = parseUnifiedDiff(NOEOL_DIFF)
    const patch = selectedHunksToPatch(diff, ['1-1'])
    expect(patch).toBe(
      [
        'diff --git a/noeol.txt b/noeol.txt',
        '--- a/noeol.txt',
        '+++ b/noeol.txt',
        '@@ -1,3 +1,3 @@',
        ' x',
        ' y',
        '-z',
        '\\ No newline at end of file',
        '+ZZZ',
        '\\ No newline at end of file',
        ''
      ].join('\n')
    )
  })

  it('a diff that ADDS a trailing newline is honoured', () => {
    // old "b" had no newline; new "b" does.
    const diff = parseUnifiedDiff(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        '+b',
        ''
      ].join('\n')
    )
    expect(diff.hunks[0]!.lines).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'b' }
    ])
    expect(expectConsistent('a\nb', diff, ['1-1'])).toBe('a\nb\n')
  })

  it('a diff that REMOVES the trailing newline is honoured', () => {
    const diff = parseUnifiedDiff(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '+b',
        '\\ No newline at end of file',
        ''
      ].join('\n')
    )
    expect(expectConsistent('a\nb\n', diff, ['1-1'])).toBe('a\nb')
  })

  it('a shared marker on a trailing context line applies to both sides', () => {
    const diff = parseUnifiedDiff(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        '-a',
        '+A',
        ' b',
        '\\ No newline at end of file',
        ''
      ].join('\n')
    )
    const patch = selectedHunksToPatch(diff, ['1-1'])
    // Exactly one marker, on the shared context line.
    expect(patch.split('\n').filter((l) => l.startsWith('\\'))).toHaveLength(1)
    expect(expectConsistent('a\nb', diff, ['1-1'])).toBe('A\nb')
  })

  it('deleting the last line of a file that lacked a trailing newline restores one', () => {
    // "a\nb" minus "b" is "a\n" — git says the same.
    const diff = parseUnifiedDiff(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,1 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        ''
      ].join('\n')
    )
    expect(expectConsistent('a\nb', diff, ['1-1'])).toBe('a\n')
  })

  it('a no-newline file is left alone when its final hunk is not selected', () => {
    const diff = parseUnifiedDiff(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1 +1 @@',
        '-a',
        '+A',
        '@@ -4 +4 @@',
        '-d',
        '+D',
        '\\ No newline at end of file',
        ''
      ].join('\n')
    )
    expect(expectConsistent('a\nb\nc\nd', diff, ['1-1'])).toBe('A\nb\nc\nd')
    expect(expectConsistent('a\nb\nc\nd', diff, ['4-4'])).toBe('a\nb\nc\nD')
  })

  it('an empty original with an empty selection stays empty', () => {
    const diff = parseUnifiedDiff(CREATED_DIFF)
    expect(applyHunksToText('', diff, [])).toBe('')
    expect(selectedHunksToPatch(diff, [])).toBe('')
  })

  it('a lone newline round-trips', () => {
    const diff = parseUnifiedDiff(
      ['--- a/f.txt', '+++ b/f.txt', '@@ -1 +1 @@', '-', '+x', ''].join('\n')
    )
    expect(expectConsistent('\n', diff, ['1-1'])).toBe('x\n')
  })
})

/* ================================================================== *
 * refusals — loud beats silently wrong
 * ================================================================== */

describe('stale diffs are refused, not misapplied', () => {
  const diff = parseUnifiedDiff(MULTI_DIFF)

  it('throws when a context line does not match the file', () => {
    const tampered = MULTI_ORIGINAL.replace('l18\n', 'l18-EDITED\n')
    expect(() => applyHunksToText(tampered, diff, ['17-18'])).toThrow(/does not match the file/)
  })

  it('throws when a deleted line does not match the file', () => {
    const tampered = MULTI_ORIGINAL.replace('l1\n', 'l1-EDITED\n')
    expect(() => applyHunksToText(tampered, diff, ['1-1'])).toThrow(/does not match the file/)
  })

  it('throws when the hunk runs past the end of the file', () => {
    expect(() => applyHunksToText('l1\nl2\n', diff, ['17-18'])).toThrow(/but the file has 2/)
  })

  it('throws when hunks overlap', () => {
    const overlapping = parseUnifiedDiff(
      [
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ' c',
        '@@ -2,2 +2,2 @@',
        '-b',
        '+X',
        ' c',
        ''
      ].join('\n')
    )
    expect(() => applyHunksToText('a\nb\nc\n', overlapping, ['1-1', '2-2'])).toThrow(
      /Hunks must be non-overlapping/
    )
  })

  it('refuses to emit a patch for a diff with no path', () => {
    const pathless = parseUnifiedDiff(['@@ -1 +1 @@', '-a', '+b', ''].join('\n'))
    expect(pathless.path).toBe('')
    expect(() => selectedHunksToPatch(pathless, ['1-1'])).toThrow(/path is empty/)
  })
})

/* ================================================================== *
 * patch shape
 * ================================================================== */

describe('emitted patch shape', () => {
  it('is a complete, newline-terminated unified diff', () => {
    const diff = parseUnifiedDiff(SHIFT_DIFF)
    const patch = selectedHunksToPatch(diff, ['7-9'])
    expect(patch.endsWith('\n')).toBe(true)
    expect(patch.split('\n').slice(0, 3)).toEqual([
      'diff --git a/shift.txt b/shift.txt',
      '--- a/shift.txt',
      '+++ b/shift.txt'
    ])
  })

  it('names both sides of a rename', () => {
    const diff = parseUnifiedDiff(
      [
        'diff --git a/old.ts b/new.ts',
        'rename from old.ts',
        'rename to new.ts',
        '--- a/old.ts',
        '+++ b/new.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        ''
      ].join('\n')
    )
    const patch = selectedHunksToPatch(diff, ['1-1'])
    expect(patch.split('\n').slice(0, 3)).toEqual([
      'diff --git a/old.ts b/new.ts',
      '--- a/old.ts',
      '+++ b/new.ts'
    ])
  })

  it('always writes explicit ,count ranges (never the abbreviated form)', () => {
    const diff = parseUnifiedDiff(SHIFT_DIFF_U0)
    for (const line of selectedHunksToPatch(diff, diff.hunks.map((h) => h.id)).split('\n')) {
      if (line.startsWith('@@')) expect(line).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    }
  })

  it('emits nothing but headers for hunks with empty bodies', () => {
    const diff: FileDiff = {
      path: 'f.txt',
      binary: false,
      truncated: false,
      hunks: [
        { id: '1-1', header: '@@ -1,0 +1,0 @@', oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [] }
      ]
    }
    expect(selectedHunksToPatch(diff, ['1-1'])).toBe('')
    expect(applyHunksToText('a\n', diff, ['1-1'])).toBe('a\n')
  })

  it('derives header counts from the body, not the declared oldLines/newLines', () => {
    // A hunk whose declared counts lie. The emitted header must describe what we emit,
    // otherwise git rejects the patch (and applyHunksToText would disagree with it).
    const diff: FileDiff = {
      path: 'f.txt',
      binary: false,
      truncated: false,
      hunks: [
        {
          id: '1-1',
          header: '@@ -1,99 +1,99 @@',
          oldStart: 1,
          oldLines: 99,
          newStart: 1,
          newLines: 99,
          lines: [
            { kind: 'ctx', text: 'a' },
            { kind: 'del', text: 'b' },
            { kind: 'add', text: 'B' }
          ]
        }
      ]
    }
    const patch = selectedHunksToPatch(diff, ['1-1'])
    expect(patch).toContain('@@ -1,2 +1,2 @@')
    expect(expectConsistent('a\nb\nc\n', diff, ['1-1'])).toBe('a\nB\nc\n')
  })
})
