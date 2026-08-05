/**
 * Electron MAIN-process REST client for nano-gpt.com.
 *
 * SECURITY: the BYOK API key is read transiently from `loadByokEnv()` / `process.env` for the
 * duration of a single request, is NEVER logged (no `console.log` anywhere in this module), and
 * NEVER appears in a thrown error message — every throw site routes its message through
 * `safeError`, which redacts the resolved key (and any `key`/`api_key`/`apiKey` query param)
 * before the message can leave this module.
 */
import { loadByokEnv } from './keys'

const BASE = 'https://nano-gpt.com'

export type NanoChatModel = {
  id: string
  name?: string
  description?: string
  context_length?: number
  max_output_tokens?: number
  capabilities?: { vision?: boolean; tool_calling?: boolean }
}

export type NanoImageModel = {
  id: string
  name?: string
  description?: string
  pricing?: unknown
  supported_parameters?: string[]
  tags?: string[]
}

/**
 * Every field is independently optional. NanoGPT does not publish a schema for
 * `/api/subscription/v1/usage`, so this type deliberately assumes nothing: a read-only quota
 * readout should degrade (show what's known, `—` for what isn't) rather than hard-fail because
 * one number is missing. Do not tighten these back to required without a captured payload to
 * justify it.
 */
export type NanoUsageBucket = {
  used?: number
  remaining?: number
  percentUsed?: number
  resetAt?: number
}

/**
 * Captured from a live `/api/subscription/v1/usage` response (2026-08): the real buckets are
 * `dailyInputTokens`, `weeklyInputTokens`, and `dailyImages` — there is no `monthly` bucket at
 * all, and the period boundary lives at `period.currentPeriodEnd` instead.
 *
 * Each bucket/limit is `NanoUsageBucket | null | undefined` (not just optional), because "no
 * cap" and "unknown" are different facts and both occur on real accounts: a plan with no daily
 * token cap sends `dailyInputTokens: null` explicitly (we preserve that as `null`), whereas a
 * key that's simply absent or malformed means we don't know (`undefined`, degrades to `—` in the
 * renderer). Do not collapse the two.
 */
export type NanoUsage = {
  active: boolean
  limits: {
    dailyInputTokens?: number | null
    weeklyInputTokens?: number | null
    dailyImages?: number | null
  }
  dailyInputTokens?: NanoUsageBucket | null
  weeklyInputTokens?: NanoUsageBucket | null
  dailyImages?: NanoUsageBucket | null
  /** `currentPeriodEnd` is an ISO timestamp string, e.g. from `period.currentPeriodEnd`. */
  period?: { currentPeriodEnd?: string }
  state: string
  graceUntil?: string | null
}

export type NanoImageRequest = {
  model: string
  prompt: string
  n?: number
  size?: string
}

export type NanoImageResult = {
  images: Array<{ b64: string; mime: string }>
  cost?: number
  paymentSource?: string
  remainingBalance?: number
  /** Which endpoint actually served the request — 'subscription' or 'standard'. */
  route: 'subscription' | 'standard'
}

/**
 * Resolve the NanoGPT API key transiently for the duration of the calling request. Never cached,
 * never logged. Throws when no key is configured.
 */
function getApiKey(): string {
  const env = loadByokEnv()
  const key = env.NANOGPT_API_KEY ?? process.env.NANOGPT_API_KEY
  if (!key) throw new Error('No NanoGPT API key is configured. Add NanoGPT under Providers first.')
  return key
}

/**
 * Redact secrets from an error before it can be thrown or surfaced. Replaces every occurrence of
 * the resolved API key (if one could be resolved) with `[redacted]`, and strips any
 * `key=`/`api_key=`/`apiKey=` query parameter value. Modelled on the `safeError` helper in
 * `geminiLive.ts`.
 */
function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  let key: string | undefined
  try {
    key = getApiKey()
  } catch {
    key = undefined
  }
  if (key && key.length > 0) {
    message = message.split(key).join('[redacted]')
  }
  message = message.replace(/([?&](?:key|api_key|apiKey)=)[^&\s]+/gi, '$1[redacted]')
  return message
}

function authHeaders(key: string, json: boolean): Record<string, string> {
  return json ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${key}` }
}

/** Build a safe, redacted error message for a non-ok HTTP response (status + reason + truncated body only, never headers). */
async function httpError(res: Response, action: string): Promise<Error> {
  let bodySnippet = ''
  try {
    bodySnippet = (await res.text()).slice(0, 200)
  } catch {
    // ignore — body may already be consumed or unreadable
  }
  const raw = `${action} failed: ${res.status} ${res.statusText}${bodySnippet ? ` — ${bodySnippet}` : ''}`
  return new Error(safeError(new Error(raw)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Extract the `data` array from either an OpenAI-style `{ data: [...] }` envelope or a bare array. Never throws. */
function extractDataArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data
  return []
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Coerce an unknown catalog entry into a `NanoChatModel`, defensively. Non-object entries or entries without a non-empty string `id` are dropped by the caller. */
function toChatModel(entry: Record<string, unknown>): NanoChatModel {
  const model: NanoChatModel = { id: entry.id as string }
  const name = stringOrUndefined(entry.name)
  if (name !== undefined) model.name = name
  const description = stringOrUndefined(entry.description)
  if (description !== undefined) model.description = description
  const contextLength = finiteNumberOrUndefined(entry.context_length)
  if (contextLength !== undefined) model.context_length = contextLength
  const maxOutputTokens = finiteNumberOrUndefined(entry.max_output_tokens)
  if (maxOutputTokens !== undefined) model.max_output_tokens = maxOutputTokens
  if (isRecord(entry.capabilities)) {
    const capabilities: NanoChatModel['capabilities'] = {}
    if (typeof entry.capabilities.vision === 'boolean') capabilities.vision = entry.capabilities.vision
    if (typeof entry.capabilities.tool_calling === 'boolean') capabilities.tool_calling = entry.capabilities.tool_calling
    model.capabilities = capabilities
  }
  return model
}

/** Coerce an unknown catalog entry into a `NanoImageModel`, defensively. Non-object entries or entries without a non-empty string `id` are dropped by the caller. */
function toImageModel(entry: Record<string, unknown>): NanoImageModel {
  const model: NanoImageModel = { id: entry.id as string }
  const name = stringOrUndefined(entry.name)
  if (name !== undefined) model.name = name
  const description = stringOrUndefined(entry.description)
  if (description !== undefined) model.description = description
  if ('pricing' in entry) model.pricing = entry.pricing
  if (Array.isArray(entry.supported_parameters) && entry.supported_parameters.every((item) => typeof item === 'string')) {
    model.supported_parameters = entry.supported_parameters as string[]
  }
  if (Array.isArray(entry.tags) && entry.tags.every((item) => typeof item === 'string')) {
    model.tags = entry.tags as string[]
  }
  return model
}

function hasNonEmptyId(entry: unknown): entry is Record<string, unknown> {
  return isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0
}

/** List chat/text models available on the caller's NanoGPT subscription. */
export async function fetchSubscriptionModels(): Promise<NanoChatModel[]> {
  const key = getApiKey()
  let res: Response
  try {
    res = await fetch(`${BASE}/api/subscription/v1/models?detailed=true`, {
      headers: authHeaders(key, false),
      signal: AbortSignal.timeout(8000)
    })
  } catch (error) {
    throw new Error(`Unable to reach NanoGPT: ${safeError(error)}`)
  }
  if (!res.ok) throw await httpError(res, 'Fetching NanoGPT subscription models')
  let payload: unknown
  try {
    payload = await res.json()
  } catch (error) {
    throw new Error(`Unable to parse NanoGPT subscription models response: ${safeError(error)}`)
  }
  return extractDataArray(payload).filter(hasNonEmptyId).map(toChatModel)
}

/** List image-generation models available on NanoGPT. */
export async function fetchImageModels(): Promise<NanoImageModel[]> {
  const key = getApiKey()
  let res: Response
  try {
    res = await fetch(`${BASE}/api/v1/image-models`, {
      headers: authHeaders(key, false),
      signal: AbortSignal.timeout(8000)
    })
  } catch (error) {
    throw new Error(`Unable to reach NanoGPT: ${safeError(error)}`)
  }
  if (!res.ok) throw await httpError(res, 'Fetching NanoGPT image models')
  let payload: unknown
  try {
    payload = await res.json()
  } catch (error) {
    throw new Error(`Unable to parse NanoGPT image models response: ${safeError(error)}`)
  }
  return extractDataArray(payload).filter(hasNonEmptyId).map(toImageModel)
}

/**
 * Resolve a limit field: an explicit `null` means "no cap" and is preserved as `null`; a finite
 * number is kept as-is; anything else (key absent, or present but not a number) is unknown and
 * becomes `undefined`. Keeping these distinct matters — "no cap" and "we don't know" render
 * differently.
 */
function toLimit(value: unknown): number | null | undefined {
  if (value === null) return null
  return finiteNumberOrUndefined(value)
}

/**
 * Build a usage bucket from whatever fields are actually present, deriving the rest where
 * possible instead of demanding all four. Given a `limit` (the cap from `payload.limits`, itself
 * `number | null | undefined`), `used` and `remaining` are complements of each other, and
 * `percentUsed` follows from `used` — but only once the limit is a known finite number; a `null`
 * (no cap) or unknown limit leaves those undecidable and they stay `undefined` rather than being
 * fabricated. Anything that can't be derived is left `undefined` — the renderer shows `—` for
 * those.
 *
 * Returns `null` when the bucket itself is explicitly `null` in the payload — a known fact ("no
 * such quota"), not a parse failure. Returns `undefined` when the bucket key is absent or not an
 * object (unknown/malformed).
 */
function toUsageBucket(value: unknown, limit: number | null | undefined): NanoUsageBucket | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  let used = finiteNumberOrUndefined(value.used)
  let remaining = finiteNumberOrUndefined(value.remaining)
  let percentUsed = finiteNumberOrUndefined(value.percentUsed)
  const resetAt = finiteNumberOrUndefined(value.resetAt)

  const knownLimit = typeof limit === 'number' ? limit : undefined
  if (used === undefined && remaining !== undefined && knownLimit !== undefined) used = knownLimit - remaining
  if (remaining === undefined && used !== undefined && knownLimit !== undefined) remaining = knownLimit - used
  if (percentUsed === undefined && used !== undefined && knownLimit) percentUsed = (used / knownLimit) * 100

  return { used, remaining, percentUsed, resetAt }
}

/** Fetch the caller's current subscription usage/limits. Throws a readable Error if the response shape is unusable. */
export async function fetchSubscriptionUsage(): Promise<NanoUsage> {
  const key = getApiKey()
  let res: Response
  try {
    res = await fetch(`${BASE}/api/subscription/v1/usage`, {
      headers: authHeaders(key, false),
      signal: AbortSignal.timeout(8000)
    })
  } catch (error) {
    throw new Error(`Unable to reach NanoGPT: ${safeError(error)}`)
  }
  if (!res.ok) throw await httpError(res, 'Fetching NanoGPT subscription usage')
  let payload: unknown
  try {
    payload = await res.json()
  } catch (error) {
    throw new Error(`Unable to parse NanoGPT subscription usage response: ${safeError(error)}`)
  }
  if (!isRecord(payload)) throw new Error(safeError(new Error('NanoGPT subscription usage response was not a JSON object.')))

  // Prefer the real field names captured from a live response. `dailyInputTokens` is the only
  // one with a legacy equivalent (the old, wrong `daily` name) — fall back to it only when
  // `dailyInputTokens` isn't present at all (an explicit `null` is meaningful and is NOT
  // overridden by the fallback). `weeklyInputTokens` and `dailyImages` have no legacy names, and
  // `monthly` is deliberately never used as a fallback for `weeklyInputTokens` — a weekly number
  // shown under a monthly label would be a lie, not just an approximation.
  const dailyInputTokensRaw = 'dailyInputTokens' in payload ? payload.dailyInputTokens : payload.daily
  const weeklyInputTokensRaw = payload.weeklyInputTokens
  const dailyImagesRaw = payload.dailyImages

  // Only a genuinely unusable payload throws — none of the three buckets present as an object in
  // any form (including the legacy `daily` fallback). A bucket that's present but missing
  // individual fields, or explicitly `null`, degrades via toUsageBucket instead.
  //
  // The message names the keys the payload *did* carry, so a repeat failure is diagnosable
  // without guessing again. Keys only, never values — the payload is account data.
  if (!isRecord(dailyInputTokensRaw) && !isRecord(weeklyInputTokensRaw) && !isRecord(dailyImagesRaw)) {
    const observed = Object.keys(payload)
    const sawKeys = observed.length ? ` Response carried: ${observed.join(', ')}.` : ' Response was an empty object.'
    throw new Error(
      safeError(
        new Error(
          `NanoGPT subscription usage response has none of dailyInputTokens, weeklyInputTokens, or dailyImages.${sawKeys}`
        )
      )
    )
  }

  const limitsSource = isRecord(payload.limits) ? payload.limits : {}
  const dailyInputTokensLimit = toLimit('dailyInputTokens' in limitsSource ? limitsSource.dailyInputTokens : limitsSource.daily)
  const weeklyInputTokensLimit = toLimit(limitsSource.weeklyInputTokens)
  const dailyImagesLimit = toLimit(limitsSource.dailyImages)

  const usage: NanoUsage = {
    active: payload.active === true,
    limits: {
      dailyInputTokens: dailyInputTokensLimit,
      weeklyInputTokens: weeklyInputTokensLimit,
      dailyImages: dailyImagesLimit
    },
    dailyInputTokens: toUsageBucket(dailyInputTokensRaw, dailyInputTokensLimit),
    weeklyInputTokens: toUsageBucket(weeklyInputTokensRaw, weeklyInputTokensLimit),
    dailyImages: toUsageBucket(dailyImagesRaw, dailyImagesLimit),
    state: typeof payload.state === 'string' ? payload.state : 'unknown'
  }
  if (isRecord(payload.period) && typeof payload.period.currentPeriodEnd === 'string') {
    usage.period = { currentPeriodEnd: payload.period.currentPeriodEnd }
  }
  if (typeof payload.graceUntil === 'string' || payload.graceUntil === null) usage.graceUntil = payload.graceUntil
  return usage
}

type GenerationEntry = { b64: string; mime: string }

function extractImages(payload: unknown): GenerationEntry[] {
  const entries = extractDataArray(payload)
  const images: GenerationEntry[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const b64 = stringOrUndefined(entry.b64_json)
    if (b64 !== undefined) {
      images.push({ b64, mime: 'image/png' })
      continue
    }
    if (typeof entry.url === 'string') {
      throw new Error(
        'NanoGPT returned a URL-form image response, which is not supported (the renderer CSP is img-src \'self\' data: blob:, so a remote image URL cannot render). Request response_format: b64_json.'
      )
    }
  }
  return images
}

/**
 * Generate one or more images via NanoGPT. Always requests `response_format: 'b64_json'` — the
 * renderer's Content-Security-Policy is `img-src 'self' data: blob:`, so a remote image URL
 * returned by the API could never actually render in the UI.
 *
 * Tries the subscription endpoint first; falls back to the standard endpoint only on 404/405
 * (endpoint not found/not allowed). Any other non-ok status (401/402/429/500/...) is a real
 * failure and is NOT retried against the fallback endpoint, since that could spend balance twice.
 */
export async function generateImage(req: NanoImageRequest): Promise<NanoImageResult> {
  const key = getApiKey()
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    n: req.n ?? 1,
    response_format: 'b64_json'
  }
  if (req.size !== undefined) body.size = req.size

  const attempt = async (path: string): Promise<Response> => {
    try {
      return await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: authHeaders(key, true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000)
      })
    } catch (error) {
      throw new Error(`Unable to reach NanoGPT: ${safeError(error)}`)
    }
  }

  let res = await attempt('/api/subscription/v1/images/generations')
  let route: NanoImageResult['route'] = 'subscription'
  if (res.status === 404 || res.status === 405) {
    res = await attempt('/v1/images/generations')
    route = 'standard'
  }
  if (!res.ok) throw await httpError(res, 'Generating an image with NanoGPT')

  let payload: unknown
  try {
    payload = await res.json()
  } catch (error) {
    throw new Error(`Unable to parse NanoGPT image generation response: ${safeError(error)}`)
  }

  const images = extractImages(payload)
  if (images.length === 0) {
    throw new Error(safeError(new Error('NanoGPT returned no image data for this request.')))
  }
  const result: NanoImageResult = { images, route }
  if (isRecord(payload)) {
    const cost = finiteNumberOrUndefined(payload.cost)
    if (cost !== undefined) result.cost = cost
    const paymentSource = stringOrUndefined(payload.paymentSource)
    if (paymentSource !== undefined) result.paymentSource = paymentSource
    const remainingBalance = finiteNumberOrUndefined(payload.remainingBalance)
    if (remainingBalance !== undefined) result.remainingBalance = remainingBalance
  }
  return result
}
