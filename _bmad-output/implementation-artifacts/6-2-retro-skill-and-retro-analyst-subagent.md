# Story 6.2: `/crew:retro` skill and retro-analyst subagent

story_shape: substrate
Status: done

## Story

As a **plugin operator**,
I want **`/crew:retro` to run the cycle-level retro-analyst over the cycle's done manifests, telemetry, prior proposals, and (when present) the rule registry**,
So that **I get a single proposal markdown file summarising what to change — without the analyst ever touching canonical state directly**.

This is the middle story of the Epic 6a tranche (per the 2026-05-27 reframe — see `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-27-reframe.md` and memory `project_epic_6_phased`). 6.1 ships the structured-retro substrate; 6.3 ships the proposal-markdown writer + schema; 6.2 ships the orchestration: the slash-command skill, the analyst subagent, and the deterministic input-gathering seam that feeds the analyst.

## Dependencies

Depends on: bmad:6.3

- bmad:6.3

**Hard dep on Story 6.3.** The retro-analyst calls `writeRetroProposal` (the MCP tool delivered by 6.3) to emit the proposal markdown. **Land 6.3 before 6.2** so the analyst's allowlisted write path exists. If 6.3 is not yet merged when 6.2 is claimed, the dev MUST halt and surface the gap rather than fall back to a hand-written file in the wrong location (memory `feedback_stop_dont_fix_forward`).

**Soft dep on Story 6.1.** The analyst reads `lessons[]` from done/ manifests; without 6.1 the manifests carry no retro entries, so the analyst's output is signal-poor but still well-formed. Acceptable degradation — not listed as a formal dep above because the degradation is graceful.

## Acceptance Criteria

**AC1:**

The `/crew:retro` skill exists at `plugins/crew/skills/retro/SKILL.md` with frontmatter `name: crew:retro`, a one-line description, and `allowed_tools` covering only the tools the skill itself calls (NOT the subagent's tools). On invocation the skill resolves `targetRepoRoot`, calls `getStatus({ targetRepoRoot })` to surface the active adapter (no branch on adapter — the retro works against any adapter), calls `gatherRetroInputs({ targetRepoRoot })` to assemble the deterministic input bundle (see AC3), then spawns the retro-analyst subagent via Claude Code's `Task` tool using `readCatalogue({ role: "retro-analyst" })`'s Prompt section as the system prompt with an `<initial-context>` block containing the gathered inputs. _(FR56)_
artifact: plugins/crew/skills/retro/SKILL.md

**AC2:**

`plugins/crew/catalogue/retro-analyst.md` is rewritten to v1 mandate: read the cycle's done/ manifests, telemetry log, prior retro proposals, and (when present) the rule registry; produce **exactly one** proposal markdown file via `writeRetroProposal`; emit the locked terminal handoff phrase `Handoff to operator — retro proposal ready for review at <path>` on success. The prompt MUST include the negative-capability statement verbatim: *"You cannot mutate `docs/standards.md`, `docs/discipline-rules.yaml`, anything under `<target-repo>/.crew/state/`, `<target-repo>/.crew/sprint-history/`, or any persona / skill file. Your only write affordance is `writeRetroProposal`. If you find yourself reaching for any other write, stop and emit the yield phrase."* This is the prose belt; AC4 is the deterministic braces. _(FR57, FR60)_
artifact: plugins/crew/catalogue/retro-analyst.md

**AC3:**

A new MCP tool `gatherRetroInputs({ targetRepoRoot })` lives at `plugins/crew/mcp-server/src/tools/gather-retro-inputs.ts` and returns a typed bundle `{ doneManifests, telemetrySummary, priorProposals, ruleRegistry }`:
- `doneManifests`: every `.yaml` file under `<targetRepoRoot>/.crew/state/done/` parsed via `parseExecutionManifest` (filenames in deterministic alphabetical order); errors propagate as `MalformedExecutionManifestError`.
- `telemetrySummary`: every event from `<targetRepoRoot>/.crew/telemetry/*.jsonl` files in the **current cycle window** (v1: every `.jsonl` file present at gather time — cycle boundaries land in Story 6.12), parsed line-by-line through `TelemetryEventSchema`. Malformed lines are skipped, **counted**, and the count is returned as `telemetrySummary.skipped_count` so the analyst can flag corrupt logs without crashing the run.
- `priorProposals`: a list of `{ path, iso_timestamp }` for every existing `<targetRepoRoot>/.crew/retro-proposals/*.md`, sorted by ISO timestamp ascending. File contents are NOT loaded (analyst can read them via the `Read` tool if needed — keeps the bundle bounded).
- `ruleRegistry`: contents of `<targetRepoRoot>/docs/discipline-rules.yaml` parsed via the comment-preserving `yaml` package, or `null` when the file is absent (6a phase: the registry doesn't exist yet; 6.5 introduces it). Absence is NOT an error — the analyst proceeds with `ruleRegistry: null`.
artifact: plugins/crew/mcp-server/src/tools/gather-retro-inputs.ts

**AC4 (integration):**

Vitest covers both halves:
- **Negative-capability allowlist test** at `plugins/crew/mcp-server/src/tools/__tests__/retro-skill.test.ts` loads `plugins/crew/permissions/retro-analyst.yaml` and asserts `tools_allow` (a) **contains** `Read`, `gatherRetroInputs`, `writeRetroProposal`, `Task` (the analyst may spawn child Tasks for deep reads); (b) **does not contain** any tool that mutates canonical state — explicit deny-list assertion against `Edit`, `Write`, `writeNativeStory`, `claimStory`, `completeStory`, `recordStoryRetro`, `markWithdrawn`, `scanSources`, plus any future `apply*` / `regenerate*` tool name pattern via a regex `^(apply|regenerate|mutate|delete)[A-Z]/`. This is the load-bearing seam — memory `project_reviewer_first_call_enforcement_needed` shows prose-only mandates get skipped under load; the YAML denial is what makes FR60 binding.
- **Fixture-cycle gather test** in the same file: seed a `.crew/` tmp dir with three `done/` manifests (one with `lessons[]` populated per 6.1's shape, one without, one with a malformed `kind` — wait, malformed shouldn't reach done/; instead use one with `lessons: []` empty), one `.crew/telemetry/2026-05.jsonl` with three events plus one corrupted line, and two prior proposals. Call `gatherRetroInputs`; assert the returned bundle has `doneManifests.length === 3`, `telemetrySummary.events.length === 3`, `telemetrySummary.skipped_count === 1`, `priorProposals.length === 2`, `ruleRegistry === null`.
vitest: plugins/crew/mcp-server/src/tools/__tests__/retro-skill.test.ts

**AC5:**

`plugins/crew/permissions/retro-analyst.yaml` is refreshed to v1 surface: `tools_allow` = exactly `[Read, gatherRetroInputs, writeRetroProposal, Task]` plus `heartbeat` (carried forward — operator-watcher hook). `gh_allow` = `[pr-view]` (read-only). Stale entries from the v0 scaffold (`readSourceStory`, `lookupStandards`, `recordYield`) are removed — they were placeholder names that never existed as real MCP tools. The catalogue prompt's "locked_phrases" remain unchanged.
artifact: plugins/crew/permissions/retro-analyst.yaml

## Implementation Notes

### Out of scope for 6.2 (deliberate)

- **No proposal-markdown writing logic.** `writeRetroProposal` is Story 6.3's tool. The skill spawns the analyst; the analyst calls 6.3's tool. If 6.3 is not yet merged, halt (see Dependencies).
- **No cycle-boundary logic.** v1 treats "the current cycle" as "every `.jsonl` file currently in `.crew/telemetry/` plus every manifest in `.crew/state/done/`." Cycle archiving (`archive-cycle`) is Story 6.12. The skill MUST NOT rotate, archive, or delete any state directory.
- **No standards-doc or rule-registry mutation.** 6a phase per `project_epic_6_phased`. The analyst reads `discipline-rules.yaml` when present but the registry itself is introduced by Story 6.5; in v1 the file is absent and the analyst proceeds with `ruleRegistry: null`.
- **No outcome-stats computation.** `computeOutcomeStats` is Story 6.11. The analyst works from raw telemetry events in 6.2; the stats helper joins the rest of the picture later.

### Files touched

**NEW:**
- `plugins/crew/skills/retro/SKILL.md` — the slash-command entrypoint.
- `plugins/crew/mcp-server/src/tools/gather-retro-inputs.ts` — deterministic input bundle.
- `plugins/crew/mcp-server/src/tools/__tests__/retro-skill.test.ts` — both AC4 halves.

**UPDATE:**
- `plugins/crew/catalogue/retro-analyst.md` — rewrite mandate + negative-capability section + locked terminal handoff phrase per AC2. Preserve the YAML frontmatter `role:`, `domain:`, `model_tier:`, `locked_phrases:` keys.
- `plugins/crew/permissions/retro-analyst.yaml` — see AC5.
- `plugins/crew/mcp-server/src/tools/register.ts` — register `gatherRetroInputs` (read-only, no `DomainError` envelope needed beyond the standard pattern). Place the registration near the other read-path tools (e.g. after `readBacklogInventory`).

**MAYBE UPDATE (only if needed for typed errors):**
- `plugins/crew/mcp-server/src/errors.ts` — add `RetroProposalDirAbsentError` only if the analyst's gather path needs it; preferred approach is treat-absent-as-empty for `.crew/retro-proposals/` (mkdir-p-on-write semantics, owned by 6.3's `writeRetroProposal`). No new error type expected from 6.2 alone.

### SKILL.md shape (binding)

```markdown
---
name: crew:retro
description: "Run the cycle-level retro: gather done manifests + telemetry + prior proposals, spawn the retro-analyst, produce one proposal markdown for human review."
allowed_tools: [Task, getStatus, gatherRetroInputs, readCatalogue]
---

# /crew:retro

# What this skill does
Spawns the retro-analyst subagent against a deterministic input bundle assembled from the current cycle's done manifests, telemetry log, and prior proposals. The analyst produces exactly one proposal markdown file at `<target-repo>/.crew/retro-proposals/<ISO>.md` via `writeRetroProposal`. No canonical state mutates in this skill or its subagent — the proposal is inert until you read it.

# Prerequisites
A target repo with at least one done/ manifest. If `.crew/state/done/` is empty, the skill emits "No completed stories in this cycle — nothing to retro on" and exits.

# Steps
1. Identify the target repo root (current Claude Code workspace).
2. Call `getStatus({ targetRepoRoot })`. Surface any typed adapter-resolution error verbatim and stop.
3. Call `gatherRetroInputs({ targetRepoRoot })`. Surface any `MalformedExecutionManifestError` verbatim and stop.
4. If `doneManifests.length === 0`, emit "No completed stories in this cycle — nothing to retro on" and exit.
5. Call `readCatalogue({ role: "retro-analyst" })`. Use the Prompt section verbatim as the system prompt.
6. Spawn the retro-analyst subagent via the `Task` tool with:
   - system prompt: the Prompt section from step 5.
   - `<initial-context>` block: `{ targetRepoRoot, doneManifests, telemetrySummary, priorProposals, ruleRegistry }` from step 3.
7. The subagent runs, calls `writeRetroProposal`, and emits the terminal locked phrase. Surface the path to the operator.
8. Exit. Do not auto-apply anything — the proposal is human-gated by design (Epic 6b's `/accept-proposal` covers that).
```

### gatherRetroInputs tool shape (binding)

```ts
// plugins/crew/mcp-server/src/tools/gather-retro-inputs.ts

export interface GatherRetroInputsOptions {
  targetRepoRoot: string;
}

export interface RetroInputBundle {
  doneManifests: ExecutionManifest[];          // alphabetical by filename
  telemetrySummary: {
    events: TelemetryEvent[];                  // chronological by ts
    skipped_count: number;                     // malformed JSONL lines
    files_read: string[];                      // absolute paths, alphabetical
  };
  priorProposals: Array<{ path: string; iso_timestamp: string }>;
  ruleRegistry: unknown | null;                // raw yaml.parse result; null when file absent
}

export async function gatherRetroInputs(opts: GatherRetroInputsOptions): Promise<RetroInputBundle>;
```

Steps:
1. `doneManifests`: `fs.readdir('<targetRepoRoot>/.crew/state/done/')` → filter `.yaml` → sort alphabetical → for each, read + `yaml.parse` + `parseExecutionManifest`. Any malformed manifest throws and propagates.
2. `telemetrySummary`: `fs.readdir('<targetRepoRoot>/.crew/telemetry/')` → filter `.jsonl` → sort alphabetical → for each file, split by `\n`, skip empty lines, try `TelemetryEventSchema.parse(JSON.parse(line))`. On parse failure: increment `skipped_count`, continue. On `ENOENT` for the directory: return `events: [], skipped_count: 0, files_read: []`.
3. `priorProposals`: `fs.readdir('<targetRepoRoot>/.crew/retro-proposals/')` → filter `.md` → for each, derive `iso_timestamp` from the filename (which is `<ISO>.md` per Story 6.3 AC1). Sort by `iso_timestamp` ascending. On `ENOENT`: return `[]`.
4. `ruleRegistry`: try `fs.readFile('<targetRepoRoot>/docs/discipline-rules.yaml', 'utf8')` then `yaml.parse(text)`. On `ENOENT`: return `null`. On `yaml.parse` failure: propagate (the registry is the source of truth — corruption is a hard error).

All file I/O is pure read. No `writeManagedFile` calls. No state mutation.

### Negative-capability test (binding)

```ts
// plugins/crew/mcp-server/src/tools/__tests__/retro-skill.test.ts

const FORBIDDEN_TOOLS = [
  "Edit", "Write",
  "writeNativeStory", "claimStory", "completeStory", "recordStoryRetro",
  "markWithdrawn", "scanSources",
];
const FORBIDDEN_PREFIX_RE = /^(apply|regenerate|mutate|delete)[A-Z]/;

describe("retro-analyst negative-capability allowlist (Story 6.2 / FR60)", () => {
  it("permissions/retro-analyst.yaml contains only read + gather + write-proposal", () => { /* ... */ });
  it("permissions/retro-analyst.yaml denies every FORBIDDEN_TOOLS entry", () => { /* ... */ });
  it("no tool in tools_allow matches FORBIDDEN_PREFIX_RE (forward-compat for future apply*/regenerate*)", () => { /* ... */ });
});
```

The forward-compat regex is the load-bearing piece. When Story 6.5 lands `applyRuleProposal` or 6.5b lands `regenerateStandards`, this test fails-closed if anyone tries to add either tool to the analyst's allowlist. That's the desired behaviour: the calibration loop's negative capability is structural, not aspirational.

### Catalogue prompt rewrite (binding)

The current `catalogue/retro-analyst.md` is sketch-level. The rewrite MUST include:
- **Domain** — single sentence.
- **Mandate** — bulleted list anchored to 6.2's scope (reads done/, telemetry, prior proposals, registry-when-present; writes exactly one proposal).
- **Negative capability** — the verbatim paragraph from AC2.
- **`<initial-context>` contract** — name the four fields the skill passes; analyst MUST NOT invent or fetch additional context paths.
- **Prompt body** — adapt the planner.md format (behavioural invariants, prompt section, locked phrases) but for the retro context. Reuse the prose-discipline rules from the planner's "Plain-language guideline" section (FR77) — operator-readable proposals.
- **Locked terminal handoff phrase** — `Handoff to operator — retro proposal ready for review at <path>` (verbatim). The skill's exit condition greps for this.

Do NOT preserve any v0 content that names `readSourceStory`, `lookupStandards`, or `recordYield` — those tools don't exist. The catalogue file is rewritten from scratch against the v1 surface.

### Test plan (per AC4)

Layered:
1. **Permission-file static test** (negative-capability) — load YAML, assert allowlist shape. No subprocess, no fixtures. This is the fast win and the structural seam.
2. **Gather-tool integration test** — seed a tmp `targetRepoRoot` with the fixture shape described in AC4. Call `gatherRetroInputs`. Assert the bundle structure. Use `tmp-promise` (already a dev dep) for the scratch dir.
3. **Skill-level test** is NOT required in v1 — driving a SKILL.md programmatically is out-of-band for vitest. The skill's correctness comes from (a) the gather tool returning right data, (b) the catalogue prompt mandating right behaviour, (c) the allowlist refusing wrong behaviour. The integration is documented; the load-bearing seams are covered.

### Dependencies and ordering

- **Land 6.3 first.** 6.2's catalogue prompt mandates calling `writeRetroProposal` (6.3's tool). If 6.2 ships before 6.3, the analyst hits an undefined tool at runtime — the SKILL.md gather succeeds, the subagent boots, and then the writer call fails. Don't ship 6.2 against an unmerged 6.3.
- **6.1 independence.** 6.2 reads `lessons[]` if present, ignores if absent. Either order works for 6.1 vs 6.2.

### Build artefacts

Same rule as always: any `plugins/crew/mcp-server/src/` change triggers a rebuild and `dist/` is staged in the same commit. Verify zero unexpected drift before staging (memory: 5.24 is the determinism fix; if drift recurs, that's a 5.24 regression).

### Edge cases worth surfacing in dev/review

- **Empty cycle.** `doneManifests.length === 0` is the documented exit at SKILL Step 4. Don't spawn the analyst — there's nothing to retro on. Confirm the empty-cycle message lands cleanly and the skill returns success (not error).
- **Single telemetry file vs multiple.** v1 reads every `.jsonl` in `.crew/telemetry/`. If the operator's repo has historical files from prior cycles, they're all in scope. That's correct for v1 — cycle boundaries are Story 6.12's job. Don't pre-empt; document in the analyst prompt that the telemetry window is "everything currently on disk."
- **`.crew/retro-proposals/` doesn't exist yet.** First-ever retro: the dir is absent. AC3 mandates `ENOENT → []`. The dir gets created by 6.3's `writeRetroProposal` on first write (mkdir-p-on-write). Don't pre-create it from 6.2.
- **Analyst tries to bypass the allowlist.** The Claude Code permissions layer is the structural seam — even if the analyst's prompt is jailbroken or hallucinates an `apply*` call, the harness denies. The allowlist test in AC4 protects against accidental allowlist additions from future PRs; the runtime denial protects against runtime mischief. Belt and braces.
- **Locked-phrase grammar drift.** Memory `project_locked_phrase_grammar_drift` shows personas append trailing prose after handoff sentinels. The retro handoff phrase MUST sit on its own line. The skill's exit condition is a substring match, not a regex with anchors, so trailing prose won't *break* exit detection — but the analyst prompt should still demand the phrase on its own line for grep tooling downstream.
- **Plain-language operator readability.** The proposal markdown is operator-facing. The analyst prompt should inherit the planner's FR77 plain-language constraint (no `kind:`, no `failure_class:` jargon in body prose — those are field names in the proposal frontmatter, not narrative content). 6.3's schema defines the structure; 6.2's prompt defines the voice.

### Architectural fit / references

- **FR56** (slash-command invocation) — `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` line 85.
- **FR57** (reads done manifests + rule registry + outcome stats) — same file, line 86. v1 omits outcome-stats (Story 6.11); the analyst gets raw telemetry instead.
- **FR60** (negative capability) — same file, line 89.
- **Architecture §Skill calibration loop** — `_bmad-output/planning-artifacts/architecture/skill-calibration-loop.md`. The retro-analyst's role in producing the seven proposal-type discriminators belongs to 6.3 but the analyst's reasoning context comes from 6.2's inputs.
- **Deterministic-seam principle** — memory `feedback_default_to_deterministic_seams`. The negative-capability allowlist test (AC4) is exactly this pattern: refuse-at-the-boundary, not refuse-by-prose.
- **Planner.md as the catalogue-shape reference** — `plugins/crew/catalogue/planner.md`. Match its structure (behavioural invariants, prompt body, locked phrases, scope reminder); adapt content to the retro context.

## Definition of Done

- [ ] All five ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; new vitest covers both halves of AC4.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit.
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean — both AC1 (artifact) and AC2/AC5 (artifact) are file-presence checks; AC3 and AC4 have runnable vitest markers.
- [ ] No mutation of `docs/standards.md`, `docs/discipline-rules.yaml`, persona files, skill files outside the new retro skill, or any state directory.
- [ ] 6.3 is merged before this PR opens (cross-story sequencing rule).

## Dev Notes

*(Dev fills this in during implementation — any deviation from the binding tool shapes above, any unexpected behaviour from `Task` spawning, any test-harness friction worth recording for the next person.)*
