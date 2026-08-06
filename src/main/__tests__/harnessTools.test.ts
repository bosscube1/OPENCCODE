import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry, type ToolDefinition, type ToolExecutor } from '../harness/tools/registry'

const noopExecutor: ToolExecutor = async () => ({ output: '' })

function def(name: string, category: ToolDefinition['category']): ToolDefinition {
  return { name, description: `${name} tool`, parameters: { type: 'object' }, category }
}

function registryWith(...categories: ToolDefinition['category'][]): ToolRegistry {
  const registry = new ToolRegistry()
  categories.forEach((category, i) => registry.register(def(`tool_${category}_${i}`, category), noopExecutor))
  return registry
}

describe('ToolRegistry.forProfile', () => {
  it('returns every tool when the profile has no constraints', () => {
    const registry = registryWith('read', 'write', 'shell')
    expect(registry.forProfile({})).toHaveLength(3)
  })

  it('filters to the tools allowlist when present', () => {
    const registry = registryWith('read', 'write', 'shell')
    const names = registry.listAll().map((t) => t.name)
    const filtered = registry.forProfile({ tools: [names[0], names[2]] })
    expect(filtered.map((t) => t.name)).toEqual([names[0], names[2]])
  })

  it('a "*" allowlist entry keeps every tool', () => {
    const registry = registryWith('read', 'write')
    expect(registry.forProfile({ tools: ['*'] })).toHaveLength(2)
  })

  it('toolDenyList wins over the tools allowlist', () => {
    const registry = registryWith('read', 'shell')
    const names = registry.listAll().map((t) => t.name)
    const filtered = registry.forProfile({ tools: ['*'], toolDenyList: [names[1]] })
    expect(filtered.map((t) => t.name)).toEqual([names[0]])
  })

  it('readOnly profiles only get read-category tools', () => {
    const registry = registryWith('read', 'write', 'shell', 'web', 'custom')
    const filtered = registry.forProfile({ readOnly: true })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].category).toBe('read')
  })

  it('readOnly combines with allowlist and deny list', () => {
    const registry = registryWith('read', 'read', 'shell')
    const names = registry.listAll().map((t) => t.name)
    const filtered = registry.forProfile({ readOnly: true, toolDenyList: [names[0]] })
    expect(filtered.map((t) => t.name)).toEqual([names[1]])
  })
})

describe('ToolRegistry.execute', () => {
  it('reports an error for unknown tools instead of throwing', async () => {
    const registry = new ToolRegistry()
    const result = await registry.execute('nope', {}, {
      directory: '/tmp', agentId: 'a', runId: 'r', abortSignal: new AbortController().signal
    })
    expect(result.error).toMatch(/Tool not found/)
  })

  it('captures executor exceptions into the result', async () => {
    const registry = new ToolRegistry()
    registry.register(def('boom', 'read'), async () => { throw new Error('kaput') })
    const result = await registry.execute('boom', {}, {
      directory: '/tmp', agentId: 'a', runId: 'r', abortSignal: new AbortController().signal
    })
    expect(result.error).toBe('kaput')
  })

  it('passes args and context through to the executor', async () => {
    const registry = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: 'ok' }))
    registry.register(def('echo', 'read'), executor)
    const context = { directory: '/tmp', agentId: 'a', runId: 'r', abortSignal: new AbortController().signal }
    const result = await registry.execute('echo', { x: 1 }, context)
    expect(result.output).toBe('ok')
    expect(executor).toHaveBeenCalledWith({ x: 1 }, context)
  })
})
