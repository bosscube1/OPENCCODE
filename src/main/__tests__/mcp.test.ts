import { describe, expect, it } from 'vitest'
import {
  mergeMcpConfig,
  publicMcpConfigMap,
  removeMcpConfig,
  stripMcpSecrets,
  validateMcpConfig,
  validateMcpName
} from '../mcp'

describe('MCP config helpers', () => {
  it('validates and normalizes local configs', () => {
    expect(validateMcpConfig({
      type: 'local',
      command: [' npx ', ' server ', ''],
      environment: { ' TOKEN ': ' secret ' },
      timeout: 5_000
    })).toEqual({
      type: 'local',
      command: ['npx', ' server ', ''],
      environment: { TOKEN: 'secret' },
      timeout: 5_000
    })
  })

  it('accepts only HTTP(S) remote URLs and positive integer timeouts', () => {
    expect(validateMcpConfig({ type: 'remote', url: 'https://example.com/mcp', oauth: false }))
      .toMatchObject({ type: 'remote', url: 'https://example.com/mcp', oauth: false })
    expect(() => validateMcpConfig({ type: 'remote', url: 'file:///tmp/mcp' })).toThrow(/HTTP or HTTPS/)
    expect(() => validateMcpConfig({ type: 'local', command: ['cmd'], timeout: 0 })).toThrow(/positive integer/)
    expect(() => validateMcpConfig({ type: 'local', command: [] })).toThrow(/command/)
  })

  it('rejects invalid names and duplicate normalized map keys', () => {
    expect(validateMcpName(' my-server ')).toBe('my-server')
    expect(() => validateMcpName('../server')).toThrow(/name/)
    expect(() => validateMcpConfig({
      type: 'remote',
      url: 'https://example.com',
      headers: { TOKEN: 'one', ' TOKEN ': 'two' }
    })).toThrow(/duplicate key/)
  })

  it('merges and removes configs without mutating the input map', () => {
    const local = { type: 'local' as const, command: ['one'] }
    const remote = { type: 'remote' as const, url: 'https://example.com/mcp' }
    const original = { one: local }
    const merged = mergeMcpConfig(original, 'two', remote)
    expect(merged).toEqual({ one: local, two: remote })
    expect(original).toEqual({ one: local })
    expect(removeMcpConfig(merged, 'one')).toEqual({ two: remote })
    expect(merged).toHaveProperty('one')
  })

  it('does not expose environment, header, or OAuth secrets in renderer snapshots', () => {
    expect(publicMcpConfigMap({
      local: { type: 'local', command: ['tool'], environment: { TOKEN: 'secret' } },
      remote: {
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer secret' },
        oauth: { clientId: 'public-id', clientSecret: 'secret', scope: 'tools' }
      }
    })).toEqual({
      local: { type: 'local', command: ['tool'] },
      remote: {
        type: 'remote',
        url: 'https://example.com/mcp',
        oauth: { clientId: 'public-id', scope: 'tools' }
      }
    })
  })

  it('removes all credential-bearing fields before workspace persistence', () => {
    expect(stripMcpSecrets({
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret' },
      oauth: { clientId: 'public', clientSecret: 'secret', scope: 'tools' }
    })).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      oauth: { clientId: 'public', scope: 'tools' }
    })
  })
})
