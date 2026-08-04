# M5 — Renderer + preload surface

Read `00-CONTRACT.md` first. Runs LAST — consumes types from M1, M2, M3, M4.

## Owns (exclusive)
- `src/preload/index.ts`, `src/preload/index.d.ts`
- `src/renderer/src/lib/types.ts`, `src/renderer/src/lib/slices/types.ts`,
  `src/renderer/src/lib/slices/api.ts`, `src/renderer/src/lib/slices/nanoQuotaSlice.ts`
- `src/renderer/src/components/SettingsPanel.tsx`, `StatusBar.tsx`, `ImagesView.tsx`
- `src/renderer/src/lib/__tests__/nanoQuotaSlice.test.ts`
- `CONTRACTS.md`

### D8 — CONTRACTS.md is out of sync (blocking, confirmed at the wave-2A gate)

`node scripts/check-contracts.mjs` currently FAILS:

```
MISSING window.api methods not found in CONTRACTS.md:
          window.api.nanogpt.balance
          window.api.nanogpt.images.today
          window.api.nanogpt.weeklyUsage
```

These three were added earlier in this branch without documenting them. Document all three,
using the FINAL types from this wave (balance is `NanoBalance | null` with the new
`{usd, nano, depositAddress?}` shape per contract T1/T2 — not the old `{balance, currency}`).

## Do NOT touch
Anything under `src/main/`.

## Defects to fix

### D1 — the type declarations lie about nullability
`usage(): Promise<NanoUsage>` and `balance(): Promise<NanoBalance>` are declared in three
places (`preload/index.ts`, `preload/index.d.ts`, `slices/api.ts`) but the main-process
handlers return `null` on failure (contract T2). Add `| null` in all three. Adopt the new
`NanoBalance` shape from contract T1 (`usd` / `nano` / `depositAddress`) — the old
`{balance, currency}` shape is gone.

### D2 — status-bar quota dot has an unreachable branch
`StatusBar.tsx:208-215` tests `percentUsed >= 80` before `>= 100`, so `app__dot--bad` can
never render and a fully exhausted quota shows amber. Reorder: bad -> warn -> ok.

### D3 — weekly gauge measures the wrong number
`SettingsPanel.tsx` compares `weeklyUsage.totalTokens` against a locally declared
`TARGET_WEEKLY = 60_000_000`. The documented cap is 60M **input** tokens (contract T3).
Use `inputTokens`, and import `WEEKLY_INPUT_TOKEN_CAP` rather than redeclaring it. Show
output tokens separately if useful, but they do not feed the gauge.

### D4 — unconditional 90 s polling
`startNanoQuotaPolling` is called from `store.init()` and fires three network round-trips
every 90 s forever, even when no NanoGPT key exists and the user's provider is something
else. Gate it: only poll when a NanoGPT key is configured. Back off (e.g. double the
interval up to a ceiling) after consecutive failures, and reset the backoff on success.
Wire `stopNanoQuotaPolling` to a teardown path so the timer does not outlive the window.

### D5 — hard-coded image cap and misleading label
`ImagesView.tsx:440` renders `{todayCount}/100`. 100 is correct per the documented free-tier
cap, but it must come from the exported `DAILY_FREE_IMAGE_CAP` (M2), and the label must say
it is a local count — the number is derived from the local index, which is pruned at 500
retained images, so it under-reports rather than tracking the account.

### D6 — inline styles
The three components in scope accumulated a lot of inline `style={{...}}` in this branch
(gallery head, weekly gauge, balance row). Move them to the existing stylesheet conventions
used elsewhere in each component. Do not restyle anything that was already class-based.

### D7 — surface documented error codes
When a generate call fails with a `code` (contract T6, attached by M1), show a specific
message for `content_policy_violation` (not billed), `daily_rpd_limit_exceeded`,
`daily_usd_limit_exceeded`, and `insufficient_balance` instead of the raw error string.

## Acceptance
1. `npm run typecheck` exits 0 (both projects).
2. `npx vitest run src/renderer/src/lib/__tests__/nanoQuotaSlice.test.ts` passes, with new
   cases for: polling is skipped with no key, backoff grows on repeated failure and resets
   on success, `null` usage/balance leave prior state intact.
3. `node scripts/check-contracts.mjs` PASS.
4. `npm run lint` introduces no new errors.
