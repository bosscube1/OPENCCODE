# Roadmap — opencode-desktop

Baseline verified 2026-08-04 on `main` @ `b0bf8ff` + version bump to 0.7.0.

| Signal | Value |
|---|---|
| Typecheck | clean (node + web) |
| Tests | 810 passing / 62 files |
| Coverage | **50.39%** overall (renderer lib 74.23%, main 46.48%) |
| Lint | 0 errors, ~42 `no-explicit-any` warnings (baseline) |
| `npm audit` | 6 findings — 3 high, 2 moderate, 1 low |
| Build | `dist:win` green; setup + portable at 0.7.0, `latest.yml` regenerated |
| Smoke | packaged portable boots, window titles, spawns `opencode` server child |
| Source | 181 TS/TSX files, ~22k lines (main 11.9k, components 10.2k) |

Corrections to older docs: `PRODUCTION_PLAN.md` / `CONTINUATION.md` describe
`feat/p2-stability` and `feat/p3-code-surface` as unmerged — both are in `main`
as of `b0bf8ff`. The `21 vulnerabilities (19 high)` figure is also stale (now 6/3).
`Chat.tsx` does have incremental windowing (step 60); it is not full
virtualization, but it is not absent either.

---

## Assessment summary

**Strong.** Security posture is genuinely good and was re-verified, not assumed:
81 IPC channels all validate arguments (`ipc.ts:292-315`), `assertSubpath`
containment layered at both the IPC boundary and inside the service functions
(`fsService.ts:19`, `gitService.ts:22`, `terminal.ts:28`), `sandbox: true` +
`contextIsolation: true` + `nodeIntegration: false` (`index.ts:128-134`), CSP in
`src/renderer/index.html:22`, zero `shell: true` spawns, BYOK keys encrypted via
`safeStorage` and never returned to the renderer beyond a 4-char masked tail
(`keys.ts:219-240`), env allowlists on both the `.env` reader (`env.ts:27-55`)
and the child env (`env.ts:216-226`), `openExternal` protocol check
(`ipc.ts:590-602`).

**Weak.** Three things, in order of risk:

1. **Verification depth.** 810 tests, all pure-unit. The 8 main-process files
   that own process lifetime — `index.ts`, `server.ts` (8.21%), `tray.ts`,
   `menu.ts`, `quickEntry.ts`, `liveWindow.ts`, `crashlog.ts`, `nanogpt.ts`
   (0.6%) — are effectively untested. `ipc.ts` sits at 21% line / **5.8%
   branch**. No E2E, no component tests, no IPC-boundary integration tests.
2. **Release engineering.** Unsigned builds (SmartScreen will warn every user),
   no CI packaging job, no coverage or audit gate. (The updater has now been
   round-tripped live — see 1.2.)
3. **Concentration.** `ipc.ts` at 1240 lines / 81 channels, `server.ts` at 549
   mixing spawn + event loop + status, `CommandPalette.tsx` at 707,
   `index.css` at ~1900. Each is the single riskiest file in its layer.

Everything else is feature work, and the feature surface is already broad.

---

## Module plan

Nine modules. **R** = release-critical, **Q** = quality, **F** = feature.
Each lists exit criteria that are checkable, not vibes.

---

### M1 — Release hardening (R) · effort M · no dependencies

The gap between "it builds" and "a stranger can install it".

| # | Task | Files |
|---|---|---|
| 1.1 | Code-sign Windows builds. Acquire an OV/EV cert; wire `win.certificateFile`/`certificatePassword` (or Azure Trusted Signing) into `electron-builder.yml`; keep the secret out of the repo. Unsigned installers trip SmartScreen for every first-time user. | `electron-builder.yml`, CI secrets |
| 1.2 | ~~Round-trip the updater for real.~~ **DONE 2026-08-05** — 0.7.0 → 1.0.2 against the live `v1.0.2` release: detected, downloaded, sha512 verified, NSIS installed, relaunched on 1.0.2, re-check reports up-to-date. Evidence in `docs/RELEASE_VERIFICATION.md` § "Live result". Differential download and signature verification remain unexercised (the latter blocked on 1.1). | `updater.ts`, GitHub Releases |
| 1.3 | `CHANGELOG.md` + a release script that bumps version, tags, and builds in one step — the 0.6.0-in-git / 0.7.0-in-dist drift found today was a manual-bump artifact. | new `scripts/release.mjs`, `CHANGELOG.md` |
| 1.4 | CI packaging job: run `dist:win:dir` on windows-latest per PR so packaging breaks are caught at PR time, not release time. | `.github/workflows/ci.yml` |
| 1.5 | Ship a crash-report surface — `crashlog.ts` writes but nothing reads it back to the user. | `crashlog.ts`, `SettingsPanel.tsx` |

**Exit:** a **signed** installer on a clean VM installs, launches, and auto-updates to
the next patch release without a manual download. The unsigned half of this was proven
on 2026-08-05 (0.7.0 → 1.0.2, see 1.2); only the signing requirement is outstanding,
blocked on 1.1.

---

### M2 — Test pyramid (R) · effort L · unblocks safe refactoring everywhere

Nothing in M3/M4 should land before this module is at least half done —
refactoring `ipc.ts` at 5.8% branch coverage is how a working app breaks.

| # | Task | Target |
|---|---|---|
| 2.1 | Playwright + `@playwright/test` against the built Electron app. 8–12 smoke scenarios: launch, create session, send prompt (mock provider), open file, edit + save, git status, terminal spawn, quit-with-no-orphans. | new `e2e/` |
| 2.2 | Component tests via React Testing Library on the five densest components: `CommandPalette`, `Composer`, `MessageView`, `ToolCall`, `ChangesPanel`. | `src/renderer/src/components/__tests__/` |
| 2.3 | ~~IPC-boundary integration tests.~~ **DONE 2026-08-05** — all 71 registered channels driven through a stub `ipcMain` by 290 tests in 7 files. `ipc.ts` 5.76% → 74.89% branch, 21.27% → 90.9% statements. Harness `ipcHarness.ts`; findings in `docs/plans/m2.3-ipc-boundary/SPEC.md`. | `src/main/__tests__/ipc.*.test.ts` |
| 2.4 | Cover the zero-coverage lifecycle files: `server.ts` spawn/probe/reap (incl. the Windows `taskkill /T /F` path at `server.ts:197`), `tray.ts`, `menu.ts`, `quickEntry.ts`. | `src/main/__tests__/` |
| 2.5 | Slice coverage for the <20% offenders: `eventSlice` (0.43%), `compareSlice` (0.68%), `routingSlice` (2.08%), `uiSlice` (3.44%), `projectsSlice` (4%), `imagesSlice` (6.89%), `sessionSlice` (17.58%). | `lib/__tests__/` |
| 2.6 | CI coverage gate at 65%, ratcheting. | `vitest.config.ts`, `ci.yml` |

**Exit:** overall coverage ≥65%, no main-process file at 0%, E2E green in CI on
windows-latest.

---

### M3 — Main-process decomposition (Q) · effort M · **after M2.3/M2.4**

| # | Task |
|---|---|
| 3.1 | Split `ipc.ts` (1240 lines) by domain: `ipc/nanogpt.ts`, `ipc/live.ts`, `ipc/projects.ts`, `ipc/mcp.ts`, `ipc/search.ts`. Handlers become thin; logic moves to the services that already exist. Keep `registerIpc`/`unregisterIpc` idempotence (`ipc.ts:417`, `1237`). |
| 3.2 | Split `server.ts` (549): event loop (`runEventLoop`, 272-311), binary resolution + spawn (138-213), status/listener registry (100-127) into three units. |
| 3.3 | Replace hand-rolled `requireString`/`requireObject` with zod schemas — one schema per channel, which also becomes the mechanical generator for `CONTRACTS.md` instead of the current drift-check script. |
| 3.4 | Extract the gitignore engine (`compileIgnorePattern`, `loadIgnoreRules`, `walk`) out of `fsService.ts` into a reusable module. |
| 3.5 | Add a timeout guard to the SDK `call()` wrapper (`ipc.ts:274-290`) — it currently relies entirely on the transport's own timeout. |
| 3.6 | Split `keys.ts` / `env.ts` along data-model / IO / validation lines. |

**Exit:** no file in `src/main` over 500 lines; every IPC channel has a schema;
contract check derives from schemas.

---

### M4 — Renderer quality (Q) · effort M

| # | Task | Cite |
|---|---|---|
| 4.1 | **Fix the keyboard collision.** `MentionMenu.tsx:66` registers a global capture-phase `keydown` listener that races `Chat.tsx:221` and double-handles Escape/Arrows against `Composer.tsx:147-193`. Real bug, cheap fix. | `MentionMenu.tsx:66` |
| 4.2 | Finish the shortcuts registry — `App.tsx:218` still carries `TODO(shortcuts registry)`; `lib/shortcuts.ts` is the intended source of truth but bindings are still ad-hoc. Add a collision assertion test. | `App.tsx`, `lib/shortcuts.ts` |
| 4.3 | Extract `useListNavigation(count, onSelect)` — arrow/enter/escape nav is triplicated across `CommandPalette.tsx:580`, `Composer.tsx:152`, `MentionMenu.tsx:51`. Also share the 150ms debounce (`CommandPalette.tsx:164`, `MentionMenu.tsx:16`). | 3 files |
| 4.4 | Extract `useMentionMenu()` out of `Composer.tsx` (548). | `Composer.tsx` |
| 4.5 | True virtualization in `Chat.tsx` — the step-60 window helps but still keeps every rendered message mounted. | `Chat.tsx` |
| 4.6 | Memoize `harnessPromptFields()` (`sessionSlice.ts:40-50`) — recomputed on every send. | `sessionSlice.ts` |
| 4.7 | Split `index.css` (~1900) and `messages.css` (~1462) per component. | CSS |
| 4.8 | A11y pass: `aria-label` on icon-only controls (ArtifactsPanel tabs/close), focus-trap audit for every modal, `prefers-reduced-motion`. | components |

**Exit:** 4.1 has a regression test; no component over 500 lines; a11y audit
documented with a checklist per modal.

---

### M5 — Agent safety & auditability (F) · effort L · the real differentiator

This is what separates a chat window from a harness you'd let touch a repo.

| # | Task |
|---|---|
| 5.1 | **Permission profiles** — read-only / workspace-write / full-auto presets, replacing per-call prompt fatigue. Profile is per-project, shown in `StatusBar`, enforced in main (not just UI). |
| 5.2 | **Checkpoint & rewind** — git-stash-backed snapshot before each agent run; one-click restore. The current undo story stops at per-message revert, which does not cover a bad 12-file edit. |
| 5.3 | **Run records** — structured per-run log (prompt, model, tool calls, diff stat, duration, cost) written to `userData/runs/`, browsable in a new panel. Answers "what did it change last Tuesday". |
| 5.4 | **Cost/token metering across all providers** — currently NanoGPT-only; surface per-session spend in `StatusBar.tsx`. |
| 5.5 | Dry-run mode: agent proposes the full plan and diff, applies nothing until accepted. |

**Exit:** an agent run on a dirty repo can be fully reverted in one action, and
its record survives an app restart.

---

### M6 — Code surface completion (F) · effort M

| # | Task |
|---|---|
| 6.1 | **Multi-file accept/apply in `ChangesPanel`** — the panel is read-only today while `HunkView` already has the accept/reject machinery. Highest-value single feature on this list. |
| 6.2 | `oc:git:status` / `oc:git:branches` should return null on a non-repo directory instead of throwing — currently spams `dev.err.log` with stacks for an entirely expected state. |
| 6.3 | Attachment size parity: OS file drops enforce `MAX_ATTACHMENT_BYTES`, internal tree drags do not (`FileNode` carries no size). |
| 6.4 | Syntax highlighting for artifact source (`ArtifactsPanel.tsx:134`) and bash tool calls (`ToolCall.tsx:364`). |
| 6.5 | Git push / branch switch / stash from `GitPanel` — deliberately omitted per `AGENTS.md`; revisit behind a permission profile (M5.1). |
| 6.6 | Search-and-replace across files, with preview. |

---

### M7 — Onboarding & discoverability (F) · effort M

| # | Task |
|---|---|
| 7.1 | First-run wizard: pick provider, enter key (reusing `ProviderPanel`), open or create a project, one guided prompt. Today's cold start is a blank slate. |
| 7.2 | Systematic empty / loading / error state pass across all panels — currently inconsistent panel to panel. |
| 7.3 | Persist UI state (panel sizes, active tab, expanded tree nodes) across restarts. |
| 7.4 | In-app command reference generated from the shortcuts registry (M4.2) rather than hand-maintained. |
| 7.5 | Project templates + per-project model preferences. |

---

### M8 — Supply chain & dependencies (R) · effort S · do this first, it's cheap

| # | Task |
|---|---|
| 8.1 | Clear 3 high findings — `brace-expansion` (DoS) and `undici` (request desync / info disclosure), both with fixes available; `dompurify` moderates come via `monaco-editor` and need its 0.53.0 bump. |
| 8.2 | `npm audit --audit-level=high` as a CI gate. |
| 8.3 | Bump `@opencode-ai/sdk` 1.18.4 → 1.18.13 (11 patches behind) — this is the core dependency. Then the other 16 outdated packages. |
| 8.4 | Dependabot or Renovate with a grouped weekly PR. |

**Exit:** `npm audit` clean at high, SDK current, CI blocks regressions.

---

### M9 — Cross-platform (F) · effort L · lowest priority, largest surface

Windows-first is a legitimate choice; this module only matters if macOS/Linux
users are actually a goal.

| # | Task |
|---|---|
| 9.1 | Audit the `.cmd`/`taskkill`/DPAPI assumptions — `server.ts:168-213` branches on Windows, `keys.ts` depends on `safeStorage` backends that differ per OS. |
| 9.2 | macOS target + notarization; Linux AppImage/deb. |
| 9.3 | CI build matrix across all three. |
| 9.4 | Finish the half-wired mac branches in `menu.ts` / `tray.ts`. |

---

## Sequencing

```
Now        M8 (supply chain, S)  →  cheap, unblocks nothing but removes risk
Wave 1     M1 (release)  ∥  M2 (tests)          ← both R, run in parallel
Wave 2     M4.1/4.2 (keyboard bug + registry)   ← ship independently, small
Wave 3     M3 (main split)  after M2.3/M2.4 land
           M6 (code surface)  ∥  M5 (agent safety)
Wave 4     M7 (onboarding)
Later      M9 (cross-platform)
```

Rationale: M8 is hours of work against 3 high-severity findings. M1 and M2 are
the two things standing between "works on my machine" and "shippable" — neither
depends on the other. M3 is a refactor and refactors without tests are how a
working app regresses, so it waits on M2. M5 is the highest-value feature work
but also the largest, and it wants the permission plumbing to be well-tested
first.

## Highest-value single items, if only three get done

1. **M8.1–8.3** — 3 high-severity vulns and an 11-patch-behind core SDK. Hours, not days.
2. **M2.1 + M2.3** — E2E smoke plus IPC-boundary tests. Turns 5.8% branch coverage on the entire attack surface into something defensible.
3. **M6.1** — multi-file accept/apply. The one missing piece that makes the review workflow whole.
