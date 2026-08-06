/**
 * Agent profile type, validation, and built-in defaults for the agentic harness.
 *
 * A profile defines an agent's identity, model selection, generation parameters,
 * tool access, and budget constraints.
 */

export type AgentProfile = {
  id: string
  name: string
  description?: string

  // ── Model Selection ──
  provider: string
  model: string
  fallbackModels?: string[]

  // ── Generation Parameters ──
  temperature?: number
  maxTokens?: number
  topP?: number
  thinking?: {
    enabled: boolean
    budget?: number
  }

  // ── System Prompt & Persona ──
  systemPrompt?: string
  systemPromptFile?: string

  // ── Tool Access ──
  tools?: string[]
  toolDenyList?: string[]
  readOnly?: boolean

  // ── Concurrency & Budget ──
  maxConcurrent?: number
  maxTurns?: number
  tokenBudget?: number
  costBudget?: number

  // ── Routing ──
  /** NanoGPT routing suffix: ':fast', ':cheap'. Only applies when provider is 'nanogpt'. */
  routingSuffix?: string
  /** NanoGPT billing route: 'subscription' uses the covered tier, 'standard' uses pay-per-prompt. */
  billingRoute?: 'subscription' | 'standard'
  caching?: boolean

  // ── Metadata ──
  builtin?: boolean
  createdAt?: number
  updatedAt?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Profile validation: ${field} must be a non-empty string.`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function optionalNumber(value: unknown, min?: number, max?: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (min !== undefined && value < min) return undefined
  if (max !== undefined && value > max) return undefined
  return value
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return result.length > 0 ? result : undefined
}

const VALID_BILLING_ROUTES = new Set(['subscription', 'standard'])
const VALID_ROUTING_SUFFIXES = new Set([':fast', ':cheap', ':speed', ':price'])

/** Validate and normalise a raw value into a well-formed AgentProfile. */
export function validateProfile(raw: unknown): AgentProfile {
  if (!isRecord(raw)) throw new Error('Profile validation: input must be an object.')

  const id = requireString(raw.id, 'id')
  if (!/^[a-z0-9_-]+$/.test(id)) {
    throw new Error('Profile validation: id must contain only lowercase letters, digits, hyphens, and underscores.')
  }
  if (id.length > 64) {
    throw new Error('Profile validation: id must be 64 characters or fewer.')
  }

  const name = requireString(raw.name, 'name')
  const provider = requireString(raw.provider, 'provider')
  const model = requireString(raw.model, 'model')

  const profile: AgentProfile = { id, name, provider, model }

  const description = optionalString(raw.description)
  if (description !== undefined) profile.description = description

  profile.fallbackModels = optionalStringArray(raw.fallbackModels)

  const temperature = optionalNumber(raw.temperature, 0, 2)
  if (temperature !== undefined) profile.temperature = temperature

  const maxTokens = optionalNumber(raw.maxTokens, 1, 1_000_000)
  if (maxTokens !== undefined) profile.maxTokens = Math.round(maxTokens)

  const topP = optionalNumber(raw.topP, 0, 1)
  if (topP !== undefined) profile.topP = topP

  if (isRecord(raw.thinking)) {
    const enabled = optionalBoolean(raw.thinking.enabled)
    if (enabled !== undefined) {
      profile.thinking = { enabled }
      const budget = optionalNumber(raw.thinking.budget, 1, 1_000_000)
      if (budget !== undefined) profile.thinking.budget = Math.round(budget)
    }
  }

  const systemPrompt = optionalString(raw.systemPrompt)
  if (systemPrompt !== undefined) profile.systemPrompt = systemPrompt

  const systemPromptFile = optionalString(raw.systemPromptFile)
  if (systemPromptFile !== undefined) profile.systemPromptFile = systemPromptFile

  profile.tools = optionalStringArray(raw.tools)
  profile.toolDenyList = optionalStringArray(raw.toolDenyList)

  const readOnly = optionalBoolean(raw.readOnly)
  if (readOnly !== undefined) profile.readOnly = readOnly

  const maxConcurrent = optionalNumber(raw.maxConcurrent, 1, 50)
  if (maxConcurrent !== undefined) profile.maxConcurrent = Math.round(maxConcurrent)

  const maxTurns = optionalNumber(raw.maxTurns, 1, 500)
  if (maxTurns !== undefined) profile.maxTurns = Math.round(maxTurns)

  const tokenBudget = optionalNumber(raw.tokenBudget, 1)
  if (tokenBudget !== undefined) profile.tokenBudget = Math.round(tokenBudget)

  const costBudget = optionalNumber(raw.costBudget, 0)
  if (costBudget !== undefined) profile.costBudget = costBudget

  if (typeof raw.routingSuffix === 'string' && VALID_ROUTING_SUFFIXES.has(raw.routingSuffix)) {
    profile.routingSuffix = raw.routingSuffix
  }

  if (typeof raw.billingRoute === 'string' && VALID_BILLING_ROUTES.has(raw.billingRoute)) {
    profile.billingRoute = raw.billingRoute as 'subscription' | 'standard'
  }

  const caching = optionalBoolean(raw.caching)
  if (caching !== undefined) profile.caching = caching

  const builtin = optionalBoolean(raw.builtin)
  if (builtin !== undefined) profile.builtin = builtin

  return profile
}

/** Sensible built-in profiles. Read-only — users can clone and customise. */
export const BUILTIN_PROFILES: readonly AgentProfile[] = Object.freeze([
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'High-capability planning agent for complex multi-step tasks. GLM-5.2 thinking, 1M context, x1 subscription cost.',
    provider: 'nanogpt',
    model: 'zai-org/glm-5.2:thinking',
    temperature: 0.3,
    maxTokens: 16384,
    thinking: { enabled: true, budget: 32768 },
    tools: ['*'],
    maxTurns: 50,
    billingRoute: 'subscription',
    builtin: true
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Fast wide-context model for information gathering. Read-only tools, no thinking overhead. DeepSeek V4 Flash, 1M context, cheapest x1.',
    provider: 'nanogpt',
    model: 'deepseek/deepseek-v4-flash:thinking',
    routingSuffix: ':fast',
    temperature: 0.2,
    maxTokens: 8192,
    readOnly: true,
    maxTurns: 20,
    billingRoute: 'subscription',
    builtin: true
  },
  {
    id: 'coder',
    name: 'Coder',
    description: 'Code-specialized model with file and shell access. Qwen3 Coder Next, x1 subscription cost, default implementer.',
    provider: 'nanogpt',
    model: 'qwen/qwen3-coder-next',
    temperature: 0.1,
    maxTokens: 16384,
    tools: ['fs_read', 'fs_write', 'fs_list', 'grep', 'shell', 'think'],
    maxTurns: 40,
    billingRoute: 'subscription',
    builtin: true
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Read-only review agent for code critique and analysis. Nemotron-3 Super, cheap x1 subscription cost.',
    provider: 'nanogpt',
    model: 'nvidia/nemotron-3-super-120b-a12b:thinking',
    routingSuffix: ':cheap',
    temperature: 0.5,
    maxTokens: 8192,
    readOnly: true,
    maxTurns: 10,
    billingRoute: 'subscription',
    builtin: true
  }
])
