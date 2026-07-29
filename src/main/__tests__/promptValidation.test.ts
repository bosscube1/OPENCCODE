import { describe, expect, it } from 'vitest'
import { optionalAgentName, optionalToolPolicy } from '../promptValidation'

describe('optionalAgentName', () => {
  it('returns undefined when absent or blank so the body field is omitted', () => {
    expect(optionalAgentName(undefined)).toBeUndefined()
    expect(optionalAgentName(null)).toBeUndefined()
    expect(optionalAgentName('')).toBeUndefined()
    expect(optionalAgentName('   ')).toBeUndefined()
  })

  it('accepts registry-style names and trims whitespace', () => {
    expect(optionalAgentName('plan')).toBe('plan')
    expect(optionalAgentName(' build ')).toBe('build')
    expect(optionalAgentName('my-agent.v2_final')).toBe('my-agent.v2_final')
    expect(optionalAgentName('A')).toBe('A')
  })

  it('rejects non-strings and unsafe names', () => {
    expect(() => optionalAgentName(42)).toThrow(/agent must be a string/)
    expect(() => optionalAgentName({})).toThrow(/agent must be a string/)
    expect(() => optionalAgentName('-plan')).toThrow(/1-64 letters/)
    expect(() => optionalAgentName('my agent')).toThrow(/1-64 letters/)
    expect(() => optionalAgentName('agent/name')).toThrow(/1-64 letters/)
    expect(() => optionalAgentName('a'.repeat(65))).toThrow(/1-64 letters/)
  })
})

describe('optionalToolPolicy', () => {
  it('returns undefined when absent or empty', () => {
    expect(optionalToolPolicy(undefined)).toBeUndefined()
    expect(optionalToolPolicy(null)).toBeUndefined()
    expect(optionalToolPolicy({})).toBeUndefined()
  })

  it('accepts lowercase identifier flags', () => {
    expect(optionalToolPolicy({ write: false, edit: false, bash: true })).toEqual({
      write: false,
      edit: false,
      bash: true
    })
  })

  it('rejects non-boolean flags and unsafe tool names', () => {
    expect(() => optionalToolPolicy({ write: 'no' })).toThrow(/must be a boolean/)
    expect(() => optionalToolPolicy({ Write: false })).toThrow(/not a valid tool name/)
    expect(() => optionalToolPolicy({ 'bad-name': false })).toThrow(/not a valid tool name/)
    expect(() => optionalToolPolicy([])).toThrow(/must be an object/)
  })

  it('caps the number of entries', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`tool${i}`, false])
    )
    expect(() => optionalToolPolicy(tooMany)).toThrow(/may not exceed 64 entries/)
  })
})
