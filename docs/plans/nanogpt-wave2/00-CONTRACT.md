# Wave 2 shared contract — NanoGPT correctness

Source of truth: `C:\Users\Hp\llm-wiki\raw\# NanoGPT API Documentation Referen.md`
(local vendored copy of the NanoGPT API reference, read it before editing).

Every module in wave 2 MUST honour the types and constants below verbatim. They are the
seams between modules that are edited by different agents in parallel.

## T1. Balance type (BREAKING — current shape is wrong)

The documented `POST /api/check-balance` response is:

```jsonc
{ "usd_balance": "12.34", "nano_balance": "5.67", "nanoDepositAddress": "nano_1..." }
```

All three are **strings**. The current code parses a numeric `payload.balance` +
`payload.currency`, which never matches, so `fetchBalance()` always throws.

New canonical type, declared in `src/main/nanogpt.ts` and mirrored (structurally identical)
in `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/lib/types.ts`:

```ts
export type NanoBalance = {
  /** Parsed from the documented string field `usd_balance`. */
  usd: number
  /** Parsed from the documented string field `nano_balance`. */
  nano: number
  /** Documented as `nanoDepositAddress`. Omitted when absent. */
  depositAddress?: string
}
```

Parse rule: `Number.parseFloat` on the string; a non-finite result for `usd_balance` is a
hard error (throw), `nano_balance` falls back to `0`.

## T2. IPC failure convention

Handlers that can fail on network MUST return `null` on failure, never a zero-valued
placeholder. A `$0.00` balance and "balance unknown" are different states and the UI must
be able to tell them apart.

- `oc:nanogpt:balance` -> `Promise<NanoBalance | null>`
- `oc:nanogpt:usage` -> `Promise<NanoUsage | null>`

Preload and renderer type declarations must say `| null` (today they lie).

## T3. Weekly token budget is INPUT tokens only

Documented subscription limit: **60 million input tokens per week**. Not total.
`WeeklyTokenData` keeps `inputTokens` / `outputTokens` separately; the budget gauge and any
percentage computation use `inputTokens` against `WEEKLY_INPUT_TOKEN_CAP = 60_000_000`.
Export that constant from `src/main/tokenBudgetTracker.ts`.

## T4. Documented subscription rate limits

| Limit | Value | Owner |
|---|---|---|
| Concurrency | 10 in flight | `nanogptLimiter` |
| Burst | 10 requests / 10 s | `nanogptLimiter` |
| Sustained | 60 requests / minute | `nanogptLimiter` (MISSING today) |
| Global account throughput | 25 requests / second | documented; out of scope, note only |
| Weekly input tokens | 60M | `tokenBudgetTracker` |
| Free images | 100 / day, resets 00:00 UTC | `nanogptImages.imagesToday` |

## T5. Retry policy (documented)

Retry with exponential backoff **and jitter** only on: `408`, `429`, `500`, `503`.
Never retry: `400`, `401`, `402`, `403`, `404`, `413`.
On `429`, honour the `Retry-After` header (integer seconds) when present.
Log the `X-Request-ID` response header on every error — it is the documented support handle.

## T6. Machine-readable error codes

The JSON error body carries a `code`. Preserve it on the thrown Error as a `code` property
so the renderer can branch. Documented values worth special-casing:
`content_policy_violation`, `context_length_exceeded`, `model_not_found`,
`model_not_available`, `all_fallbacks_failed`, `rate_limit_exceeded`,
`daily_rpd_limit_exceeded`, `daily_usd_limit_exceeded`, `insufficient_balance` (402).

## T7. Endpoint paths to verify, not blind-swap

Current code calls `GET /api/v1/image-models`. The reference documents
`GET /api/v1/images/models`. Both may exist (the reference notes an older and a newer
normalized image surface). M1 must probe both live before changing anything, and keep the
one that returns models. Do not swap on the strength of the doc alone.

`POST /api/subscription/v1/images/generations` (current primary, with fallback to
`/v1/images/generations`) is NOT in the reference. Leave the fallback chain alone.
