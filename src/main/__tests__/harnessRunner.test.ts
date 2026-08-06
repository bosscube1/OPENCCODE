import { describe, expect, it, vi } from 'vitest'
import { AgentRunner, type RunnerEvent } from '../harness/runner'
import { ToolRegistry } from '../harness/tools/registry'
import type { AgentProfile } from '../harness/profiles'
import type { ChatResponse, ProviderAdapter } from '../harness/providers/adapter'

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return { id: 'tester', name: 'Tester', provider: 'stub', model: 'm', ...overrides }
}

function response(overrides: Partial<ChatResponse>): ChatResponse {
  return {
    id: 'r1',
    content: '',
    finishReason: 'stop',
    usage: { input: 1, output: 1 },
    ...overrides
  }
}

/** Adapter that replays queued responses (last one repeats when exhausted). */
function stubAdapter(responses: ChatResponse[]): ProviderAdapter & { chat: ReturnType<typeof vi.fn> } {
  let i = 0
  return {
    id: 'stub',
    chat: vi.fn(async () => responses[Math.min(i++, responses.length - 1)]),
    abort: vi.fn(),
    probe: vi.fn(async () => true)
  }
}

function toolCall(name: string, args: Record<string, unknown> = {}): NonNullable<ChatResponse['toolCalls']>[number] {
  return { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function makeRunner(adapter: ProviderAdapter, tools: ToolRegistry, prof = profile()): AgentRunner {
  return new AgentRunner({ id: 'run-1', profile: prof, adapter, tools, directory: '/tmp' })
}

describe('AgentRunner', () => {
  it('executes a tool_call response, then completes on the next stop response', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ output: 'tool says hi' }))
    tools.register(
      { name: 'echo', description: 'echo', parameters: { type: 'object' }, category: 'read' },
      executor
    )

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('echo', { x: 1 })] }),
      response({ content: 'final answer', finishReason: 'stop' })
    ])

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools)
    const result = await runner.run('do the thing', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(result.content).toBe('final answer')
    expect(result.toolCallCount).toBe(1)
    expect(result.turns).toBe(2)
    expect(result.usage).toEqual({ input: 2, output: 2 })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(executor.mock.calls[0][0]).toEqual({ x: 1 })
    expect(executor.mock.calls[0][1]).toMatchObject({ directory: '/tmp', agentId: 'tester', runId: 'run-1' })

    const types = events.map((e) => e.type)
    expect(types).toEqual(['tool_call', 'tool_result', 'text', 'done'])
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toMatchObject({ name: 'echo', output: 'tool says hi' })
    expect(events.at(-1)).toEqual({ type: 'done', result })

    // The second chat call saw the tool result appended as a tool message.
    const secondRequest = adapter.chat.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> }
    const toolMessage = secondRequest.messages.at(-1)
    expect(toolMessage?.role).toBe('tool')
    expect(toolMessage?.content).toBe('tool says hi')
  })

  it('stops with finishReason "max_turns" when the profile budget is exhausted', async () => {
    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('noop')] })
    ])
    const tools = new ToolRegistry()
    tools.register(
      { name: 'noop', description: 'noop', parameters: { type: 'object' }, category: 'read' },
      async () => ({ output: '' })
    )

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools, profile({ maxTurns: 1 }))
    const result = await runner.run('loop forever', (e) => events.push(e))

    expect(result.finishReason).toBe('max_turns')
    expect(result.turns).toBe(1)
    expect(adapter.chat).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toEqual({ type: 'done', result })
  })

  it('abort() ends the run with finishReason "aborted" and aborts the adapter', async () => {
    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('noop')] })
    ])
    const tools = new ToolRegistry()
    tools.register(
      { name: 'noop', description: 'noop', parameters: { type: 'object' }, category: 'read' },
      async () => ({ output: '' })
    )

    const runner = makeRunner(adapter, tools)
    const events: RunnerEvent[] = []
    const result = await runner.run('run', (e) => {
      events.push(e)
      if (e.type === 'tool_result') runner.abort()
    })

    expect(result.finishReason).toBe('aborted')
    expect(adapter.abort).toHaveBeenCalledWith('run-1')
    expect(events.at(-1)).toEqual({ type: 'done', result })
  })

  it('turns adapter exceptions into an error event and an error result', async () => {
    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(async () => { throw new Error('provider down') }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }
    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, new ToolRegistry())
    const result = await runner.run('boom', (e) => events.push(e))

    expect(result.finishReason).toBe('error')
    expect(result.error).toBe('provider down')
    expect(events.some((e) => e.type === 'error' && e.message === 'provider down')).toBe(true)
  })
})
