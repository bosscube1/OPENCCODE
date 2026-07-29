/**
 * Permission presets for the Settings panel, plus a readout summariser.
 * PURE — no store, no React, no IPC.
 *
 * A preset is written as the `permission` key of the project's opencode.json via
 * `oc:config:permission:set`; main validates it again before anything is persisted.
 */

import type { PermissionConfig } from './types'

export type PermissionPreset = {
  id: 'ask' | 'workspace' | 'auto'
  label: string
  description: string
  permission: PermissionConfig
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    id: 'ask',
    label: 'Ask everything',
    description: 'Prompt before every edit, shell command, or fetch.',
    permission: {
      edit: 'ask',
      bash: 'ask',
      webfetch: 'ask',
      doom_loop: 'ask',
      external_directory: 'ask'
    }
  },
  {
    id: 'workspace',
    label: 'Workspace write',
    description: 'Edits and fetches run freely; shell commands still ask.',
    permission: {
      edit: 'allow',
      webfetch: 'allow',
      bash: 'ask'
    }
  },
  {
    id: 'auto',
    label: 'Full auto',
    description: 'Edits, shell commands, and fetches all run without asking.',
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow'
    }
  }
]

/** The keys the main-process validator accepts, in display order. */
export const PERMISSION_KEYS = ['edit', 'bash', 'webfetch', 'doom_loop', 'external_directory'] as const

/**
 * One row per known key for the current-values readout. Unset keys show as "default"
 * (the server's own defaults apply); a per-pattern bash map shows its rule count.
 */
export function summarizePermission(
  permission: PermissionConfig | null
): Array<{ key: string; value: string }> {
  return PERMISSION_KEYS.map((key) => {
    const raw = permission?.[key]
    let value: string
    if (raw === undefined) {
      value = 'default'
    } else if (typeof raw === 'string') {
      value = raw
    } else {
      const count = Object.keys(raw).length
      value = count === 0 ? 'default' : `${count} pattern${count === 1 ? '' : 's'}`
    }
    return { key, value }
  })
}
