# `/flow:ask` ask-mode enforcement — `_meta.role` propagation record

_Contributor artefact. Story 2.8 AC2, AC5. See `plugins/flow/docs/user-surface-acs.md` for the user-surface rubric._

## Question

Does Claude Code's `Task` tool propagate `_meta.role` from the spawning skill's
`Task` invocation through to the spawned subagent's MCP `CallTool` requests?
Specifically: when Story 2.7's `/flow:ask` Step 5 calls `Task` with
`_meta.role: "ask-mode"`, does the resulting `CallTool` request reach the MCP
server's `CallToolRequestSchema` handler (`server.ts` lines 116–150) with
`params._meta.role === "ask-mode"`?

## Investigation method

Two investigation paths were attempted, in order of cost:

1. **Operator-paste-evidence path (Task 4.1):** A live Claude Code session is
   required to observe whether the spawned subagent's MCP calls carry `_meta.role`.
   The dev agent implementing this story operates inside a bmad-dev-story subagent
   context that cannot drive a real Claude Code TUI session. No operator-paste
   evidence was therefore obtainable within story scope.

2. **Claude Code documentation check (Task 4.2):** Claude Code's public
   documentation does not provide a definitive statement on whether the `Task`
   tool propagates `_meta` fields through to the spawned subagent's MCP
   `CallTool` requests. The MCP spec (v1) defines `_meta` as a pass-through
   field on `CallToolRequest`, but whether Claude Code's `Task` invocation
   carries the calling skill's `_meta` context to the subagent's outbound
   calls is an implementation detail not covered in the available docs.

## Answer

**`unknown-but-belt-and-braces`**: propagation status could not be empirically
confirmed within story scope. As defence-in-depth, a code-level fallback has
been implemented: the `/flow:ask` skill body's Step 5 is updated to pass
`allowed_tools` to the `Task` invocation (option (a) from the spec's Task 4
decision rubric). The `allowed_tools` array is assembled at runtime from
`permissions/ask-mode.yaml` by the `assembleAskModeAllowedTools()` helper
(`mcp-server/src/lib/ask-mode-allowed-tools.ts`). This constrains the spawned
subagent's tool surface at the Claude Code layer — independently of whether
`_meta.role` propagates through `Task` to the MCP server.

If future operator-paste evidence or Claude Code changelog confirms that `Task`
DOES propagate `_meta.role`, the fallback is redundant-but-harmless (the
`allowed_tools` set is a strict subset of the spawned session's tool surface
during ask mode; defence-in-depth adds no functional risk).

## Verification artefact

The vitest harness at `plugins/flow/mcp-server/tests/ask-mode-enforcement.test.ts`
(Story 2.8 AC6) proves the chosen enforcement path:

- **AC6(a):** A `CallTool` request with `params._meta.role === "ask-mode"` against
  `instantiatePersona` is refused with `PermissionDeniedError` — proving the
  existing Story 1.4 boundary fires when `_meta.role` IS present.
- **AC6(b):** A `CallTool` request with `_meta` omitted is NOT refused — proving the
  contrapositive: if `Task` strips `_meta`, the subagent's calls are unconstrained
  at the MCP layer, which motivates the `allowed_tools` fallback.
- **AC6(c):** `assembleAskModeAllowedTools()` returns the read-only tool set from
  `permissions/ask-mode.yaml` plus `"Read"`, matching `ASK_MODE_TASK_ALLOWED_TOOLS`.
  No mutator name (`instantiatePersona`, etc.) appears in the returned array.
- **AC6(d–h):** worktree-smoke script exit-code matrix, doc/script parity,
  enforcement doc shape, tool registration, and ask-mode.yaml stability.

Run `pnpm --dir plugins/flow/mcp-server test` to execute the full suite.

## Implications for future stories

A future `(user-surface)` story that needs a similar non-mutating side-session
should cross-reference this file and reuse the `assembleAskModeAllowedTools()`
pattern: read `permissions/<role-name>.yaml`, pass the resulting array as
`allowed_tools` to the `Task` invocation, and add `"Read"` if the subagent
needs to read files. If a future Claude Code release documents `Task`'s `_meta`
propagation semantics definitively, update the `## Answer` section here to
`confirmed-propagating` or `confirmed-not-propagating` accordingly; the
`allowed_tools` fallback can then be removed from the skill body if it is
confirmed-propagating, or hardened further if confirmed-not-propagating.
