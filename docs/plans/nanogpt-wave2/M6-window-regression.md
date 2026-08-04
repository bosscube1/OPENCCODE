# M6 — Revert the window-show debug hack

Read `00-CONTRACT.md` first. Trivial, mechanical, independent of every other module.

## Owns (exclusive)
- `src/main/index.ts`

## Defect

The working tree changed `createWindow()`:
- `src/main/index.ts:124` — `show: false` became `show: true`
- `src/main/index.ts:145-146` — added `win.setAlwaysOnTop(true)` immediately followed by
  `win.setAlwaysOnTop(false)`

This reads as leftover debugging from smoke-testing the NanoGPT panels. It is unrelated to
the NanoGPT feature and it regresses behaviour: `show: false` plus `show()` on the
`ready-to-show` path is what prevents a blank unpainted window from flashing at launch, and
the always-on-top toggle force-fronts the window over whatever the user is doing.

## Task

Restore `show: false`. Remove both `setAlwaysOnTop` calls. Keep `win.focus()` only if the
surrounding code shows it predates this branch — check `git diff HEAD -- src/main/index.ts`
and keep exactly what was there before, nothing more.

## Acceptance
1. `git diff HEAD -- src/main/index.ts` shows no remaining changes to `createWindow()`.
2. `npx tsc --noEmit -p tsconfig.node.json --composite false` exits 0.
