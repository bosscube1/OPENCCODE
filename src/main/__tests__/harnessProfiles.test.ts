import { describe, expect, it } from 'vitest'
import { BUILTIN_PROFILES, validateProfile } from '../harness/profiles'
import { ToolRegistry } from '../harness/tools/registry'
import { registerBuiltins } from '../harness/tools/builtins'

describe('validateProfile', () => {
  it('accepts a minimal profile and applies defaults (absent optional fields stay absent)', () => {
    const profile = validateProfile({ id: 'my-agent', name: 'My Agent', provider: 'nanogpt', model: 'm' })
    expect(profile).toEqual({ id: 'my-agent', name: 'My Agent', provider: 'nanogpt', model: 'm' })
  })

  it('trims strings and normalises numeric fields', () => {
    const profile = validateProfile({
      id: 'a', name: ' A ', provider: ' nanogpt ', model: ' m ',
      temperature: 0.5, maxTokens: 4096.7, maxTurns: 10.4
    })
    expect(profile.name).toBe('A')
    expect(profile.provider).toBe('nanogpt')
    expect(profile.maxTokens).toBe(4097)
    expect(profile.maxTurns).toBe(10)
  })

  it('rejects non-object input', () => {
    for (const bad of [undefined, null, 'x', 42, []]) {
      expect(() => validateProfile(bad)).toThrow(/must be an object/)
    }
  })

  it('rejects missing or empty required strings', () => {
    for (const bad of [
      { name: 'n', provider: 'p', model: 'm' },
      { id: 'i', provider: 'p', model: 'm' },
      { id: 'i', name: 'n', model: 'm' },
      { id: 'i', name: 'n', provider: 'p' },
      { id: '  ', name: 'n', provider: 'p', model: 'm' }
    ]) {
      expect(() => validateProfile(bad)).toThrow(/non-empty string/)
    }
  })

  it('rejects ids outside the allowed charset or over 64 chars', () => {
    expect(() => validateProfile({ id: 'Bad Id!', name: 'n', provider: 'p', model: 'm' })).toThrow(/id must contain/)
    expect(() => validateProfile({ id: 'a'.repeat(65), name: 'n', provider: 'p', model: 'm' })).toThrow(/64 characters/)
  })

  it('drops out-of-range optional numbers and unknown enum values', () => {
    const profile = validateProfile({
      id: 'a', name: 'n', provider: 'p', model: 'm',
      temperature: 99, topP: -1, billingRoute: 'free', routingSuffix: ':turbo'
    })
    expect(profile.temperature).toBeUndefined()
    expect(profile.topP).toBeUndefined()
    expect(profile.billingRoute).toBeUndefined()
    expect(profile.routingSuffix).toBeUndefined()
  })
})

describe('BUILTIN_PROFILES', () => {
  it('contains the orchestrator, researcher, coder and reviewer profiles', () => {
    const ids = BUILTIN_PROFILES.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['orchestrator', 'researcher', 'coder', 'reviewer']))
    for (const profile of BUILTIN_PROFILES) {
      expect(profile.builtin).toBe(true)
    }
  })

  it('read-only built-ins only receive read-category tools', () => {
    const registry = new ToolRegistry()
    registerBuiltins(registry)

    for (const id of ['researcher', 'reviewer']) {
      const profile = BUILTIN_PROFILES.find((p) => p.id === id)
      expect(profile?.readOnly).toBe(true)
      const tools = registry.forProfile(profile!)
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.every((t) => t.category === 'read')).toBe(true)
      expect(tools.some((t) => t.name === 'shell')).toBe(false)
    }
  })
})
