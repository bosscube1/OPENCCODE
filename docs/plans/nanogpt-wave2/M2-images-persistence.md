# M2 — Image persistence race + IPC wiring

Read `00-CONTRACT.md` first. Runs AFTER M1 lands (consumes M1's `NanoBalance`).

## Owns (exclusive)
- `src/main/nanogptImages.ts`
- `src/main/ipc.ts`
- `src/main/__tests__/nanogptImages.test.ts`

## Do NOT touch
`nanogpt.ts` (M1), `tokenBudgetTracker.ts` (M3), `nanogptLimiter.ts` (M4), any renderer or
preload file (M5).

## Defects to fix

### D1 (critical, data loss) — concurrent index writes
`ipc.ts:1198` wraps `saveImage` in `Promise.all`. Each `saveImage` does
`await readIndex()` then `await writeIndex()`. Concurrent calls interleave read-modify-write
on `index.json`, so generating n>1 images persists only one index entry — the PNGs land on
disk but the gallery never shows them.

Fix at the source, not the call site: serialize all `index.json` mutations inside
`nanogptImages.ts` behind a module-level promise chain (a simple
`let tail = Promise.resolve(); function withIndexLock(fn) { ... }`). `saveImage`,
`deleteImage`, and `reconcile` all take the lock. Then the `Promise.all` in ipc.ts becomes
safe; converting the call site to a sequential loop as well is fine and cheaper to reason
about — do both.

Add a regression test: 5 concurrent `saveImage` calls -> `readIndex()` has 5 entries.

### D2 — async readers still block
`readIndex` / `readImage` / `deleteImage` call `existsSync` on the async path. That is a
blocking syscall in code that exists to be non-blocking, and it is a TOCTOU window against
`deleteImage`. Use `readFile` and treat `ENOENT` as the empty/absent case.

### D3 — `readIndex` / `readIndexSync` are copy-paste twins
Same for `readCache`/`readCacheSync` in `nanogptConfig.ts` — but that file is NOT yours;
leave it and note it. In `nanogptImages.ts`, extract the shared parse/sanitize step so only
the I/O differs.

### D4 — `imagesToday` counts the wrong thing
The documented cap is **100 free images per day, reset 00:00 UTC** (contract T4). UTC
midnight is already correct. Two problems remain:
- it counts every retained image, including ones billed to balance, which do not consume the
  free-tier allowance. Exclude entries whose `paymentSource` indicates balance billing.
- it silently under-reports once retention (`MAX_RETAINED = 500`) or `reconcile` prunes.
  Document that in the JSDoc and return the count as a local best-effort figure.

Export `DAILY_FREE_IMAGE_CAP = 100` from this module so the renderer stops hard-coding it.

### D5 — IPC failure convention (contract T2)
`oc:nanogpt:balance` currently catches and returns `{balance: 0, currency: 'USD'}`, which is
indistinguishable from a genuinely empty wallet and makes the Settings card permanently
render `$0.00`. Return `null`. Same for `oc:nanogpt:usage`. Update the handler return types
to `NanoBalance | null` / `NanoUsage | null`.

### D6 — limiter coverage
Only `generateImage` acquires a limiter slot. Per contract T4 the documented limits are
account-wide. Route `fetchSubscriptionUsage`, `fetchBalance`, and both catalog fetches
through `nanogptLimiter.acquireSlot()` too — at the ipc.ts call sites, since `nanogpt.ts`
belongs to M1.

## Acceptance
1. `npx tsc --noEmit -p tsconfig.node.json --composite false` exits 0.
2. `npx vitest run src/main/__tests__/nanogptImages.test.ts` passes, including the new
   concurrency regression test.
3. `node scripts/check-contracts.mjs` PASS.
