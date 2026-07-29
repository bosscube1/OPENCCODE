# Production Plan — opencode-desktop → production-grade coding & agentic harness

Status: draft, 2026-07-28. Baseline verified against the working tree on
`feat/p3-code-surface` (typecheck clean, 501/501 tests green, lint 0 errors /
53 warnings).

---

## Part 1 — Assessment

### 1.1 What exists today (verified, not assumed)

| Layer | State |
|---|---|
| Architecture | Sound. Main owns HTTP/SDK/child process; renderer is types-only, all traffic over `contextBridge`; one SSE subscription rebroadcast on `oc:event`; zustand store is a composition root over 14 domain slices |
| Feature surface | Broad: chat parity (edit-resend, search, image previews), BYOK key manager (`safeStorage`/DPAPI, no plaintext fallback), smart routing v2 + task-kind pools (`poolForTask` in `freeTier.ts`), artifacts panel, projects + knowledge, MCP connectors UI, tray + quick-entry + `electron-updater` wrapper, git/editor/terminal code surface, NanoGPT suite, Gemini Live, multi-model compare |
| Security posture | Strong baseline: `sandbox: true`, `contextIsolation: true`, CSP in `index.html`, `setWindowOpenHandler` deny, `will-navigate` **and** `will-frame-navigate` guards, `assertSubpath` containment, masked-only key data over IPC, argument validation on IPC handlers |
| Tests | 36 files / 501 cases, all pure-unit. Good coverage of routing/rotation/hunks/git/fs/keys/updater logic |
| CI | typecheck + lint + test on ubuntu **and** windows (`ci.yml`) |

### 1.2 Gaps between here and "production-level"

**G1 — Release engineering is unproven end-to-end.** `electron-builder.yml` is
win-only; builds are unsigned (no certificate); the updater wrapper has unit
tests but has never round-tripped against a real GitHub Release; CI never runs
`electron-vite build` or packaging; two stacked feature branches
(`feat/p2-stability`, `feat/p3-code-surface`, ~2k lines ahead of `main`) are
unmerged — `main` does not represent the product.

**G2 — Test pyramid stops at unit level.** Zero E2E (no Playwright), zero
component tests, no coverage measurement or gates. Documented unexercised
paths: the amber "reconnecting…" SSE state, `taskkill` reap paths, the full
update flow.

**G3 — Supply chain hygiene.** `npm audit`: **21 vulnerabilities (19 high)**.
`react-markdown` and `remark-gfm` are listed under `devDependencies` despite
being runtime renderer code (bundled, so not fatal — but wrong). No audit gate
in CI, no dependency-update policy, no integrity pinning beyond the lockfile.

**G4 — Cross-platform is aspirational.** Windows-first by design (`.cmd`
spawn, `taskkill /T /F`, DPAPI), and that is fine as a positioning decision —
but `node-pty` ships a win32-x64 prebuilt only, `menu.ts`/`tray.ts` carry
half-wired mac branches, and nothing else is smoke-tested off Windows.
Decide: Windows-only product (say so, delete dead branches) or true
cross-platform (real work).

**G5 — Reliability & observability are thin.** Only `crashlog.ts` (1 MB
rotating file). No structured logging, no diagnostics bundle for support, no
perf/memory metrics. Expected conditions are thrown as IPC errors — e.g.
`oc:git:status` on a non-repo directory spams `dev.err.log` with stack traces
(observed in this session). Server/SSE health states exist but the failure
branches have never been exercised live.

**G6 — Performance ceilings.** `Chat.tsx` renders `messages.map(...)` with no
virtualization — long agentic sessions degrade. `index.css` is 1 899 lines and
`messages.css` 1 462 — global-token discipline exists but the sheets are
monolithic. Monaco workers are excluded from pre-bundling (correct), but
there is no route-level code splitting; mermaid/Monaco load strategy is
undocumented.

**G7 — UX/a11y/i18n.** 26 of 30 components use some `aria-*`, but there is no
keyboard-navigation map, no focus management audit (modals, palette,
lightbox), no reduced-motion handling, no i18n seam (strings hardcoded), no
first-run onboarding flow.

**G8 — Security hardening backlog.** Known, documented: internal file-tree
drag bypasses `MAX_ATTACHMENT_BYTES`; `ArtifactsPanel` preview sandbox needs a
final audit pass; markdown rendering (`react-markdown` + GFM + `highlight.js`)
has no recorded XSS review; IPC argument validation is hand-rolled per handler
(no schema library, inconsistent strictness); no permission-model doc for what
the agent may do by default.

**G9 — Codebase health.** `ipc.ts` is 1 059 lines / ~45 handlers in one
function; lint baseline has drifted 42 → 53 warnings; `CONTRACTS.md` (66 KB)
is a strength but has no drift check; dead `dist-*` directories (7 of them)
pollute the repo root; no ADRs, no contributor guide, no changelog.

**G10 — Agentic-harness depth (product layer).** To be a *harness*, not just a
client: no checkpoint/rewind story beyond per-message revert, no permission
profiles (read-only / workspace-write / full-auto), no run-level cost or token
metering (NanoGPT subscription usage only), no headless/CLI invocation, no
structured run artifacts (a run produces chat text, not an auditable record).

### 1.3 Verdict

The bones are production-quality; the surrounding apparatus (release, E2E,
supply chain, observability, platform story) is prototype-grade. The plan
below closes that gap without rewriting what already works.

---

## Part 2 — Plan

Ground rules carried over (binding): CONTRACTS.md first for new surface; main
owns HTTP; slices for state; global CSS tokens; `register(ipc)` pattern for
services; typecheck + test green before a module is "done".

### Phase 0 — Reconcile & baseline (0.5–1 week)

Precondition for everything; no new features.

| # | Task | Acceptance |
|---|---|---|
| 0.1 | Merge `feat/p2-stability` + `feat/p3-code-surface` → `main` (PRs via browser, `gh` absent); delete merged branches | `main` == working tree, CI green on `main` |
| 0.2 | `npm audit fix` (non-breaking), then triage the rest; move `react-markdown`/`remark-gfm` to `dependencies` | audit ≤ moderate-only, each remaining finding documented with rationale |
| 0.3 | Delete `dist-fixed*`, `dist-fresh`, `dist-router-fix`, `dist-installer`, stale `dev-*.log`; add `dist*/` to `.gitignore` | repo root clean |
| 0.4 | Non-repo directories: return `GitStatus \| null` gracefully instead of throwing through `oc:git:status` / `oc:git:branches` | no stack traces in logs for expected states; regression test |
| 0.5 | Record baseline metrics: cold-start time, renderer bundle size, memory after 200-message session | numbers committed to `docs/baseline.md` (used by M5) |

### M1 — Release engineering & distribution (1–2 weeks)

Goal: a signed, auto-updating installer produced by CI on every tag.

1. **Release workflow** `.github/workflows/release.yml`: on `v*` tag →
   `electron-vite build` → `electron-builder --win` → draft GitHub Release
   with artifacts + generated notes. Add a `build` job to `ci.yml` (build only,
   no package) so `main` can never break the bundle.
2. **Updater round-trip**: publish one real `v0.2.1` prerelease from the repo
   owner account; verify check → download → prompt → install on a clean
   machine. Wire `updater.ts` status into `SettingsPanel` (partially exists).
3. **Versioning discipline**: `CHANGELOG.md` (keep-a-changelog), version bump
   script, `electron-builder.yml` `publish` block verified against the real
   owner/repo.
4. **Code signing**: blocked on the owner purchasing an OV/EV certificate —
   document the exact `win.certificateFile`/`CSC_LINK` env wiring now so it is
   a config change when the cert arrives. Until then: unsigned build clearly
   labeled in release notes.
5. **Squirrel/NSIS polish**: installer icon, per-machine vs per-user choice,
   uninstall cleanup of `userData` opt-in.

### M2 — Test pyramid & quality gates (2–3 weeks, parallel with M1)

Goal: the documented "never exercised" paths get exercised; coverage is
measured and gated.

1. **E2E with Playwright** (`@playwright/test` + Electron launch): golden
   paths only — app boots with a mocked `opencode serve` fixture, send prompt
   → streamed reply renders, permission prompt → approve, session switch,
   file-tree open → Monaco loads, settings → BYOK add (mocked safeStorage).
   ~8–12 scenarios. Runs in CI on windows-latest.
2. **Server-fault harness**: a fixture server that can drop SSE without
   exiting → finally trips and asserts the amber reconnecting state and silent
   reconnect (closes the CONTINUATION.md gap #1).
3. **Component tests**: vitest + Testing Library for `PermissionPrompt`,
   `ToolCall`, `Composer`, `CommandPalette` (the four highest-logic
   components).
4. **Coverage**: `vitest --coverage` (v8), gate at lines ≥ 70 % / branches
   ≥ 60 % on `src/main` + `src/renderer/src/lib` (UI components exempt
   initially), ratchet upward per release.
5. **Contract drift check**: CI script asserting every `ipcMain.handle`
   channel name appears in CONTRACTS.md and every preload method in
   `index.d.ts` — the document stays the source of truth mechanically, not by
   discipline.

### M3 — Security & trust hardening (1–2 weeks)

1. **IPC schema validation**: introduce `zod` (main + preload shared schemas);
   convert all ~45 handlers from hand-rolled checks to schemas; shared schemas
   become the mechanical source for CONTRACTS.md snippets.
2. **Markdown/XSS review**: pin down `react-markdown` config (allowed
   protocols, no raw HTML, `rehype-sanitize` if raw HTML ever enabled); test
   suite of hostile payloads (javascript: links, data: URIs, iframe injection)
   rendered through `MessageView`.
3. **Artifacts sandbox audit**: verify `allow-same-origin` can never combine
   with `allow-scripts`; assert `will-frame-navigate` covers iframe targets;
   hostile-artifact E2E case.
4. **Attachment size parity**: `FileNode` gains size via one batched IPC at
   tree load (not per-drag), so tree drags enforce `MAX_ATTACHMENT_BYTES`
   identically to OS drops (closes CONTINUATION.md gap #2).
5. **Threat model doc** (`docs/SECURITY.md`): trust boundaries, key custody,
   update-signing story, responsible-disclosure contact.

### M4 — Reliability & observability (1 week)

1. **Structured logging**: leveled logger in main (JSON lines, per-day
   rotation, redaction hook reusing `redactedSummary`); renderer forwards
   boundary errors over a new `oc:log` channel.
2. **Diagnostics bundle**: "Help → Export diagnostics" → zip of sanitized
   logs, versions, provider list (no keys), recent IPC error counts.
3. **Error taxonomy**: expected-state vs fault split (extends 0.4): IPC
   handlers return typed `{ ok: false, reason }` for expected states; faults
   keep throwing and land in crashlog with context.
4. **Health surface**: extend `ServerStatus` reporting into a small
   diagnostics view (server pid, uptime, SSE state, last event age, reconnect
   count) — turns the invisible reconnect logic into something supportable.

### M5 — Performance & scale (1–2 weeks)

1. **Chat virtualization**: windowed rendering for the message list (custom
   hook or `@tanstack/react-virtual`); target: 1 000-message session at
   constant memory, scroll anchoring preserved at bottom.
2. **Bundle splitting**: route/dynamic `import()` for Monaco, mermaid, the
   compare view, and the images gallery; report per-chunk sizes in CI against
   the M0 baseline.
3. **CSS modularization**: split `index.css` into tokens + base + shell; move
   component styles next to components (existing `*.css` convention extended);
   no visual diff allowed (screenshot-compare in E2E).
4. **Store render profiling**: selector audit with zustand devtools in dev
   builds; wrap high-frequency rows (`MessageView`, `ToolCall`) in `memo`
   where profiling shows re-render storms during streaming.

### M6 — Platform decision & execution (1–3 weeks depending on choice)

- **Option A (recommended short-term): Windows-only, stated.** Delete the
  half-wired mac branches or mark them experimental; installer, docs, and CI
  matrix reflect one platform done well.
- **Option B: true cross-platform.** Per-platform `node-pty` rebuild strategy
  (or `conpty`/`winpty` abstraction), spawn/kill abstraction replacing
  `taskkill`, keychain fallback where DPAPI is absent (`safeStorage` already
  abstracts), mac notarization + linux AppImage/deb in the release workflow,
  E2E matrix on all three OSes.

### M7 — UX polish, accessibility, onboarding (1–2 weeks)

1. **Keyboard map**: documented shortcut registry, focus traps in
   palette/lightbox/modals, visible focus rings, reduced-motion media query.
2. **First-run flow**: provider setup wizard reusing `ProviderPanel`,
   workspace picker, sample prompt — replaces the current blank-slate start.
3. **Empty/error states audit**: every panel gets designed empty, loading, and
   error states (today they are inconsistent).
4. **i18n seam (no translations yet)**: extract strings behind a `t()`
   helper so localization is a data problem later, not a refactor.

### M8 — Agentic-harness depth (2–3 weeks; the "harness" differentiator)

1. **Permission profiles**: read-only / workspace-write / full-auto presets
   mapping to opencode permission config; per-session override; visible badge
   in the composer.
2. **Checkpoints**: named workspace snapshots (git stash-based for repos,
   file-copy manifest otherwise) with a rewind UI — generalizes the existing
   per-message revert.
3. **Run records**: every agent run persists a structured artifact (prompt,
   model, tool calls, diff summary, duration, outcome) under
   `userData/runs/`; a runs browser reusing the Changes/HunkView surfaces —
   makes agent work auditable.
4. **Usage metering**: token/cost estimate per session and per model from SSE
   usage events (all providers, not just NanoGPT), shown in StatusBar and the
   runs browser.
5. **Headless mode**: `opencode-desktop --headless --prompt ... --dir ...`
   driving the same main-process services without a window — turns the app
   into an automation harness (CI-friendly agent runs).

### M9 — Documentation & contributor experience (continuous, 0.5 week focused)

- ADRs for the four real decisions already made (env-injection vs `auth.set`,
  DPAPI custody, main-owns-HTTP, Windows-first) + each M1–M8 decision.
- `docs/USER_GUIDE.md`, `CONTRIBUTING.md` (dev setup, ground rules, the
  run-driver skill, PR process without `gh`).
- CONTRACTS.md gets a table of contents and per-module ownership header once
  M2.5 makes it machine-checked.

---

## Sequencing

```
P0 ──► M1 (release) ──┬─► M6 (platform) ──► M7 (UX) ──► M8 (harness)
 └─► M2 (tests) ──────┤         ▲                ▲
      M3 (security) ──┘   M6 needs M1's    M7/M8 need M2's E2E
      M4 (observability)    release pipe     safety net
      M5 (performance)
```

M1–M5 are parallelizable across two workstreams (main-process vs renderer);
M6–M8 are sequential-ish and each gates on the safety net from M2.

## Definition of "production" (exit criteria)

1. Tagged release installs, self-updates, and is signed (or explicitly
   deferred with the cert purchase tracked).
2. CI: typecheck + lint + unit + coverage gate + build + E2E, green on `main`.
3. `npm audit` clean of high/critical; contract drift check enforced.
4. 1 000-message session at flat memory; cold start ≤ baseline +10 %.
5. Every documented "never exercised" path from CONTINUATION.md exercised.
6. A support bundle can be produced from any user machine in two clicks.
