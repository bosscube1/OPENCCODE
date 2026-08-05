# M2.3 — IPC-boundary tests: module spec

Branch: `test/m2.3-ipc-boundary`. Started 2026-08-05.

## Goal

Drive the real `ipc.ts` handlers through a stub `ipcMain`, asserting every channel
rejects malformed input and delegates correctly. Target: lift `ipc.ts` off its 5.76%
branch coverage. 71 registered channels (70 `ipcMain.handle` + 1 `ipcMain.on`).

## Harness (already built and proven — do not rewrite)

`src/main/__tests__/ipcHarness.ts` exports:

- `loadIpc(overrides?)` — resets modules, mocks electron + all 20 collaborating services,
  imports `ipc.ts` fresh, calls `registerIpc` with stub controllers. Returns
  `{ invoke, send, channels, has, mocks, ipc }`.
- `HOSTILE_STRINGS` / `HOSTILE_OBJECTS` — the values every `requireString` /
  `requireObject` guard must reject.
- `expectRejectsAll(invoke, values)` — asserts rejection for each.

Proven by `src/main/__tests__/ipc.registration.test.ts` (5 tests, green).

Mocks are installed with `vi.doMock` + dynamic import, NOT top-level `vi.mock`, because
`vi.mock` hoists only within its own file.

## Module split — one test file each

| # | File | Channels | Agent |
|---|------|----------|-------|
| 0 | `ipc.registration.test.ts` | registration/idempotence/teardown | done (main thread) |
| 1 | `ipc.sessions.test.ts` | `oc:sessions:*`, `oc:messages:*`, `oc:prompt`, `oc:abort`, `oc:session:fork`, `oc:agents:list` | |
| 2 | `ipc.projects.test.ts` | `oc:projects:*` incl. knowledge | |
| 3 | `ipc.mcpKeys.test.ts` | `oc:mcp:*`, `oc:keys:*` | |
| 4 | `ipc.nanogpt.test.ts` | `oc:nanogpt:*` | |
| 5 | `ipc.shell.test.ts` | `oc:status`, `oc:restart`, `oc:pick*`, `oc:openExternal`, `oc:clipboard:saveImage`, `oc:providers`, `oc:permission:reply`, `oc:config:permission:set`, `oc:appSettings:*`, `oc:liveWindow:*`, `oc:live:*`, `oc:quick:submit`, `oc:crashlog:*` | |

## Acceptance criteria (per module)

1. Every channel in the module has at least one happy-path test asserting the handler
   calls the right collaborator with the right arguments.
2. Every channel taking an argument has a rejection test over `HOSTILE_STRINGS` or
   `HOSTILE_OBJECTS` as appropriate.
3. `oc:openExternal` must be proven to reject non-http(s) schemes (`file:`, `javascript:`,
   `data:`) — this is a security boundary, not a validation nicety.
4. No production file is modified. If a test exposes a real bug, record it in this file
   under "Findings" and pin current behaviour with a test that says so.
5. `npx vitest run src/main/__tests__/<your file>` is green before reporting done.

## Outcome — 2026-08-05

**Done.** 71/71 registered channels covered by 290 tests across 7 files, all green.

| Metric | Before | After |
|---|---|---|
| `ipc.ts` branch | 5.76% | 74.89% |
| `ipc.ts` statements | 21.27% | 90.90% |
| repo branch | 59.66% | 63.07% |
| repo statements | 62.69% | 68.07% |

A 6th module (`ipc.misc.test.ts`, 39 tests) was added after a registered-vs-tested channel
diff caught 9 channels the original 5-way split had missed: `oc:sessions:update`,
`oc:sessions:todos`, `oc:commands:list`, `oc:find:files`, `oc:vcs:get`, `oc:exportChat`,
`oc:saveFile`, `oc:config:permission:get`, `oc:search:chats`. Re-run that diff before
declaring any future IPC work complete — the split is not self-verifying.

## Findings

### Verified by the main thread, not just reported

- **`oc:openExternal` is sound.** Confirmed by reading `ipc.ts:601-613`: it is an
  allowlist, not a denylist — `new URL()` first (malformed throws, which is what stops
  `//evil.com`), then `protocol !== 'http:' && !== 'https:'` throws before
  `shell.openExternal` is reached.
- **`oc:saveFile` / `oc:exportChat` have no path-traversal hole.** Confirmed by reading
  `ipc.ts:863-894`: the written path comes from `dialog.showSaveDialog`, not from the
  renderer. `defaultName` only seeds `defaultPath`, so a hostile `../../x` merely
  pre-fills the dialog the user still has to confirm.
- **`oc:messages:revert` returning `void` while `unrevert` returns `Session` is NOT a
  bug** (reported as one by the sessions module). The asymmetry is deliberate and
  declared in the renderer's own contract: `api.ts:90-91` types them differently, and
  `sessionSlice.ts:314` consumes the returned session only on the unrevert path, to drop
  the reverted-state banner without waiting on the `session.updated` SSE. Do not
  "fix" this.

### Module 5 (ipc.shell.test.ts) — COMPLETE ✓

**No findings.** All 22 shell-module channels tested. Test file: `src/main/__tests__/ipc.shell.test.ts` (56 tests, all green).
- **oc:openExternal security:** Properly validates `URL.protocol` to reject `file:`, `javascript:`, `data:`, `vbscript:` and scheme-relative URLs. Handler throws before delegating to `shell.openExternal`.
- **All channels validate inputs:** Every channel taking arguments has hostile-input rejection tests. No bypass found.
- **oc:live:send correctly registered as `ipcMain.on()`**, not `.handle()`.

### Module 3 (ipc.mcpKeys.test.ts)

**Finding: MCP handlers do not validate `args.name` at the IPC boundary**
- **Location:** `src/main/ipc.ts` lines 777–805 (handlers: `oc:mcp:add`, `oc:mcp:remove`, `oc:mcp:connect`, `oc:mcp:disconnect`, `oc:mcp:auth`)
- **Issue:** The handlers validate `args.directory` with `requireString()` but pass `args.name` and `args.config` (for add) directly to the downstream mcp service methods without validation at the IPC boundary. Callers can pass undefined, null, empty string, or any other value, and it reaches the service unvalidated.
- **Severity:** Medium — inconsistent with the pattern established in other handlers (e.g., `oc:mcp:status` validates its single argument). The downstream services may handle it correctly, but the IPC boundary should be strict.
- **Current behavior pinned by tests:** `ipc.mcpKeys.test.ts` lines 308–368 document and assert this current unvalidated pass-through behavior.
- **No fix applied:** Per spec section 4, findings are recorded, not fixed.
