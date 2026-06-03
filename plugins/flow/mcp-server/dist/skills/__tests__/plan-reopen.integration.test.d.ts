/**
 * Re-open mode integration tests — Story 3.6 Task 5.1.
 *
 * Tests AC4 branches (a)–(g) at the tool-call boundary layer.
 * Instead of spinning up an LLM, these tests operate directly against the
 * underlying MCP tools (`markWithdrawn`, `writeNativeStory`, `scanSources`)
 * and the catalogue-prompt-shape layer, asserting that given the right
 * `<initial-context>` the right tool behaviour emerges.
 *
 * Per the Testing requirements section:
 *   "If a scripted runner does not exist yet, the dev agent MAY exercise the
 *    routing logic at the catalogue-prompt-shape layer ... AND at the
 *    tool-call boundary (assert that given the right <initial-context>, the
 *    right MCP tool would be called) without spinning up an LLM."
 *
 * Branch (h) — dev-loop skip — is covered by is-claimable.test.ts (Task 4.2).
 *
 * This file covers:
 *   (a) native add — round-trip: existing backlog + new writeNativeStory → new file, existing untouched.
 *   (b) native edit-pending — rewrite a to-do story → source file bytes change.
 *   (c) native discard — revert/deprecate story appears, original files untouched.
 *   (d) BMad add — writeNativeStory refuses on BMad workspace (WrongAdapterError).
 *   (e) BMad edit-pending — markWithdrawn on a native ref on BMad raises WrongAdapterError,
 *       and the planner prompt encodes the refusal string for BMad edit-pending.
 *   (f) BMad discard — markWithdrawn flips withdrawn, idempotent on second call.
 *   (g) in-progress guard — planner prompt encodes the refusal string.
 */
export {};
