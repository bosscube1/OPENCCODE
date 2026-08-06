import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

import { ProfileStore } from '../harness/profileStore'
import { BUILTIN_PROFILES } from '../harness/profiles'

describe('ProfileStore', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'opencode-profile-store-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('lists built-in profiles when no custom profiles exist', () => {
    const store = new ProfileStore()
    const list = store.list()
    expect(list.length).toBe(BUILTIN_PROFILES.length)
    expect(store.get('orchestrator')?.builtin).toBe(true)
    expect(store.get('missing')).toBeUndefined()
  })

  it('round-trips a custom profile: save → list/get → update → delete', async () => {
    const store = new ProfileStore()

    const saved = await store.save({ id: 'helper', name: 'Helper', provider: 'nanogpt', model: 'm' })
    expect(saved.createdAt).toBeTypeOf('number')
    expect(saved.updatedAt).toBeTypeOf('number')

    expect(store.get('helper')?.name).toBe('Helper')
    expect(store.list().some((p) => p.id === 'helper')).toBe(true)

    // Persisted to disk in the mocked userData dir.
    const onDisk = JSON.parse(readFileSync(join(userDataPath, 'harness-profiles.json'), 'utf8')) as {
      version: number
      profiles: Array<{ id: string }>
    }
    expect(onDisk.version).toBe(1)
    expect(onDisk.profiles.map((p) => p.id)).toEqual(['helper'])

    const updated = await store.save({ id: 'helper', name: 'Helper v2', provider: 'nanogpt', model: 'm' })
    expect(updated.createdAt).toBe(saved.createdAt)
    expect(store.get('helper')?.name).toBe('Helper v2')
    expect(store.list().filter((p) => p.id === 'helper')).toHaveLength(1)

    expect(await store.delete('helper')).toBe(true)
    expect(store.get('helper')).toBeUndefined()
    expect(await store.delete('helper')).toBe(false)
  })

  it('a fresh store instance reloads persisted custom profiles from disk', async () => {
    const first = new ProfileStore()
    await first.save({ id: 'helper', name: 'Helper', provider: 'nanogpt', model: 'm' })

    const second = new ProfileStore()
    expect(second.get('helper')?.name).toBe('Helper')
  })

  it('refuses to save a profile marked as built-in', async () => {
    const store = new ProfileStore()
    await expect(
      store.save({ id: 'x', name: 'X', provider: 'p', model: 'm', builtin: true })
    ).rejects.toThrow(/built-in/)
    expect(store.get('x')).toBeUndefined()
  })

  it('refuses to overwrite a built-in profile id, even without the builtin flag', async () => {
    const store = new ProfileStore()
    await expect(
      store.save({ id: 'coder', name: 'Evil Coder', provider: 'p', model: 'm' })
    ).rejects.toThrow(/built-in/)
    // The built-in definition is untouched.
    expect(store.get('coder')?.name).toBe('Coder')
  })

  it('refuses to delete a built-in profile', async () => {
    const store = new ProfileStore()
    await expect(store.delete('reviewer')).rejects.toThrow(/built-in/)
    expect(store.get('reviewer')).toBeDefined()
  })

  it('treats a corrupt store file as empty and never throws', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(userDataPath, 'harness-profiles.json'), '{not json', 'utf8')
    const store = new ProfileStore()
    expect(store.list().length).toBe(BUILTIN_PROFILES.length)
  })
})
