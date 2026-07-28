---
name: run-opencode-desktop
description: Build, launch, screenshot and drive the OpenCode Desktop Electron app on Windows. Use when asked to run, start, launch, smoke test, screenshot, or click through the app, or to verify a UI change in the real window rather than in tests.
---

# Run OpenCode Desktop

Electron 43 + React 19 desktop app. The main process owns all SDK/HTTP traffic;
the renderer reaches it only through a preload `contextBridge`. Driven by
`.claude/skills/run-opencode-desktop/driver.ps1` (PowerShell 5.1, Win32 window
capture) plus the `computer-use` MCP for clicks.

All paths below are relative to the repo root. Windows only - there is no
headless path, see Gotchas.

## Prerequisites

Already on this machine, no install step: Node 24, npm 11, `opencode` CLI
(`C:\Users\Hp\AppData\Roaming\npm\opencode.ps1`). Dependencies are installed;
if `node_modules` is missing, `npm install` at the repo root.

The `computer-use` MCP needs a grant before it can see or click the window.
Request the **process basename**, not the friendly name:

```
request_access(apps: ["electron.exe"])
```

`"OpenCode Desktop"` resolves to the *installed* build at
`%LOCALAPPDATA%\Programs\opencode-desktop\opencode-desktop.exe`, which is a
different binary from the dev run - grant it and the dev window still comes
back masked in screenshots.

## Run (agent path)

```bash
powershell -File .claude/skills/run-opencode-desktop/driver.ps1 start
```

| Command | What it does |
|---|---|
| `start` | Kills any stale instance, launches `npm run dev` detached, waits for the renderer to attach. Logs to `%TEMP%\opencode-desktop-run\dev.{out,err}.log` |
| `shot -Out <path.png>` | Maximizes + raises the window, saves a PNG, drops topmost again |
| `shot -Out <p> -KeepTop` | Same but leaves it topmost - use before a click sequence |
| `status` | Window pid, dev processes, listening ports, log tails |
| `focus` / `release` | Raise / un-raise without capturing |
| `stop` | Kills vite, electron, and the spawned `opencode serve` |

Read the PNG back with the Read tool. **Look at it** - a cream-coloured page
reading "Starting the OpenCode server..." means the boot never finished, not
that it worked.

To click, keep the window topmost and drive it with `computer-use`:

```
driver.ps1 shot -Out shot.png -KeepTop     # raise + capture
mcp__computer-use__screenshot               # get the coordinate frame
mcp__computer-use__computer_batch(...)      # click / type
driver.ps1 release                          # give the desktop back
```

`computer-use` coordinates come from *its own* `screenshot`, not from the
driver's PNG - the two have different scaling. Always take one before clicking.

### Landmarks

Status bar, bottom-left: `Files` `Editor` `Git` `Terminal` toggle the right-hand
panel. Same tabs repeat along the panel's own top edge once it is open. The
server-health dot and port sit next to them (`127.0.0.1:4599` when healthy).

Switching workspace: `Ctrl+O` opens a native "Choose a project folder" dialog.
Click the **Folder:** field, type an absolute path, click **Open project**. The
dialog belongs to the same electron.exe grant, so no extra `request_access`.

## Verified smoke flow

This is the round trip that exercises the Phase 1 code surface. Every step was
run against a real workspace (`C:\Users\Hp\Music\docs`):

1. `Files` - tree loads, modified files render in the accent colour.
2. Click a modified file - `Editor` opens it in **diff mode** with per-hunk
   Accept checkboxes and an "Apply accepted (n/m)" button.
3. `Git` - branch, upstream, STAGED / UNSTAGED sections.
4. `Terminal` -> **New Terminal** spawns PowerShell in the workspace.
5. Point the workspace at a non-repo folder - `Git` must read "This folder is
   not a git repository", never a stuck "Loading git status...".

## Test / typecheck

```bash
npm run typecheck
```

```bash
npm run test
```

444 tests, ~20s. `npm run lint` reports 0 errors and ~42 pre-existing
`no-explicit-any` warnings - that is the baseline, not a regression.

## Gotchas

- **A stale dev instance silently hijacks your run.** The old instance holds
  port 5173 *and* the Electron single-instance lock, so a second `npm run dev`
  prints `starting electron app...`, exits, and leaves the OLD window (old
  code) on screen looking like your build. Symptom: the window shows a state
  your change should have altered, or sits on "Starting the OpenCode server...".
  `driver.ps1 start` always stops first for this reason. Never launch with a
  bare `npm run dev`.
- **`starting electron app...` is not the ready signal.** It prints before the
  window exists. Wait for `[Renderer Console] [vite] connected.` in
  `dev.out.log` - that is what the driver polls.
- **You cannot drive this app through a browser.** Loading
  `http://127.0.0.1:5173` gives a renderer with no `window.api` (the preload
  bridge is absent), so it never leaves the boot screen. Same reason there is
  no headless/CI path: the real window is the only working surface.
- **`SetForegroundWindow` is not enough to raise the window.** Whatever app owns
  focus keeps it. Only `SetWindowPos(HWND_TOPMOST)` actually raises it - and it
  must be released afterwards or the user's desktop stays covered.
- **PowerShell 5.1 parses `.ps1` as ANSI unless the file has a UTF-8 BOM.** A
  bare em-dash in a comment produces a cascade of `Unexpected token` parse
  errors pointing at unrelated lines. Keep driver edits ASCII, and save with a
  BOM.
- **xterm needs a click in the terminal body before it accepts input.** Typing
  right after clicking the `New Terminal` button goes nowhere.
- **Do not end typed terminal input with `\n`.** PowerShell reads it as a line
  continuation and drops to a `>>` prompt. Type the command, then send `Return`
  as a separate key action.
- **`file.edited` is emitted by the agent's edit tool, not a filesystem
  watcher.** Writing a file into the workspace from outside the app does *not*
  refresh the file tree or git panel. Verifying `refreshTree()` / `refreshGit()`
  requires a real agent turn that edits a file - which spends the configured
  provider's quota, so ask before doing it.
- **`opencode serve` is a child of the app** and survives a hard kill of
  electron alone, leaving a listener on 4599 that confuses the next run.
  `driver.ps1 stop` kills it explicitly.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `dev window never appeared` from `start` | Read `%TEMP%\opencode-desktop-run\dev.err.log`. A stale lock is the usual cause - run `stop`, then `start` again. |
| Window sits on "Starting the OpenCode server..." | Stale instance, or `opencode.exe` orphaned from a previous run. `driver.ps1 stop` then `start`. |
| Screenshot shows the window masked / a solid rectangle | `electron.exe` is not granted. `request_access(apps: ["electron.exe"])`. |
| Screenshot shows another app on top | The topmost flag was released. Use `shot -KeepTop`. |
| `Port 5173 is in use, trying another one...` in the log | A stale vite is alive. `stop` first - the app on 5174 is a second instance that will lose the single-instance race. |
| Driver dies with `Unexpected token` errors | Non-ASCII character in the script, or the BOM was stripped by an editor. See the encoding gotcha above. |
