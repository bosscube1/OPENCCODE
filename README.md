# OpenCode Desktop

A Claude-Code-style desktop GUI for coding agents — backed by [OpenCode](https://opencode.ai)
instead of a single vendor's API.

The chat surface, streaming tool calls, permission prompts and session history all look and
behave like a modern agentic coding client, but the engine underneath is `opencode serve`.
That means **any** provider OpenCode supports: Groq, Google Gemini, OpenRouter, Cerebras,
Mistral, local Ollama, and so on. There is no Anthropic dependency anywhere in the app — the
model picker is populated entirely from whatever providers you have authenticated.

---

## Architecture

```
┌────────────────────────┐   IPC    ┌───────────────────────┐   HTTP + SSE   ┌──────────────────┐
│  renderer (React 19)   │ ───────► │  main (Electron 43)   │ ─────────────► │  opencode serve  │
│  zustand store, chat   │ ◄─────── │  owns SDK + child     │ ◄───────────── │  (child process) │
└────────────────────────┘  events  └───────────────────────┘   event stream └──────────────────┘
```

- **Main process owns everything stateful.** It spawns `opencode serve` as a child process,
  holds the only `@opencode-ai/sdk` client, and subscribes exactly once to the server's SSE
  event stream.
- **The renderer never speaks HTTP.** A `file://` origin cannot make cross-origin requests to
  a loopback server without tripping CORS, so all traffic is funnelled over `ipcRenderer.invoke`
  through a `contextBridge` API (`window.api`). The renderer imports SDK **types only**.
- **Events are rebroadcast verbatim.** Every SSE event the main process receives is forwarded
  to the renderer on the `oc:event` channel; a single reducer in the zustand store folds them
  into UI state (message parts stream in token by token, tool calls transition
  `pending → running → completed`, permission requests appear as prompts).
- **The OpenCode server is torn down with the app.** Quitting kills the child process, so no
  orphaned server is left holding the port.

Renderer hardening: `contextIsolation: true`, `nodeIntegration: false`, plus a restrictive CSP
in `src/renderer/index.html`.

### Layout

```
src/
  main/       Electron main process — server lifecycle, SDK client, IPC handlers
  preload/    contextBridge definition of window.api  (+ index.d.ts for the renderer)
  renderer/
    index.html
    src/
      main.tsx        React entry
      App.tsx         shell
      index.css       design tokens + app/sidebar styles
      components/     Chat, MessageView, ToolCall, Composer, PermissionPrompt, Sidebar, ...
      lib/            store.ts (zustand), types.ts
electron.vite.config.ts
electron-builder.yml
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 20.19+ or 22.12+** | electron-vite 5 requires it. `node -v` |
| **OpenCode CLI** | `npm i -g opencode-ai` — then check with `opencode --version` |
| **Windows 10/11** | The build targets Windows first; the app spawns `opencode.cmd`. |

The app looks for `opencode` on your `PATH`. If `npm i -g` put it somewhere unusual, make sure
that directory is on `PATH` before launching (`where opencode` should print a path ending in
`opencode.cmd`).

---

## Adding free provider keys

**Keys never live in this repo.** There is no `.env` to fill in and no key field in the UI.
Authentication is delegated to the OpenCode CLI, which writes credentials to its own store
(`%USERPROFILE%\.local\share\opencode\auth.json`). That file is outside the project directory
and is not something this app reads or writes.

Run this once per provider, in any terminal:

```powershell
opencode auth login
```

Pick a provider from the list and paste the key. Good free-tier options:

| Provider | Where to get a key | Free-tier highlights |
|---|---|---|
| **Groq** | <https://console.groq.com/keys> | `llama-3.3-70b-versatile`, `openai/gpt-oss-120b` — extremely fast |
| **Google Gemini** | <https://aistudio.google.com/apikey> | `gemini-2.5-flash`, `gemini-2.5-pro` — large context |
| **OpenRouter** | <https://openrouter.ai/keys> | every `:free` model, e.g. `qwen/qwen3-coder:free` |

Then restart the app (or hit **Reconnect** in the title bar) and the new provider's models
appear in the picker.

If you would rather configure providers declaratively — pin a default model, restrict the
picker to specific models, give the `plan` and `build` agents different models — copy
[`opencode.json.example`](./opencode.json.example) to `opencode.json` in your project folder
and edit it. It uses `{env:GROQ_API_KEY}`-style references, never literal keys. `opencode.json`
is gitignored.

---

## Scripts

```powershell
npm install          # first time only

npm run dev          # electron-vite dev — Vite HMR for the renderer, hot restart for main
npm run typecheck    # tsc over both projects (node + web); must be clean before a PR
npm run build        # production bundle into out/
npm run dist:win     # build + package a Windows app into dist/
```

- `npm run dev` starts the Vite dev server on `http://127.0.0.1:5173` and opens the Electron
  window against it. The OpenCode server is started by the main process, not by you.
- `npm run typecheck` runs two passes — `tsconfig.node.json` (config file, `src/main`,
  `src/preload`) and `tsconfig.web.json` (`src/renderer/src`) — both with `--composite false`
  so nothing is emitted.
- `npm run dist:win` runs `electron-builder --win --dir`, producing an unpacked app under
  `dist/win-unpacked`. Drop the `--dir` from the script to get the NSIS installer and the
  portable `.exe` configured in `electron-builder.yml`.

---

## Troubleshooting

### "Port already in use" / the app starts but never connects

The main process binds `opencode serve` to `127.0.0.1:4599`. If something else already owns
that port — usually a previous run of this app or a stray `opencode serve` from a terminal —
the server fails to start and the title bar shows a red disconnected state.

```powershell
netstat -ano | Select-String ":4599"      # find the PID in the last column
Stop-Process -Id <PID>                    # then hit Reconnect in the app
```

### Provider authentication errors

Symptom: the session starts, then immediately errors with a 401/403 or "no such model".

1. Confirm the provider is actually authenticated: `opencode auth list`.
2. Re-run `opencode auth login` for that provider — free-tier keys are often rotated or
   rate-limited rather than invalid, and a 429 surfaces the same way in the UI.
3. If you use `opencode.json`, check the model id is one the provider really serves. A typo in
   a model id fails at request time, not at startup. `opencode models` lists valid ids.
4. Free tiers have per-minute request and token caps. If long sessions die partway through,
   you are probably hitting a rate limit — switch to a second free provider in the picker.

### Orphaned `opencode serve` process

If Electron is killed hard (Task Manager, a crash during `npm run dev`), the child server can
survive and keep the port.

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*opencode*serve*" } |
  Select-Object ProcessId, CommandLine

Stop-Process -Id <PID>
```

Then restart the app. The main process reaps its child on `will-quit`, so this should only
happen after an abnormal exit.

### `opencode` is not recognised

The app spawns `opencode.cmd`, which only exists after a global install. Run
`npm i -g opencode-ai`, close and reopen your terminal (so the updated `PATH` is picked up),
verify with `where opencode`, then relaunch the app.

### Blank window after `npm run dev`

Usually a renderer exception. Open DevTools (`Ctrl+Shift+I`) and check the console. If the
error is a CSP violation, the dev server is likely running on a non-loopback host — the CSP in
`src/renderer/index.html` only whitelists `127.0.0.1` and `localhost`.

---

## License

MIT.
