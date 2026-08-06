import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'opencode-controller-')) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { HarnessController } from '../harness/controller'
import type { ProfileStore } from '../harness/profileStore'
import type { ProviderRegistry } from '../harness/providers/registry'
import type { AgentProfile } from '../harness/profiles'
import type { ChatResponse, ProviderAdapter } from '../harness/providers/adapter'

const testProfile: AgentProfile = {
  id: 'tester', name: 'Tester', provider: 'stub', model: 'm'
}

function stubProfiles(profile?: AgentProfile): ProfileStore {
  return {
    list: () => (profile ? [profile] : []),
    get: (id: string) => (profile && profile.id === id ? profile : undefined),
    save: vi.fn(),
    delete: vi.fn(),
    reset: vi.fn()
  } as unknown as ProfileStore
}

function stubProviders(adapter: ProviderAdapter, supported = true): ProviderRegistry {
  return {
    resolve: () => adapter,
    isSupported: () => supported,
    list: () => (supported ? ['stub'] : []),
    probe: vi.fn(async () => true),
    reset: vi.fn()
  } as unknown as ProviderRegistry
}

function immediateAdapter(chatResponse: Partial<ChatResponse> = {}): ProviderAdapter {
  return {
    id: 'stub',
    chat: vi.fn(async (): Promise<ChatResponse> => ({
      id: 'r1',
      content: 'done',
      finishReason: 'stop',
      usage: { input: 1, output: 1 },
      ...chatResponse
    })),
    abort: vi.fn(),
    probe: vi.fn(async () => true)
  }
}

/** Poll until the run leaves the running state (run() is fire-and-forget). */
async function waitForSettled(controller: HarnessController, runId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (controller.getRunStatus(runId)?.status !== 'running') return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('run did not settle in time')
}

describe('HarnessController', () => {
  it('rejects startRun for an unknown profile', async () => {
    const controller = new HarnessController(stubProfiles(), stubProviders(immediateAdapter()))
    await expect(
      controller.startRun({ profileId: 'nope', task: 't', directory: '/tmp' })
    ).rejects.toThrow(/Profile not found/)
  })

  it('rejects startRun when the profile provider is unsupported', async () => {
    const controller = new HarnessController(
      stubProfiles(testProfile),
      stubProviders(immediateAdapter(), false)
    )
    await expect(
      controller.startRun({ profileId: 'tester', task: 't', directory: '/tmp' })
    ).rejects.toThrow(/not supported/)
  })

  it('runs to completion: status transitions running → completed with usage and result', async () => {
    // Gated adapter: the first chat call blocks until the test releases it, so the
    // 'running' state is observable before the run completes.
    let releaseChat: (value: ChatResponse) => void = () => {}
    const gate = new Promise<ChatResponse>((resolve) => { releaseChat = resolve })
    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(() => gate),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }
    const controller = new HarnessController(stubProfiles(testProfile), stubProviders(adapter))
    const events: Array<{ runId: string; type: string }> = []
    controller.setEventCallback((runId, event) => events.push({ runId, type: event.type }))

    const runId = await controller.startRun({ profileId: 'tester', task: 'hi', directory: '/tmp' })
    expect(typeof runId).toBe('string')
    expect(controller.getRunStatus(runId)?.status).toBe('running')

    releaseChat({ id: 'r1', content: 'done', finishReason: 'stop', usage: { input: 1, output: 1 } })
    await waitForSettled(controller, runId)

    const status = controller.getRunStatus(runId)
    expect(status?.status).toBe('completed')
    expect(status?.completedAt).toBeTypeOf('number')
    expect(status?.result?.finishReason).toBe('complete')
    expect(status?.usage).toEqual({ input: 1, output: 1 })
    expect(controller.listRuns().map((r) => r.id)).toContain(runId)

    const done = events.find((e) => e.type === 'done')
    expect(done?.runId).toBe(runId)
  })

  it('stopRun cancels a running run', async () => {
    // Adapter that never resolves on its own; abort() unblocks nothing — stopRun
    // flips the status synchronously.
    const hanging: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(() => new Promise<ChatResponse>(() => {})),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }
    const controller = new HarnessController(stubProfiles(testProfile), stubProviders(hanging))

    const runId = await controller.startRun({ profileId: 'tester', task: 'hi', directory: '/tmp' })
    controller.stopRun(runId)

    const status = controller.getRunStatus(runId)
    expect(status?.status).toBe('cancelled')
    expect(status?.completedAt).toBeTypeOf('number')
    expect(hanging.abort).toHaveBeenCalledWith(runId)

    // Stopping a non-running run is a no-op, unknown ids are ignored.
    controller.stopRun(runId)
    controller.stopRun('unknown')
    expect(controller.getRunStatus(runId)?.status).toBe('cancelled')
  })

  it('getRunStatus returns undefined for unknown runs', () => {
    const controller = new HarnessController(stubProfiles(), stubProviders(immediateAdapter()))
    expect(controller.getRunStatus('missing')).toBeUndefined()
  })

  it('listTools returns the builtin tool definitions', () => {
    const controller = new HarnessController(stubProfiles(), stubProviders(immediateAdapter()))
    const names = controller.listTools().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['fs_read', 'fs_list', 'grep', 'shell', 'think']))
  })

  it('testProfile probes the profile provider and returns false for unknown profiles', async () => {
    const providers = stubProviders(immediateAdapter())
    const controller = new HarnessController(stubProfiles(testProfile), providers)
    await expect(controller.testProfile('missing')).resolves.toBe(false)
    await expect(controller.testProfile('tester')).resolves.toBe(true)
    expect(providers.probe).toHaveBeenCalledWith('stub')
  })
})
