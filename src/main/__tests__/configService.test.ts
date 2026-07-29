import { describe, expect, it } from 'vitest'
import { validatePermissionConfig } from '../configService'

describe('validatePermissionConfig', () => {
  it('accepts a full preset of plain levels', () => {
    expect(
      validatePermissionConfig({
        edit: 'allow',
        bash: 'ask',
        webfetch: 'deny',
        doom_loop: 'ask',
        external_directory: 'allow'
      })
    ).toEqual({
      edit: 'allow',
      bash: 'ask',
      webfetch: 'deny',
      doom_loop: 'ask',
      external_directory: 'allow'
    })
  })

  it('accepts a partial config and an empty object', () => {
    expect(validatePermissionConfig({ edit: 'allow' })).toEqual({ edit: 'allow' })
    expect(validatePermissionConfig({})).toEqual({})
  })

  it('accepts a per-pattern bash map', () => {
    expect(
      validatePermissionConfig({ bash: { 'git *': 'allow', 'rm *': 'deny' } })
    ).toEqual({ bash: { 'git *': 'allow', 'rm *': 'deny' } })
    expect(validatePermissionConfig({ bash: {} })).toEqual({ bash: {} })
  })

  it('rejects non-objects', () => {
    expect(() => validatePermissionConfig(null)).toThrow(/must be an object/)
    expect(() => validatePermissionConfig('ask')).toThrow(/must be an object/)
    expect(() => validatePermissionConfig(['ask'])).toThrow(/must be an object/)
  })

  it('rejects unknown keys', () => {
    expect(() => validatePermissionConfig({ shell: 'allow' })).toThrow(/unknown key "shell"/)
    expect(() => validatePermissionConfig({ edit: 'ask', sudo: 'allow' })).toThrow(/unknown key "sudo"/)
  })

  it('rejects invalid levels', () => {
    expect(() => validatePermissionConfig({ edit: 'yes' })).toThrow(/edit must be "ask", "allow", or "deny"/)
    expect(() => validatePermissionConfig({ edit: 1 })).toThrow(/edit must be/)
    expect(() => validatePermissionConfig({ bash: 'sometimes' })).toThrow(/bash must be/)
    expect(() => validatePermissionConfig({ webfetch: undefined })).toThrow(/webfetch must be/)
  })

  it('rejects invalid per-pattern bash entries', () => {
    expect(() => validatePermissionConfig({ bash: { 'git *': 'yeet' } })).toThrow(/bash\["git \*"\] must be/)
    expect(() => validatePermissionConfig({ bash: { '': 'ask' } })).toThrow(/patterns must be 1-256/)
    expect(() => validatePermissionConfig({ bash: { '   ': 'ask' } })).toThrow(/patterns must be 1-256/)
    expect(() => validatePermissionConfig({ bash: { ['x'.repeat(257)]: 'ask' } })).toThrow(/patterns must be 1-256/)
  })

  it('caps the number of bash patterns', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`cmd${i} *`, 'ask'])
    )
    expect(() => validatePermissionConfig({ bash: tooMany })).toThrow(/may not exceed 64 patterns/)
  })

  it('does not retain extra properties from the input', () => {
    const input = { edit: 'ask', extra: 'allow' }
    expect(() => validatePermissionConfig(input)).toThrow(/unknown key/)
    // And the accepted path copies values rather than aliasing the caller's object.
    const bash = { 'git *': 'allow' as const }
    const out = validatePermissionConfig({ bash })
    expect(out.bash).toEqual(bash)
    expect(out.bash).not.toBe(bash)
  })
})
