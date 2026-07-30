/**
 * Validation for the optional `oc:prompt` body fields. Kept out of ipc.ts (which loads
 * Electron) so the rules stay unit-testable. Every field validated here lands in the
 * `promptAsync` body, so anything unvalidated must be rejected rather than forwarded.
 */

/** Maximum entries in a per-request tool policy — well above any legitimate use. */
const MAX_TOOL_POLICY_KEYS = 64

/**
 * Validate an optional per-request tool policy for `promptAsync`.
 *
 * Every key lands in the agent's tool registry, so this is an allowlisted character class rather than
 * a blocklist: lowercase identifiers only, booleans only, bounded size. Returns undefined when absent
 * so the body field is omitted entirely and default tool behaviour is untouched.
 */
export function optionalToolPolicy(value: unknown): Record<string, boolean> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid IPC argument: tools must be an object of boolean flags.')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return undefined
  if (entries.length > MAX_TOOL_POLICY_KEYS) {
    throw new Error(`Invalid IPC argument: tools may not exceed ${MAX_TOOL_POLICY_KEYS} entries.`)
  }
  const policy: Record<string, boolean> = {}
  for (const [key, flag] of entries) {
    if (!/^[a-z_][a-z0-9_]{0,63}$/.test(key)) {
      throw new Error(`Invalid IPC argument: "${key}" is not a valid tool name.`)
    }
    if (typeof flag !== 'boolean') {
      throw new Error(`Invalid IPC argument: tools.${key} must be a boolean.`)
    }
    policy[key] = flag
  }
  return policy
}

/**
 * Validate an optional agent name for `promptAsync`.
 *
 * Names come from the server's own agent registry (`oc:agents:list`), so the same conservative
 * charset as MCP connector names is used: 1-64 letters, numbers, dots, underscores, or hyphens.
 * Returns undefined when absent so the body field is omitted and the server default agent runs.
 */
export function optionalAgentName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error('Invalid IPC argument: agent must be a string.')
  }
  const name = value.trim()
  if (name.length === 0) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      'Invalid IPC argument: agent must be 1-64 letters, numbers, dots, underscores, or hyphens.'
    )
  }
  return name
}
