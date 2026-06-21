# Story 3.3b: Adapter config seam — move `configureBmadAdapter` into `resolveWorkspace`

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **adapter-specific context (e.g. BMad's `stories_root`) bound at workspace-resolution time rather than opportunistically inside each tool**,
so that **every caller of `resolveWorkspace` gets a fully wired adapter without having to know the adapter's name or call its `configure` helper themselves.**

### What this story is, in one sentence

Move the existing `if (activeAdapterName === "bmad") { configureBmadAdapter({ targetRepo, storiesRoot }) }` block out of `scanSources()` and into `resolveWorkspace()`, so that any tool which calls `resolveWorkspace` (today: `scan-sources`, `get-status`; tomorrow: every new tool) receives a workspace whose `activeAdapter` is already bound to its per-invocation context — and `scanSources` (and any other tool body) can stop knowing or caring about per-adapter `configure` helpers.

### What this story fixes (and why it needs its own story)

Story 3.3 (BMad adapter v1) landed `configureBmadAdapter` as a per-process mutable context setter and noted in its module comment that "the runtime sets this via `getActiveAdapter()` (Story 3.1)". In practice, Story 3.1 never wired that — it left the adapter context unbound, and Story 3.2 worked around the gap by calling `configureBmadAdapter` inside `scanSources()` itself. That workaround is duplicated logic waiting to happen: the *next* tool that calls `resolveWorkspace` and then invokes an adapter method (e.g. `get-status` if/when it starts calling `listSourceStories`, or any 4.x dev-loop tool) will trip the "BmadAdapter has no bound context" error unless its author remembers to paste the same `if` block. This story moves the binding to the single resolution point so the rest of the codebase can stop carrying that knowledge.

### This story does NOT

- (a) Touch `sprint-status.yaml` or any other status/state file — the orchestrator owns status transitions.
- (b) Change the `PlanningAdapter` interface (Story 3.1) or the `SourceStory` shape — the contract is unchanged.
- (c) Add a new `configure` method to `PlanningAdapter`. The seam stays adapter-local: `configureBmadAdapter` remains a named export of `adapters/bmad/index.ts` and `resolveWorkspace` performs a narrow dispatch on `activeAdapterName === "bmad"`. Generalising to a `PlanningAdapter.configure?(...)` hook is a future-adapter concern (called out as a known follow-up in Dev Notes), not part of this story.
- (d) Modify `scanSources`' externally observable behaviour. Inputs, return shape, idempotency semantics, hash-refresh semantics, and skipped-ref semantics are all preserved bit-for-bit.
- (e) Modify `get-status` or any other current `resolveWorkspace` caller — they continue to work; AC3 only asserts that they *would* work without their own `configure` call.
- (f) Touch the BMad adapter's parsing, status mapping, fixture suite, or any of its existing tests beyond the new focused assertion in AC5.
- (g) Re-locate, rename, or remove `configureBmadAdapter` / `resetBmadAdapter` from `adapters/bmad/index.ts`. They stay exported (the BMad adapter's own tests call them directly; that contract is preserved).
- (h) Introduce caching of the resolved workspace. `resolveWorkspace` remains pure-per-call; binding the adapter context on every call is intentional and cheap.
- (i) Add a new MCP tool or modify any tool registration.
- (j) Add or modify any slash command, README, install doc, or TUI surface. This is internal plumbing; no user-facing surface changes.

---

## Acceptance Criteria

> **Verbatim from epic.** The five ACs below match `_bmad-output/planning-artifacts/epics/epic-3-backlog-layer-planning-adapters-story-manifests-and-the-planning-conversation.md` § Story 3.3b exactly. Every AC governs an internal TypeScript function (`resolveWorkspace`, `configureBmadAdapter`, `scanSources`), an internal import statement, an internal `Workspace` invariant, a hard-coded default literal, or vitest coverage against fixtures. None of the ACs names a slash command, a CLI literal the operator types verbatim, a README-named install path, or a Claude Code UI element. They are therefore **all untagged** per `plugins/crew/docs/user-surface-acs.md`. (This story is `story_shape: substrate` — pure refactor seam, no user-facing surface.)

**AC1:**
**Given** `resolveWorkspace` in `mcp-server/src/state/workspace-resolver.ts`,
**When** it returns a `Workspace`,
**Then** any adapter-specific context binding (currently the `configureBmadAdapter({ targetRepo, storiesRoot })` call) has already been performed, using `targetRepoRoot` and the resolved `adapterConfig`.
<!-- Not user-surface: AC1 governs the internal `resolveWorkspace` function and the internal `Workspace` invariant. No slash command, no CLI literal, no copy-by-name path, no UI element. -->

**AC2:**
**Given** `scan-sources.ts`,
**When** I inspect the body of `scanSources()`,
**Then** the `if (activeAdapterName === "bmad") { configureBmadAdapter(...) }` block is gone and the `configureBmadAdapter` import is removed; the tool relies on `resolveWorkspace` having wired the adapter.
<!-- Not user-surface: AC2 governs an internal source file's import list and function body. -->

**AC3:**
**Given** any other current or future tool that calls `resolveWorkspace` (e.g. `get-status.ts`),
**When** it subsequently invokes adapter methods,
**Then** it does not need to call `configureBmadAdapter` (or any per-adapter `configure` helper) itself.
<!-- Not user-surface: AC3 governs an internal invariant of the resolution seam. It is satisfied structurally — see Task 4 — without modifying `get-status.ts`. -->

**AC4:**
**Given** the BMad adapter's default `stories_root` fallback (`"_bmad-output/planning-artifacts/stories"`),
**When** `adapterConfig.stories_root` is absent,
**Then** `resolveWorkspace` applies the same default that `scan-sources` applied previously, so behaviour is unchanged.
<!-- Not user-surface: AC4 governs a hard-coded default string literal and behavioural equivalence to the prior implementation. -->

**AC5 (integration):**
the existing vitest suite for `scan-sources` (and any workspace-resolver tests) passes unchanged; a focused test asserts that calling `resolveWorkspace` against a BMad-shaped fixture leaves `BmadAdapter` in a bound state (calling `listSourceStories()` does not throw the "no bound context" error).

---

## Tasks / Subtasks

- [ ] **Task 1 — Move the binding into `resolveWorkspace` (AC: 1, 4)**
  - [ ] 1.1 Open `plugins/crew/mcp-server/src/state/workspace-resolver.ts`.
  - [ ] 1.2 Add an import: `import { configureBmadAdapter } from "../adapters/bmad/index.js";`. Place it alongside the existing adapter-registry import.
  - [ ] 1.3 At the **end** of `resolveWorkspace()` — after the `Workspace` object is fully assembled (after the `pluginSettings` parse, immediately before the `return`) — add a narrow dispatch:
    ```
    if (activeAdapter.name === "bmad") {
      const bmadConfig = adapterParsed.data as { stories_root?: string };
      configureBmadAdapter({
        targetRepo: targetRepoRoot,
        storiesRoot:
          bmadConfig.stories_root ?? "_bmad-output/planning-artifacts/stories",
      });
    }
    ```
    The default literal `"_bmad-output/planning-artifacts/stories"` MUST be identical (byte-for-byte) to the one previously embedded in `scan-sources.ts` line 181 — that equivalence is what AC4 demands.
  - [ ] 1.4 The dispatch runs on **every** `resolveWorkspace` call. Do not cache. Do not gate on "context already bound". Binding is cheap (a single object assignment + index invalidation inside `configureBmadAdapter`) and idempotent; double-binding is safe (the adapter resets its lazy `refIndex` on each call, which is the same behaviour as today's repeat-`configureBmadAdapter` pattern in tests).
  - [ ] 1.5 The `adapterConfigSchema` for BMad (`z.object({ stories_root: z.string() })` in `adapters/bmad/index.ts`) currently makes `stories_root` **required**, not optional. That means `bmadConfig.stories_root` will be a string at runtime and the `?? "_bmad-output/..."` fallback is **defensive** — it never fires under the current schema. Keep the fallback anyway: it (a) preserves the literal AC4 demands; (b) survives a future loosening of the BMad schema to `stories_root: z.string().optional()` without behavioural drift; (c) documents intent. Do not change the BMad schema as part of this story.
  - [ ] 1.6 Add a TSDoc comment on the dispatch block explaining: "Per-adapter context binding. Today only BMad needs this; future adapters should add their own narrow branch here (or graduate to a `PlanningAdapter.configure?(workspace)` hook — see Dev Notes)."

- [ ] **Task 2 — Strip the binding out of `scanSources` (AC: 2)**
  - [ ] 2.1 Open `plugins/crew/mcp-server/src/tools/scan-sources.ts`.
  - [ ] 2.2 Remove the entire `if (activeAdapterName === "bmad") { ... }` block (currently lines 170–183, including the comment header at lines 170–176). Replace nothing — `resolveWorkspace` now owns this.
  - [ ] 2.3 Remove the import at line 5: `import { configureBmadAdapter } from "../adapters/bmad/index.js";`. After this story, `scan-sources.ts` MUST NOT contain the string `configureBmadAdapter` anywhere. Verify with `grep -n configureBmadAdapter plugins/crew/mcp-server/src/tools/scan-sources.ts` → expect zero matches.
  - [ ] 2.4 Update the surrounding comment block at the top of `scanSources()` to reflect the new contract: the comment that today reads "Configure adapter context before calling any adapter methods..." (lines 170–176) is deleted entirely; the dev loop now relies on `resolveWorkspace` having wired the adapter. Do NOT add a replacement comment in `scanSources()` — the contract belongs on `resolveWorkspace`, not on its callers. (The TSDoc on `Workspace.activeAdapter` is updated in Task 3 instead.)
  - [ ] 2.5 Confirm `scanSources()` still compiles. `activeAdapterName` and `adapterConfig` may now be referenced only by the `result.adapterName = activeAdapterName` line; that's fine — keep them in the destructure on line 168. Do not over-prune.

- [ ] **Task 3 — Document the invariant on `Workspace` (AC: 1, 3)**
  - [ ] 3.1 In `workspace-resolver.ts`, update the TSDoc on the `Workspace` interface's `activeAdapter` field (currently: "The registered `PlanningAdapter` instance for `activeAdapterName`.") to add a second sentence: "The adapter's per-invocation context (e.g. BMad's `(targetRepo, storiesRoot)` binding) has already been applied; callers may invoke adapter methods immediately without calling any `configure` helper."
  - [ ] 3.2 No other interface or schema changes. The exported shape of `Workspace` is unchanged; only the documented invariant strengthens.

- [ ] **Task 4 — Verify AC3 structurally (no code change to `get-status.ts`) (AC: 3)**
  - [ ] 4.1 `get-status.ts` already does not call `configureBmadAdapter` today (it doesn't currently call any adapter list/read/resolve method — it only inspects `workspace.activeAdapterName`). AC3 is therefore satisfied **by construction** once Task 1 lands: any future tool that calls `resolveWorkspace` and then an adapter method will get a bound adapter automatically.
  - [ ] 4.2 No edit to `get-status.ts` is required or desired. Confirm in the Dev Agent Record that the file was inspected and found to need no change. If during implementation the dev discovers a `resolveWorkspace` caller that DOES manually `configureBmadAdapter` today (other than `scan-sources`), strip that call in the same change — but the audit (Task 6) should confirm there is none.

- [ ] **Task 5 — Tests (AC: 5)**
  - [ ] 5.1 Open `plugins/crew/mcp-server/tests/workspace-resolver.test.ts`. Add a focused test inside the existing `describe("resolveWorkspace", () => { ... })` block. Name: `it("binds BmadAdapter context so listSourceStories() works without an explicit configureBmadAdapter call", ...)`.
  - [ ] 5.2 The test:
    1. Imports the real `BmadAdapter` from `../src/adapters/bmad/index.js` and `resetBmadAdapter` for cleanup.
    2. In `beforeEach` of this test (or via the existing fixture-setup pattern in this file), creates a tmp dir that looks like a BMad-shaped target repo: a `.crew/config.yaml` containing `adapter: bmad\nadapter_config:\n  stories_root: _bmad-output/planning-artifacts/stories\nplugin: {}\n`, and at least one valid BMad story file at `_bmad-output/planning-artifacts/stories/9-9-fixture-story.md` whose contents are enough for `parseBmadStory` to succeed (mirror an existing fixture from `tests/bmad-adapter.test.ts` if convenient).
    3. Calls `resetBmadAdapter()` to ensure the adapter starts unbound.
    4. Calls `await resolveWorkspace({ targetRepoRoot: tmp, adapters: [BmadAdapter] })`.
    5. Asserts `ws.activeAdapterName === "bmad"`.
    6. **Critical assertion:** calls `await ws.activeAdapter.listSourceStories()` and asserts it resolves to an array with length ≥ 1 (i.e. does NOT throw `"BmadAdapter has no bound context..."`). This is the load-bearing part of AC5: it proves binding happened inside `resolveWorkspace`.
    7. In `afterEach`, calls `resetBmadAdapter()` to leave global state clean for the next test.
  - [ ] 5.3 Add a second, smaller test asserting AC4 directly: `it("applies the default stories_root fallback when adapterConfig.stories_root is absent", ...)`. Because the current BMad `adapterConfigSchema` requires `stories_root`, this test cannot easily exercise the missing-field path without monkey-patching the schema. Instead, write the test as a **string-level assertion against the resolver source**: read `workspace-resolver.ts` from disk in the test, regex-match the literal `"_bmad-output/planning-artifacts/stories"`, and assert it appears exactly once. This is sufficient: the previous implementation in `scan-sources.ts` had the same literal, and the assertion proves byte-equivalence of the default. (If a future story makes `stories_root` optional, this assertion becomes a behavioural test trivially — that's deferred.)
  - [ ] 5.4 Re-run the **existing** `tests/scan-sources.test.ts` suite (no edits to it — AC5 demands "passes unchanged"). If any test in that suite fails after Tasks 1–2, the binding-move was incorrect; do not amend the scan-sources test to compensate. The most likely failure mode is a test that calls `scanSources()` against a target repo where `BmadAdapter` was previously bound by the old in-tool code and the test never called `resetBmadAdapter`. If a failure surfaces, root-cause it in `resolveWorkspace` (which now does the bind on every call); do not fix it by re-adding state mutation to `scanSources`.
  - [ ] 5.5 Run the **existing** `tests/bmad-adapter.test.ts` suite unchanged. Same rule: any failure is a Task-1 bug, not a license to edit BMad adapter tests.

- [ ] **Task 6 — Audit & build (AC: 1, 2, 3)**
  - [ ] 6.1 Run `grep -rn "configureBmadAdapter" plugins/crew/mcp-server/src/ --include="*.ts"`. Expected matches after this story:
    - `adapters/bmad/index.ts` — the export itself, the TSDoc reference, and the `requireContext()` error message. (Updating the error message's hint text is out of scope; leave it as today's `"Call configureBmadAdapter({ targetRepo, storiesRoot }) before invoking..."` — the error is still accurate for direct test callers and for any future adapter-internal code path that bypasses `resolveWorkspace`.)
    - `state/workspace-resolver.ts` — the new import and the new dispatch (added by Task 1).
    - Expected to be **absent**: any reference in `tools/scan-sources.ts` or any other file under `src/tools/`.
  - [ ] 6.2 Rebuild the TypeScript output: `cd plugins/crew/mcp-server && pnpm run build`. Per the project rule in `plugins/crew/docs/README-install.md` § Build artefacts, the resulting `plugins/crew/mcp-server/dist/` MUST be committed in the same change. Stage and commit the `dist/` diff alongside the `src/` and `tests/` diffs. CI fails on `src`/`dist` drift.
  - [ ] 6.3 Run the full vitest suite from `plugins/crew/mcp-server/`: `pnpm test`. All suites must pass. No skips, no `.only`s introduced.

---

## Dev Notes

### Why move the binding to `resolveWorkspace` rather than to a `PlanningAdapter.configure?` hook

The interface-level hook is the architecturally cleaner answer; this story deliberately defers it. Two reasons:

1. **Surface size.** Today there is exactly one adapter (`bmad`) that needs per-invocation context. The other registered adapter is the `native` adapter stub (Story 3.4) which does not have a `stories_root`-equivalent setting. Introducing a `configure?(workspace: Workspace): void | Promise<void>` hook on `PlanningAdapter` would touch the Story 3.1 interface, the registry, the native adapter, and force every future adapter author to reason about whether they need it. The narrow `if (activeAdapter.name === "bmad")` branch in `resolveWorkspace` is one line; the cost of removing it later (when a second adapter shows up that needs the same pattern) is the same one line.
2. **Story scope.** This story is the *seam-move*. Promoting the seam to an interface is a follow-up. Note it in the Dev Agent Record as a known refactor candidate so it doesn't get lost.

### Per-process global state: still ugly, still acceptable for v1

`configureBmadAdapter` mutates module-level state (`currentContext`, `refIndex`, `refIndexFor` inside `adapters/bmad/index.ts`). This story does NOT fix that — fixing it would mean threading a context object through `BmadAdapter.listSourceStories()` / `readSourceStory()` / `resolveSourcePath()`, which means re-shaping the `PlanningAdapter` interface from Story 3.1. The MCP server is single-process and single-target-repo per invocation, so the global is functionally safe in v1. Concurrent-target-repo support is a known v2 concern (also called out in `tools/scan-sources.ts`' Concurrency block). Do not attempt to clean this up here.

### Relationship to Story 3.3's TSDoc claims

`adapters/bmad/index.ts` says: "the runtime sets this via `configureBmadAdapter` (called by `getActiveAdapter()` once it lands in Story 3.1)." That sentence is misleading today — `getActiveAdapter()` never wired it. After this story, the wiring lives inside `resolveWorkspace`, which is morally the same seam (resolution-time binding). Update the TSDoc comment on `BmadAdapter` to point to `resolveWorkspace` instead of `getActiveAdapter()`:
- Before: `"the runtime sets this via {@link configureBmadAdapter} (called by getActiveAdapter() once it lands in Story 3.1)."`
- After: `"the runtime sets this via {@link configureBmadAdapter}, invoked from `resolveWorkspace` once the workspace config has been resolved (Story 3.3b). Tests bypass `resolveWorkspace` and call `configureBmadAdapter` directly."`

This is a comment-only change; it does not affect AC count or behaviour.

### Files to read fully before editing

Per the workflow rule, the dev MUST read the current state of every UPDATE file end-to-end before editing it:

- `plugins/crew/mcp-server/src/state/workspace-resolver.ts` (177 lines) — UPDATE. State today: Branch A (no config → detect → write synthesised config) and Branch B (config exists → parse → validate against adapter schema → assemble `Workspace`). Adds adapter-binding step at end of Branch B (which Branch A falls through to). Preserve all existing error paths (`NoAdapterMatchedError`, `AmbiguousAdapterError`, `InvalidWorkspaceConfigError`); they fire **before** the new dispatch, so a misconfigured workspace never reaches `configureBmadAdapter`.
- `plugins/crew/mcp-server/src/tools/scan-sources.ts` (288 lines) — UPDATE. State today: imports `configureBmadAdapter` (line 5), calls it inside `scanSources` (lines 177–183). Removes both. The `scanSources` function body's Step 2+ logic (listSourceStories, per-story create/update/unchanged/skip branching, `validateAgainstDiscipline` seam at line 203) is unchanged. Preserve every other behaviour.
- `plugins/crew/mcp-server/src/adapters/bmad/index.ts` (309 lines) — UPDATE (TSDoc only). State today: exports `BmadAdapter`, `configureBmadAdapter`, `resetBmadAdapter`; the JSDoc on line 28–32 references `getActiveAdapter()`. Update that JSDoc per "Relationship to Story 3.3's TSDoc claims" above. No code change.
- `plugins/crew/mcp-server/tests/workspace-resolver.test.ts` — UPDATE (additions only). State today: stub-adapter-based tests of the three branches. Adds two new `it(...)` blocks per Task 5; touches nothing else.
- `plugins/crew/mcp-server/src/tools/get-status.ts` (117 lines) — READ ONLY. State today: calls `resolveWorkspace` (line 52), never calls `configureBmadAdapter`, never calls adapter list/read/resolve methods. Confirm no edit needed; record the audit in the Dev Agent Record.

### Source tree / paths

Per `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md`, all source under `plugins/crew/mcp-server/src/` is owned by the plugin; `dist/` is build output (committed per Story 1.9 rules); `tests/` is unit + integration test code.

### Testing standards

- Framework: `vitest` (already configured; see `plugins/crew/mcp-server/vitest.config.ts`).
- Test files live alongside `src/` under `plugins/crew/mcp-server/tests/`.
- Use `beforeEach`/`afterEach` for tmp-dir setup and `resetBmadAdapter()` cleanup. Follow the existing pattern in `workspace-resolver.test.ts` (which already creates tmp dirs and uses stub adapters).
- No `.only`, no `.skip` in committed test code.

### Acceptance verification commands (for the AC-verifier)

- AC1 + AC4: `grep -n "configureBmadAdapter\|_bmad-output/planning-artifacts/stories" plugins/crew/mcp-server/src/state/workspace-resolver.ts` → expect both literals present.
- AC2: `grep -n "configureBmadAdapter" plugins/crew/mcp-server/src/tools/scan-sources.ts` → expect zero matches.
- AC3: `grep -n "configureBmadAdapter" plugins/crew/mcp-server/src/tools/*.ts` → expect zero matches (after Task 2; AC3 is "no tool calls it").
- AC5: `cd plugins/crew/mcp-server && pnpm test` → all suites green, with the new `binds BmadAdapter context...` test present in the workspace-resolver suite output.

### Project Structure Notes

- No new files. All changes are edits to existing files plus an additive `dist/` rebuild.
- No new dependencies. No `package.json` change.
- No schema change. `WorkspaceConfigSchema`, `PluginSettingsSchema`, and BMad's `adapterConfigSchema` are all unchanged.
- No public API surface change. `Workspace` interface fields are unchanged; only the TSDoc invariant on `activeAdapter` strengthens.

### References

- Epic: `_bmad-output/planning-artifacts/epics/epic-3-backlog-layer-planning-adapters-story-manifests-and-the-planning-conversation.md` § Story 3.3b
- Architecture: `_bmad-output/planning-artifacts/architecture/planning-adapter-model.md` (the adapter seam this story tightens)
- Architecture: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` (file locations)
- Previous story (BMad adapter v1, source of `configureBmadAdapter`): `_bmad-output/implementation-artifacts/3-3-bmad-adapter-v1-reference-implementation.md`
- Story that introduced the workaround being removed: `_bmad-output/implementation-artifacts/3-2-execution-manifest-schema-scan-sources-mcp-tool-and-source-hash-capture.md`
- User-surface AC rubric (confirms zero ACs tagged here): `plugins/crew/docs/user-surface-acs.md`
- Build-artefact rule (dist/ commit requirement): `plugins/crew/docs/README-install.md` § Build artefacts

## Dev Agent Record

### Agent Model Used

claude-opus-4-7

### Debug Log References

### Completion Notes List

- Substrate-only refactor; no user-facing surface changes. `story_shape: substrate`. No ACs carry the `(user-surface)` tag.
- Known follow-up (deferred): promote the `if (activeAdapter.name === "bmad")` dispatch in `resolveWorkspace` to a `PlanningAdapter.configure?(workspace)` interface hook once a second adapter needs per-invocation context.

### File List
