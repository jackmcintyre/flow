# Epic 3: Backlog Layer — Planning Adapters, Story Manifests, and the Planning Conversation

A user ends this epic with a primed, validated backlog of execution manifests — either via BMad or the native planner. Source-drift captured; planning-discipline validated.

## Story 3.1: PlanningAdapter interface and adapter registry

As a plugin maintainer,
I want a `PlanningAdapter` TypeScript interface and a registry that resolves the active adapter from workspace config,
So that BMad and native (and future Linear / GitHub Issues / etc.) can plug in behind one seam.

**Acceptance Criteria:**

**Given** the adapter interface at `mcp-server/src/adapters/adapter.ts`, **When** I inspect it, **Then** it declares `name`, `detect`, `listSourceStories`, `readSourceStory`, `resolveSourcePath`, optional `watchForChanges`, and `validateAgainstDiscipline`. _(Architecture §Planning Adapter Model)_

**Given** the adapter registry at `mcp-server/src/adapters/registry.ts`, **When** the active adapter is requested, **Then** it reads `adapter:` from workspace config and returns the matching registered adapter or fails with a typed `UnknownAdapterError`.

**Given** a workspace config with no `adapter:`, **When** the registry runs `detect()` across registered adapters in registration order, **Then** the first match wins; ambiguity raises a typed `AmbiguousAdapterError` that surfaces to the user via the calling skill.

**AC4 (integration):** vitest covers the three branches (configured / detected / ambiguous) using two stub adapters.

## Story 3.2: Execution-manifest schema, `scan-sources` MCP tool, and source-hash capture

As a plugin operator,
I want my source stories projected into plugin-owned execution manifests under `.flow/state/to-do/<ref>.yaml`,
So that the dev loop has a stable, validated handle on each story without writing to the source tool's tree.

**Acceptance Criteria:**

**Given** a target repo with an adapter that returns source stories,
**When** `scan-sources` is invoked,
**Then** each new ref produces an execution manifest in `state/to-do/<ref>.yaml` with `ref`, `status: to-do`, `adapter`, `source_path`, `source_hash` (sha256 of source contents), and `depends_on` carried from the source. _(FR9 via execution-manifest layer; Architecture §Source-drift handling)_

**Given** a re-scan after no source changes, **When** `scan-sources` runs, **Then** existing manifests are not rewritten (idempotent); only genuinely new refs land. _(NFR10)_

**Given** a re-scan after a source story has been edited, **When** `scan-sources` runs against a story still in `to-do/`, **Then** the manifest's `source_hash` updates; manifests not in `to-do/` are not touched.

**Given** the plugin skills tree, **When** I look at `skills/scan.md`, **Then** the skill exists and invokes `scan-sources` via the MCP server; running `/<plugin>:scan` produces the same result as calling `scan-sources` directly.

**Given** the execution manifest schema (Zod), **When** a malformed manifest is read, **Then** the MCP tool refuses with a human-readable error. _(FR13)_

**AC5 (integration):** vitest scans a fixture twice back-to-back and asserts idempotency + hash capture.

## Story 3.3: BMad adapter — v1 reference implementation

As a plugin operator using BMad,
I want my BMad-authored stories projected into execution manifests automatically,
So that I can keep authoring in BMad and have the plugin execute against my BMad backlog.

**Acceptance Criteria:**

**Given** the BMad story file format as it exists today,
**When** the implementer begins this story,
**Then** a brief BMad-format spike report exists at `plugins/<plugin>/docs/spikes/bmad-format.md` enumerating the source frontmatter fields, lifecycle vocabulary, and dependency syntax the adapter must handle.

**Given** a target repo with BMad-shaped sources under `_bmad-output/.../stories/`,
**When** `BmadAdapter.listSourceStories()` runs,
**Then** it returns one `SourceStory` per BMad story file, with normalised `acceptance_criteria` (each tagged `integration` or `unit`), `depends_on`, `narrative`, and `raw_frontmatter`. _(Architecture §BMad adapter)_

**Given** a BMad story whose lifecycle status maps to `Done`, **When** `BmadAdapter` reconciles status with our execution manifest, **Then** discrepancies (BMad says Done; manifest says in-progress) surface as a reconciliation prompt rather than a silent override.

**Given** the BMad adapter's fixture target repo at `mcp-server/src/adapters/bmad/fixtures/`, **When** the adapter integration tests run, **Then** every interface method (`detect`, `list`, `read`, `resolveSourcePath`) is exercised against committed fixture data.

**AC4 (integration):** vitest runs the BMad fixture suite end-to-end and asserts normalised `SourceStory` shape, including AC kind tagging and `depends_on` resolution.

## Story 3.3b: Adapter config seam — move `configureBmadAdapter` into `resolveWorkspace`

As a plugin maintainer,
I want adapter-specific context (e.g. BMad's `stories_root`) bound at workspace-resolution time rather than opportunistically inside each tool,
So that every caller of `resolveWorkspace` gets a fully wired adapter without having to know the adapter's name or call its `configure` helper themselves.

**Acceptance Criteria:**

**Given** `resolveWorkspace` in `mcp-server/src/state/workspace-resolver.ts`, **When** it returns a `Workspace`, **Then** any adapter-specific context binding (currently the `configureBmadAdapter({ targetRepo, storiesRoot })` call) has already been performed, using `targetRepoRoot` and the resolved `adapterConfig`.

**Given** `scan-sources.ts`, **When** I inspect the body of `scanSources()`, **Then** the `if (activeAdapterName === "bmad") { configureBmadAdapter(...) }` block is gone and the `configureBmadAdapter` import is removed; the tool relies on `resolveWorkspace` having wired the adapter.

**Given** any other current or future tool that calls `resolveWorkspace` (e.g. `get-status.ts`), **When** it subsequently invokes adapter methods, **Then** it does not need to call `configureBmadAdapter` (or any per-adapter `configure` helper) itself.

**Given** the BMad adapter's default `stories_root` fallback (`"_bmad-output/planning-artifacts/stories"`), **When** `adapterConfig.stories_root` is absent, **Then** `resolveWorkspace` applies the same default that `scan-sources` applied previously, so behaviour is unchanged.

**AC5 (integration):** the existing vitest suite for `scan-sources` (and any workspace-resolver tests) passes unchanged; a focused test asserts that calling `resolveWorkspace` against a BMad-shaped fixture leaves `BmadAdapter` in a bound state (calling `listSourceStories()` does not throw the "no bound context" error).

## Story 3.4: Native adapter, planner subagent, and `/plan` skill

As a plugin operator without a planning tool,
I want to open `/plan` and produce conforming native-adapter story files from a free-form intent conversation,
So that I can prime a backlog without adopting a separate planning tool.

**Acceptance Criteria:**

**Given** a target repo with `adapter: native` configured,
**When** I run `/<plugin>:plan`,
**Then** the planner subagent opens a conversation, interprets my intent, and produces story files at `<target-repo>/.flow/native-stories/<ref>.md` following the native-adapter body shape (`## Narrative`, `## Acceptance Criteria`, `## Implementation Notes`, `## Dependencies`). _(FR1, FR2, FR12)_

**Given** a target repo with `adapter: bmad` configured, **When** I run `/<plugin>:plan`, **Then** the skill points me at BMad's own authoring skills (`/bmad-create-story` etc.) and offers a `scanSources` pass to pick up newly authored stories. _(Architecture §Native adapter)_

**Given** a planner-produced native story, **When** it is validated, **Then** it parses against the native-story schema and produces a normalised `SourceStory` identical in shape to the BMad adapter's output. _(FR3, FR13)_

**Given** a planner conversation, **When** the user describes a feature in vague terms, **Then** the planner produces ACs at the user-value level (what the user *does*), not implementation level. _(FR4)_

**AC5 (integration):** vitest drives a scripted planning conversation against a fixture and asserts the resulting native-story files parse and reconcile via `scan-sources`.

## Story 3.5: Planning-discipline validation at authoring and scan time

As a plugin operator,
I want planning-discipline rules enforced — integration ACs for state-mutating stories, explicit `depends_on`, ship-gate refusal,
So that the backlog the dev loop drains is not silently broken.

**Acceptance Criteria:**

**Given** a state-mutating native story authored without an integration AC,
**When** the planner attempts to commit it,
**Then** the planner detects the omission and prompts the user to add an integration AC before the file is written. _(FR5)_

**Given** a native story whose body implicitly depends on another story (named in narrative or AC text), **When** the planner reviews it, **Then** the planner prompts the user to make the dependency explicit in `depends_on`. _(FR6)_

**Given** a backlog being committed without a ship-gate story (no story flagged as the final gate), **When** the planner finalises, **Then** it refuses to commit and surfaces the missing ship-gate. _(FR7)_

**Given** a BMad source story missing an integration AC for a state-mutating change, **When** `scan-sources` runs `validateAgainstDiscipline`, **Then** the manifest is created with `blocked_by: planning-discipline` and the missing field is cited in the block surface. _(Architecture Gap 1)_

**AC5 (integration):** vitest covers each of the four enforcement paths against fixtures.

## Story 3.6: Re-open planning mid-cycle and discard-a-feature flow

As a plugin operator,
I want to re-open the planner mid-cycle to add stories, edit pending ones, or discard a built feature,
So that I can correct course without restarting from scratch.

**Acceptance Criteria:**

**Given** a target repo with stories in progress,
**When** I run `/<plugin>:plan` again,
**Then** the planner surfaces the current backlog and offers add / edit-pending / discard actions; stories in `in-progress/` are not editable. _(FR8, FR14)_

**Given** I choose to discard a built feature, **When** the planner runs the discard flow, **Then** for the native adapter it produces a `revert/deprecate` story; for external adapters it calls `mark-withdrawn` on the manifest and reminds me to close the story in the source tool. _(FR78, Architecture Gap 3)_

**Given** a story marked `withdrawn: true`,
**When** the dev loop encounters it,
**Then** the story is skipped (not claimed).

**AC4 (integration):** vitest covers the three branches (add / edit-pending / discard) for both adapters.

## Story 3.7: Plain-language guideline and direct-edit allowance

As a non-engineer plugin operator,
I want stories whose bodies and ACs I can read on skim,
So that I'm not blocked by jargon when checking whether a story matches my intent.

**Acceptance Criteria:**

**Given** the planner catalogue prompt, **When** it is reviewed, **Then** it carries an explicit plain-language guideline directing the planner to write ACs accessible to a non-engineer who reads code at skim level. _(FR77, guideline)_

**Given** an execution manifest in `to-do/` or `blocked/`, **When** I edit the manifest by hand, **Then** subsequent reads reflect my edits and validation re-runs on next skill invocation. _(FR14)_

**Given** an execution manifest in `in-progress/`, **When** I try to hand-edit it, **Then** the next skill invocation flags the edit and refuses to proceed (orchestration surfaces the violation in v1). _(FR14)_

**AC4 (integration):** vitest asserts hand-edit acceptance in `to-do/` and refusal in `in-progress/`.

---
