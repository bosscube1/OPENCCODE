/**
 * Shared per-request tool policies for `oc:prompt`. PURE — no store, no React, no IPC.
 */

/**
 * Tools disabled when a session (or a compare column) must not mutate the working tree.
 *
 * THIS IS A SAFETY INVARIANT, not a preference. Compare runs fan N columns out against the SAME
 * working tree concurrently; if they could write, edit, patch or shell out they would race and
 * corrupt the user's repository. The same policy backs the composer's per-session read-only
 * toggle. `promptAsync`'s `tools` map (verified present in the SDK's `SessionPromptAsyncData.body`)
 * disables them per request, so no config change is needed and normal chat is unaffected.
 *
 * Reads still work — that is what makes read-only sessions useful. A true agentic bake-off would
 * need one git worktree per column — deliberately out of scope.
 */
export const READONLY_TOOLS: Readonly<Record<string, boolean>> = Object.freeze({
  write: false,
  edit: false,
  patch: false,
  bash: false,
  task: false
})
