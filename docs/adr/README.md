# Architecture Decision Records

Decisions already made and binding. New ADRs get the next number, the same
format (Status / Context / Decision / Consequences / Alternatives considered),
and an entry here.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-env-injection-vs-auth-set.md) | Inject BYOK keys into the `opencode serve` child env at spawn; never `auth.set` / `auth.json` | Accepted |
| [0002](0002-keystorage-safeStorage.md) | Key custody via Electron `safeStorage` in `src/main/keys.ts` only; masked-only over IPC; fail closed on write | Accepted |
| [0003](0003-main-owns-http.md) | Main holds the only SDK client and SSE subscription; renderer speaks IPC only, events rebroadcast verbatim on `oc:event` | Accepted |
| [0004](0004-windows-first.md) | Windows-first: `.cmd` spawn, `taskkill /T /F`, DPAPI; POSIX kept compiling in CI but not verified | Accepted |

Related: `CONTRACTS.md` (binding interface spec), `AGENTS.md` (architecture
invariants), `docs/history/CONTINUATION.md` (session handoffs).
