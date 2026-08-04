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

export type NanoUsage = {
  active: boolean
  limits: { daily: number; monthly: number }
  enforceDailyLimit?: boolean
  daily: { used: number; remaining: number; percentUsed: number; resetAt: number }
  monthly: { used: number; remaining: number; percentUsed: number; resetAt: number }
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

/**
 * An Error thrown from this module for an HTTP-level or network-level failure. `status` is
 * absent for network failures (DNS/socket/TLS/abort — see `networkError`). `code` is the
 * machine-readable error code from the JSON error body (contract T6), when present. `requestId`
 * is the `X-Request-ID` response header (support correlation id — never a secret). `retryable`
 * and `retryAfterMs` drive `withRetry`; they are internal to this module and not part of the
 * public contract.
 */
export type NanoGptError = Error & {
  status?: number
  code?: string
  requestId?: string
  retryable?: boolean
  retryAfterMs?: number
}

/** HTTP statuses that are safe to retry per contract T5. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 503])

/** `Retry-After` values above this many seconds are not worth waiting for — fail fast instead. */
const MAX_RETRY_AFTER_SEC = 30

/** Extract the documented machine-readable `code` from a parsed JSON error body, if present. */
function extractErrorCode(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined
  if (typeof parsed.code === 'string') return parsed.code
  if (isRecord(parsed.error) && typeof parsed.error.code === 'string') return parsed.error.code
  return undefined
}

/** Parse a `Retry-After` header value per contract T5: integer seconds only. */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  return Number(trimmed)
}

/**
 * Build a safe, redacted error for a non-ok HTTP response (status + reason + truncated body
 * only, never headers except the documented `X-Request-ID` support handle). Attaches `status`,
 * `code` (contract T6), `requestId` (contract T3/T5), and retry metadata (contract T5) used by
 * `withRetry`.
 */
async function httpError(res: Response, action: string): Promise<NanoGptError> {
  let bodyText = ''
  try {
    bodyText = await res.text()
  } catch {
    // ignore — body may already be consumed or unreadable
  }
  let parsedBody: unknown
  try {
    parsedBody = bodyText ? JSON.parse(bodyText) : undefined
  } catch {
    // body wasn't JSON — no machine-readable code available
  }
  const code = extractErrorCode(parsedBody)
  const requestId = res.headers.get('X-Request-ID') ?? undefined

  const bodySnippet = bodyText.slice(0, 200)
  let raw = `${action} failed: ${res.status} ${res.statusText}${bodySnippet ? ` — ${bodySnippet}` : ''}`
  if (requestId) raw += ` (X-Request-ID: ${requestId})`

  const error = new Error(safeError(new Error(raw))) as NanoGptError
  error.status = res.status
  if (code) error.code = code
  if (requestId) error.requestId = requestId

  if (res.status === 429) {
    const retryAfterSec = parseRetryAfterSeconds(res.headers.get('Retry-After'))
    if (retryAfterSec === undefined) {
      error.retryable = true
    } else if (retryAfterSec <= MAX_RETRY_AFTER_SEC) {
      error.retryable = true
      error.retryAfterMs = retryAfterSec * 1000
    } else {
      // Beyond the cap: fail fast rather than hanging the UI for the requested duration.
      error.retryable = false
    }
  } else {
    error.retryable = RETRYABLE_STATUSES.has(res.status)
  }
  return error
}

/** Build the redacted "unable to reach" error for a genuine network-level failure (never an HTTP status). Always retryable. */
function networkError(error: unknown): NanoGptError {
  const wrapped = new Error(`Unable to reach NanoGPT: ${safeError(error)}`) as NanoGptError
  wrapped.retryable = true
  return wrapped
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

/** Maximum number of retries (contract T5: "max 2 retries"). */
const MAX_RETRIES = 2

/** Exponential backoff with jitter: 500ms, 1000ms, ... plus up to 50% random jitter. */
function backoffWithJitter(attempt: number): number {
  const base = 500 * 2 ** attempt
  return base + Math.random() * base * 0.5
}

/**
 * Retry a fetch-based operation per contract T5: retry only on 408/429/500/503 responses
 * (`NanoGptError.retryable === true`, set by `httpError`) or a genuine network-level rejection
 * (set by `networkError`) — never on other 4xx business errors, and never on JSON-parsing or
 * response-shape validation failures (those are plain `Error`s with no `retryable` flag).
 * Exponential backoff with jitter; honours an explicit `retryAfterMs` (from the `Retry-After`
 * header on 429) in place of the computed backoff. Max `MAX_RETRIES` retries.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      const classified = error as NanoGptError
      if (!classified.retryable || attempt >= MAX_RETRIES) throw error
      const delayMs = classified.retryAfterMs ?? backoffWithJitter(attempt)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      attempt++
    }
  }
}

/** Shared GET/POST-with-retry helper: performs the fetch, classifies network/HTTP failures per contract T5, and returns the ok `Response`. */
async function fetchWithRetry(path: string, init: RequestInit, action: string): Promise<Response> {
  return withRetry(async () => {
    let res: Response
    try {
      res = await fetch(`${BASE}${path}`, init)
    } catch (error) {
      throw networkError(error)
    }
    if (!res.ok) throw await httpError(res, action)
    return res
  })
}

/** List chat/text models available on the caller's NanoGPT subscription. */
export async function fetchSubscriptionModels(): Promise<NanoChatModel[]> {
  const key = getApiKey()
  const res = await fetchWithRetry(
    '/api/subscription/v1/models?detailed=true',
    { headers: authHeaders(key, false), signal: AbortSignal.timeout(8000) },
    'Fetching NanoGPT subscription models'
  )
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
  // Path per contract T7 / spec D6: the reference documents GET /api/v1/images/models, but this
  // code has always called GET /api/v1/image-models. D6 requires a live probe of both before
  // swapping on the strength of the doc alone — no API key was available in this environment
  // (see M1 report), so the probe was not run and this path is left unchanged.
  const res = await fetchWithRetry(
    '/api/v1/image-models',
    { headers: authHeaders(key, false), signal: AbortSignal.timeout(8000) },
    'Fetching NanoGPT image models'
  )
  let payload: unknown
  try {
    payload = await res.json()
  } catch (error) {
    throw new Error(`Unable to parse NanoGPT image models response: ${safeError(error)}`)
  }
  return extractDataArray(payload).filter(hasNonEmptyId).map(toImageModel)
}

function toUsageBucket(value: unknown): { used: number; remaining: number; percentUsed: number; resetAt: number } | undefined {
  if (!isRecord(value)) return undefined
  const used = finiteNumberOrUndefined(value.used)
  const remaining = finiteNumberOrUndefined(value.remaining)
  const percentUsed = finiteNumberOrUndefined(value.percentUsed)
  const resetAt = finiteNumberOrUndefined(value.resetAt)
  if (used === undefined || remaining === undefined || percentUsed === undefined || resetAt === undefined) return undefined
  return { used, remaining, percentUsed, resetAt }
}

/** Fetch the caller's current subscription usage/limits. Throws a readable Error if the response shape is unusable. */
export async function fetchSubscriptionUsage(): Promise<NanoUsage> {
  const key = getApiKey()
  const res = await fetchWithRetry(
    '/api/subscription/v1/usage',
    { headers: authHeaders(key, false), signal: AbortSignal.timeout(8000) },
    'Fetching NanoGPT subscription usage'
  )
  let payload: unknown
  try {
    payload = await res.json()
  } catch (error) {
    throw new Error(`Unable to parse NanoGPT subscription usage response: ${safeError(error)}`)
  }
  if (!isRecord(payload)) throw new Error(safeError(new Error('NanoGPT subscription usage response was not a JSON object.')))

  const daily = toUsageBucket(payload.daily)
  const monthly = toUsageBucket(payload.monthly)
  if (!daily || !monthly) {
    throw new Error(safeError(new Error('NanoGPT subscription usage response is missing usable daily/monthly usage data.')))
  }

  const limitsSource = isRecord(payload.limits) ? payload.limits : {}
  const dailyLimit = finiteNumberOrUndefined(limitsSource.daily) ?? 0
  const monthlyLimit = finiteNumberOrUndefined(limitsSource.monthly) ?? 0

  const usage: NanoUsage = {
    active: payload.active === true,
    limits: { daily: dailyLimit, monthly: monthlyLimit },
    daily,
    monthly,
    state: typeof payload.state === 'string' ? payload.state : 'unknown'
  }
  if (typeof payload.enforceDailyLimit === 'boolean') usage.enforceDailyLimit = payload.enforceDailyLimit
  if (typeof payload.graceUntil === 'string' || payload.graceUntil === null) usage.graceUntil = payload.graceUntil
  return usage
}

/**
 * Canonical balance shape per contract T1. The documented `POST /api/check-balance` response
 * carries `usd_balance` / `nano_balance` as STRINGS (not numbers) — see the vendored API
 * reference. `usd` is a hard parse failure (throws) when non-finite; `nano` falls back to `0`.
 */
export type NanoBalance = {
  /** Parsed from the documented string field `usd_balance`. */
  usd: number
  /** Parsed from the documented string field `nano_balance`. */
  nano: number
  /** Documented as `nanoDepositAddress`. Omitted when absent. */
  depositAddress?: string
}

/** Fetch the caller's current pay-per-prompt balance. */
export async function fetchBalance(): Promise<NanoBalance> {
  const key = getApiKey()
  const res = await fetchWithRetry(
    '/api/check-balance',
    { method: 'POST', headers: authHeaders(key, true), body: JSON.stringify({}), signal: AbortSignal.timeout(8000) },
    'Checking NanoGPT balance'
  )
  let payload: unknown
  try {
    payload = await res.json()
  } catch (error) {
    throw new Error(`Unable to parse NanoGPT balance response: ${safeError(error)}`)
  }
  if (!isRecord(payload)) throw new Error('NanoGPT balance response was not a JSON object.')

  const usdRaw = payload.usd_balance
  const usd = typeof usdRaw === 'string' ? Number.parseFloat(usdRaw) : NaN
  if (!Number.isFinite(usd)) {
    throw new Error('NanoGPT balance response has a missing or non-numeric usd_balance.')
  }
  const nanoRaw = payload.nano_balance
  const nanoParsed = typeof nanoRaw === 'string' ? Number.parseFloat(nanoRaw) : NaN
  const nano = Number.isFinite(nanoParsed) ? nanoParsed : 0

  const balance: NanoBalance = { usd, nano }
  const depositAddress = stringOrUndefined(payload.nanoDepositAddress)
  if (depositAddress !== undefined) balance.depositAddress = depositAddress
  return balance
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
  const action = 'Generating an image with NanoGPT'

  // Retries (contract T5, including 429/Retry-After handling — folded in here per D5 so all
  // five endpoints share identical retry/error behaviour) happen within a single endpoint
  // attempt. 404/405 pass through un-thrown so the caller can fall back to the other endpoint —
  // any other non-ok status after retries are exhausted is a real failure and is NOT retried
  // against the fallback endpoint, since that could spend balance twice.
  const attempt = async (path: string): Promise<Response> => {
    return withRetry(async () => {
      let res: Response
      try {
        res = await fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: authHeaders(key, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000)
        })
      } catch (error) {
        throw networkError(error)
      }
      if (res.status === 404 || res.status === 405) return res
      if (!res.ok) throw await httpError(res, action)
      return res
    })
  }

  let res = await attempt('/api/subscription/v1/images/generations')
  let route: NanoImageResult['route'] = 'subscription'
  if (res.status === 404 || res.status === 405) {
    res = await attempt('/v1/images/generations')
    route = 'standard'
    if (res.status === 404 || res.status === 405) {
      throw await httpError(res, action)
    }
  }

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
