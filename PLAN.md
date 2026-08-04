# PLAN.md — Codebase update plan, wave 1

Derived from the architecture review of 2026-08-04. Full rationale for each item lives in
that review; this file is the executable checklist.

Baseline at start of wave 1:
- 36 test files, 511 tests, all passing, ~20s
- Coverage: 44.64% lines / 40.03% branches / 43.28% functions
- `npm run typecheck`, `npm run lint`, `node scripts/check-contracts.mjs` all clean

## Wave 1 — parallel modules (disjoint file ownership)

Every module below owns a file set that no other module in this wave touches. Agents run
concurrently. Do NOT add npm install / dependency work to this wave — node_modules churn
mid-run breaks the test modules.

| Module | Scope | Owns (exclusive) | Agent | Status |
|---|---|---|---|---|
| M1 | Test the SSE reducer | `src/renderer/src/lib/__tests__/eventSlice.test.ts` | sonnet / general-purpose | **DONE** — 63 tests, 987 lines, verified passing in isolation; agent reports eventSlice.ts 98.37% lines (from 0.43%), pending clean full-suite re-measure |
| M2 | Test session lifecycle + failover | `src/renderer/src/lib/__tests__/sessionSlice.test.ts`, `.../attemptMachine.test.ts` | sonnet / general-purpose | **DONE** — 113 tests; sessionSlice 0.38%->92.82%, attemptMachine 5.23%->100% lines |
| M3 | Test preferences round-trip | `src/renderer/src/lib/__tests__/prefs.test.ts` | haiku / general-purpose | **DONE** — 41 tests; prefs.ts 4.54%->**100%** lines (44/44), 100% branches. NOTE: v8 text reporter omits fully-covered files, which is why prefs.ts disappears from the per-file table — verified by isolated run, not a measurement failure |
| M4 | Fix stale doc headers | `src/renderer/src/lib/slices/editorSlice.ts`, `.../gitSlice.ts` (comments only) | haiku / cavecrew-builder | **DONE** — diff verified comment-only (4 ins / 7 del, both docblocks); uncommitted |
| M5 | Archive handoff docs | `HANDOFF_GEMINI.md`, `CONTINUATION.md`, `PRODUCTION_PLAN.md`, `docs/history/` | haiku / general-purpose | **DONE** — 3 true renames (R, history preserved), refs fixed in AGENTS.md + docs/adr/README.md, no stale paths; uncommitted |
| M0 | Untrack committed installer | git index only (`release/0.1.1/*`) | main thread | **DONE** — 3 paths `git rm --cached`, 0 tracked under release/, all 3 still on disk; uncommitted |

### Global acceptance criteria (every module)

1. `npm run typecheck` exits 0.
2. `npm run lint` exits 0 (no new warnings).
3. `npm run test` exits 0 and the **pre-existing 511 tests still pass** — a module may add
   tests, never modify or delete another module's.
4. No file outside the module's "Owns" column is modified. No `package.json` /
   `package-lock.json` edits in this wave.
5. No new dependencies. jsdom / testing-library are NOT available in wave 1 — every test
   must run in the existing `environment: 'node'` vitest config.

### M1 — Test the SSE reducer (highest value in the wave)

Target: `src/renderer/src/lib/slices/eventSlice.ts`, currently **0.43% covered**. It is the
single reducer folding every server SSE event into UI state — the heart of the app.

Acceptance:
- New file `src/renderer/src/lib/__tests__/eventSlice.test.ts`, vitest, node environment.
- Covers at minimum: text-part streaming append (token-by-token), tool-call state
  transitions `pending -> running -> completed`, tool-call error state, permission request
  arriving as a prompt, `session.error`, an out-of-order event, a duplicate event, and an
  event for a session that is not the active one (must not leak into active state).
- `eventSlice.ts` line coverage >= 60% (from 0.43%).
- Assertions derive from documented event semantics in `CONTRACTS.md`, NOT from reading the
  reducer implementation and restating it. If the reducer appears to contradict
  CONTRACTS.md, write the test to the contract, mark it `.todo`/skipped with a comment, and
  report the discrepancy — do not silently encode a bug as expected behaviour.

### M2 — Test session lifecycle + failover

Targets: `sessionSlice.ts` (0.38%) and `attemptMachine.ts` (5.23%).

Acceptance:
- Two new files under `src/renderer/src/lib/__tests__/`.
- sessionSlice: send path, abort mid-stream, the queued-prompt path, directory switch
  clearing session state, error surfacing.
- attemptMachine: watchdog fires on stall, ledger restore from persisted state, failover
  model selection, and that a locked routing mode never swaps model.
- Combined line coverage of the two target modules >= 50%.
- Uses fake timers for watchdogs — no real sleeps, suite must stay under ~5s.

### M3 — Test preferences round-trip

Target: `src/renderer/src/lib/prefs.ts`, currently **4.16% covered**. Pure functions plus
`window.localStorage`; stub localStorage on `globalThis` (node environment, no jsdom).

Acceptance:
- New file `src/renderer/src/lib/__tests__/prefs.test.ts`.
- Covers: `loadPrefs` on empty/absent storage, on malformed JSON, full round-trip through
  `savePrefs`, the legacy `autoRotate`/`stickyModel` -> `routingMode` migration, paid-model
  pruning of `providerID`/`modelID`/`modelPool`/`compareTargets` when `showPaidModels` is
  false, and the partial-save merge (calling `savePrefs` without `routingMode` must preserve
  the persisted one).
- `prefs.ts` line coverage >= 85%.
- KNOWN BUG to pin down with a test: `savePrefs` derives `autoRotate` from `routingMode` at
  prefs.ts:142, which discards any `autoRotate` a caller passed (see
  `routingSlice.ts:60`). Write a test that DOCUMENTS the current behaviour, name it so the
  discrepancy is obvious, and report it. Do not fix it in this module — the fix is U6 and
  belongs to a later wave.

### M4 — Fix stale doc headers

Two file-header comments assert that `src/renderer/src/lib/hunks.ts` "does not exist yet"
and that actions are "stubbed below — see TODO(hunks)". Both are false: `hunks.ts` exists,
is imported at the top of both files, and is 97.9% covered.

Acceptance:
- `editorSlice.ts` header no longer claims `hunks.ts` is missing or that
  `applyAcceptedHunks` is stubbed.
- `gitSlice.ts` header no longer claims `hunks.ts` is missing or that `stageHunks` is
  stubbed.
- **Comments only.** Zero executable-line changes in either file. `git diff` must show only
  comment lines.

### M5 — Archive handoff docs

Seven top-level markdown files, ~137 KB. Three are dead handoff artifacts.

Acceptance:
- `HANDOFF_GEMINI.md`, `CONTINUATION.md`, `PRODUCTION_PLAN.md` moved (via `git mv`, history
  preserved) into `docs/history/`.
- `docs/history/README.md` added: one line per file saying what it was and that it is
  retained for history, not maintained.
- Any reference to the three moved paths from `README.md`, `AGENTS.md`, `CONTRIBUTING.md`,
  or `CONTRACTS.md` is updated to the new path. Grep before and after.
- `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CONTRACTS.md`, `docs/adr/**` are NOT moved.

### M0 — Untrack committed installer (main thread, not delegated)

`release/0.1.1/OpenCode Desktop-0.1.1-setup.exe` (100,910,253 bytes), its `.blockmap`, and
`latest.yml` are tracked despite `release/` being in `.gitignore`. Stale (0.1.1 vs
package.json 0.2.0).

Acceptance: `git rm --cached` the three paths, files remain on disk, staged but NOT
committed without explicit approval. Full `.git` reclamation (429 MB) needs a
`git filter-repo` history rewrite — that is wave 3, and requires the four open feature
branches to be resolved first.

## Wave 1 result (measured on the main thread after all agents finished)

| Metric | Before | After |
|---|---|---|
| Test files | 36 | 40 |
| Tests | 511 | **728** (+217) |
| Lines | 44.64% | **57.38%** (+12.74pp) |
| Branches | 40.03% | 53.62% |
| Functions | 43.28% | 53.96% |
| `eventSlice.ts` (SSE reducer) | 0.43% | **98.37%** |
| `sessionSlice.ts` | 0.38% | **92.82%** |
| `attemptMachine.ts` | 5.23% | **100%** |
| `prefs.ts` | 4.54% | **100%** |

`npm run typecheck` exit 0. `npm run lint` 0 errors / 87 warnings (all pre-existing
`no-explicit-any` idiom in test fixtures). `node scripts/check-contracts.mjs` PASS —
70 invoke + 1 listener + 8 send channels, 80/80 window.api methods documented.

Everything is staged/working-tree only. NOTHING COMMITTED — awaiting user review.

## Carried into wave 2 (found by wave-1 agents, not acted on)

1. **CONTRACTS.md under-documents `applyEvent`** (found by M1, 4 gaps): `permission.updated`
   is gated on active session OR any subagent reachable via `parentID`, not just the active
   session; failover also triggers on `timeout`/`transient`, not only rate-limit; the
   `MessageAbortedError` user-abort vs. recovery-abort split is entirely absent; and
   `session.idle` draining `queuedPrompts` into `send()` is undocumented. No code/contract
   contradiction — the contract is just thinner than reality. Now pinned by 63 tests.
2. **`autoRotate` write is discarded** (confirmed by M3, pinned by 2 tests): `savePrefs`
   derives `autoRotate` from `routingMode` at prefs.ts:142, silently dropping the value
   passed at `routingSlice.ts:60`. Fix belongs to U6.
3. **Stall watchdog can never auto-retry** (found by M2): the stall watchdog is only armed
   via `touchActiveAttempt`, which unconditionally sets `hasStreamed = true`, so R1 always
   blocks a silent retry — only the TTFT watchdog can trigger silent failover. Appears
   intentional given R1's side-effect-safety design, but worth confirming the intent.

## Explicitly NOT in wave 1

- U2 contract dedup, U3 `ipc.ts` split — large structural moves; must land after M1-M3 give
  them a safety net.
- U5 renderer test environment (jsdom + testing-library) — adds dependencies, conflicts with
  any concurrent test module.
- U6 prefs patch-API refactor — gated on M3's tests existing first.
- U7 chat-search bounds — edits `ipc.ts`, conflicts with U3.
- U8 dependency bumps — npm install churn; must run alone.

## Resume instructions

If a session dies mid-wave: each module is independent and idempotent. Check the Status
column, re-read the failed module's section, re-spawn only that module. Nothing in wave 1
depends on another wave-1 module completing.

---

# Wave 2 — NanoGPT API conformance (added 2026-08-04)

Trigger: cross-check of the working tree against the vendored NanoGPT API reference
(`C:\Users\Hp\llm-wiki\raw\# NanoGPT API Documentation Referen.md`). The wave-1 NanoGPT
feature work shipped against guessed response shapes and guessed limits; three of the
guesses are wrong in ways that make the feature silently useless, and the sync-to-async
filesystem conversion introduced a data-loss race.

Shared contract (types + constants every module must honour):
`docs/plans/nanogpt-wave2/00-CONTRACT.md`. Per-module specs live beside it.

## Damage inventory

| ID | Defect | Impact |
|---|---|---|
| A | `fetchBalance` parses `{balance, currency}`; documented response is `{usd_balance, nano_balance, nanoDepositAddress}`, all strings | Balance fetch has never once succeeded; IPC swallows the throw and returns `$0.00` |
| B | `Promise.all(saveImage)` interleaves read-modify-write on `index.json` | Multi-image generation persists 1 of n gallery entries; PNGs orphaned on disk |
| C | Weekly tracker adds cumulative `message.updated` totals as if they were deltas | Weekly token figure inflates superlinearly; the gauge is meaningless |
| D | Weekly cap compared against total tokens; documented cap is 60M **input** tokens | Gauge measures the wrong quantity even after C is fixed |
| E | `withRetry` gates on `TypeError`, which the wrapped functions always swallow | Retry has never fired on any endpoint |
| F | Limiter enforces concurrency + burst but not the documented 60 rpm sustained limit | Steady traffic exceeds a server-enforced limit |
| G | IPC returns zero-valued placeholders on failure; preload types omit `\| null` | UI cannot distinguish "empty wallet" from "request failed" |
| H | StatusBar quota dot tests `>= 80` before `>= 100` | Exhausted quota renders amber, never red |
| I | 90 s poll runs unconditionally with no key and no backoff | Wasted network forever on non-NanoGPT setups |
| J | `show: true` + `setAlwaysOnTop` toggle in `createWindow` | Debug leftover; blank-window flash + focus steal at launch |
| K | `tokenBudgetTracker` test flakes on `ENOTEMPTY` (observed, not theoretical) | Fire-and-forget save outlives `afterEach` teardown |
| L | `CONTRACTS.md` omits `nanogpt.balance`, `nanogpt.images.today`, `nanogpt.weeklyUsage` | `scripts/check-contracts.mjs` FAILS — found at the 2A gate, assigned to M5 |

## Modules

Wave 2A runs in parallel — disjoint file ownership, no shared edits.
Wave 2B is serialized behind it because it consumes 2A's exported types.

| Module | Scope | Owns (exclusive) | Fixes | Agent | Status |
|---|---|---|---|---|---|
| M1 | NanoGPT HTTP client: balance shape, status-aware retry, `X-Request-ID`, error `code`, endpoint probe | `src/main/nanogpt.ts` + test | A, E | sonnet / general-purpose | **DONE** — 17 new tests. D6 endpoint probe NOT run: no API key present in env or `%APPDATA%\opencode-desktopyok-keys.json`, so `/api/v1/image-models` left unchanged. Probe still owed. |
| M3 | Weekly token accounting: delta tracking, input-token cap, lazy init, flake fix | `src/main/tokenBudgetTracker.ts` + test | C, D, K | sonnet / general-purpose | **DONE** — cumulative-payload premise verified against the SDK's `EventMessageUpdated` type before coding. Baseline is a high-water mark, not last-reading (last-reading re-credited tokens on out-of-order events). 10 tests, 5 consecutive clean runs, flake gone. |
| M4 | Limiter: add 60 rpm window, queue fairness, `pauseFor` | `src/main/nanogptLimiter.ts` + test | F | haiku / general-purpose | **DONE** — implementation correct. Its sustained-limit test passed for the wrong reason (asserted a *release* freed sustained capacity; it actually passed because `runAllTimersAsync` skipped 60s ahead). Rewrote that test and added a real 60-rpm-default test in the main thread. 11 tests. |
| M6 | Revert window-show debug hack | `src/main/index.ts` | J | haiku / cavecrew-builder | **DONE** — `git diff HEAD -- src/main/index.ts` now empty. Agent restored `show: false` and dropped both `setAlwaysOnTop` calls but left an added `win.focus()`; removed in the main thread. Agent could not self-verify (no shell access in that agent type) — verified here instead. |
| M2 | Image index write lock, non-blocking reads, `imagesToday` scoping, IPC null convention, limiter wiring | `src/main/nanogptImages.ts`, `src/main/ipc.ts` + test | B, G | sonnet / general-purpose | **DONE** — race reproduced first: 5 concurrent saves yielded **2** index entries before the fix, 5 after. Lock is `tail.then(fn, fn)` so a rejected mutation cannot wedge the queue. Limitation: only `refreshCatalogs()` could take a limiter slot, so its two inner fetches share one slot. |
| M5 | Preload + renderer: nullable types, dot ordering, input-token gauge, gated polling, error codes, de-inline styles, CONTRACTS.md | preload ×2, renderer lib ×4, components ×3, CONTRACTS.md + test | D, G, H, I, L | sonnet / general-purpose | **DONE** — also edited `index.css` + `images.css` (outside its declared Owns list; no conflict, nobody else owned CSS). Constants had to be duplicated renderer-side; see the drift guard below. |

## Wave 2 gate

After 2A and before 2B: `npm run typecheck`, `npx vitest run src/main`, and
`node scripts/check-contracts.mjs` must all be clean. After 2B: full `npm test`, `npm run
lint`, plus a real app launch (`/run`) exercising the Images tab and the Settings quota card
— per the standing rule that a feature is not done until it is exercised in the running app.

## Explicitly NOT in wave 2

- `readCache`/`readCacheSync` duplication in `nanogptConfig.ts` — same smell as M2's D3, but
  the file is untouched by wave 2; fold into a later cleanup.
- The undocumented `/api/subscription/v1/images/generations` primary route and its fallback
  chain — not in the reference, currently working, leave alone.
- Global 25 RPS account throughput cap — documented, not enforceable from one client.
- Any endpoint the reference marks "not specified in official documentation" (batches,
  embeddings, TTS/STT, web search, AI detection). No speculative clients.

## Resume instructions

Module specs are on disk at `docs/plans/nanogpt-wave2/`. If a session dies mid-wave, check
the Status column above, re-read that module's spec, re-spawn only that module. 2A modules
are mutually independent; 2B must not start until every 2A module is DONE.

## Wave 2A gate result (run after M1/M3/M4/M6)

- `npx tsc --noEmit -p tsconfig.node.json --composite false` — 1 error, the expected M2
  hand-off point: `src/main/ipc.ts(1111,16)` still builds the old `{balance, currency}`
  shape. Assigned to M2.
- `npx vitest run src/main` — 27 files, **312 tests, all passing**.
- `node scripts/check-contracts.mjs` — **FAIL**, 3 undocumented `window.api` methods
  (defect L, pre-existing in this branch, assigned to M5).

Gate treated as passed for 2B purposes: both failures are already owned by a 2B module.

## Wave 2 final result

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0, both projects |
| `npm test` | **70 files, 1079 tests, all passing** (was 69 files / 1047 with 1 flaky failure) |
| `node scripts/check-contracts.mjs` | PASS |
| `npm run lint` | 0 errors, 89 pre-existing warnings, none new |
| Real app launch | Settings quota card and Images gallery header both verified on screen |

### D6 endpoint probe — RESOLVED

M1 reported no API key available, but one exists at
`%APPDATA%\opencode-desktopyok-keys.json` and the running app fetches a live balance with
it. Probed both paths (this endpoint needs no key — the reference's own example is
unauthenticated):

```
/api/v1/image-models     -> HTTP 200 | 217 models
/api/v1/images/models    -> HTTP 200 | 217 models
```

Both are live and return the same catalogue. **The current path is correct; no change made.**

### Live-app evidence

- Settings: `Weekly Input-Token Budget (2026-W32)  51.6k / 60M (0%)`, with
  `Output tokens this week (not counted against the cap)  3.6k` listed separately — defect
  D fixed and visible.
- Settings: `Pay-per-prompt balance: $1.77`, and a `NanoGPT $1.77` chip in the status bar.
  This is the strongest single result in the wave: that number was structurally unreachable
  before (defect A meant `fetchBalance` always threw and the UI always showed `$0.00`).
- Images: `0/100 generated today (this device)` — the cap now comes from the shared constant
  and the label states it is a local count.
- The NanoGPT status dot renders amber because subscription usage is null (the catalog
  refresh failed with "No NanoGPT API key is configured" at boot while balance succeeded).
  Correct per the reordered logic, but the boot-time key-load race is worth a look.

## Added on the main thread (not delegated)

- **Mirrored-constant drift guard** in `scripts/check-contracts.mjs`.
  `WEEKLY_INPUT_TOKEN_CAP` and `DAILY_FREE_IMAGE_CAP` are duplicated in
  `src/renderer/src/lib/types.ts` because the renderer cannot import the main-process modules
  that own them (Electron `app` / node `fs`). Duplication is forced; silent divergence is
  not. The checker now fails when the two sides disagree — verified by perturbing the
  renderer value to 99 and watching it fail, then restoring.

## Still owed

- **Boot-time key-load race**: `oc:nanogpt:refresh` threw "No NanoGPT API key is configured"
  at startup while `balance` succeeded moments later, leaving subscription usage null and the
  status dot amber on a healthy account. Not a wave-2 defect — pre-existing, now visible.
- **`readCache`/`readCacheSync` duplication** in `nanogptConfig.ts` — same smell M2 fixed in
  `nanogptImages.ts`, deliberately out of scope.
- **Per-fetch limiter gating** for the two catalog fetches inside `refreshCatalogs()`.
- Nothing is committed. Everything is working-tree only, awaiting review.
