# Continuation — P2 Stability

Written mid-session against branch `feat/p2-stability` (branched from `main`
at `d753fa6`, the merge of PR #1). Read this first if the session was cut off
by a usage limit.

## Where things stand

P0 and P1 are done and merged. PR #1 landed the whole Phase 1 code surface on
`main`. Both P1A bugs were verified in the running app, not just in tests:

- Non-repo folder shows "This folder is not a git repository", not a stuck
  spinner.
- `refreshTree()` / `refreshGit()` fire off `file.edited` — confirmed by
  pointing the workspace at a throwaway repo and sending one real agent turn.
  `hello.txt` appeared in the tree and as `U hello.txt` under UNSTAGED with no
  manual reload.

`main` is clean. `feat/p2-stability` is the active branch.

## P2 scope (agreed)

The original audit doc's P2 breakdown was lost to context compaction. This
list was reconstructed from a codebase survey and approved by the user:

1. **Error boundary per panel** — there is none anywhere in
   `src/renderer/src/components/`, so a render throw in any panel white-screens
   the entire app.
2. **Tests for the four Phase 1 slices** — `fileTreeSlice`, `gitSlice`,
   `editorSlice`, `terminalSlice` have zero coverage. The existing 444 tests
   cover main-process services and pure renderer libs only.
3. **SSE reconnect audit** — DONE, see below.
4. **IPC error surfacing** — make the call sites that swallow errors to console
   match the established `set({ error: errText(e) })` pattern.
5. **Stray `dev*.log` in the repo root** — NOT AN ISSUE. Already covered by
   `.gitignore:27` (`*.log`). They are untracked local artifacts. Leave them.

## SSE audit result — one real gap, not yet fixed

`runEventLoop` in `src/main/server.ts:265` is sound: generation guard,
per-attempt `AbortController`, exponential backoff (`RECONNECT_MIN_MS` 500ms to
`RECONNECT_MAX_MS` 10s), backoff reset after a successful subscribe, clean
bail-out on `stopping`. No changes needed to the reconnect logic itself.

The gap is observability:

```ts
export type ServerStatus = {
  running: boolean
  url: string | null
  error?: string
}
```

There is no stream-connected flag. When the SSE stream drops, the loop retries
silently and only calls `record()` into the log ring. `status.running` stays
`true`, so the status-bar dot stays green while events are dead — the app looks
healthy but has stopped responding to the agent.

**Proposed fix** (deferred to avoid colliding with the in-flight slice edits):
add a `streamConnected: boolean` to `ServerStatus`, set it false on entering the
catch/backoff path and true after a successful `event.subscribe`, emit through
the existing `statusListeners`, surface it on the status-bar dot. This touches
main + preload + `CONTRACTS.md` + a slice. **Per the ground rules, update
`CONTRACTS.md` FIRST** — it is the single source of truth for interfaces.

## How to resume

```bash
git checkout feat/p2-stability
git status
```

Then run the checks to see where you actually are — do not trust this file over
the working tree:

```bash
npm run typecheck
```

```bash
npm run test
```

Baseline before P2: **444 tests passing, typecheck clean.** `npm run lint` has
0 errors and ~42 pre-existing `no-explicit-any` warnings — that is the
baseline, not a regression.

To drive the real app, use the committed skill rather than a bare `npm run dev`
(a stale instance silently hijacks the run):

```bash
powershell -File .claude/skills/run-opencode-desktop/driver.ps1 start
```

Full command reference and the accumulated traps are in
`.claude/skills/run-opencode-desktop/SKILL.md`. Read its Gotchas section before
driving the window.

## Ground rules (binding, from the user)

- `CONTRACTS.md` is the single source of truth for interfaces — update it
  FIRST when adding surface.
- Main owns HTTP. The renderer NEVER imports the SDK runtime.
- New services copy the `register(ipc)` pattern in `src/main/ipc.ts`.
- New state goes in the appropriate slice under
  `src/renderer/src/lib/slices/`.
- CSS uses the global tokens in `index.css`.
- Windows-first: `.cmd` spawn, `safeStorage` DPAPI, no POSIX assumptions.
- After every change: `npm run typecheck`, `npm run test`, and a `npm run dev`
  smoke test.
- The security invariants in `CONTRACTS.md` are binding.
- `gh` is NOT installed and direct pushes to `main` are blocked. Push a feature
  branch and hand over a manual PR link.

## After P2

P3 features and P4 distribution, both untouched. Their item lists were also in
the audit doc and did not survive compaction — ask the user to re-post them
rather than guessing.
