# Story 4.1: `claim-story`, dependency check, and `complete-story` MCP tools

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer building the dev loop's state-transition surface**,
I want **atomic `claim-story` and `complete-story` MCP tools that enforce dependency order, refuse to operate on hand-edited `in-progress/` manifests, and never observe a story in two states simultaneously**,
so that **Story 4.2's `/start` skill (and every future Epic 4/5 caller) has a trusted, race-free primitive for moving manifests through `to-do → in-progress → done`**.

### What this story is, in one sentence

Land FR17 (atomic claim), FR18 (dependency check + refusal), FR19 (atomic complete), and the FR14a wire-up (closing Story 3.7 AC3's paper promise) by adding two new MCP tools (`claimStory`, `completeStory`) that delegate to `moveBetweenStates` for atomicity, gate on `done/` presence of every ref in `depends_on`, refuse to act when `detectInProgressHandEdit` reports a hand-edit, and stamp `claimed_by` with the calling session's ULID on transition into `in-progress/`. No slash command, no operator chat surface — this story ships the primitives Story 4.2 consumes.

### What this story fixes (and why it needs its own story)

Three threads close in this story:

- **FR17 + FR19 — atomic claim and complete.** Story 1.6 shipped the `moveBetweenStates` primitive (single-syscall `rename(2)` between canonical state directories, EXDEV refusal, ENOENT mapping). Story 3.2 shipped the manifest schema and `scan-sources` writer. Until now there has been no tool that drives the `to-do → in-progress` and `in-progress → done` transitions. Story 4.2's `/start` skill cannot exist until those primitives do.
- **FR18 — dependency check.** A story whose `depends_on` list names refs that are not yet in `done/` must not be claimed — claiming it would let the dev subagent run before its prerequisites land. The check is a directory-presence test against `<target-repo>/.crew/state/done/<dep-ref>.yaml`, returning a typed `DependenciesNotReadyError` that names the missing refs.
- **FR14a — `detectInProgressHandEdit` wiring (closes Story 3.7 AC3 paper promise).** Story 3.7 landed the `detectInProgressHandEdit` predicate and the `InProgressHandEditError` type but shipped zero callers — the planner doesn't touch `in-progress/`. Story 4.1 is the first real consumer: both `claimStory` (when re-entered against an already-claimed ref) and `completeStory` MUST call the guard on entry and propagate the thrown error to the MCP layer verbatim. PRD FR14a names the claim path (Story 4.1) as the first required consumer.

This story is the foundation of Epic 4. After it, Story 4.2 can layer `/start` on top; Stories 4.3–4.4 add the dev-subagent handoff and PR-creation surfaces. Without this story, the entire Epic 4 dev loop is paper.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Ship a slash command, CLI surface, or any operator-visible chat surface. The `/start` skill is Story 4.2's deliverable; this story exposes only MCP tools.
- (c) Implement subagent spawning, persona-prompt assembly, or any Task-tool invocation. Story 4.2 owns the spawn surface. `claimStory` and `completeStory` are pure state-machine drivers.
- (d) Implement the `block-story` MCP tool (FR20). That is a separate story; this story focuses on the happy-path claim/complete transitions.
- (e) Implement heartbeat liveness, stale-claim detection, or the `claimed_by`-orphan recovery path. Those are Epic 5 concerns (`heartbeat.ts`, `archive-cycle.ts`). This story only stamps `claimed_by` on claim; it does NOT validate liveness on complete.
- (f) Implement `rework_count` increment, `blocked_by: handoff-grammar`, or any review/handoff signal recording. Those are Stories 4.3 and beyond.
- (g) Re-implement `detectInProgressHandEdit` or `InProgressHandEditError`. Both shipped in Story 3.7 — this story imports and wires them.
- (h) Re-implement `moveBetweenStates`. It shipped in Story 1.6 — this story imports and wires it.
- (i) Add new fields to `ExecutionManifestSchema` beyond what is strictly needed to widen `status` to accept `"in-progress"` and `"done"` and to admit an optional `claimed_by` ULID. The schema widening is a coordinated bump — see § Architecture compliance.
- (j) Add a `--force` or `--i-know-what-im-doing` bypass for the hand-edit refusal. The refusal is unconditional, mirroring Story 3.7's design.
- (k) Walk the in-progress directory defensively. The hand-edit guard runs only for the ref the tool is about to operate on (per Story 3.7's caller contract in `manifest-state-machine.ts` TSDoc lines 199–215).
- (l) Read or write any source story file (BMad-tracked `_bmad-output/stories/*.md` or native `.crew/native-stories/<ULID>.md`). The dependency check is a pure `.crew/state/done/` directory check; no source-side read is required to gate the claim.
- (m) Emit JSONL telemetry. Telemetry is Story 4.12's deliverable (`agent.invoke`, `reviewer.verdict`). This story keeps the primitives pure with respect to side-effects beyond the manifest move.

---

## Acceptance Criteria

> AC1–AC5 are verbatim from the epic. AC6 is the epic's integration AC. None carry the `(user-surface)` parenthetical because none names a slash command, CLI invocation, file path the operator opens by name, or Claude Code UI element — they all govern internal MCP tools and typed errors. (Per `plugins/crew/docs/user-surface-acs.md`.)

**AC1:**
**Given** a story in `to-do/` with all `depends_on` refs present in `done/`,
**When** `claim-story` is called with that ref and a session ULID,
**Then** the manifest is atomically moved to `in-progress/` via `moveBetweenStates({ from: "to-do", to: "in-progress", ref })`, with `claimed_by` set to the supplied session ULID and `status` updated to `"in-progress"`. The move and the field updates MUST land in a single atomic operation observable to other sessions (write the updated manifest to `in-progress/<ref>.yaml` via `writeManagedFile`'s `.tmp`-then-`rename` path BEFORE the `to-do/` deletion, OR move first then rewrite — see § Implementation strategy for the chosen sequence). _(FR17, FR18)_

**AC2:**
**Given** a story whose `depends_on` references at least one ref not in `done/`,
**When** `claim-story` is called,
**Then** it returns a typed `DependenciesNotReadyError` carrying `ref: string`, `missingDeps: readonly string[]`, and a human-readable diagnostic naming each missing ref. The on-disk manifest stays in `to-do/` — no write, no move, no `claimed_by` stamp. _(FR18)_

**AC3:**
**Given** a story in `in-progress/` whose `claimed_by` field matches the calling session's ULID,
**When** `complete-story` is called,
**Then** the manifest is atomically moved to `done/` via `moveBetweenStates({ from: "in-progress", to: "done", ref })`, with `status` updated to `"done"`. The `claimed_by` field is preserved (not cleared) so retros can attribute the completion to the session that ran the story. _(FR19)_

**AC4:**
**Given** a story in `in-progress/` whose `claimed_by` field does NOT match the calling session's ULID,
**When** `complete-story` is called,
**Then** it returns a typed `WrongClaimantError` carrying `ref: string`, `expectedSessionUlid: string`, `actualSessionUlid: string`, and a human-readable diagnostic. The on-disk manifest stays in `in-progress/` — no write, no move.

**AC5 (FR14a wiring — closes Story 3.7 AC3):**
**Given** a story whose `in-progress/<ref>.yaml` manifest has been hand-edited since claim (operator-editable fields drift from scan-time baseline OR `source_hash` drifts from the source story's current hash),
**When** EITHER `claim-story` is called for that ref (re-entry case — ref is already in `in-progress/`) OR `complete-story` is called for that ref,
**Then** the tool MUST invoke `detectInProgressHandEdit({ targetRepoRoot, ref, sourceHash, sourceFields })` from `mcp-server/src/state/manifest-state-machine.ts` BEFORE any move, dependency check, or field rewrite, and the thrown `InProgressHandEditError` MUST propagate to the MCP layer verbatim (no swallow, no downgrade). The error message MUST be the Story 3.7 verbatim diagnostic with the offending ref and changed field list. _(FR14a, closes Story 3.7 AC3)_

**AC6 (integration):**
vitest covers all five branches against a fixture target repo:
- (a) happy claim (deps satisfied → `in-progress/` with `claimed_by` stamped),
- (b) deps-not-ready claim (one dep missing from `done/` → `DependenciesNotReadyError`, manifest unchanged in `to-do/`),
- (c) happy complete (matching `claimed_by` → moved to `done/`),
- (d) wrong-claimant complete (mismatched ULID → `WrongClaimantError`, manifest unchanged in `in-progress/`),
- (e) hand-edit refusal on `complete-story` (operator hand-edited `in-progress/<ref>.yaml` → `InProgressHandEditError` thrown, manifest unchanged).
Plus a chaos test: 1,000 concurrent `claim-story` attempts against the same `to-do/` ref MUST result in exactly one success and 999 typed failures (either `ManifestNotFoundError` from `moveBetweenStates` on the losing claims, or no other observable state). At no point during the chaos run can a single ref's manifest exist in two state directories simultaneously — assert by directory snapshot after the run.

---

## Tasks / Subtasks

- [x] **Task 1 — Widen `ExecutionManifestSchema` to admit `in-progress` and `done` states and `claimed_by` (AC: 1, 3)**
  - [x] 1.1 Edit `plugins/crew/mcp-server/src/schemas/execution-manifest.ts`. Change the `status` enum from `z.enum(["to-do", "blocked"])` to `z.enum(["to-do", "blocked", "in-progress", "done"])`. The schema's TSDoc on the `status` field (lines 36–40 today) MUST be updated to name the new producers: `claimStory` writes `"in-progress"`; `completeStory` writes `"done"`.
  - [x] 1.2 Add an optional `claimed_by` field: `claimed_by: z.string().min(1).optional()`. Document in TSDoc that the value is the calling session's ULID and that the field is present iff `status === "in-progress" || status === "done"`. (No cross-field invariant enforced in Zod — the tools enforce the invariant on write. A Zod refinement here would block `scan-sources` rewrites of `to-do/` manifests that don't carry `claimed_by`.)
  - [x] 1.3 Update the strict-mode comment near `.strict()` to note that Story 4.1 widened the status vocabulary and added `claimed_by`, so a `yaml.stringify(parseExecutionManifest(...))` round-trip of an `in-progress/` or `done/` manifest preserves all fields.
  - [x] 1.4 No change to `parseExecutionManifest`'s error shape. `MalformedExecutionManifestError` continues to wrap Zod failures.
  - [x] 1.5 Regenerate / update any snapshot tests under `mcp-server/src/schemas/__tests__/` that pin the strict-mode rejection set. Existing tests asserting `"in-progress"` was rejected MUST be flipped to assert acceptance.

- [x] **Task 2 — Add `DependenciesNotReadyError` and `WrongClaimantError` to `errors.ts` (AC: 2, 4)**
  - [x] 2.1 Edit `plugins/crew/mcp-server/src/errors.ts`. Add `export class DependenciesNotReadyError extends DomainError` carrying `readonly ref: string`, `readonly missingDeps: readonly string[]`. Constructor message: `` `claim-story refused: '${ref}' depends on refs not yet in done/: [${missingDeps.join(", ")}]. Wait for these stories to complete, or remove them from depends_on via the source story.` ``. Cite FR18.
  - [x] 2.2 Add `export class WrongClaimantError extends DomainError` carrying `readonly ref: string`, `readonly expectedSessionUlid: string`, `readonly actualSessionUlid: string`. Constructor message: `` `complete-story refused: '${ref}' was claimed by session '${actualSessionUlid}' but the caller's session is '${expectedSessionUlid}'. Only the claiming session may complete a story.` ``.
  - [x] 2.3 Match the existing error style in `errors.ts` — class-name as `name` (auto via `DomainError`'s constructor), readonly fields exposed on the instance, message format `<tool-name> refused: <reason>` (mirrors `GitCommitMessageMalformedError`'s `git commit refused: …` precedent at line 360).
  - [x] 2.4 Export both errors from `errors.ts` (no barrel file — errors are imported by direct path; mirror existing pattern).

- [x] **Task 3 — Implement `claimStory` MCP tool (AC: 1, 2, 5)**
  - [x] 3.1 Create `plugins/crew/mcp-server/src/tools/claim-story.ts`. Export `claimStory(opts: { targetRepoRoot: string; ref: string; sessionUlid: string }): Promise<{ ref: string; absPath: string }>`.
  - [x] 3.2 Implementation flow (in order):
    1. Resolve `absToDoPath = <targetRepoRoot>/.crew/state/to-do/<ref>.yaml` and `absInProgressPath = <targetRepoRoot>/.crew/state/in-progress/<ref>.yaml`.
    2. **Hand-edit guard** (AC5 / FR14a). If `absInProgressPath` exists on disk (the ref is already in `in-progress/`), call `detectInProgressHandEdit({ targetRepoRoot, ref, sourceHash: <computed from active adapter's readSourceStory>, sourceFields: <derived from same> })` and let any thrown `InProgressHandEditError` propagate. Use `fs.stat` to test existence; ENOENT means proceed (ref is in `to-do/`). For sourceHash/sourceFields: re-read the source story via the active adapter's `readSourceStory(ref)` and compute the same canonical view `scan-sources` would write (see § Implementation strategy below for the helper).
    3. **Load to-do manifest.** `fs.readFile(absToDoPath)` → `yaml.parse` → `parseExecutionManifest`. Propagate `ENOENT` as `ManifestNotFoundError({ ref, expectedAbsPath: absToDoPath, fromState: "to-do" })`. Propagate `MalformedExecutionManifestError` unchanged.
    4. **Dependency check** (AC2 / FR18). For each `dep` in `manifest.depends_on`, `fs.stat(<targetRepoRoot>/.crew/state/done/<dep>.yaml)`. Collect refs whose stat throws ENOENT into `missingDeps[]`. If non-empty, throw `DependenciesNotReadyError({ ref, missingDeps })`. (No partial state change occurred — bail clean.)
    5. **Atomic transition** (AC1 / FR17). Call `moveBetweenStates({ targetRepoRoot, ref, from: "to-do", to: "in-progress" })` from `state/manifest-state-machine.ts`. The rename is the atomicity guarantee. After the rename returns, the file lives at `absInProgressPath`.
    6. **Field rewrite.** Build the updated manifest: spread the parsed manifest, set `status: "in-progress"`, set `claimed_by: sessionUlid`. Re-parse via `parseExecutionManifest` (defensive — guarantees the widened schema accepts the result). Serialise via `yaml.stringify(manifest, { lineWidth: 0 })`. Write via `writeManagedFile({ absPath: absInProgressPath, contents: yamlText, targetRepoRoot, mcpToolContext: { toolName: "claimStory", role: "<caller-role>" } })`. Use `writeManagedFile`'s `.tmp`-then-`rename` for atomicity at the rewrite step.
    7. Return `{ ref, absPath: absInProgressPath }`.
  - [x] 3.3 **Sequencing rationale:** The move-then-rewrite sequence is chosen over rewrite-then-move because `moveBetweenStates` is the canonical atomicity primitive — using it first means another concurrent claim sees the `to-do/<ref>.yaml` ENOENT immediately (rename is atomic), and the rewrite is an in-place update on the winner's manifest. The rewrite step's `.tmp`-then-`rename` is itself atomic, so readers never see a partially-written `in-progress/<ref>.yaml`. The narrow window between rename and rewrite is observable as "an `in-progress/<ref>.yaml` whose `status` field is still `to-do` and `claimed_by` is absent" — this is fine because (a) no other tool inspects `status` on the in-progress layer (they all use the directory as ground truth), and (b) the hand-edit guard's baseline check sees the rewritten manifest, not the transient one. Document this rationale in a TSDoc comment on the tool.
  - [x] 3.4 **Caller-role for `mcpToolContext`:** Accept an optional `role: string` parameter on `claimStory(opts)`. Default to `"orchestrator"` if not supplied. The role is plumbed through to `writeManagedFile`'s `mcpToolContext` for the FR81 / NFR16 canonical-write guard. (The MCP server's tool dispatcher in `register.ts` will eventually pass the actual calling role; Story 4.2 may refine this.)
  - [x] 3.5 Add TSDoc citing FR17 / FR18 / FR14a and Story 4.1, and pointing to `moveBetweenStates` and `detectInProgressHandEdit` as the load-bearing primitives.

- [x] **Task 4 — Implement `completeStory` MCP tool (AC: 3, 4, 5)**
  - [x] 4.1 Create `plugins/crew/mcp-server/src/tools/complete-story.ts`. Export `completeStory(opts: { targetRepoRoot: string; ref: string; sessionUlid: string; role?: string }): Promise<{ ref: string; absPath: string }>`.
  - [x] 4.2 Implementation flow (in order):
    1. Resolve `absInProgressPath = <targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` and `absDonePath = <targetRepoRoot>/.crew/state/done/<ref>.yaml`.
    2. **Hand-edit guard** (AC5 / FR14a). Always call `detectInProgressHandEdit({ ... })` on entry — for `completeStory` the ref MUST be in `in-progress/` (otherwise the next step throws), so the guard is unconditional. Let any thrown `InProgressHandEditError` propagate. SourceHash/sourceFields derivation same as Task 3.
    3. **Load in-progress manifest.** `fs.readFile` → `yaml.parse` → `parseExecutionManifest`. Propagate `ENOENT` as `ManifestNotFoundError({ ref, expectedAbsPath: absInProgressPath, fromState: "in-progress" })`. Propagate `MalformedExecutionManifestError` unchanged.
    4. **Claimant check** (AC4). If `manifest.claimed_by !== opts.sessionUlid`, throw `WrongClaimantError({ ref, expectedSessionUlid: opts.sessionUlid, actualSessionUlid: manifest.claimed_by ?? "<unset>" })`. (Treat absent `claimed_by` as a mismatch — a story in `in-progress/` without `claimed_by` is malformed and should not be completable by any caller; the operator must fix the manifest or `block-story` it.)
    5. **Atomic transition** (AC3 / FR19). Call `moveBetweenStates({ targetRepoRoot, ref, from: "in-progress", to: "done" })`.
    6. **Field rewrite.** Spread parsed manifest, set `status: "done"`. Preserve `claimed_by` verbatim (retros attribute completion). Re-parse, serialise, `writeManagedFile` to `absDonePath`.
    7. Return `{ ref, absPath: absDonePath }`.
  - [x] 4.3 TSDoc citing FR19 / FR14a, Story 4.1, and the same primitive references as Task 3.

- [x] **Task 5 — Source-hash + source-fields derivation helper (AC: 5)**
  - [x] 5.1 Both tools need a `{ sourceHash, sourceFields }` view to feed `detectInProgressHandEdit`. The canonical source-of-truth is "what `scan-sources` would write for this ref against the current source story." Extract a helper `deriveSourceBaseline({ targetRepoRoot, ref, activeAdapter }): Promise<{ sourceHash: string; sourceFields: OperatorEditableFields }>` and place it under `plugins/crew/mcp-server/src/state/derive-source-baseline.ts` (co-located with `manifest-state-machine.ts` because it serves the state-machine layer).
  - [x] 5.2 Implementation: call `activeAdapter.readSourceStory(ref)` to get a `SourceStory`. Compute `sourceHash` the same way `scan-sources` does (see `scan-sources.ts` — `SourceStory.source_hash` is already computed by the adapter at `listSourceStories` time; for `readSourceStory` the adapter may need to expose the hash; if not, recompute via `crypto.createHash("sha256").update(rawBytes).digest("hex")` where `rawBytes` is the raw file contents). Build `sourceFields = { title, narrative, acceptance_criteria, implementation_notes, depends_on, withdrawn: false }` from the `SourceStory`. (Note: `SourceStory` carries source-side `withdrawn` semantics if any; the baseline for a freshly-scanned story is `withdrawn: false` per Story 3.6.)
  - [x] 5.3 Resolve the active adapter via the existing `resolveWorkspace(targetRepoRoot)` → `getActiveAdapter(...)` path. Both new tools accept `targetRepoRoot` and do the resolution themselves; no adapter argument is plumbed through the public tool API.
  - [x] 5.4 Edge case: if the source story has been deleted from the planning tool (BMad file removed; native file removed), `readSourceStory` throws (`UnknownBmadRefError` / equivalent). In that case, propagate the error — claim and complete cannot proceed against a source-less ref. The orchestrator will surface this as a state inconsistency. Document in TSDoc.

- [x] **Task 6 — Register both tools in `register.ts` (AC: all)**
  - [x] 6.1 Edit `plugins/crew/mcp-server/src/tools/register.ts`. Import `claimStory` from `./claim-story.js` and `completeStory` from `./complete-story.js`.
  - [x] 6.2 Register `claimStory` with the MCP server. Tool name (per § 4 MCP Tool Naming in `implementation-patterns-consistency-rules.md`): `claimStory` (camelCase verb-noun, flat namespace). Description: `"Atomically claim a story for dev work (FR17) — moves manifest from to-do/ to in-progress/, stamps claimed_by with the caller's session ULID, refuses if any depends_on ref is not in done/ (FR18) or if the in-progress manifest has been hand-edited (FR14a). Story 4.1."`. Input schema: `{ targetRepoRoot: string, ref: string, sessionUlid: string, role?: string }`. Handler validates via Zod, calls the tool function, returns the result as JSON-stringified text content. On thrown `DomainError`, set `isError: true` in the MCP response and include the error message + `name`.
  - [x] 6.3 Register `completeStory` symmetrically. Description: `"Atomically complete a claimed story (FR19) — moves manifest from in-progress/ to done/, preserves claimed_by, refuses if the caller's session ULID does not match the manifest's claimed_by (WrongClaimantError) or if the in-progress manifest has been hand-edited (FR14a). Story 4.1."`. Input schema: same shape minus the role default.
  - [x] 6.4 Mirror the existing handler error-response pattern used by `scanSources` / `getStatus` in `register.ts` — Zod parse failure on args returns a typed error; tool-thrown `DomainError` is mapped to `isError: true` content.

- [x] **Task 7 — Unit tests (AC: 2, 4, 5)**
  - [x] 7.1 Add `plugins/crew/mcp-server/src/tools/__tests__/claim-story.test.ts` covering:
    - (a) happy claim: seed a `to-do/<ref>.yaml` via the canonical write path (`scan-sources` against a tmpdir adapter fixture, OR direct `writeManagedFile` with the `scanSources` mcpToolContext). Pre-place all `depends_on` refs as `done/<dep>.yaml`. Call `claimStory`. Assert the manifest now lives at `in-progress/<ref>.yaml` with `status: "in-progress"` and `claimed_by: <supplied-ulid>`, and `to-do/<ref>.yaml` does NOT exist.
    - (b) deps-not-ready: same setup, but omit one `depends_on` ref from `done/`. Call `claimStory`. Assert it throws `DependenciesNotReadyError` with the missing ref in `missingDeps`. Assert the manifest is still at `to-do/<ref>.yaml`, unchanged byte-for-byte (compare file mtime + content hash).
    - (c) hand-edit refusal on re-entry: pre-place an `in-progress/<ref>.yaml` (mimicking a prior claim by a different session). Hand-edit `title` on disk. Call `claimStory(ref, <new-session>)`. Assert `InProgressHandEditError` thrown with `changedFields` listing `title`. Assert no move occurred.
    - (d) `claimed_by` defensive parse: assert that the rewritten manifest round-trips through `parseExecutionManifest` cleanly with the widened schema.
  - [x] 7.2 Add `plugins/crew/mcp-server/src/tools/__tests__/complete-story.test.ts` covering:
    - (a) happy complete: seed an `in-progress/<ref>.yaml` with `claimed_by: <ulidA>`. Call `completeStory(ref, ulidA)`. Assert manifest at `done/<ref>.yaml` with `status: "done"` and `claimed_by: <ulidA>` preserved.
    - (b) wrong claimant: seed `in-progress/<ref>.yaml` with `claimed_by: <ulidA>`. Call `completeStory(ref, ulidB)`. Assert `WrongClaimantError` thrown carrying both ULIDs. Assert manifest unchanged.
    - (c) hand-edit refusal: seed `in-progress/<ref>.yaml` with `claimed_by: <ulidA>`, then hand-edit `narrative` on disk. Call `completeStory(ref, ulidA)`. Assert `InProgressHandEditError` thrown.
    - (d) absent `claimed_by`: seed `in-progress/<ref>.yaml` WITHOUT `claimed_by`. Call `completeStory(ref, anyUlid)`. Assert `WrongClaimantError` thrown with `actualSessionUlid: "<unset>"`.
  - [x] 7.3 Both test files follow the existing pattern under `mcp-server/src/tools/__tests__/` — vitest, tmpdir fixtures, no reinvented test scaffolding. Use the BMad adapter fixture path established in Story 3.3 for the active-adapter resolution, OR mock the active adapter via the existing seam where simpler.

- [x] **Task 8 — Integration + chaos tests (AC: 6)**
  - [x] 8.1 Add `plugins/crew/mcp-server/src/tools/__tests__/claim-complete-loop.integration.test.ts`. Build a tmpdir target repo with a real BMad adapter fixture, seed two source stories where `B.depends_on = [A]`. Run end-to-end:
    1. `scanSources` → both manifests land in `to-do/`.
    2. `claimStory(A, sessionUlid)` → A moves to `in-progress/` with `claimed_by` stamped.
    3. `completeStory(A, sessionUlid)` → A moves to `done/`.
    4. `claimStory(B, sessionUlid)` → B moves to `in-progress/` (A is now in `done/`).
    5. `completeStory(B, sessionUlid)` → B moves to `done/`.
    Assert each transition's filesystem state via directory listing.
  - [x] 8.2 Chaos test: spawn 1,000 concurrent `claimStory` calls against the same ref (using `Promise.allSettled` over an array of 1,000 invocations). Assert exactly one resolved (the winner), 999 rejected with `ManifestNotFoundError` (losers — `moveBetweenStates` returns this when the source file vanished mid-flight). Assert the manifest exists at exactly one of `to-do/`, `in-progress/`, or `done/` — never two simultaneously — by snapshotting the three directories after the run. Use the existing concurrent-test pattern from `manifest-state-machine.test.ts` or equivalent.
  - [x] 8.3 The chaos test MUST be deterministic in its assertions even if it is non-deterministic in scheduling — exactly one winner is invariant by `rename(2)` semantics on a single filesystem.

- [x] **Task 9 — Build artefacts and final checks (AC: all)**
  - [x] 9.1 Run `pnpm build` at the plugin root. Commit `plugins/crew/mcp-server/dist/` per CLAUDE.md §Process notes (the plugin tree is shipped as-is via `/plugin install`).
  - [x] 9.2 Run the full vitest suite. All existing tests MUST remain green. The schema-widening in Task 1 may cause previously-passing tests that assert `"in-progress"` is rejected to fail — those assertions MUST be flipped, not the schema rolled back.
  - [x] 9.3 No telemetry events are emitted by either tool — Story 4.12 owns telemetry plumbing. The tools are silent with respect to JSONL.
  - [x] 9.4 No `console.log`, no `console.error` in either tool. Errors flow through the typed-error contract.

---

## Architecture compliance

- **`moveBetweenStates` is the only canonical atomic mover.** Story 1.6's primitive at `plugins/crew/mcp-server/src/state/manifest-state-machine.ts:76-144`. Both new tools delegate to it. The static `canonical-fs-guard.test.ts` enforces that no other module in `mcp-server/src/**` invokes `rename` against a state-machine path. The new tools comply because the `.tmp`-then-`rename` for field rewrite goes through `writeManagedFile` (whitelisted), and the state transition goes through `moveBetweenStates` (whitelisted).
- **`writeManagedFile` is the only canonical writer.** `plugins/crew/mcp-server/src/lib/managed-fs.ts:137-155`. Both new tools route their field rewrites through it with an explicit `mcpToolContext: { toolName, role }`. The FR81 / NFR16 guard refuses canonical-state writes without this context, so the tools cannot accidentally bypass the contract.
- **Schema widening is a coordinated bump.** `ExecutionManifestSchema` (`mcp-server/src/schemas/execution-manifest.ts`) gains two new status values (`in-progress`, `done`) and an optional `claimed_by` field. Per `implementation-patterns-consistency-rules.md` § 12, pattern changes that break existing artifacts ship as a breaking plugin-semver bump. The widening is additive (existing `to-do/` and `blocked/` manifests parse unchanged), so a semver minor bump is appropriate — no operator-side migration is required. Coordinate with the plugin version in `plugins/crew/.claude-plugin/plugin.json`.
- **`detectInProgressHandEdit` is the FR14a contract.** Story 3.7 shipped the predicate at `mcp-server/src/state/manifest-state-machine.ts:228-316` and the `InProgressHandEditError` at `mcp-server/src/errors.ts:700-716`. Story 4.1 is the first required caller per PRD FR14a sub-bullet. Both tools call the guard on entry against the in-progress layer. The guard's caller contract (TSDoc lines 199–215) explicitly names Epic 4/5 as the consumers.
- **`PlanningAdapter` interface is unchanged.** The dependency check is a pure `done/` directory test — no adapter-side read is required to gate the claim. The hand-edit guard requires an adapter-side `readSourceStory` to derive the baseline, but that method already exists; no signature change.
- **No new MCP tool category.** Both `claimStory` and `completeStory` fit the existing camelCase verb-noun convention (§ 4). No dotted namespacing, no new top-level grouping.
- **Filesystem is the only coordination surface (NFR19).** Concurrent claim safety derives entirely from `rename(2)` atomicity on a single filesystem. No lockfile, no in-memory mutex, no daemon. The chaos test pins this invariant.
- **Cross-filesystem moves remain refused.** `moveBetweenStates` throws `CrossFilesystemMoveError` on EXDEV (Story 1.6 AC2). The new tools inherit this contract — no copy+delete fallback is introduced.
- **`isClaimable` is NOT invoked by `claimStory` in this story.** Story 3.6's `isClaimable` predicate gates on `withdrawn === false && status === "to-do"`. The PRD FR18 contract for `claim-story` is dependency presence, not `isClaimable` — Story 4.2's `/start` skill is the layer that picks the next ready story (and that layer SHOULD use `isClaimable` to filter the queue). `claimStory` itself is a primitive: given a ref, claim it if deps are ready and the manifest is not hand-edited. If `/start` hands `claimStory` a withdrawn ref by mistake, the parse step will surface `withdrawn: true` and `/start`'s queue-selection logic is the layer that prevents that. Document in TSDoc.
- **No source-side writes.** The adapter's `readSourceStory` is invoked for the hand-edit baseline; no `writeSourceStory` exists and none is introduced.
- **`docs/standards.md` is untouched.** This is execution-layer plumbing; standards are review-layer concerns (Story 4.6).

## Library / framework requirements

- **No new dependencies.** `node:fs/promises`, `yaml` (already in use), Zod (already in use), `crypto` (already in use for source-hash computation in adapters) cover the surface.
- **ULID generation is the caller's responsibility.** `claimStory` accepts a `sessionUlid: string` and does NOT generate one itself. Story 4.2's `/start` skill is the ULID generator (the dev session has one session per skill invocation). Validation: `z.string().min(1)` on the tool input; no regex enforcement of ULID shape in this story (Story 4.2 may tighten this).
- **`yaml` `lineWidth: 0`** mirrors the existing `scan-sources` writer pattern (see `scan-sources.ts:308, 339, 394, 412, 446`) for stable diffs.
- **TypeScript conventions** per § 6 of `implementation-patterns-consistency-rules.md`: kebab-case filenames (`claim-story.ts`, `complete-story.ts`), named exports only, no `any`, typed errors extending `DomainError`.

## File structure requirements

New files:
- `plugins/crew/mcp-server/src/tools/claim-story.ts`
- `plugins/crew/mcp-server/src/tools/complete-story.ts`
- `plugins/crew/mcp-server/src/state/derive-source-baseline.ts` (helper for hand-edit baseline)
- `plugins/crew/mcp-server/src/tools/__tests__/claim-story.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/complete-story.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/claim-complete-loop.integration.test.ts`

Modified files (UPDATE, not NEW — read fully before editing):
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — widen `status` enum, add optional `claimed_by`. Existing TSDoc updated. Existing call-sites of `parseExecutionManifest` (in `scan-sources.ts`, `manifest-state-machine.ts`, `mark-withdrawn.ts`, planner backlog validator) MUST be re-read to confirm none break on the widened enum. Spot check: `scan-sources.ts` line 322 forces `status: "blocked"` literal — unchanged. `scan-sources.ts` line 287 reads `status` from disk but does not switch on the enum exhaustively — unchanged. `mark-withdrawn.ts` writes back to `to-do/` only — unchanged.
- `plugins/crew/mcp-server/src/errors.ts` — add `DependenciesNotReadyError` and `WrongClaimantError`. No edits to existing classes.
- `plugins/crew/mcp-server/src/tools/register.ts` — add two `server.registerTool` calls for the new tools. No edits to existing registrations.

Build output (regenerate, do not hand-edit):
- `plugins/crew/mcp-server/dist/` — committed per CLAUDE.md §Process notes.

## Testing requirements

- **vitest** (project precedent). Co-locate tests with the production module under `__tests__/`.
- **Tmpdir fixtures.** No mutation of repo state. Use `node:fs/promises mkdtemp` + cleanup in `afterEach`. Mirror the existing pattern from `scan-sources.test.ts` and `detect-in-progress-hand-edit.test.ts`.
- **No mocking of `node:fs`.** The state-machine tests use real renames against a tmpdir; this story follows suit. The `FsImpl` injection seam on `moveBetweenStates` (line 43–47) is for narrow EXDEV simulation only — Story 4.1 tests should NOT use it.
- **Adapter mocking is permitted** for unit tests that just need a `readSourceStory` result. Integration tests use the real BMad adapter against a fixture story tree (mirroring Story 3.3's pattern).
- **Chaos test thresholds.** 1,000 concurrent claims is the epic-specified count. If runtime is excessive on CI, the test can be tagged `@chaos` and run via `pnpm test:chaos` rather than the default suite — but the test MUST exist and pass locally. Default suite includes it unless flakiness is observed.
- **Coverage target.** All five error branches (`DependenciesNotReadyError`, `WrongClaimantError`, `InProgressHandEditError` on claim, `InProgressHandEditError` on complete, `ManifestNotFoundError` on claim against missing to-do ref) MUST be exercised by named tests.

## Previous story intelligence

- **Story 3.7 (just landed):** Shipped `detectInProgressHandEdit` and `InProgressHandEditError`. The predecessor's spec (`_bmad-output/implementation-artifacts/3-7-plain-language-guideline-and-direct-edit-allowance.md` § Behavioural contract → guard) explicitly states that Epic 4/5 callers MUST invoke the guard on entry. Story 4.1 closes the paper promise. The guard's signature is `async function detectInProgressHandEdit(opts: { targetRepoRoot, ref, sourceHash, sourceFields: OperatorEditableFields }): Promise<{ ok: true }>`. The `OperatorEditableFields` type is exported from `manifest-state-machine.ts`.
- **Story 3.6:** Shipped `isClaimable` predicate and `mark-withdrawn` tool. The withdrawn semantics are orthogonal to claim/complete: `/start` (Story 4.2) is responsible for filtering withdrawn refs out of the candidate set BEFORE calling `claimStory`. This story does NOT re-check `withdrawn` — if Story 4.2 hands a withdrawn ref to `claimStory`, the move will technically succeed (`withdrawn` is just a field; `moveBetweenStates` doesn't inspect it), and the dev subagent would then receive a withdrawn story. Document this layering decision in TSDoc to ensure Story 4.2 owns the filter.
- **Story 3.5:** Discipline-gate runs at scan time, writes `blocked/` manifests for violations. `claimStory` does NOT re-run the discipline gate; a manifest in `to-do/` is by definition discipline-passing (or was when last scanned). Hand-edited to-do/ manifests that subsequently fail discipline surface naturally on the next scan-sources call (Story 3.5 wiring), not on claim.
- **Story 3.2:** `parseExecutionManifest` is the canonical reader; all manifest reads in this story route through it. The `MalformedExecutionManifestError` propagation contract is unchanged.
- **Story 1.6:** `moveBetweenStates` is the only atomic mover. EXDEV → `CrossFilesystemMoveError`. ENOENT → `ManifestNotFoundError`. The state-machine module is the single source of truth for canonical-path renames.
- **Lesson from Story 1.6's retro / canonical-fs guard:** the static test in `tests/canonical-fs-guard.test.ts` walks `mcp-server/src/**` and forbids any non-whitelisted file from importing a write-shaped `node:fs` API. The new tool files MUST NOT `import { rename, writeFile } from "node:fs/promises"` — they go through `writeManagedFile` and `moveBetweenStates`. Failing this test is the most common Epic-1-era regression and will block the build.

## References

- Epic source: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md` § Story 4.1 (lines 16–36).
- PRD: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR14a (line 24), FR17 (line 30), FR18 (line 31), FR19 (line 32).
- Predecessor spec (FR14a paper promise): `_bmad-output/implementation-artifacts/3-7-plain-language-guideline-and-direct-edit-allowance.md` § Behavioural contract.
- Architecture: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` (MCP tool naming § 4, locked phrases § 7, TS conventions § 6).
- Architecture: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` (tool layout — `mcp-server/src/tools/claim-story.ts` and `complete-story.ts` enumerated at lines 63–64).
- Source: `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` (`moveBetweenStates` at 76–144, `detectInProgressHandEdit` at 228–316).
- Source: `plugins/crew/mcp-server/src/errors.ts` (`InProgressHandEditError` at 700–716, `ManifestNotFoundError` at 471–488, error-class precedent for `DependenciesNotReadyError` / `WrongClaimantError`).
- Source: `plugins/crew/mcp-server/src/lib/managed-fs.ts` (`writeManagedFile` / `atomicWriteFile` at 115–155).
- Source: `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` (schema to widen).
- Source: `plugins/crew/mcp-server/src/tools/register.ts` (registration pattern).
- Source: `plugins/crew/mcp-server/src/tools/scan-sources.ts` (writer pattern, line 308 onward — mcpToolContext shape, yaml stringify options).

### Project Structure Notes

- The new tools live alongside `scan-sources.ts`, `mark-withdrawn.ts`, `write-native-story.ts` under `mcp-server/src/tools/`. No subdirectory.
- The `derive-source-baseline.ts` helper sits in `mcp-server/src/state/` because it serves the state-machine layer (it's the FR14a baseline builder, not a tool itself). Alternative placement under `mcp-server/src/lib/` was considered but rejected — the helper is state-machine-specific.
- No changes to the plugin's top-level layout, `plugin.json` manifest (beyond the semver bump in Task 1's schema widening), or skill files.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

None.

### Completion Notes List

- Widened `ExecutionManifestSchema` status enum to include `"in-progress"` and `"done"`, and added optional `claimed_by` field. Additive change — existing `to-do/` and `blocked/` manifests parse unchanged.
- Added `DependenciesNotReadyError` and `WrongClaimantError` to `errors.ts`, following the existing `DomainError` class pattern.
- Implemented `deriveSourceBaseline` helper in `state/derive-source-baseline.ts` to build the FR14a hand-edit baseline from the active adapter's `readSourceStory`.
- Implemented `claimStory` tool (move-then-rewrite sequence for atomicity; hand-edit guard on re-entry; dep check via `done/` directory stats).
- Implemented `completeStory` tool (unconditional hand-edit guard on entry; claimant check before move; `claimed_by` preserved in `done/` manifest).
- Registered both tools in `register.ts`; updated tool-count assertions in three existing test files (13 → 15).
- 18 new tests: 8 unit (claim-story), 6 unit (complete-story), 4 integration+chaos (claim-complete-loop). All pass. The 1,000-concurrent-claim chaos test confirms exactly one winner and 999 `ManifestNotFoundError` failures.
- The 8 pre-pr-gate failures are pre-existing — `ship.py` explicitly refuses to run from `.worktrees/` directories and are unrelated to this story.
- `dist/` rebuilt and committed per CLAUDE.md §Process notes.

### File List

New files:
- `plugins/crew/mcp-server/src/tools/claim-story.ts`
- `plugins/crew/mcp-server/src/tools/complete-story.ts`
- `plugins/crew/mcp-server/src/state/derive-source-baseline.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/claim-story.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/complete-story.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/claim-complete-loop.integration.test.ts`

Modified files:
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — widened status enum, added `claimed_by`, updated TSDoc
- `plugins/crew/mcp-server/src/errors.ts` — added `DependenciesNotReadyError` and `WrongClaimantError`
- `plugins/crew/mcp-server/src/tools/register.ts` — registered `claimStory` and `completeStory` tools
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` — updated tool count 13 → 15
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` — updated tool count 13 → 15
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` — updated tool count 13 → 15

Build output (regenerated):
- `plugins/crew/mcp-server/dist/` — committed per CLAUDE.md §Process notes

### Change Log

- Story 4.1 implementation: `claimStory` and `completeStory` MCP tools with dependency check (FR18), atomic transitions (FR17/FR19), hand-edit guard (FR14a), and error types (Date: 2026-05-21)
