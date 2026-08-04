# HANDOFF.md

Written 2026-08-04, end of wave 2. Supersedes the wave-1 handoff.

Branch: `feat/wave1-coverage` — **0 behind, 3 ahead of `origin/main`**, nothing pushed.

The wave-1 handoff opened with a STOP saying the branch was 3 commits behind `origin/main`
and that the 217 new tests had been written against a 2-version-stale tree. **That is
resolved.** The upstream merge landed (`b0bf8ff`, PR #4), the branch now sits on top of
current `origin/main`, and the full suite was re-verified against the merged tree.

---

## Where things stand

Tree is clean. Three commits, all verified before committing.

| Commit | What |
|---|---|
| `b638b0c` | `docs:` archived three dead handoff artifacts under `docs/history/` |
| `5851a22` | `test:` 217 tests covering the SSE reducer, session lifecycle, failover, prefs |
| `2ae4b3c` | `feat:` NanoGPT quota/balance/gallery, conformed to the published API |

Verification at the last commit:

```
npm run typecheck                  exit 0, both projects
npm test                           70 files, 1079 tests, all passing
node scripts/check-contracts.mjs   PASS
npm run lint                       0 errors, 89 pre-existing warnings, none new
real app launch                    both NanoGPT surfaces confirmed on screen
```

## Exact next command

Nothing is in flight.

```bash
git checkout feat/wave1-coverage && npm test
```

`gh` is not installed on this machine — no `gh pr create`. To open a PR, push and use the
web UI:

```bash
git push -u origin feat/wave1-coverage
```

then open `https://github.com/bosscube1/opencode-desktop/compare/main...feat/wave1-coverage`.

## What wave 2 was, in one paragraph

The NanoGPT feature had been built against *guessed* API response shapes. Cross-checking it
against the vendored reference found four wrong guesses, one of which (the balance response
shape) meant the balance call had never once succeeded in the feature's entire life — it
threw every time, and the IPC layer quietly returned a `$0.00` placeholder that was
indistinguishable from a real empty wallet. Separately, the sync-to-async filesystem
conversion had introduced a data-loss race: five concurrent image saves persisted two index
entries. Both are fixed, with the race pinned by a regression test that was watched failing
first.

## Open follow-ups, highest value first

### 1. Boot-time NanoGPT key-load race (new — found during app verification, not by tests)

On launch, `oc:nanogpt:refresh` failed with `No NanoGPT API key is configured. Add NanoGPT
under Providers first.` while `oc:nanogpt:balance` succeeded moments later with a real value
on the same account. Net effect on a healthy, funded account: subscription usage stays null,
the Settings card reads "No NanoGPT subscription data loaded yet", and the status dot sits
amber. Pre-existing, not introduced here — it only became *visible* once the balance path
started working.

Start at `src/main/server.ts` `doStart()` and `src/main/keys.ts`; the catalog refresh appears
to run before the BYOK key store is loaded.

### 2. `readCache` / `readCacheSync` duplication in `nanogptConfig.ts`

The same copy-paste twin that was fixed in `nanogptImages.ts` — extract the shared parse step
so only the I/O differs. Left alone because no wave-2 module owned that file.

### 3. Per-fetch limiter gating for the catalog refresh

`refreshCatalogs()` fans out to `fetchSubscriptionModels` and `fetchImageModels` concurrently
inside `nanogptConfig.ts`. Only the outer call could be wrapped in a limiter slot, so both
inner fetches share one. True per-fetch gating means moving `acquireSlot()` into
`nanogptConfig.ts`.

### 4. `autoRotate` write is discarded — still live upstream

`savePrefs` derives `autoRotate` from `routingMode` at `prefs.ts:142`, silently dropping any
caller-supplied value (see `routingSlice.ts:60`). Confirmed still present in `origin/main`
despite the commit titled "routing-mode single source of truth". Pinned by a test that
documents current behaviour; the fix is owed.

### 5. Stall watchdog can never auto-retry

The stall watchdog is only armed via `touchActiveAttempt`, which unconditionally sets
`hasStreamed = true`, so R1 always blocks a silent retry — only the TTFT watchdog can trigger
silent failover. Plausibly intentional given R1's side-effect-safety design. Confirm the
intent before changing anything.

### 6. CONTRACTS.md under-documents `applyEvent`

Four gaps, all contract-thinner-than-reality rather than contradictions: `permission.updated`
is gated on the active session OR any subagent reachable via `parentID`; failover also
triggers on `timeout`/`transient`, not only rate-limit; the `MessageAbortedError` user-abort
vs recovery-abort split is absent; `session.idle` draining `queuedPrompts` into `send()` is
undocumented. All four are now pinned by tests.

## Things worth knowing before touching this area

- **The NanoGPT API reference is vendored** at
  `C:\Users\Hp\llm-wiki\raw\# NanoGPT API Documentation Referen.md`. Wave 2 exists because
  the first pass was written without it. Read it before changing any NanoGPT request or
  response handling.
- **Two constants are duplicated across the process boundary.**
  `WEEKLY_INPUT_TOKEN_CAP` and `DAILY_FREE_IMAGE_CAP` live in both `src/main/` and
  `src/renderer/src/lib/types.ts`, because the renderer cannot import modules pulling in
  Electron `app` or node `fs`. `scripts/check-contracts.mjs` fails the build if they diverge —
  change both sides.
- **All `index.json` mutations must go through `withIndexLock`** in `nanogptImages.ts`. The
  unlocked version lost 3 of 5 concurrent saves.
- **A NanoGPT key exists** at `%APPDATA%\opencode-desktop\byok-keys.json`, so live endpoint
  probing is possible. The image-model discovery endpoints need no key at all —
  `/api/v1/image-models` and `/api/v1/images/models` were both probed, both return 200 and
  the same 217-model catalogue, so the existing path was kept.
- **Wave-2 module specs are on disk** at `docs/plans/nanogpt-wave2/`. The work is done, but
  `00-CONTRACT.md` remains the reference for the seams between main, preload and renderer.
- **Running the app:** `powershell -File .claude/skills/run-opencode-desktop/driver.ps1 start`.
  Never a bare `npm run dev` — a stale instance silently hijacks the run and shows old code.
  Always `stop` when finished.
- **Subagent reports need checking.** In wave 2, one agent reported "verified" from a file
  re-read because its agent type had no shell, and had left an unwanted line behind; another
  wrote a test that passed for the wrong reason (it asserted a released slot frees a
  *time*-based window, and only went green because `runAllTimersAsync` skipped a minute
  ahead); a third reported no API key existed at a path where one did. All three reports read
  as confident. Re-run the acceptance checks yourself.
