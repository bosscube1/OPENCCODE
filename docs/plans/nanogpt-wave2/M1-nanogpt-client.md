# M1 — NanoGPT HTTP client correctness

Read `00-CONTRACT.md` first. Read the vendored API reference at
`C:\Users\Hp\llm-wiki\raw\# NanoGPT API Documentation Referen.md`.

## Owns (exclusive — no other wave-2 module edits these)
- `src/main/nanogpt.ts`
- `src/main/__tests__/nanogpt.test.ts` (create if absent)

## Do NOT touch
`ipc.ts`, any renderer file, any preload file. Other agents own those and will consume your
exported types via the contract.

## Defects to fix

### D1 (critical) — `fetchBalance` can never succeed
It reads a numeric `payload.balance` / `payload.currency`. The documented response is
`{usd_balance: string, nano_balance: string, nanoDepositAddress: string}`. Rewrite to the
`NanoBalance` type in contract T1. Keep the "response was not a JSON object" guard.

### D2 (critical) — `withRetry` is dead code
`withRetry` (nanogpt.ts:~170) only retries when `error instanceof TypeError`, but every
wrapped function catches its own fetch rejection and rethrows
`new Error('Unable to reach NanoGPT: ...')`. The `TypeError` never escapes, so no call site
has ever retried. `AbortSignal.timeout` also throws `DOMException`, not `TypeError`.

Replace with a status-aware retry per contract T5: retry on 408/429/500/503 and on genuine
network rejection; never on 4xx business errors. Exponential backoff with jitter, max 2
retries. Honour `Retry-After` (integer seconds) on 429, capped at 30s — beyond that, fail
fast rather than hanging the UI.

### D3 — `X-Request-ID` is discarded
`httpError` builds a redacted message from status + 200 chars of body. Append the
`X-Request-ID` response header when present (it is a support correlation id, not a secret).

### D4 — error `code` is lost
Parse the JSON error body and attach the machine-readable `code` (contract T6) to the thrown
Error as a `code` property. Keep the existing body truncation and never include headers
beyond `X-Request-ID`.

### D5 — 429 handling is image-only and lossy
`generateImage` special-cases 429 inline. Fold that into the shared retry/error path so all
five endpoints behave identically.

### D6 — endpoint verification (contract T7)
Probe `GET /api/v1/image-models` and `GET /api/v1/images/models` against the live API using
the key from the app's key store if one is present. Report which returns models. Change the
path only if the current one 404s. If no key is available, report that and change nothing.

## Constraints
- Never log or include the API key in any error message. `httpError` is deliberately
  redacted — keep it that way.
- Keep `AbortSignal.timeout(8000)` on every call.
- The existing exported names `fetchSubscriptionModels`, `fetchImageModels`,
  `fetchSubscriptionUsage`, `generateImage` must keep their signatures. Only `fetchBalance`
  changes shape, per contract.

## Acceptance
1. `npx tsc --noEmit -p tsconfig.node.json --composite false` exits 0.
2. New unit tests cover: balance string parsing (valid, missing field, non-numeric),
   retry fires on 503 and does NOT fire on 400, `Retry-After` is honoured on 429,
   `X-Request-ID` reaches the error message, `code` is attached.
3. `npx vitest run src/main/__tests__/nanogpt.test.ts` passes.
4. Report the D6 probe result explicitly (which path, what status).
