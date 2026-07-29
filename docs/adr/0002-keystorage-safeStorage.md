# ADR 0002: Key custody via Electron `safeStorage`, single module, masked-only IPC

- Status: Accepted
- Date: 2026-07-28

## Context

The app needs to persist user-supplied provider API keys across restarts.
Whatever stores them must survive app updates, must not be readable by other
unprivileged processes on the machine, and must never expose the plaintext to
the sandboxed renderer. The renderer is hardened (`contextIsolation: true`,
`nodeIntegration: false`, CSP), so anything it can read over IPC is
effectively untrusted-adjacent and must be treated as potentially disclosed.

## Decision

All key custody goes through Electron `safeStorage` — DPAPI on Windows,
Keychain on macOS, libsecret on Linux — and exactly one module touches it:
`src/main/keys.ts`.

Concretely:

- Keys are encrypted with `safeStorage.encryptString` and persisted as base64
  in `userData/byok-keys.json` (mode `0o600`); the file holds ciphertext only.
  MCP connector secrets use the same scheme in `userData/mcp-secrets.json`.
- **Single module.** Only `keys.ts` imports `safeStorage`. No other main
  module — and nothing in the renderer — encrypts or decrypts keys.
- **Fail closed on write.** `setKey` / `setMcpSecrets` throw when
  `safeStorage.isEncryptionAvailable()` is false. Plaintext is never persisted
  as a fallback.
- **Degrade gracefully on read.** `loadByokEnv()` skips undecryptable keys so
  a broken keychain does not block server startup.
- **Masked-only over IPC.** `listKeys()` returns `{ providerID, envVar,
  maskedTail }` rows — the last 4 characters, decrypted transiently in main
  and discarded. The full key never crosses the bridge; `src/preload/index.ts`
  exposes only the masked `KeyRow` shape. Plaintext is never written to logs,
  error messages, or the crash log; errors reference only the providerID /
  envVar (see the invariants block in `keys.ts`).
- Decrypted plaintext exists only transiently in main, at child-spawn time
  (ADR 0001) and during `testKey` / Gemini Live token minting.

## Consequences

Positive:

- Keys are protected at rest by the OS account's own credential store —
  no master password to manage, no key-derivation code to get wrong.
- One audit point: reviewing key handling means reviewing one file.
- The renderer can display "key stored, ends in …ab12" without ever being
  able to exfiltrate the key, which keeps the sandbox boundary meaningful.
- Write fails closed: a downgraded environment (no keychain) yields an error,
  not a plaintext file.

Negative:

- `safeStorage` strength varies by platform. On Linux it depends on an
  available libsecret service; on Windows, DPAPI protects per-user, so another
  process running as the same user can decrypt. This is the accepted
  desktop-app baseline, not a vault.
- The store is tied to the OS account — keys do not roam between machines or
  users, and a lost keychain means re-entering keys.
- Single-module custody concentrates risk: a future change to `keys.ts` is a
  security-sensitive change and must be reviewed as such.

## Alternatives considered

- **Plaintext file in `userData` (gitignored).** Rejected: any process running
  as the user — including the agent sessions this app exists to run — could
  read it.
- **Rolling our own encryption with an app-managed passphrase.** Rejected: adds
  a master-password UX and key-derivation code for no gain over the OS store.
- **Deferring to OpenCode's `auth.json`.** Rejected — see ADR 0001.
