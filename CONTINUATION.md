# Handoff

State as of the end of the P3A session. Read this before touching anything;
then verify against the working tree rather than trusting this file.

## Branch state — two branches stacked, neither merged

```
main                     d753fa6   PR #1 merged (Phase 1 code surface)
feat/p2-stability        ee2191c   pushed, NOT merged
feat/p3-code-surface     01f4e3e   pushed, NOT merged, branched from ee2191c
```

`feat/p3-code-surface` contains all of P2. Merging P3 to main brings P2 with
it; merging P2 separately first is also fine. Both need PRs — `gh` is not
installed on this machine, so use the browser:

- https://github.com/bosscube1/OPENCCODE/pull/new/feat/p2-stability
- https://github.com/bosscube1/OPENCCODE/pull/new/feat/p3-code-surface

Baseline on `feat/p3-code-surface`: **typecheck clean, 501 tests passing**
(was 444 before P2). `npm run lint` has 0 errors and ~42 pre-existing
`no-explicit-any` warnings — that is the baseline, not a regression.

## What P2 shipped (b53673d, ee2191c)

- **Error boundaries** — `src/renderer/src/components/ErrorBoundary.tsx`, one
  per panel tab plus the main view in `App.tsx`. The view boundary is keyed on
  `activeView`; without that key its error state outlives the view that threw
  and the next view is unreachable behind a stale error.
- **Stream health** — `ServerStatus` gained `streamConnected`. `running` means
  the HTTP server answers; `streamConnected` means the SSE subscription is
  live. They are independent — the stream can drop and silently reconnect
  (500ms..10s backoff) while the server stays up, and no events arrive in
  between. The status dot has three states: red offline, amber "reconnecting…",
  green with the host.
- **Editor dirty-flag bug** — `setOpenFileText` compared the incoming text
  against `state.openFile.text`, which the same `set()` call had just
  overwritten. The flag meant "differs from the previous keystroke", so an edit
  repeating the text before it cleared the flag while the buffer still differed
  from disk. Fixed with `openFileBaseText`, reset on open/save/apply/close.
- **Slice tests** — first coverage for `fileTreeSlice`, `gitSlice`,
  `editorSlice`, `terminalSlice`.

## What P3A shipped (01f4e3e)

Four of the five listed P3A items were ALREADY BUILT. Verified, not assumed:

| Item | Reality |
|---|---|
| Ctrl+P fuzzy file finder | Already complete. `App.tsx:234` binds it; `CommandPalette.tsx` debounces 150ms, shows a spinner, and selection does `setPanelTab('editor')` + `openPath`. |
| Inline diff in chat | Already complete. `ToolCall.tsx` builds diffs from `oldString`/`newString`, `metadata.diff`, or a multiedit `edits[]`, clamps at 60 lines with a "Show N more" expander. |
| Syntax highlighting on fences | Already complete, including ```diff fences taking the same path as tool-call diffs. |
| Drag-and-drop to composer | Half-built — OS file drops worked, tree drags did not. Now both do. |
| Multi-file diff view | Genuinely new. Built as the Changes panel. |

New surface:

- **Changes panel** (`ChangesPanel.tsx`) — every changed path in one scrollable
  read-only surface, each file collapsible. A sibling tab, not a mode inside
  Git. Backed by `changedDiffs` / `changedDiffsLoading` / `loadChangedDiffs()`
  on the git slice.
- **Shared `HunkView`** — `EditorPanel` and `ChangesPanel` render hunks through
  one component. Passing `onToggle` opts into the accept checkbox; that is the
  only difference between the editable and read-only surfaces.
- **File-tree drag** — `FILE_TREE_DRAG_MIME` = `application/x-opencode-file-path`,
  carrying the workspace-relative `FileNode.path`. A same-window HTML5 drag
  never populates `dataTransfer.files`, which is why the custom type exists.

## Known gaps — real, deliberate, not forgotten

1. **The amber "reconnecting…" state has never been seen in the running app.**
   Green-on-live-stream is confirmed by screenshot. Tripping amber needs the
   SSE severed while the server stays up; killing `opencode serve` fires the
   child-exit handler instead, which is a different branch. The code path is
   typechecked but not exercised.
2. **The internal drag cannot enforce `MAX_ATTACHMENT_BYTES`.** The OS drop path
   checks `file.size` and silently skips oversized files. `FileNode` carries no
   size, so the tree path would need an IPC round trip per drag to match.
   Dragging a very large file from the tree attaches it where an OS drop of the
   same file would be skipped.
3. **Two minor highlighting gaps, outside the P3A scope.**
   `ArtifactsPanel.tsx:134` renders artifact source unhighlighted, and
   `ToolCall.tsx:364` shows bash commands unhighlighted — the latter looks
   deliberate, since it is formatted with a prompt prefix.
4. **`ChangesPanel` is read-only.** No multi-file accept/apply. The per-hunk
   accept machinery exists in `EditorPanel` and now shares `HunkView`, so wiring
   it up is tractable, but it was out of scope.

## Not started

- **P3B** — task-kind routing (`poolForTask('title')` / `('summary')`, since
  everything currently goes through the `code` pool), provider health
  dashboard, manual model blacklist.
- **P3C** — project templates, project-scoped model preferences, recent
  projects.
- **P4A** — CI/CD verification (`.github/workflows/` exists, unverified),
  portable build testing. **Code signing needs a certificate the user must
  purchase** (OV/EV from a CA). **Auto-update end-to-end needs a real GitHub
  Release published from the user's account** — an agent can dry-run the
  updater logic but not the round trip.
- **P4B** — user guide, contributing guide, architecture decision records. The
  ADR material is real: env injection vs `auth.set`, `safeStorage` DPAPI,
  main-owns-HTTP.

## How to resume

```bash
git checkout feat/p3-code-surface
git status
```

```bash
npm run typecheck
```

```bash
npm run test
```

Drive the real app with the committed skill, never a bare `npm run dev` — a
stale instance holds port 5173 and the Electron single-instance lock, so a
second run exits silently and leaves the OLD window on screen looking like
yours:

```bash
powershell -File .claude/skills/run-opencode-desktop/driver.ps1 start
```

`.claude/skills/run-opencode-desktop/SKILL.md` has the command reference and
the accumulated traps. Read its Gotchas section before driving the window.

## Ground rules (binding, from the user)

- `CONTRACTS.md` is the single source of truth for interfaces — update it FIRST
  when adding surface.
- Main owns HTTP. The renderer NEVER imports the SDK runtime. All backend calls
  go through `window.api`.
- New services copy the `register(ipc)` pattern in `src/main/ipc.ts`.
- New state goes in the appropriate slice under `src/renderer/src/lib/slices/`.
- CSS uses the global tokens in `index.css` — never invent a token name without
  adding it there first.
- Windows-first: `.cmd` spawn, `safeStorage` DPAPI, no POSIX assumptions.
- After every change: `npm run typecheck` + `npm run test` + a `npm run dev`
  smoke test.
- Security invariants in `CONTRACTS.md` are binding — `assertSubpath`
  containment, no shell interpolation for git, sandboxed iframes only.
- `gh` is NOT installed and direct pushes to `main` are blocked. Push a feature
  branch and hand over a manual PR link.

## If you fan out to subagents

Two things went wrong when this session did, both worth avoiding:

- **Partition by file, and include EVERY file a feature touches.** The Changes
  panel agent was barred from `StatusBar.tsx`, which keeps its own
  `PANEL_BUTTONS` list — so the new tab appeared in the panel's tab strip but
  not in the status-bar launcher, the only entry point while the panel is
  collapsed. It shipped invisible until caught in a smoke test.
- **A partition that splits a component from its natural home causes
  duplication.** The same agent could not edit `EditorPanel.tsx` to extract a
  shared component, so it copied the hunk JSX. That was cleaned up afterwards
  into `HunkView`, but the cleanup was only possible once the fleet was done.

Have agents report contract deltas instead of editing `CONTRACTS.md` — the
orchestrator applies them, which both keeps the ground rule and avoids a
guaranteed collision.
