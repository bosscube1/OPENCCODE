import { describe, expect, it } from 'vitest'
import { rowsToRecord, splitCommandLine } from '../mcp'

describe('splitCommandLine', () => {
  it('splits whitespace and preserves quoted arguments', () => {
    expect(splitCommandLine('npx -y "my server" --label \'hello world\'')).toEqual([
      'npx', '-y', 'my server', '--label', 'hello world'
    ])
  })

  it('keeps Windows path separators and quoted empty arguments', () => {
    expect(splitCommandLine('C:\\tools\\server.exe "" "C:\\My Tools\\config.json"')).toEqual([
      'C:\\tools\\server.exe', '', 'C:\\My Tools\\config.json'
    ])
  })

  it('supports escaped double quotes', () => {
    expect(splitCommandLine('tool "say \\"hello\\""')).toEqual(['tool', 'say "hello"'])
  })

  it('rejects empty and unclosed commands', () => {
    expect(() => splitCommandLine('   ')).toThrow('Enter a command')
    expect(() => splitCommandLine('tool "oops')).toThrow('unclosed quote')
  })
})

describe('rowsToRecord', () => {
  it('trims rows and skips entirely blank rows', () => {
    expect(rowsToRecord([{ key: ' TOKEN ', value: ' abc ' }, { key: '', value: '' }], 'Environment')).toEqual({ TOKEN: 'abc' })
  })

  it('returns undefined when no rows contain values', () => {
    expect(rowsToRecord([], 'Headers')).toBeUndefined()
  })

  it('rejects empty and duplicate keys', () => {
    expect(() => rowsToRecord([{ key: '', value: 'x' }], 'Headers')).toThrow('cannot be empty')
    expect(() => rowsToRecord([{ key: 'X', value: '1' }, { key: ' X ', value: '2' }], 'Headers')).toThrow('duplicated')
  })
})
