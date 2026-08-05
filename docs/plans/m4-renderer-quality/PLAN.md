# M4 — Renderer quality · PLAN

Branch: `feat/m4-renderer-quality` (off `main` @ `6d0dcf7`).
Started 2026-08-05.

Baselines to quote in every subagent prompt (measured on `main` @ `6d0dcf7`,
post-M2.3/M2.5/M2.6):

| Check | Baseline |
|---|---|
| `npm run typecheck` | clean |
| `node scripts/check-contracts.mjs` | PASS |
| `npx vitest run` | see §Baseline capture |
| `npx eslint .` | 0 errors, 89 warnings |

## Hard environment constraint discovered before planning

`vitest.config.ts` uses `environment: 'node'` and only includes
`src/renderer/src/lib/__tests__/**` and `src/main/__tests__/**`. There is **no
jsdom, no @testing-library/react, no `components/__tests__/`**. Therefore:

- A regression test for 4.1 **cannot** be a component render test without adding
  dependencies (a `package.json` change — single-writer only, not this wave).
- The in-grain fix is to move keyboard dispatch decisions into pure helpers under
  `src/renderer/src/lib/` and test them there. This is also what 4.2 wants
  (`lib/shortcuts.ts` as the source of truth) and what 4.3 needs later.

## Wave 1 — three non-overlapping lanes, run in parallel

| Lane | Tasks | Owns (exclusive) | Model |
|---|---|---|---|
| A | 4.1 keyboard collision + 4.2 shortcuts registry | `MentionMenu.tsx`, `Chat.tsx`, `Composer.tsx`, `App.tsx`, `lib/shortcuts.ts`, `lib/keyboard.ts` (new), `lib/__tests__/shortcuts.test.ts`, `lib/__tests__/keyboard.test.ts` | sonnet |
| B | 4.6 memoize `harnessPromptFields` | `lib/slices/sessionSlice.ts`, `lib/__tests__/sessionSlice.harnessPrompt.test.ts` | haiku |
| C | 4.8 a11y pass | `ArtifactsPanel.tsx`, `SettingsPanel.tsx`, `ProviderPanel.tsx`, `Sidebar.tsx`, `StatusBar.tsx`, `index.css`, `docs/plans/m4-renderer-quality/A11Y-AUDIT.md` | haiku |

Lane A owns every file lanes B/C are forbidden to touch, and vice versa. No two
lanes share a file. `package.json` / `package-lock.json` are off limits to all
three.

## Wave 2 — sequential, after wave 1 lands

- 4.3 `useListNavigation` extraction (needs lane A's files settled)
- 4.4 `useMentionMenu()` out of `Composer.tsx`
- 4.5 true virtualization in `Chat.tsx`
- 4.7 CSS split (conflicts with lane C's `index.css` edit)

## Checklist — update after EVERY lane completes

- [x] Lane A — 4.1 + 4.2. Fix verified by inspection on the main thread: no
      `addEventListener` remains in `MentionMenu.tsx`; `lib/keyboard.ts`
      `resolveMentionMenuKey` is the single arbiter; `Composer.tsx:222` consults it
      first and falls through on `null`. **The agent's own "proof" was invalid** — it
      deleted `keyboard.ts`, got `Cannot find module`, and called that a demonstration
      that the test fails against pre-fix behaviour. It is not. The fix stands on
      inspection, not on that argument.
- [x] Lane C — 4.8. 5 icon-only controls labelled; reduced-motion block at the end of
      `index.css` covering 7 transitions + 4 animations; `A11Y-AUDIT.md` written.
      Its reported audit tally ("1 PASS" listing two components) is not consistent with
      the file; the file's own per-criterion marks are 31 PASS / 8 FAIL / 9 UNKNOWN /
      2 PARTIAL. Treat the file as the record, not the summary.
- [ ] Lane B — 4.6. **Cache logic is correct and verified**: `harnessPromptFields`
      re-reads `get()` for both agent and readOnly on every call and compares all three
      cache-key parts before returning a hit, so there is no stale-prompt path.
      **Its tests were worthless** — `harnessPromptFields` is module-private
      (`sessionSlice.ts:55`, no `export`), so the test file could not and did not call
      it; all 12 tests re-implemented the logic inline and pass with the cache deleted.
      Sent back: export the function, rewrite tests to assert reference identity on a
      cache hit and a new reference on each independent input change.
- [ ] Main thread re-ran typecheck / contracts / vitest / eslint itself
- [ ] Committed
- [ ] Wave 2 planned

## Residual risk logged, not fixed

The memoized `result.tools` object is returned by reference. Both call sites
(`sessionSlice.ts:311`, `:594`) spread the result, which is a *shallow* copy — the
`tools` object itself escapes into the request body by reference and is shared across
sends. Nothing observed mutates it, so this is not a live bug; it becomes one the day
something does. Worth a comment or a freeze if this code is touched again.

## Main-thread verification, all three lanes in the tree

```
npm run typecheck                 clean
node scripts/check-contracts.mjs  PASS
npx vitest run                    1493 passed / 84 files   (baseline 1464 / 82)
npx eslint .                      0 errors, 101 warnings   (baseline 0 / 102)
```

## Baseline capture

Filled in by the main thread before spawning:

```
(see BASELINE.txt in this directory)
```
