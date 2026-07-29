# ADR 0001: Inject BYOK keys into the child process env instead of `auth.set`

- Status: Accepted
- Date: 2026-07-28

## Context

OpenCode's SDK offers `auth.set`, which stores a provider key by persisting it
to OpenCode's own `auth.json` — in plaintext, on disk, owned by the CLI rather
than by this app. The app also needs keys to reach `opencode serve` some other
way when the user adds them through the Providers UI.

OpenCode's providers resolve credentials from process environment variables
(`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, …). The desktop app
already spawns and supervises the `opencode serve` child
(`src/main/server.ts:doStart`), so it fully controls that child's environment.

## Decision

Store keys under OS encryption (see ADR 0002) and inject them into the child
process environment at spawn time. Never call `auth.set`; never write
`auth.json`.

Concretely:

- `src/main/keys.ts:loadByokEnv()` decrypts stored keys into
  `{ ENV_VAR: plaintext }` at spawn time and nothing else.
- `src/main/server.ts` merges them over the `.env`-file vars
  (`{ ...providerEnv.vars, ...byokVars }` — BYOK wins on conflict) and passes
  the result to `buildChildEnv()`.
- `src/main/env.ts:buildChildEnv()` is allow-list based: only a fixed set of
  OS runtime variables (`PATH`, `APPDATA`, `SYSTEMROOT`, …) plus the explicit
  provider vars reach the child. It is not a deny-list — the full desktop
  environment is not forwarded.
- `src/main/env.ts:ALLOWLIST` gates which variable names may carry secrets at
  all; `ALIASES` expands names OpenCode expects differently (e.g.
  `GEMINI_API_KEY` also sets `GOOGLE_GENERATIVE_AI_API_KEY` and
  `GOOGLE_API_KEY`).

## Consequences

Positive:

- The only at-rest copy of a key lives under OS encryption
  (`userData/byok-keys.json`); no plaintext key file exists anywhere on disk.
- No `auth.json` to gitignore, leak, sync, or end up in a backup.
- A deleted key disappears from the next server spawn — revocation is just
  "restart the child", no second store to keep in sync.
- The allow-list in `buildChildEnv` doubles as a boundary against unrelated
  secrets: the user's `.env` may contain crypto-exchange credentials, and the
  `BLOCKLIST` in `env.ts` plus the `ALLOWLIST` keep them out of the child even
  though the child could otherwise leak them into prompts, tools, and
  extensions.
- The embedded terminal (`src/main/terminal.ts`) reuses the same
  `buildChildEnv` mechanism but is called with empty provider vars
  (`buildChildEnv({})`), so PTY processes get the OS runtime variables and
  never the decrypted BYOK keys.

Negative:

- Keys exist in plaintext in the child process's memory and environment —
  readable by anything that can inspect the process (this is inherent to
  env-var providers; OpenCode itself reads them from env).
- Keys only take effect at spawn. Adding or removing a key requires a server
  restart to reach the child.
- Env injection bypasses OpenCode's `auth.json`-based provider detection, so
  the app maintains its own notion of "which providers are authorized"
  (`linkedProviderIDs` in `env.ts`, `authorizedProviderIDs` in `server.ts`)
  instead of trusting OpenCode's provider list.

## Alternatives considered

- **`auth.set` / `auth.json`.** Rejected: persists the raw key in plaintext to
  a file the app does not own, outside the OS-encrypted store, and creates a
  second copy to revoke.
- **Writing keys into `opencode.json` config.** Rejected for the same reason —
  plaintext on disk. The one config the app does inject
  (`OPENCODE_CONFIG_CONTENT` for the NanoGPT custom provider, see
  `src/main/nanogptConfig.ts`) carries only the `{env:NANOGPT_API_KEY}`
  placeholder, never a key value.
