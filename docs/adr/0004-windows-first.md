# ADR 0004: Windows-first platform stance

- Status: Accepted
- Date: 2026-07-28

## Context

The app is developed on and primarily shipped for Windows (x64 NSIS +
portable targets in `electron-builder.yml`). Several subsystems have
genuinely platform-specific behavior: process spawning, process-tree
termination, secret storage, shell selection, and window chrome. A claim of
full cross-platform parity would be untested and misleading.

## Decision

Windows is the primary target and the reference implementation. Where the
platforms diverge, the Windows path is the one that is designed first and
verified against the running app. POSIX is kept compiling and passing CI
(which runs on `ubuntu-latest` and `windows-latest`), but no macOS or Linux
behavior is guaranteed beyond that.

The Windows-specific mechanisms this commits to:

- **`.cmd` spawn.** `resolveBinary` in `src/main/server.ts` looks for
  `%APPDATA%\npm\opencode.cmd` first, then PATH. Because Node refuses to
  spawn `.cmd`/`.bat` directly (CVE-2024-27980) and `shell: true` is
  forbidden, `buildCommand` routes the launcher through `cmd.exe /d /s /c`
  with verbatim, self-quoted arguments — never renderer-supplied strings.
- **Process-tree kill.** A `.cmd` launcher spawns a real process tree, so
  shutdown is `taskkill /pid <pid> /T /F` (`killTree` in
  `src/main/server.ts`); the POSIX fallback is a plain `SIGTERM`.
- **DPAPI key storage.** `safeStorage` resolves to DPAPI on Windows — the
  custody model in ADR 0002 is designed around it; Keychain/libsecret are
  the same API on other platforms but only DPAPI behavior is verified.
- **Shell default.** Embedded terminals default to `powershell.exe`
  (`src/main/terminal.ts`), with `$SHELL`/`/bin/bash` only as the POSIX path.
- Platform branches elsewhere (`isMac` in `src/main/menu.ts`,
  `src/main/tray.ts`, the `darwin` check in `src/main/index.ts`) exist to
  keep the app from misbehaving on other OSes; they are **not** a commitment
  to macOS/Linux feature parity.

## Consequences

Positive:

- One well-tested process/env/storage stack instead of three shallow ones.
- Security-sensitive code (spawn quoting, tree kill, key custody) is
  exercised daily on the platform most users run.
- CI still catches POSIX compile breaks and pure-logic regressions, since
  unit tests run on both `windows-latest` and `ubuntu-latest`.

Negative:

- macOS/Linux users get an app that builds and passes tests but is not
  smoke-tested on their platform; real bugs there will be found by users,
  not by us.
- POSIX fallbacks (SIGTERM kill, `$SHELL` detection) are code-reviewed but
  not driven end-to-end.
- Any future macOS/Linux commitment requires real verification work —
  notarized packaging, Keychain/libsecret testing, menu/tray behavior —
  and would be a separate decision superseding this one.

## Alternatives considered

- **Full cross-platform parity from day one.** Rejected: triples the
  verification surface (spawn, kill, storage, packaging, updater) for a user
  base that is currently Windows.
- **Windows-only, deleting POSIX branches.** Rejected: the branches are
  small, keep CI honest, and cost little to carry — the decision is about
  where verification effort goes, not about forbidding other platforms.
