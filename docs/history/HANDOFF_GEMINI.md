# Handoff — opencode-desktop → Claude-Desktop-class clone

For: Gemini 3.6 Flash continuing this build.
Repo: `C:\Users\Hp\Dev\opencode-desktop` (Electron + React 19 + zustand, backend = local `opencode serve` via `@opencode-ai/sdk` 1.18.4, HTTP+SSE, main process owns the SDK client, renderer talks only through preload `window.api`).
Full original plan on disk: `C:\Users\Hp\.claude\plans\create-a-plan-to-merry-newell.md` — read it once for the verified-SDK-facts table and per-module file lists; this doc is the status + operating instructions layer on top of it.

**Build state right now: `npm run typecheck` clean, `npm run test` → 70/70 passing.** Do not regress either. Run both after every module before pausing for review.

---

## Ground rules (apply to every module)

1. **CONTRACTS.md is the interface contract.** Before touching code in a module, update `CONTRACTS.md` with the new IPC channels / `window.api` shape / store fields / CSS tokens for that module. Every other stream/file codes against what's written there.
2. **Main owns the SDK client and all HTTP.** Renderer never imports `@opencode-ai/sdk` runtime code, only types. Every backend call is renderer → `window.api.*` (preload) → `ipcMain.handle` (main) → SDK client (`getClient()` in `src/main/server.ts`) → `call<T>(...)` unwrap helper in `src/main/ipc.ts`.
3. **New IPC channel pattern** (copy exactly, see `src/main/ipc.ts`):
   - Add the channel name string to the `CHANNELS` array.
   - `ipcMain.handle('oc:xxx', async (_event, argsArg: unknown) => { const args = requireObject(argsArg, 'xxx args'); const directory = requireString(args.directory, 'directory'); ...; return call<T>(getClient().someMethod({...})) })`.
   - Mirror in `src/preload/index.ts` (the `api` object + `OpencodeApi` interface) **and** `src/preload/index.d.ts`.
4. **Renderer state:** single zustand store at `src/renderer/src/lib/store.ts`. Components read via selectors (`useStore((s) => s.foo)`), never keep local copies of server state. New actions go in the `AppState` interface + the `create<AppState>()((set, get) => ({...}))` body.
5. **Styling:** plain CSS + custom properties, no Tailwind/CSS-in-JS. Global tokens in `src/renderer/src/index.css` (`--bg`, `--bg-alt`, `--bg-inset`, `--bg-sunken`, `--fg`, `--fg-dim`, `--border`, `--accent`, `--accent-fg`, `--accent-soft`, `--danger`, `--warn`, `--ok`, `--radius`, `--card-radius`, `--mono`, `--serif`, `--chat-max-w`, `--shadow`, `--hover`). Component-scoped CSS lives in `messages.css` (Chat/MessageView), `composer.css` (Composer), and any new `*.css` you add per component — import it directly in the `.tsx` file. **Never invent new token names without adding them to `index.css` first and documenting in CONTRACTS.md.**
6. **Tests:** vitest, node environment, `globals:false` (explicit `import { describe, it, expect } from 'vitest'`). Config is `vitest.config.ts` at repo root — it already includes both `src/renderer/src/lib/__tests__/**/*.test.ts` and `src/main/__tests__/**/*.test.ts`. Pure logic (no Electron, no DOM) goes in `lib/`; anything touching `electron` APIs (e.g. `safeStorage`) goes in `src/main/__tests__/` with the Electron module mocked (see `src/main/__tests__/keys.test.ts` for the pattern).
7. **Windows-first environment.** Binary spawn, `taskkill /T /F`, DPAPI via `safeStorage`, path separators — this machine is Windows. Don't assume POSIX paths.
8. **Verification after every module:** `npm run typecheck` (must be clean) + `npm run test` (must be 100% green) + a short manual `npm run dev` smoke pass. Then STOP and let the user review before starting the next module — do not chain modules automatically.
9. Keep branding neutral — no Anthropic/Claude names, logos, or wordmarks anywhere (code, UI copy, assets). App is called "OpenCode Desktop."

---

## Where things stand — module by module

### ✅ Module 1 — Claude-style visual foundation (DONE)
Warm dark theme kept as default (`#1f1e1d`/`#262624`, terracotta accent `#d97757`); warm ivory light theme added (`#faf9f5`/`#f0eee6`, clay accent `#c96442`). All original 14 CSS token names preserved; new tokens (`--serif`, `--bg-sunken`, `--accent-soft`, `--card-radius`, `--chat-max-w`) added. Sidebar restructured: brand strip → "+ New chat" CTA → Chats/Projects nav (Projects nav item is a disabled placeholder for Module 6) → session search + list → footer. Composer is now a rounded elevated card with the model picker embedded as a compact pill inside it (opens upward). Chat column centered at `--chat-max-w` (48rem). App shell reserves a hidden right-panel grid slot for Artifacts (Module 5). Serif uses the system font stack (Georgia etc.) — no bundled font file, to avoid a binary asset + disk pressure; this was the one deviation from the original plan, noted and accepted.
Files touched: `index.css`, `App.tsx`, `Sidebar.tsx`, `Chat.tsx`, `composer.css`, `Composer.tsx`, `ModelPicker.tsx`, `StatusBar.tsx`, `messages.css`, `src/main/index.ts` (`backgroundColor` only).

### ✅ Module 2 — Chat parity (DONE)
- **Edit-and-resend**: hover a user message → Edit pencil → inline textarea → Save → `window.confirm` warning that it reverts workspace file snapshots → `session.revert` via new channel `oc:messages:revert` → store action `editAndResend(messageID, newText)` truncates local messages then calls the existing `send()` (so routing/rotation still apply).
- **Image previews**: file parts with `mime` starting `image/` render as ~240px thumbnails (`.msg__thumb`) instead of the old file chip; click opens `<ImageLightbox>` (new component, full-screen, Esc/backdrop close).
- **Chat content search**: sidebar "Search chats" button → `<ChatSearch>` modal → Enter triggers `oc:search:chats` (main-process fan-out over all sessions, bounded concurrency 4, LRU cache keyed `sessionID:time.updated`, capped 100 results) → click a hit jumps to that session and scrolls to the message (`chat:scroll-to-message` window CustomEvent, message rows wrapped with `id="msg-${id}"` in `Chat.tsx`).
- **In-session find**: Ctrl+F opens an inline find bar over the currently loaded messages using pure helpers in `src/renderer/src/lib/search.ts` (`findMatches`, `makeSnippet`, `splitHighlight` — all tested, 29 vitest cases).
New IPC: `oc:messages:revert`, `oc:search:chats`. New preload: `revertMessage`, `searchChats`, exported `ChatSearchHit` type.
Files touched: `ipc.ts`, `preload/index.ts` + `.d.ts`, `store.ts`, `MessageView.tsx`, `Chat.tsx`, `Sidebar.tsx`, `messages.css`; new `ChatSearch.tsx`, `ImageLightbox.tsx`, `lib/search.ts` + test.

### ✅ Module 3 — BYOK in-app key manager (DONE)
Mechanism (locked decision, do not revisit): **NOT** `client.auth.set` (that writes plaintext into opencode's own `auth.json`, outside our custody). Instead: `electron.safeStorage`-encrypted store on disk, merged into the `opencode serve` child process environment at spawn.
- `src/main/keys.ts` — sole module touching `safeStorage`. Store file `userData/byok-keys.json`, shape `{ version: 1, keys: { ENV_VAR: base64(safeStorage.encryptString(value)) } }`. Refuses to store anything (throws) when `safeStorage.isEncryptionAvailable()` is false — never a plaintext fallback. Exports `loadByokEnv()` (decrypt all → `Record<envVar, value>`), `setKey`, `deleteKey`, `listKeys()` (masked: last-4-chars only, decrypted only transiently), `testKey`.
- `src/main/providerCatalog.ts` — pure `providerID → { envVar, label, docsUrl, testRequest }` map for the free-tier + major providers.
- `src/main/server.ts` `doStart()`: env merge order is `{ ...providerEnv.vars (.env file), ...loadByokEnv() (BYOK store) }` — **BYOK wins on conflict**. Logged via existing `redactedSummary` (key names only, never values).
- New IPC (masked data only over the wire, full key crosses renderer→main on `set` only, never main→renderer): `oc:keys:list`, `oc:keys:set`, `oc:keys:delete`, `oc:keys:test` (cheap authenticated GET in main, 5s timeout, no CORS issue since it's main-side).
- `ProviderPanel.tsx` was rewritten into the key-manager UI (masked key rows, add/test/remove per provider, "Apply & restart" calling the existing `oc:restart`), keeping the old `opencode auth login` hint as an "advanced" footnote. `SettingsPanel.tsx` has a "Manage provider keys…" button that dispatches a `providers:open` CustomEvent (ProviderPanel listens for it, mounted from Sidebar).
- Tests: `src/main/__tests__/keys.test.ts` (12 cases, mocks `electron.safeStorage`), `providerCatalog.test.ts` (8 cases). `vitest.config.ts` include list extended to also cover `src/main/__tests__/**/*.test.ts`.
Files touched/created: `keys.ts`, `providerCatalog.ts`, `__tests__/keys.test.ts`, `__tests__/providerCatalog.test.ts`, `server.ts`, `ipc.ts`, `preload/index.ts` + `.d.ts`, `ProviderPanel.tsx`, `SettingsPanel.tsx`, `vitest.config.ts`.

**⏸ This is the exact pause point. Modules 4–8 below are NOT started — zero code for routing v2, artifacts, projects, MCP, or OS integration exists yet.** Confirmed by grep: no `modelPool`/routing ledger in store/prefs, no `lib/artifacts.ts` or `ArtifactsPanel.tsx`, no `src/main/projects*.ts`, no `oc:mcp:*` channels, no `tray.ts`/`quickEntry.ts`/`updater.ts`.

---

## What's next — Module 4: Smart routing v2 (proactive health-ledger router)

**Goal.** Today's rotation (`src/renderer/src/lib/rotation.ts` + the reactive-429 handling inside `store.ts`'s `send()` and the `session.error` branch of `applyEvent`) only reacts AFTER a 429. Module 4 adds a **proactive** picker that chooses the best healthy free model BEFORE every send, keeps the reactive path as a fallback, and gives the user a toggleable model pool + sticky option.

**Read first:** `src/renderer/src/lib/rotation.ts` (existing `PREFERRED_MODELS`, `FALLBACK_PROVIDER_ORDER`, `FREE_ROUTING_CANDIDATES`, `isRateLimitError`, `pickDefaultModel`, `restoredSelectionValid`) and the `send()` / `rotateToNextFreeModel()` / `session.error` case in `store.ts` (lines ~581-649 and ~780-841 as of this handoff — re-locate by searching `rotateToNextFreeModel` and `isRateLimitError`). Do not duplicate `isRateLimitError` or `FREE_ROUTING_CANDIDATES` — import and reuse them.

**Build `src/renderer/src/lib/routing.ts`** — pure module, **no store import, no React**:
- `type ModelKey = string` (format `"providerID/modelID"`).
- `type ModelHealth = { cooldownUntil: number; cooldownMs: number; success: number; error: number; last429: number | null; latencyEwma: number | null; sends: number[] }` (`sends` = epoch-ms timestamps, pruned to last 24h — this is what drives RPM/RPD counting).
- `type Ledger = Record<ModelKey, ModelHealth>`.
- `record429(ledger, key, now): Ledger` — exponential cooldown starting 30s, doubling each consecutive 429, capped at 30 min. Return a new ledger (immutable-style, matches the codebase's `collections.ts` pattern).
- `recordSuccess(ledger, key, latencyMs, now): Ledger` — halve the cooldown base back down, update `latencyEwma` with α=0.3, push `now` into `sends`, prune entries older than 24h.
- `recordFailure(ledger, key, now): Ledger` — non-429 failure, increment `error` count, do not touch cooldown.
- `underRateCaps(ledger, key, caps, now): boolean` — checks the model's `sends` array against a conservative per-provider caps table you define and export, e.g. `{ groq: { rpm: 30 }, google: { rpm: 10, rpd: 250 }, cerebras: {...}, mistral: {...}, cohere: {...}, openrouter: {...} }` (values are deliberately conservative estimates — document that they're not authoritative).
- `selectModel(pool, ledger, caps, now, opts: { sticky: boolean; current: ModelKey | null; available: Set<ModelKey> }): ModelKey | null` — if `sticky` and `current` is healthy (not in cooldown, under caps, in `available`), return it. Otherwise score every pool member that's `available` and out of cooldown and under caps: `score = successRatio*w1 - latencyPenalty*w2 - recent429Penalty*w3` (pick reasonable weights, document them), highest score wins; ties broken by original position in `FREE_ROUTING_CANDIDATES` (imported from `rotation.ts`) for determinism.
- `loadLedger(): Ledger` / `saveLedger(ledger: Ledger): void` — `localStorage` key `opencode-desktop:routing-ledger`, debounce writes (~500ms), prune on load.

**Test file:** `src/renderer/src/lib/__tests__/routing.test.ts` — cooldown math (doubling, cap), cap counting across a simulated midnight rollover, `selectModel` determinism (same inputs → same output) and sticky-stays-put behavior, ledger round-trip through JSON.

**Wire into `store.ts`:**
- Add `modelPool: ModelKey[] | null` (null = "use default `FREE_ROUTING_CANDIDATES` pool") and `stickyModel: boolean` to `AppState` + `prefs.ts` (`Prefs` type, `loadPrefs`/`savePrefs`).
- In `send()`, when `autoRotate` is on: before the `api().prompt(...)` call, run `selectModel(...)` against the current ledger; if it differs from `providerID/modelID`, `set({ providerID, modelID })` + `addSystemNotice(...)` explaining the proactive switch, THEN send.
- On `session.idle` (already handled in `applyEvent`), call `recordSuccess`. In the existing `session.error` 429 branch, call `record429` and have the reactive retry ask `selectModel` (with the just-updated ledger) instead of walking `FREE_ROUTING_CANDIDATES` directly — keep the existing 3-retry cap.
- **Race to watch:** the pre-send proactive pick and the reactive-retry-after-429 path both mutate the ledger and `providerID`/`modelID`. Do the ledger update and the `set()` in a single synchronous block inside each path — don't let a proactive pick and a reactive retry interleave against a stale ledger snapshot.
- `SettingsPanel.tsx`: add a pool section — checkbox list of candidate models grouped by provider (reuse `FREE_ROUTING_CANDIDATES` + live `providers` from the store to know what's actually available), plus a "Sticky model" toggle.
- `ModelPicker.tsx`: add a small "auto" badge / quick toggle mirroring `autoRotate`.

No new IPC channels — this module is renderer-only. Update CONTRACTS.md with the `routing.ts` function signatures, the new store fields/actions, and the localStorage key.

**Verify:** enable a 2-model pool, hammer one until it 429s (or simulate via the test suite), confirm the *next* send proactively switches with a notice — not just after an error. Turn `autoRotate` off and confirm the model stays put. Confirm `/free` and `/auto` slash commands still work unchanged.

---

## Modules 5–8 (not started) — quick-reference

Full detail is in `C:\Users\Hp\.claude\plans\create-a-plan-to-merry-newell.md`. Summary so Gemini doesn't need to open it immediately:

**Module 5 — Artifacts side panel.** Detect substantial code/html/svg/mermaid/markdown blocks in assistant text via a pure `lib/artifacts.ts` scanner (fenced blocks with lang html/svg/mermaid, or ≥15 lines/≥800 chars; identity = filename hint or language+title heuristic; repeat key = new version). Chip in `MessageView.tsx` opens `ArtifactsPanel.tsx` in the right-panel slot M1 already reserved in `App.tsx`. **Security-critical:** preview renders in `<iframe sandbox="allow-scripts">` — **never** add `allow-same-origin`, and verify `will-navigate`/`setWindowOpenHandler` in `src/main/index.ts` cover iframes (add `will-frame-navigate` if not). Mermaid rendered `securityLevel:'strict'`, lazy-imported. New IPC: `oc:saveFile` generalizing the existing `oc:exportChat` save-dialog pattern.

**Module 6 — Projects.** opencode has no native "knowledge" concept — map Project → directory (`userData/Projects/<slug>/`). Custom instructions = a managed marker-delimited block inside that directory's `AGENTS.md` (opencode's real mechanism). Knowledge files copied into `<project>/knowledge/` + a generated `opencode.json` with `instructions: ["knowledge/**/*.md"]` (verified field on `Config`; smoke-test the glob works, fallback to per-message `body.system` if not). New `src/main/projects.ts` + `projectsPaths.ts` (pure path-containment helpers — every path must resolve inside the registered project root; test traversal attempts explicitly). New IPC: `oc:projects:create`, `oc:projects:instructions:get/set`, `oc:projects:knowledge:list/add/remove`.

**Module 7 — MCP connectors settings UI.** SDK confirmed capable: `client.mcp.status/add/connect/disconnect`, `mcp.auth.authenticate`, `Config.mcp` + `config.update` (PATCH /config). New `McpPanel.tsx` in Settings. New IPC: `oc:mcp:status/add/remove/connect/disconnect/auth`. If `config.update` proves to be runtime-only (verify at implementation time), fall back inside the same handler to editing `opencode.json` via `node:fs` + `restartServer()` — the IPC surface doesn't change either way.

**Module 8 — OS integration: tray, quick-entry, auto-update.** System tray (`src/main/tray.ts`), global shortcut (default `Ctrl+Alt+Space`) opening a frameless always-on-top quick-entry window (`quickEntry.ts` + `QuickEntry.tsx`, same renderer bundle branched on a `#/quick` hash — forwards typed text into the MAIN window's store/send so routing still applies), and `electron-updater` + GitHub Releases (`updater.ts`, `electron-builder.yml` needs `publish: { provider: 'github', owner, repo }`, add `electron-updater` as a **runtime** dependency not devDependency). New IPC: `oc:quick:submit`, `oc:appSettings:get/set`; new send channels `quick-entry:prompt`, `update:status`.

---

## How to run things

```bash
npm run typecheck   # must stay clean
npm run test         # must stay 100% green (currently 70/70)
npm run dev          # electron-vite dev server + app window, for manual smoke checks
```

Do not run `npm run dist:win` / `dist:win:dir` unless the user asks — packaging is Module 8 territory and untested until then.

## Orchestration note for whoever executes this

The plan calls for splitting each module into 2-3 disjoint-file parallel workstreams (tagged by model tier: mechanical/tests → cheap model, standard feature code → mid model, security/architecture/gnarly-async → strongest model available), each stream editing CONTRACTS.md first if it owns new interface surface, then running independently. That pattern is optional — a single continuous agent can do a module sequentially just as correctly, just slower. What matters is: CONTRACTS.md updated before dependents are written, typecheck+test green before calling a module done, and a pause for human review between modules.
