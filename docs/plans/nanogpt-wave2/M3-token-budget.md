# M3 — Weekly token budget accounting

Read `00-CONTRACT.md` first.

## Owns (exclusive)
- `src/main/tokenBudgetTracker.ts`
- `src/main/__tests__/tokenBudgetTracker.test.ts`

## Do NOT touch
Any other file. `server.ts` already calls `tokenBudgetTracker.recordEvent(event)` inside a
try/catch — that wiring is correct and stays.

## Defects to fix

### D1 (critical) — cumulative totals are added as if they were deltas
`recordEvent` builds a dedup key of `` `${id}:${input}:${output}` `` and then calls
`addTokens(input, output)`, which **adds**. opencode's `message.updated` event carries the
running cumulative token count for that message, so every update produces a new dedup key
(the numbers changed) and re-adds the entire running total. A single 10k-token message can
contribute several times its real cost. The weekly figure is therefore garbage.

Fix: keep a `Map<messageId, {input, output}>` of the last-seen totals and add only the
positive delta. Key on the message id alone, never on the token values. Bound the map the
way `processedIds` is bounded today (drop oldest past ~1000 entries); a dropped entry
re-baselines to 0 delta on next sight rather than double counting — implement it that way
explicitly.

### D2 — budget is measured against the wrong metric
The documented subscription cap is **60 million INPUT tokens per week** (contract T3), not
total. Export `WEEKLY_INPUT_TOKEN_CAP = 60_000_000`. Keep `totalTokens` in the payload for
display, but it must not be what the cap is compared against. The renderer (M5) will consume
the exported constant.

### D3 — module-level singleton does eager disk I/O at import
`export const tokenBudgetTracker = new TokenBudgetTracker()` runs `loadSync()` — which calls
`app.getPath('userData')` and `readFileSync` — at import time, before `app.whenReady()`.
It happens to work today but breaks silently if `app.setPath` is ever called. Make load lazy
on first use.

### D4 — flaky test, already observed failing
`npx vitest run src/main/__tests__/tokenBudgetTracker.test.ts` fails intermittently with:

```
Error: ENOTEMPTY, Directory not empty: ...\opencode-tokenbudget-OzKnv7
```

Cause: `saveAsync()` is fire-and-forget, so a write lands after `afterEach`'s `rmSync`.
Expose a `whenSettled(): Promise<void>` that resolves once any in-flight save completes, and
await it in `afterEach`. Do not fix this with a sleep or a retry loop.

## Acceptance
1. `npx tsc --noEmit -p tsconfig.node.json --composite false` exits 0.
2. New test: three `message.updated` events for the same id carrying cumulative
   `{input: 100} -> {input: 250} -> {input: 400}` accumulate to 400, not 750.
3. New test: out-of-order / decreasing totals never subtract and never double count.
4. `npx vitest run src/main/__tests__/tokenBudgetTracker.test.ts` passes 5 runs in a row.
