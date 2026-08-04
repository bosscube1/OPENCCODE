# M4 — Rate limiter completeness

Read `00-CONTRACT.md` first. This is a small, self-contained module.

## Owns (exclusive)
- `src/main/nanogptLimiter.ts`
- `src/main/__tests__/nanogptLimiter.test.ts`

## Do NOT touch
Any other file. M2 wires additional call sites into this limiter; you only change the
limiter itself and must keep `acquireSlot(): Promise<() => void>` source-compatible.

## Defects to fix

### D1 — the documented sustained limit is not enforced
Documented subscription limits (contract T4) are: 10 concurrent, 10 requests / 10 s burst,
**60 requests / minute sustained**. The limiter implements the first two and ignores the
third, so a steady 1 req/s stream sails past a limit the server does enforce.

Add a second sliding window (60 requests / 60_000 ms) alongside the existing burst window.
Both must be satisfied for `canProceed()` to return true, and `scheduleCheck()` must wake on
whichever window frees first.

### D2 — queue starvation
`acquireSlot()`'s fast path takes a slot without consulting the queue, so a request arriving
while others wait can jump ahead. Make the fast path conditional on `this.queue.length === 0`.

### D3 — no Retry-After feedback path
When the server returns 429 it may include `Retry-After` (contract T5). The limiter has no
way to be told "stop issuing slots for N seconds". Add
`pauseFor(ms: number): void` that blocks new grants until the deadline passes, and make
`scheduleCheck()` account for it. M1/M2 will call it from the 429 path.

### D4 — timestamps are only pruned, never bounded on the pause path
Verify `pruneTimestamps` still runs on every `canProceed`/`scheduleCheck` entry after the
above changes so the arrays cannot grow without bound while paused.

## Acceptance
1. `npx tsc --noEmit -p tsconfig.node.json --composite false` exits 0.
2. Tests use `vi.useFakeTimers()`, no real sleeps.
3. New tests: 61 sequential acquires within a minute — the 61st waits; burst of 11 within
   10 s — the 11th waits; 11 concurrent — the 11th waits; `pauseFor(5000)` defers grants;
   a released slot is idempotent when `release()` is called twice.
4. `npx vitest run src/main/__tests__/nanogptLimiter.test.ts` passes.
