# ADR 0003: The main process owns all HTTP and the single SSE subscription

- Status: Accepted
- Date: 2026-07-28

## Context

The engine is `opencode serve`, an HTTP/SSE server bound to `127.0.0.1`
(port 4599 and up). The renderer is a sandboxed Electron web page that, in a
packaged build, loads from `file://` — direct HTTP from the renderer would hit
CORS, bypass the preload boundary, and spread SDK knowledge across two
processes.

## Decision

The main process holds the only `@opencode-ai/sdk` client and the only SSE
subscription. The renderer never speaks HTTP and never imports SDK runtime
code — only `import type { ... } from '@opencode-ai/sdk'`. All backend traffic
goes through the single `contextBridge` API (`window.api`) defined in
`src/preload/index.ts`.

Concretely:

- `src/main/server.ts` spawns/supervises the child, creates the client
  (`createOpencodeClient`), and runs one event loop (`runEventLoop`) with
  500ms→10s backoff reconnect. It is the only place `event.subscribe` is
  called.
- Every SSE event main receives is rebroadcast **verbatim** on the `oc:event`
  channel (`src/main/index.ts` fans `onEvent` out to the renderer). Main does
  not interpret, filter, or enrich events.
- The renderer folds events into zustand UI state through a single reducer —
  `applyEvent` in `src/renderer/src/lib/slices/eventSlice.ts`. One event
  stream, one reducer.
- Every renderer→main call is an invoke channel named in CONTRACTS.md,
  registered in `src/main/ipc.ts`, which unwraps the SDK's `{ data, error }`
  shape and throws a readable `Error` on failure.
- The SDK is externalized from the main bundle (`electron.vite.config.ts` —
  `mainExternals`); it ships from `node_modules` and is never bundled, and it
  is absent from the renderer bundle entirely.
- Status has two independent bits: `running` (HTTP answers) and
  `streamConnected` (SSE subscription live), so the UI can distinguish
  "server up, stream reconnecting" from "server down" (see
  `ServerStatus` in `src/main/server.ts`).

## Consequences

Positive:

- **One reconnect point.** Backoff, abort, and stream scoping
  (`setEventDirectory`) live in one loop; there is no renderer-side retry
  logic to keep in sync.
- **No CORS, no credentials in the renderer.** The renderer needs no
  network access to function, which keeps the production CSP at
  `connect-src 'self'` with no remote origins (the `prod-csp` plugin in
  `electron.vite.config.ts`).
- **Testability.** Main services are unit-tested with mocked
  fs/child_process/electron seams (`src/main/__tests__/`); the renderer's
  event handling is tested as a pure reducer over event fixtures. No HTTP
  mock layer is needed on either side.
- The renderer bundle stays free of Node-oriented SDK code and its dynamic
  requires.

Negative:

- Every SDK call must be surfaced as an explicit IPC channel, so the
  `window.api` surface grows with OpenCode features and CONTRACTS.md must be
  updated first for each addition.
- All events cross the IPC boundary even when only one panel cares — the
  verbatim rebroadcast trades bandwidth for simplicity (no subscription
  filtering).
- A bug in the single event loop stalls every view at once; there is no
  per-view fallback path by design.

## Alternatives considered

- **Renderer speaks HTTP directly to `127.0.0.1:4599`.** Rejected: CORS on
  `file://`, a remote origin in the CSP, SDK runtime in the renderer bundle,
  and two processes each managing reconnect state.
- **Multiple SDK clients / per-view subscriptions.** Rejected: N reconnect
  loops, N backoff policies, and event-ordering races between views.
- **Main pre-digests events into per-slice messages.** Rejected: it would
  duplicate the renderer's state model in main and couple the two codebases;
  verbatim rebroadcast plus one reducer keeps the contract thin.
