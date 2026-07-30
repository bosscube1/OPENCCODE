import { describe, expect, it } from 'vitest'
import { PERMISSION_KEYS, PERMISSION_PRESETS, summarizePermission } from '../permissionPresets'
import type { PermissionConfig } from '../types'

describe('PERMISSION_PRESETS', () => {
  it('offers ask-everything, workspace-write, and full-auto in that order', () => {
    expect(PERMISSION_PRESETS.map((p) => p.id)).toEqual(['ask', 'workspace', 'auto'])
    expect(PERMISSION_PRESETS.map((p) => p.label)).toEqual([
      'Ask everything',
      'Workspace write',
      'Full auto'
    ])
  })

  it('ask-everything sets every known key to ask', () => {
    const ask = PERMISSION_PRESETS[0]
    for (const key of PERMISSION_KEYS) {
      expect(ask.permission[key]).toBe('ask')
    }
  })

  it('workspace-write allows edit/webfetch and keeps bash on ask', () => {
    expect(PERMISSION_PRESETS[1].permission).toEqual({
      edit: 'allow',
      webfetch: 'allow',
      bash: 'ask'
    })
  })

  it('full-auto allows edit/bash/webfetch and nothing else', () => {
    expect(PERMISSION_PRESETS[2].permission).toEqual({
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow'
    })
  })

  it('only uses keys the main-process validator accepts', () => {
    for (const preset of PERMISSION_PRESETS) {
      for (const key of Object.keys(preset.permission)) {
        expect(PERMISSION_KEYS).toContain(key)
      }
    }
  })
})

describe('summarizePermission', () => {
  it('shows defaults for unset keys', () => {
    expect(summarizePermission(null)).toEqual([
      { key: 'edit', value: 'default' },
      { key: 'bash', value: 'default' },
      { key: 'webfetch', value: 'default' },
      { key: 'doom_loop', value: 'default' },
      { key: 'external_directory', value: 'default' }
    ])
    expect(summarizePermission({})).toEqual(summarizePermission(null))
  })

  it('shows plain levels verbatim', () => {
    const summary = summarizePermission({ edit: 'allow', webfetch: 'deny' })
    expect(summary.find((r) => r.key === 'edit')).toEqual({ key: 'edit', value: 'allow' })
    expect(summary.find((r) => r.key === 'webfetch')).toEqual({ key: 'webfetch', value: 'deny' })
    expect(summary.find((r) => r.key === 'bash')).toEqual({ key: 'bash', value: 'default' })
  })

  it('summarises a per-pattern bash map by rule count', () => {
    const permission: PermissionConfig = { bash: { 'git *': 'allow', 'rm *': 'deny' } }
    expect(summarizePermission(permission).find((r) => r.key === 'bash')).toEqual({
      key: 'bash',
      value: '2 patterns'
    })
    expect(summarizePermission({ bash: { 'git *': 'allow' } }).find((r) => r.key === 'bash')).toEqual({
      key: 'bash',
      value: '1 pattern'
    })
    expect(summarizePermission({ bash: {} }).find((r) => r.key === 'bash')).toEqual({
      key: 'bash',
      value: 'default'
    })
  })
})
