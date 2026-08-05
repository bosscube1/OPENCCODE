import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// initCrashLog only needs app.getPath('userData'); the mock reads this mutable holder
// (vi.hoisted so it exists before the hoisted vi.mock factory runs).
const state = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataPath }
}))

import type { App } from 'electron'
import { app } from 'electron'
import {
  countCrashEntries,
  getCrashLogPath,
  initCrashLog,
  logCrash,
  readCrashLog
} from '../crashlog'

describe('countCrashEntries', () => {
  it('counts ISO-timestamped entry headers at line starts', () => {
    const text = [
      '[2026-08-04T10:00:00.000Z] uncaughtException: boom',
      'Error: boom',
      '    at something (file.ts:1:1)',
      '',
      '[2026-08-04T11:00:00.000Z] unhandledRejection: bad',
      'Error: bad'
    ].join('\n')
    expect(countCrashEntries(text)).toBe(2)
  })

  it('ignores bracketed text that is not an entry header', () => {
    expect(countCrashEntries('some [2026-08-04T10:00:00.000Z] inline mention\n[not a date] x')).toBe(0)
    expect(countCrashEntries('')).toBe(0)
  })
})

describe('crash log read path', () => {
  beforeEach(() => {
    state.userDataPath = mkdtempSync(join(tmpdir(), 'crashlog-test-'))
    initCrashLog(app as App)
  })

  afterEach(() => {
    rmSync(state.userDataPath, { recursive: true, force: true })
  })

  it('resolves the log path under userData', () => {
    expect(getCrashLogPath()).toBe(join(state.userDataPath, 'crash.log'))
  })

  it('returns an empty report when the log file does not exist', () => {
    const report = readCrashLog()
    expect(report.path).toBe(getCrashLogPath())
    expect(report.exists).toBe(false)
    expect(report.sizeBytes).toBe(0)
    expect(report.hasOld).toBe(false)
    expect(report.entryCount).toBe(0)
    expect(report.tail).toBe('')
    expect(report.truncated).toBe(false)
  })

  it('reports a rotated crash.log.old even when the active log is absent', () => {
    writeFileSync(`${getCrashLogPath()}.old`, 'old entries', 'utf8')
    const report = readCrashLog()
    expect(report.exists).toBe(false)
    expect(report.hasOld).toBe(true)
  })

  it('returns entries written by logCrash with metadata', () => {
    logCrash('uncaughtException', new Error('first boom'))
    logCrash('unhandledRejection', new Error('second boom'))

    const report = readCrashLog()
    expect(report.exists).toBe(true)
    expect(report.sizeBytes).toBe(statSync(getCrashLogPath()).size)
    expect(report.hasOld).toBe(false)
    expect(report.entryCount).toBe(2)
    expect(report.tail).toContain('uncaughtException: first boom')
    expect(report.tail).toContain('unhandledRejection: second boom')
    expect(report.truncated).toBe(false)
    // The tail is the whole file when it fits under the cap.
    expect(report.tail).toBe(readFileSync(getCrashLogPath(), 'utf8'))
  })

  it('bounds the tail to the byte cap and flags truncation', () => {
    const cap = 1024
    const header = '[2026-08-04T10:00:00.000Z] uncaughtException: boom\n'
    const filler = 'x'.repeat(cap * 3)
    writeFileSync(getCrashLogPath(), header + filler, 'utf8')

    const report = readCrashLog(cap)
    expect(report.exists).toBe(true)
    expect(report.sizeBytes).toBe(header.length + filler.length)
    expect(report.truncated).toBe(true)
    expect(Buffer.byteLength(report.tail, 'utf8')).toBe(cap)
    // The tail is the END of the file — the newest bytes survive, the head is dropped.
    expect(report.tail).toBe(filler.slice(-cap))
    expect(report.tail).not.toContain(header)
    expect(report.entryCount).toBe(0)
  })

  it('reads the whole file when it is exactly at the cap', () => {
    const content = '[2026-08-04T10:00:00.000Z] scope: exact\n'
    writeFileSync(getCrashLogPath(), content, 'utf8')
    const report = readCrashLog(Buffer.byteLength(content, 'utf8'))
    expect(report.truncated).toBe(false)
    expect(report.tail).toBe(content)
    expect(report.entryCount).toBe(1)
  })

  it('handles an empty log file without throwing', () => {
    writeFileSync(getCrashLogPath(), '', 'utf8')
    const report = readCrashLog()
    expect(report.exists).toBe(true)
    expect(report.sizeBytes).toBe(0)
    expect(report.tail).toBe('')
    expect(report.truncated).toBe(false)
  })
})
