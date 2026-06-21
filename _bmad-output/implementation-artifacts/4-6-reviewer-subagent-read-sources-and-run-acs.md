# Story 4.6: Reviewer subagent — read sources and run ACs

story_shape: user-surface

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **the generalist-reviewer subagent to always read the source story, the PR diff, and `docs/standards.md` BEFORE any verdict reasoning, and to programmatically execute every integration-tagged AC against the diff (not eyeball it) before emitting a verdict**,
so that **`READY FOR MERGE` becomes trustworthy — when the operator sees that verdict in their chat surface they can trust the dev actually built the artifact each AC promised, instead of getting the rubber-stamp behaviour Story 4.3c's smoke caught on 2026-05-24 (`hello-a.txt` AC artifact never created; reviewer returned `READY FOR MERGE` anyway; story moved to `done/` carrying a green verdict against a broken artifact)**.

### What this story is, in one sentence

Introduce a tool-layer composite `runReviewerSession` MCP tool that the SKILL.md reviewer-spawn prose hands the just-claimed story ref + PR number to; the tool performs all three reads (source story via the active adapter, PR diff via `gh pr diff`, standards.md via the existing `lookupStandards`) in a guaranteed order, captures the standards-doc criteria as a `Record<criterionId, Criterion>` keyed by id, executes each integration-tagged AC against the diff via a structured runner, and returns a `ReviewerSessionResult` carrying `{ sourceStory, prDiff, standardsByCriterionId, acResults: Record<acIndex, AcResult> }` for the persona prose to compose a verdict from — closing the prose-flake loop the 4.3c smoke exposed (reviewer prose said "I checked" but didn't).

### What this story fixes (and why it needs its own story)

Stories 4.3 / 4.3b / 4.3c shipped the reviewer-spawn machinery: the SKILL.md prose invokes `Task` with the `generalist-reviewer` persona prompt; the reviewer outputs a transcript ending in `**Verdict: <SENTINEL>**`; `processReviewerTranscript` parses the verdict and (on `READY FOR MERGE`) atomically completes the story. The machinery works — Story 4.3c's smoke proved it.

The smoke also exposed what the machinery does NOT enforce: the reviewer is currently a persona prompt and nothing else. There is no tool-layer compulsion to actually read the diff, actually look at the source story, actually run the ACs. On 2026-05-24, the smoke reviewer returned `READY FOR MERGE` on a story whose only AC artifact (`hello-a.txt`) was never created. The dev's PR claimed it was created; the reviewer believed the dev; the verdict stamped green; the manifest moved to `done/`. All 4.3c contracts held. The artifact didn't exist.

This is the prose-flake failure mode (`feedback_prose_mut_steps_need_seam.md`) applied to the reviewer: prose-level MUST instructions ("read the source story, the PR diff, and standards.md") are flaky under load. The structural anchor (persona-file contents on disk) proves the prose SAYS the right thing; it does not prove the reviewer EXECUTES it. The 4.3c experience is the load-bearing evidence: same SKILL.md, same persona, two trials — one verified, one rubber-stamped. Pure non-determinism.

Story 4.6 closes that loop by moving "did I actually read the diff?" and "did I actually run AC2?" out of the prose layer and into a composite MCP tool whose return value the persona prose is structurally required to consume. The persona can no longer skip a read — there is nothing to skip; the tool did it. The persona can no longer skip an AC check — the tool returned a structured pass/fail per AC, and the persona's verdict line is composed from that structure.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Move the verdict-emission, comment-posting, or label-application surface. That is owned by Stories 4.6b, 4.7, and 4.8. This story stops at "the reviewer holds in memory a structured per-AC pass/fail and a `standardsByCriterionId` record". The verdict-line composition stays in the persona prose for now; v1 just feeds the prose better inputs.
- (c) ~~Modify `processReviewerTranscript`. The reviewer's transcript surface — the final-line `**Verdict: <SENTINEL>**` shape — is unchanged. `processReviewerTranscript`'s parsing path, manifest mutations, and `completeStory` call stay byte-identical to Story 4.3c's state. (Locked.)~~ **REVISED 2026-05-24 (revision 2 — see § Mid-flight revision history):** this story DOES modify `processReviewerTranscript`. The verdict-extraction logic is rewritten to read from the persisted `reviewer-result.json` file rather than scrape the reviewer's chat for `**Verdict: <SENTINEL>**`. See locked-files exception below and AC3/AC4 updates.
- (d) Add real PR-comment posting. Posting inline + summary comments is Story 4.6b. Story 4.6 holds results in memory; Story 4.6b reads that memory (via the same composite tool's return value, re-invoked or persisted between spawn and post — Story 4.6b owns the wire-up choice).
- (e) Implement risk-tier classification. The persona body mentions classifying risk tier as a behaviour; that's Story 4.9 / 4.9b. v1 reviewer reads standards and runs ACs only; risk-tier classification is a no-op stub returning `medium` if any caller asks (no caller will in this story).
- (f) Add a "manual-check-required" UI path. The structured result carries an `applicability: "runnable" | "manual-check-required"` flag per AC (see (2c)); rendering that into a comment surface is 4.6b. Story 4.6 just produces the flag.
- (g) Touch the dev subagent path or any dev-side persona/tool. The dev cycle from Stories 4.2–4.5 is locked.
- (h) Add `pr-diff` to the `gh_allow_args` map. v1 enforcement is subcommand-only (Story 4.4 wrapper). `pr-diff` is added to `gh_allow` in `permissions/generalist-reviewer.yaml` and that is sufficient. (Note: `pr diff` is the actual `gh` segment shape; per Story 4.4's normaliser, the role-spec entry is kebab `pr-diff`.)
- (i) Change the standards-doc schema. The criteria array, the `name`/`what`/`check`/`anti_criterion` fields, and the `.max(10)` cap are unchanged. v1 derives a `criterionId` from the existing `name` field by slugifying it (lowercase, non-alnum → `-`). No on-disk schema change.
- (j) Add new locked phrases. The reviewer still emits `**Verdict: <SENTINEL>**` and Story 4.6b owns any verdict-text changes. The composite tool is invoked from the persona prose with structured args; no new locked-phrase grammar is introduced.
- (k) Implement an AC executor that runs arbitrary user code. v1's "AC execution" is constrained to two checkable shapes: (i) artifact-existence checks (path-based, `fs.access`) and (ii) vitest-test-name references (the AC body contains a `vitest:<test-name>` token that the runner resolves by running `pnpm vitest --run -t "<test-name>"` and capturing pass/fail). ACs that match neither shape are flagged `applicability: "manual-check-required"` and surfaced unchanged in the structured result. The runner does NOT shell out to arbitrary scripts the AC body might describe in prose. See (2c) for the full applicability matrix.
- (l) Modify `lookupStandards` or the `StandardsDoc` schema. The composite tool calls the existing function as-is; it adds an in-tool derivation step (`Record<criterionId, Criterion>` keyed by slugified `name`) on top of the returned array. That derivation is a pure helper, not a schema change.
- (m) Emit telemetry. Story 4.12 owns reviewer-side `agent.invoke` and `reviewer.verdict` JSONL events. v1's composite tool is silent on telemetry; a TODO comment marks the obvious 4.12 wire-up point in code.
- (n) Add a target-repo override path for the reviewer persona. Personas resolve from the team copy at `<targetRepoRoot>/team/generalist-reviewer/PERSONA.md` (Story 2.3); that path is unchanged.

---

## Acceptance Criteria

> AC1, AC2, AC3, AC4 are verbatim from the epic. AC5 is the user-surface contract this story makes — the operator-observable promise that the rubber-stamp failure mode is closed. Per `plugins/crew/docs/user-surface-acs.md`, AC5 tagged `(user-surface)`; the others describe internal reviewer behaviour and stay untagged. AC4 retains its `(integration)` tag.

**AC1:**
**Given** a PR opened by the dev subagent,
**When** the reviewer subagent boots,
**Then** it reads the source story (via the adapter), the PR diff (via `gh pr diff`), and `docs/standards.md`; all three reads complete before any verdict reasoning begins. _(FR30, FR32)_

<!-- Not user-surface: AC1 describes internal reviewer-subagent boot behaviour; the operator-visible promise is AC5. -->

**AC2:**
**Given** the story's acceptance criteria, **When** the reviewer runs them, **Then** runnable ACs (integration-tagged ones in particular) are executed and pass/fail results are captured in memory for the comment-posting step. _(FR31)_

<!-- Not user-surface: AC2 describes in-memory data shape for downstream (Story 4.6b) consumption. -->

**AC3:**
**Given** the standards-doc lookup AND the executed AC results, **When** the reviewer's composite tool returns, **Then** (a) the criteria array is held in memory keyed by id so each can be checked against the diff independently, AND (b) `runReviewerSession` persists a structured `reviewer-result.json` to `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/` containing `recommendedVerdict` derived deterministically from `acResults` (literal: `"READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED"`), AND (c) `processReviewerTranscript` reads that file and returns the corresponding result variant — the verdict transport is the file, not the chat. _(FR32)_

<!-- Not user-surface: AC3 is the structural-anchor AC asserting (i) an internal data shape and (ii) the file-based verdict transport. Revised 2026-05-24 (revision 2) to fold in deterministic-verdict-transport. -->

**AC4 (integration):**
vitest drives the reviewer's read-and-execute phase against a fixture PR and asserts (a) all three reads succeed, (b) integration-AC execution returns structured pass/fail per AC, (c) `runReviewerSession` writes `reviewer-result.json` at the expected path with the correct JSON shape and `recommendedVerdict` literal per the deterministic algorithm, (d) `processReviewerTranscript` reads the file and returns the matching variant, and (e) when the file is absent, `processReviewerTranscript` returns `done-blocked-no-session-result`.

<!-- Not user-surface: vitest integration suite — internal harness only. Revised 2026-05-24 (revision 2) to cover file-persistence and file-read paths. -->

**AC5 (user-surface):**
**Given** a target repo with a ready story whose dev subagent fails to produce the AC artifact (the canonical 4.3c rubber-stamp scenario reproduced),
**When** the operator runs `/crew:start` against that scratch repo end-to-end and the reviewer subagent reaches the verdict step,
**Then** the operator observes (a) the in-progress manifest stamped with `blocked_by: "reviewer-verdict-needs-changes"` (or the equivalent variant for `BLOCKED`) — derived from `recommendedVerdict` in the persisted `reviewer-result.json`, NOT from chat-prose scraping — AND (b) the missing artifact (`target-file.txt`) is referenced in either the reviewer's chat output OR the `acResults[0].reason` field of the persisted `reviewer-result.json`, AND (c) the manifest does NOT move to `done/`. The 4.3c rubber-stamp behaviour (green verdict against a missing artifact) is no longer observable; AND the 2026-05-24 trial-7 failure mode (correct semantics defeated by `done-blocked-reviewer-grammar` because the reviewer LLM appended trailing prose after the verdict sentinel) is no longer possible — the verdict transport is structured, not prose. _(FR30, FR31, FR32 — operator-observable promise)_

<!-- User-surface: AC5 names `/crew:start`, the operator's chat surface, and the manifest's `blocked_by` stamp (now derived from the persisted file). Revised 2026-05-24 (revision 2): the verdict text is no longer the load-bearing chat artifact — the file is. AC5's prose-reference clause is satisfied by EITHER chat OR the persisted reason field. Smoke-gate this AC via operator-smoke before merging. -->

### Expanded acceptance specifics (folded into AC1–AC5 above; each clause maps to an AC for the AC-table gate)

**AC1 unpacked.** Read ordering, source plumbing, and "before any verdict reasoning":

- (1a) **Composite tool entrypoint:** a new MCP tool `runReviewerSession` is registered (added to `register.ts`'s tool list and to the SKILL.md `allowed_tools` array). Signature: `runReviewerSession({ targetRepoRoot: string, sessionUlid: string, ref: string, prNumber: number, role: string = "generalist-reviewer" }) → Promise<ReviewerSessionResult>`. The tool performs the three reads in fixed order (source story → PR diff → standards) and the AC execution pass before returning. No persona prose runs between the reads and the return.
- (1b) **Source-story read via active adapter:** the tool resolves the workspace (`resolveWorkspace({ targetRepoRoot })`, same pattern as `processDevTranscript`/`processReviewerTranscript`) and calls `workspace.activeAdapter.readSourceStory(ref)`. The returned `SourceStory` (shape per `adapters/adapter.ts`) is held verbatim in the result under `sourceStory`. On `SourceFileNotFoundError` or any adapter read error, the tool re-raises the typed error unchanged — the SKILL.md prose surfaces it and the reviewer cycle stops (no verdict is composed against an unreadable source).
- (1c) **PR-diff read via existing `gh` wrapper:** the tool calls `gh({ role, permissions, subcommand: "pr-diff", args: [String(prNumber)] })` where `permissions` is the loaded `RolePermissions` for `generalist-reviewer` (Story 2.2's `loadRolePermissions`). The wrapper's `gh_allow` enforcement applies — `pr-diff` MUST be present in `permissions/generalist-reviewer.yaml`'s `gh_allow` list (added in Task 2). The wrapper's recoverable-error classification (Story 4.5) applies unchanged; on `GhRecoverableError` the tool re-raises and the SKILL.md prose surfaces it. The wrapper's `stdout` is held in the result under `prDiff` (raw unified-diff string).
- (1d) **Standards read via existing `lookupStandards`:** the tool calls `lookupStandards(targetRepoRoot)` (existing `state/lookup-standards.ts`). The returned `StandardsDoc` (`{ version, updated, criteria[], sourcePath }`) is held verbatim in the result under `standards`. On `StandardsDocMissingError` or `StandardsDocMalformedError`, the tool re-raises — same propagation pattern as (1b)/(1c).
- (1e) **Read order is fixed and enforced by sequential `await`:** the tool body MUST perform `const sourceStory = await ...; const prDiff = await ...; const standards = await ...;` in that exact order, with no `Promise.all` parallelism. Rationale: deterministic error surface (a `StandardsDocMissingError` doesn't race a `SourceFileNotFoundError`); deterministic test seam (vitest can stub each read in turn). The integration test in AC4 asserts this ordering by stub-call sequence.
- (1f) **"Before any verdict reasoning begins" mechanically:** the composite tool returns the structured result; the persona prose THEN reads it and composes the verdict text. The persona body is updated (Task 3) so the prompt instructs the reviewer subagent to invoke `runReviewerSession` as its FIRST action and to consume the returned structure for verdict composition. The prose-flake risk is constrained to "did the persona call the tool" (one prose decision) rather than "did the persona execute three reads + N AC checks" (N+3 prose decisions). The persona invocation of `runReviewerSession` is itself a single tool call, and tool calls fail loudly when omitted (the reviewer cannot compose `acResults` from thin air — there is nothing to read).
- (1g) **Initial-context shape:** the SKILL.md reviewer-spawn `initial_context` block (currently passes `ref`, `title`, `sessionUlid`, `targetRepoRoot`) is extended to also carry `prNumber: <n>`. The PR number is obtained from the dev subagent's transcript output. `processDevTranscript` is extended (declared change — see locked-files note) to parse the PR URL from the dev's transcript final line (the dev emits the PR URL after `gh pr create` per Story 4.4), extract the trailing integer, and return it on the `spawn-reviewer` result. The SKILL.md prose then includes it in the reviewer's `initial_context`. The persona prompt instructs the reviewer to pass it as the `prNumber` arg to `runReviewerSession`. If `prNumber` cannot be parsed from the dev transcript (e.g. the dev didn't push), `processDevTranscript` raises a new typed `PrUrlNotFoundInDevTranscriptError` and the SKILL.md prose surfaces it; the reviewer is not spawned.

**AC2 unpacked.** AC execution mechanics, applicability matrix, and the `acResults` shape:

- (2a) **AC enumeration via existing `extractAcsFromSpec`:** the composite tool reuses `lib/extract-acs-from-spec.ts` to enumerate ACs from the source story's spec path. The adapter's `SourceStory` carries `specPath` (verify shape in `adapters/adapter.ts`; native adapter returns `specPath = <targetRepoRoot>/.crew/native-stories/<ULID>.md`). The tool calls `extractAcsFromSpec(specPath)` and gets back an `AcEntry[]` (`{ index, firstLine }`). v1 extends the existing extractor by ALSO capturing the `(user-surface)`/`(integration)`/`(<tag>)` parenthetical tag and the full body lines (until the next AC heading or end of section). The extended return type is `AcEntry[]` with new fields `tag?: string` and `body: string[]`. The extractor change is additive — existing callers (Story 4.4) read only `{ index, firstLine }` and are unaffected. (Declared locked-file change — see § Locked files.)
- (2b) **Applicability classifier:** for each `AcEntry`, the tool classifies applicability by scanning `body` lines:
  - **`runnable-artifact-check`:** body contains a line matching `/^artifact:\s*(\S+)$/` (e.g. `artifact: hello-a.txt`). The artifact path is resolved relative to `targetRepoRoot`.
  - **`runnable-vitest`:** body contains a line matching `/^vitest:\s*(.+)$/` (e.g. `vitest: completeStory atomically renames manifest`). The capture group is the test-name filter passed to `pnpm vitest --run -t "<name>"`.
  - **`manual-check-required`:** neither pattern matches.
  - If both patterns match in the same AC body, `runnable-artifact-check` takes precedence (artifact existence is the cheapest, most-deterministic check; mirrors the 4.3c rubber-stamp failure mode directly).
- (2c) **`AcResult` shape (per AC, keyed by `index`):**
  ```ts
  type AcResult =
    | { index: number; tag: string | null; applicability: "runnable-artifact-check"; artifactPath: string; status: "pass" | "fail"; reason: string }
    | { index: number; tag: string | null; applicability: "runnable-vitest"; testNameFilter: string; status: "pass" | "fail"; reason: string; stdout: string; stderr: string; exitCode: number }
    | { index: number; tag: string | null; applicability: "manual-check-required"; reason: string };
  ```
  - **Artifact-check runner:** `await fs.access(path.resolve(targetRepoRoot, artifactPath))` — pass if it resolves, fail if `ENOENT`. `reason` on pass: `"artifact present at <path>"`. `reason` on fail: `"artifact missing at <path> (ENOENT)"`. Any other error (e.g. EACCES) raises and propagates uncaught.
  - **Vitest runner:** `execa("pnpm", ["vitest", "--run", "-t", testNameFilter], { cwd: targetRepoRoot, reject: false })`. `status: "pass"` if `exitCode === 0`; `status: "fail"` otherwise. `reason` on pass: `"vitest filter '<filter>' passed"`. `reason` on fail: `"vitest filter '<filter>' failed (exit <code>)"`. `stdout`/`stderr` are the raw process streams (capped at 4000 chars each to bound the result size — truncation marker appended if cut).
  - **Manual-check-required runner:** no execution. `reason` = `"AC body has no `artifact:` or `vitest:` marker — manual check required before merge"`.
- (2d) **`acResults` keyed by index, not by array position:** the tool returns `acResults: Record<number, AcResult>` keyed by the AC's numeric index from the spec (so `acResults[2]` is AC2's result). Rationale: makes downstream (Story 4.6b) lookup unambiguous against the spec's `**AC2:**` heading; survives reorderings; matches the AC1's "ACs ... captured in memory" wording from the epic.
- (2e) **Integration-tagged ACs are NOT special-cased at the runner level:** AC2's wording singles out "integration-tagged ones in particular" but the runner applies the same applicability classifier to every AC regardless of tag. The tag is preserved on each `AcResult` so downstream (4.6b) can prioritise integration ACs in the summary comment. v1 runner: tag-agnostic execution; tag-aware reporting.
- (2f) **Execution order is sequential:** ACs are executed in numeric-index order, one at a time. No `Promise.all`. Rationale: deterministic test surface and bounded resource use (vitest runs serialise naturally with `--run`; parallel `execa` of `pnpm vitest` would race the vitest cache).
- (2g) **Per-AC timeout:** vitest runs are capped at 90 seconds wall-clock (`execa` with `timeout: 90_000`). On timeout, `status: "fail"`, `reason: "vitest filter '<filter>' timed out after 90s"`. The 90s cap is well below Story 4.12's hard-8-min reviewer cap; an AC that needs longer than 90s is over-broad and should be sharded.
- (2h) **No-AC story handling (revised — revision 2):** if `extractAcsFromSpec` returns an empty list, `acResults` is `{}` (empty record). The tool returns successfully with `recommendedVerdict: "BLOCKED"` (per the closed algorithm in (3f) — empty set of `runnable-*` passes does not certify; the verdict default for "we cannot certify" is `BLOCKED`). The persisted `reviewer-result.json` carries `recommendedVerdict: "BLOCKED"` and `acResults: {}`; `processReviewerTranscript` stamps `blocked_by: "reviewer-verdict-blocked"`. The reviewer persona may chat-summarise "source story declares no ACs" but that summary is informational only. The runner does not synthesise a placeholder AC.

**AC3 unpacked.** The `standardsByCriterionId` shape and the slugify rule:

- (3a) **`standardsByCriterionId` shape on the result:** `Record<string, Criterion>` where the key is `slugify(criterion.name)` and the value is the verbatim `Criterion` from the parsed `StandardsDoc`. `Criterion` shape per `schemas/standards-doc.ts`: `{ name, what, check, anti_criterion }`. The composite tool MUST produce this record before returning — the persona prose cannot construct it (the tool is the only path that holds the parsed doc).
- (3b) **`slugify(name)` rule:** lowercase the string, replace any character matching `/[^a-z0-9]+/g` with `-`, trim leading/trailing dashes. E.g. `"story-aligned"` → `"story-aligned"`; `"No Canonical FS Writes Outside MCP"` → `"no-canonical-fs-writes-outside-mcp"`. The slugify helper is a new pure function in `lib/slugify-standards-criterion.ts` (one export, no deps).
- (3c) **Duplicate-name guard:** the standards-doc schema doesn't currently forbid duplicate `name`s across criteria (verify in `schemas/standards-doc.ts` — the `.max(10)` cap is on array length, not name uniqueness). If `slugify` produces the same id for two criteria, the composite tool raises a new typed `DuplicateStandardsCriterionIdError({ criterionId, names })` listing both offending names. This is a real bug surface — the standards doc should not have two criteria the reviewer can't distinguish.
- (3d) **`standardsByCriterionId` available to v1 but not yet consumed for AC execution:** v1's runner does NOT cross-check each AC against each standards criterion. That cross-check belongs in Story 4.6b's verdict-composition path. v1 produces the record; v1's persona prose may read it to inform verdict text; v1's structured contract is just "the record exists, keyed correctly".
- (3e) **`standards.version` is held on the result:** under `result.standards.version` (the existing `StandardsDoc` field). Story 4.7 will read it for version stamping. v1 just preserves it.

- (3f) **`recommendedVerdict` deterministic derivation (NEW — revision 2):** `runReviewerSession` computes a `recommendedVerdict: "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED"` literal-typed union field from `acResults` before returning. Algorithm (closed set; the tool decides, the LLM does not):
  1. If `Object.values(acResults).some(r => r.status === "fail")` → `"NEEDS CHANGES"`.
  2. Else if `acResults` is empty OR `Object.values(acResults).some(r => r.applicability === "manual-check-required")` → `"BLOCKED"`. (Empty `acResults` means no runnable check exists to certify correctness — per (2h), no-AC stories produce `recommendedVerdict: "BLOCKED"`.)
  3. Else → `"READY FOR MERGE"`. (Every AC is `runnable-*` AND status `"pass"`.)
- (3g) **Persisted `reviewer-result.json` side-effect (NEW — revision 2):** before returning, `runReviewerSession` serialises the full `ReviewerSessionResult` to disk via `atomicWriteFile` (Story 1.6's helper) at the path `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json`. File contents shape: `{ sessionUlid, ref, recommendedVerdict, acResults, standardsByCriterionId, sourceStoryRef, prNumber }` (the `sourceStory` and `prDiff` fields are NOT persisted — they're heavy reads kept in-memory only for the return value; only the verdict-relevant projection lives on disk). The directory is created via `mkdir -p` semantics if absent. This is the same tool-layer side-effect pattern as Story 4.3c's `completeStory` call inside `processReviewerTranscript`: load-bearing decisions live in the tool layer, not in LLM prose.
- (3h) **The persisted file is the verdict transport (NEW — revision 2):** the reviewer's chat output is informational only after revision 2. `processReviewerTranscript` reads `reviewer-result.json` and uses its `recommendedVerdict` field as the authoritative verdict. The locked-phrase `**Verdict: <SENTINEL>**` line in the reviewer's chat is no longer parsed — the reviewer LLM may emit it or omit it; either way the manifest mutation is decided by the file's `recommendedVerdict`. See § Mid-flight revision history for why this matters (trial 7 of the 2026-05-24 smoke).

**AC4 unpacked.** vitest integration suite — fixture shape, stub shape, assertions:

- (4a) **Fixture base:** a tmpdir created by `mkdtempSync(path.join(os.tmpdir(), "crew-4-6-"))`, structured as:
  - `<tmp>/.crew/config.yaml` declaring `active_adapter: native`.
  - `<tmp>/.crew/native-stories/01HZ-fixture-story.md` with a planning-discipline-compliant spec containing 3 ACs: AC1 with `artifact: hello-a.txt`, AC2 with `vitest: fixture passing test`, AC3 with no marker (manual-check-required).
  - `<tmp>/.crew/state/in-progress/native:01HZ-fixture-story.yaml` manifest claimed by the test session.
  - `<tmp>/docs/standards.md` matching the shipped `standards-example.md` (4 criteria, valid).
  - A real `hello-a.txt` file at `<tmp>/hello-a.txt` (the artifact AC1 expects).
  - A vitest test in `<tmp>/__tests__/fixture.test.ts` named `"fixture passing test"` that the runner can hit.
- (4b) **Stub seam for `gh pr-diff`:** an injected `execaImpl` (the same test seam used in `gh.ts` and Story 4.5's tests) returns scripted `{ stdout, stderr, exitCode }` for `gh pr diff <prNumber>`. The stub returns a valid unified-diff string. The `execaImpl` is passed to `runReviewerSession` via a new optional `execaImpl?: typeof execa` parameter (mirrors `gh.ts`'s pattern). Production callers do not pass it.
- (4c) **Three-reads assertion:** the test wraps the three I/O functions with `vi.fn` spies (`readSourceStory`, the injected `execaImpl` for `gh pr-diff`, and `lookupStandards`) and asserts: (i) all three were called exactly once, (ii) `readSourceStory.mock.invocationCallOrder[0] < execaImpl.mock.invocationCallOrder[0] < lookupStandards.mock.invocationCallOrder[0]`. The strict ordering claim from (1e) is mechanically verified.
- (4d) **AC-execution structured-result assertion:** the returned `acResults` has three entries:
  - `acResults[1].applicability === "runnable-artifact-check"`, `status === "pass"`, `artifactPath === "hello-a.txt"`, `reason` contains `"artifact present"`.
  - `acResults[2].applicability === "runnable-vitest"`, `status === "pass"`, `testNameFilter === "fixture passing test"`, `exitCode === 0`.
  - `acResults[3].applicability === "manual-check-required"`, no `status` field (TS literal-typed union enforces this), `reason` contains `"manual check required"`.
- (4e) **Standards-by-id assertion:** `standardsByCriterionId["story-aligned"].what` contains the verbatim `what` field from `standards-example.md`. `Object.keys(standardsByCriterionId).length === 4`.
- (4f) **Negative path — missing artifact:** a second test case removes `<tmp>/hello-a.txt` before invoking; asserts `acResults[1].status === "fail"`, `reason` contains `"ENOENT"` and the resolved absolute path of `hello-a.txt`. This is the inline-test version of AC5's user-surface promise.
- (4g) **Negative path — failing vitest:** a third test case rewrites `<tmp>/__tests__/fixture.test.ts` to fail; asserts `acResults[2].status === "fail"`, `exitCode !== 0`, `reason` contains `"vitest filter '... ' failed"`.
- (4h) **Negative path — duplicate criterion id:** a fourth test case writes a malformed `docs/standards.md` with two criteria named `Story Aligned` and `story aligned` (both slugify to `story-aligned`); asserts the tool raises `DuplicateStandardsCriterionIdError` with both names in the error message.
- (4i) **Negative path — `pr-diff` recoverable error:** a fifth test case stubs `execaImpl` to return `{ exitCode: 4, stderr: "API rate limit exceeded", stdout: "" }`. Asserts the wrapper raises `GhRecoverableError({ class: "defer", subcommand: "pr-diff" })` and it propagates through `runReviewerSession` uncaught. (Reviewer-side recoverable-error routing is a future story; v1 just ensures the error is not swallowed.)
- (4j) **Negative path — adapter read error:** a sixth test case deletes the source-story file before invocation; asserts `SourceFileNotFoundError` propagates from `runReviewerSession` uncaught.

- (4k) **`reviewer-result.json` persistence (NEW — revision 2):** after the happy-path invocation in (4d), assert: (i) the file exists at `<tmp>/.crew/state/sessions/<sessionUlid>/reviewer-result.json`; (ii) parsing it yields an object with keys `{ sessionUlid, ref, recommendedVerdict, acResults, standardsByCriterionId, sourceStoryRef, prNumber }`; (iii) `recommendedVerdict === "READY FOR MERGE"` (all ACs pass in the happy fixture). For the missing-artifact case (4f), assert the file exists and `recommendedVerdict === "NEEDS CHANGES"`. For an all-manual-check case (synthesise a third fixture variant if needed, or use the existing one with all artifact/vitest markers stripped), assert `recommendedVerdict === "BLOCKED"`.

- (4l) **`processReviewerTranscript` reads the file (NEW — revision 2):** a new test (or new test file `process-reviewer-transcript.test.ts` extension) pre-populates `<tmp>/.crew/state/sessions/<sessionUlid>/reviewer-result.json` with a hand-crafted object carrying `recommendedVerdict: "READY FOR MERGE"` and a fully-passing `acResults`; invokes `processReviewerTranscript` with an empty (or arbitrary-prose) `reviewerTranscript` arg; asserts the result variant is the existing `done-merged` (or whatever the current 4.3c happy-path variant is named) and that `completeStory` was invoked. Repeat with `recommendedVerdict: "NEEDS CHANGES"` → assert the in-progress `blocked_by` stamp is set to `"reviewer-verdict-needs-changes"`. Repeat with `"BLOCKED"` → assert `blocked_by: "reviewer-verdict-blocked"`. Verdict text in the chat is irrelevant for these assertions — the file drives the outcome.

- (4m) **Missing-file path (NEW — revision 2):** invoke `processReviewerTranscript` against a tmpdir where `<sessionUlid>/reviewer-result.json` does NOT exist; assert the returned variant is the new `done-blocked-no-session-result` with `blocked_by: "reviewer-no-session-result"` stamped on the in-progress manifest. This is the rubber-stamp protection analogous to Story 4.3c's reviewer-grammar protection: if the reviewer subagent skipped the tool invocation entirely, the operator gets a loud blocker rather than a silent rubber-stamp.

**AC5 unpacked.** The user-surface contract and the smoke-gate evidence:

- (5a) **Reproducer scenario (the 4.3c rubber-stamp scenario, made deterministic):** a scratch repo configured for `/crew:start` end-to-end (mirrors the 4.3c smoke harness in `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/`). One source story in `.crew/native-stories/` with one AC: `artifact: target-file.txt`. The dev subagent's persona prompt is patched (in the smoke harness only) to terminate without creating `target-file.txt` — i.e. the dev "claims" it built the artifact and emits the handoff phrase, but the file is not on disk. This is the deterministic version of what the 4.3c smoke caught accidentally.
- (5b) **Operator-observable manifest state (revised 2026-05-24 — revision 2):** the binding contract is the manifest's `blocked_by` stamp, NOT the chat verdict line. After Story 4.6 lands, the in-progress manifest carries `blocked_by: "reviewer-verdict-needs-changes"` (or `"reviewer-verdict-blocked"` for the manual-check variant), derived deterministically by `processReviewerTranscript` from `reviewer-result.json`'s `recommendedVerdict` field. The reviewer's chat MAY also emit `**Verdict: NEEDS CHANGES**` for human readability but this is no longer parsed — the persona prose is unconstrained after the `runReviewerSession` invocation. The 2026-05-24 trial-7 failure mode (trailing prose after the verdict sentinel defeating the locked-phrase parser) is mechanically impossible because the parser has been retired.
- (5c) **Manifest-state assertion:** at the end of the inner cycle, the manifest state is determined by `recommendedVerdict` in the persisted `reviewer-result.json` (per Task 8b.3):
  - On `recommendedVerdict === "NEEDS CHANGES"` → manifest's `blocked_by` IS stamped with `"reviewer-verdict-needs-changes"` and the manifest stays in `in-progress/`.
  - On `recommendedVerdict === "BLOCKED"` → manifest's `blocked_by` IS stamped with `"reviewer-verdict-blocked"` and the manifest stays in `in-progress/`.
  - On `recommendedVerdict === "READY FOR MERGE"` → existing 4.3c semantics apply (`completeStory` fires, manifest moves to `done/`).
  For the AC5 reproducer scenario (missing `target-file.txt` → AC1 `status: "fail"`), `recommendedVerdict === "NEEDS CHANGES"` and the manifest carries `blocked_by: "reviewer-verdict-needs-changes"`, remaining in `in-progress/`.
- (5d) **Missing-artifact reference (revised 2026-05-24 — revision 2):** the literal `target-file.txt` MUST appear in EITHER the reviewer's transcript summary OR the persisted `reviewer-result.json`'s `acResults[<index>].reason` field for the failing AC, alongside a fail-signal word (one of `"missing"`, `"not found"`, `"ENOENT"`, `"fail"`). The `reason` field is mechanically guaranteed: per (2c), the `runnable-artifact-check` runner's failure reason is `"artifact missing at <path> (ENOENT)"` — which contains `target-file.txt` and `"missing"`/`"ENOENT"` by construction. The chat-prose path is best-effort (the persona is instructed in the revised Task 8 to fold reasons into the summary, but the smoke gate passes if the file alone carries the reference — the operator can inspect the file). This is the deliberate revision-2 loosening: the load-bearing artifact-path reference lives in the structured file; the chat is a nicety, not a contract.
- (5e) **Smoke-gate evidence:** operator-smoke evidence (per `plugins/crew/docs/user-surface-acs.md` § Pre-PR gate) is mandatory before merge. The smoke can be either (i) the automated `operator-smoke` vitest harness driving the scratch repo, or (ii) an operator pasting verbatim Claude Code transcript output from a manual `/crew:start` run. The smoke must show the reproducer scenario producing a non-READY-FOR-MERGE verdict and the manifest staying in `in-progress/`.

---

## Tasks / Subtasks

The implementation order below is **load-bearing**. Some files have ordering constraints (e.g. `register.ts` cannot expose `runReviewerSession` until the tool exists). Follow it.

- [ ] **Task 1: Extend `extractAcsFromSpec` to capture tag + body** (AC: #2)
  - [ ] 1.1 Open `plugins/crew/mcp-server/src/lib/extract-acs-from-spec.ts`. Extend `AcEntry` interface with `tag: string | null` and `body: string[]`.
  - [ ] 1.2 In the parser loop, capture the parenthetical tag from `headingMatch[2]` (already captured by the existing regex; just unwrap parens and trim). Populate `tag`.
  - [ ] 1.3 After locating the AC heading, collect every subsequent non-blank line until the next AC heading or end of file into `body`. Do NOT trim individual lines; preserve verbatim. (The applicability classifier in Task 4 needs verbatim body to grep for `artifact:` / `vitest:`.)
  - [ ] 1.4 Update existing call sites that destructure only `{ index, firstLine }` — verify they still compile (TS-structural pass; the additive fields are ignored).
  - [ ] 1.5 Add unit tests in `plugins/crew/mcp-server/src/lib/__tests__/extract-acs-from-spec.test.ts` (create if absent): tagged AC, untagged AC, multi-line body, AC with no body.

- [ ] **Task 2: Add `pr-diff` to reviewer permissions** (AC: #1)
  - [ ] 2.1 Edit `plugins/crew/permissions/generalist-reviewer.yaml`. Add `- pr-diff` to the `gh_allow` list. Preserve the existing entries (`pr-view`, `pr-comment`, `pr-review`).
  - [ ] 2.2 Verify the Story 2.2 schema accepts `pr-diff` (the schema is "any string"; no schema change needed). Add a unit-test fixture in `plugins/crew/permissions/__tests__/` (if such a suite exists) that loads the updated YAML and asserts `pr-diff` is in `gh_allow`.

- [ ] **Task 3: Add the `slugify-standards-criterion` helper + duplicate-id error** (AC: #3)
  - [ ] 3.1 Create `plugins/crew/mcp-server/src/lib/slugify-standards-criterion.ts` exporting `slugifyStandardsCriterion(name: string): string`. Implementation per (3b): lowercase, replace `/[^a-z0-9]+/g` with `-`, trim leading/trailing dashes. Pure function, no deps.
  - [ ] 3.2 Add unit tests covering: typical name, name with capitals, name with punctuation, leading/trailing whitespace, all-non-alnum (edge case — returns empty string; the caller raises `DuplicateStandardsCriterionIdError` if more than one criterion produces empty).
  - [ ] 3.3 Open `plugins/crew/mcp-server/src/errors.ts`. Add a new `DuplicateStandardsCriterionIdError` extending the existing `DomainError` base; constructor takes `{ criterionId: string; names: string[] }`; message format: `"Two or more standards criteria slugify to the same id '<criterionId>': <names.join(', ')>. Rename one in docs/standards.md to make ids unique."`.
  - [ ] 3.4 Add a new `PrUrlNotFoundInDevTranscriptError` extending `DomainError`; constructor takes `{ ref: string; transcriptTail: string }` (the transcript-tail field is the last ~500 chars of the dev transcript for diagnostics); message format: `"Could not parse a GitHub PR URL from the dev subagent's transcript for story <ref>. Expected a line containing 'https://github.com/.../pull/<n>'. Last 500 chars of transcript: <transcriptTail>"`.

- [ ] **Task 4: Implement `runReviewerSession` composite tool** (AC: #1, #2, #3)
  - [ ] 4.1 Create `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`. Export `runReviewerSession(opts) → Promise<ReviewerSessionResult>` with the option shape from (1a). Add the `execaImpl?: typeof execa` test seam (4b).
  - [ ] 4.2 Implement the three reads in fixed order per (1e): `readSourceStory` (via `resolveWorkspace(...).activeAdapter`), `gh pr-diff` (via `gh()` wrapper with the reviewer's loaded `RolePermissions`), `lookupStandards`. Each read's result populates a field on the in-progress `ReviewerSessionResult`.
  - [ ] 4.3 After all three reads return, build `standardsByCriterionId` via `slugifyStandardsCriterion` per (3a). Detect duplicates per (3c) and throw `DuplicateStandardsCriterionIdError` if any.
  - [ ] 4.4 Call `extractAcsFromSpec(sourceStory.specPath)` to enumerate ACs. For each AC, run the applicability classifier per (2b) and the per-applicability runner per (2c). Build `acResults: Record<number, AcResult>` keyed by `ac.index`. Execute serially per (2f). Apply the 90s timeout per (2g).
  - [ ] 4.5 Compute `recommendedVerdict` deterministically from `acResults` per (3f). Assemble and return the `ReviewerSessionResult`:
    ```ts
    type RecommendedVerdict = "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED";
    interface ReviewerSessionResult {
      sessionUlid: string;
      ref: string;
      prNumber: number;
      sourceStory: SourceStory;
      sourceStoryRef: string; // sourceStory.ref convenience copy for the persisted file
      prDiff: string;
      standards: StandardsDoc;
      standardsByCriterionId: Record<string, Criterion>;
      acResults: Record<number, AcResult>;
      recommendedVerdict: RecommendedVerdict;
    }
    ```
  - [ ] 4.6 **Persist `reviewer-result.json` (NEW — revision 2)** before returning. Use `atomicWriteFile` (Story 1.6) to write the projection `{ sessionUlid, ref, recommendedVerdict, acResults, standardsByCriterionId, sourceStoryRef, prNumber }` to `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json`. Create the parent directory via `mkdir -p` semantics if absent. The full `ReviewerSessionResult` (including `sourceStory` and `prDiff`) is still returned in-memory; only the verdict-relevant projection persists. See (3g) for shape rationale.
  - [ ] 4.7 Add a top-of-file JSDoc citing this story spec at the behavioural-contract anchor (mirrors `process-reviewer-transcript.ts`'s pattern). Call out the deterministic-verdict-transport contract explicitly.

- [ ] **Task 5: Register `runReviewerSession` as an MCP tool** (AC: #1)
  - [ ] 5.1 Open `plugins/crew/mcp-server/src/tools/register.ts`. Add the import for `runReviewerSession`. Register it under the tool name `"runReviewerSession"` with a Zod input schema mirroring `RunReviewerSessionOptions` (`targetRepoRoot`, `sessionUlid`, `ref`, `prNumber: z.number().int().positive()`, `role: z.string().optional()`).
  - [ ] 5.2 Wrap the handler in the existing `DomainError → { isError: true, content: [...] }` envelope used by other tools.
  - [ ] 5.3 Verify via the existing register-suite tests that the tool is enumerated and callable.

- [ ] **Task 6: Extend `processDevTranscript` to parse the PR URL** (AC: #1, #5)
  - [ ] 6.1 Open `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`. On the `spawn-reviewer` happy path (after `parseHandoff` returns ok and BEFORE building the reviewer prompt), grep the transcript for the rightmost `https://github.com/[^/]+/[^/]+/pull/(\d+)` match. The dev subagent emits the PR URL after `gh pr create` (Story 4.4); v1 takes the rightmost match to allow for multiple URL mentions.
  - [ ] 6.2 If no match: throw `PrUrlNotFoundInDevTranscriptError` per (1g). The error propagates through `register.ts`'s envelope and surfaces to the SKILL.md prose, which displays it and exits the inner cycle.
  - [ ] 6.3 If matched: extract the trailing integer as `prNumber` and add it to the `spawn-reviewer` result:
    ```ts
    { next: "spawn-reviewer"; reviewerPrompt: string; prNumber: number; chatLog: string[] }
    ```
  - [ ] 6.4 Update the result-type union at the top of the file. (This is the declared-locked-file change — see § Locked files.)
  - [ ] 6.5 Add a unit test under `__tests__/process-dev-transcript.test.ts`: (i) transcript with one PR URL → prNumber returned; (ii) transcript with two PR URLs → rightmost wins; (iii) transcript with no PR URL → `PrUrlNotFoundInDevTranscriptError` thrown.

- [ ] **Task 7: Update the SKILL.md reviewer-spawn block** (AC: #1, #5)
  - [ ] 7.1 Open `plugins/crew/skills/start/SKILL.md`. In the `allowed_tools` array (line 4), add `runReviewerSession`. (Set-equality widens from the current seven-tool set.)
  - [ ] 7.2 In step 8 (reviewer-spawn `initial_context`), add `prNumber: <prNumber>` to the YAML block.
  - [ ] 7.3 Update step 7's switch on `next`: the `spawn-reviewer` case stores both `reviewerPrompt` AND `prNumber` (the new field from Task 6.3).
  - [ ] 7.4 Do NOT add prose instructions to the SKILL.md telling the reviewer to "read the source story, the PR diff, and standards.md" — that prose-flake instruction is precisely what this story removes. The persona prompt (Task 8) carries the structured instruction.

- [ ] **Task 8: Update the `generalist-reviewer` persona (REVISED 2026-05-24 — revision 2)** (AC: #1, #2, #3, #5)
  - [ ] 8.1 Open `plugins/crew/catalogue/generalist-reviewer.md`. In the `tools_allow` block at top, add `runReviewerSession` (so `loadRolePermissions` reflects it; though SKILL.md's `allowed_tools` is the binding gate).
  - [ ] 8.2 Rewrite the `## Prompt` section so the reviewer's ONLY mandatory action is to invoke `runReviewerSession({ targetRepoRoot, sessionUlid, ref, prNumber })` using the `initial_context` values. After that single tool call returns, the chat output is informational — the persona may compose a human-readable summary, comments, or footer markers in any form. None of it is parsed.
  - [ ] 8.3 **REMOVE the prose rule** "MUST emit `**Verdict: <SENTINEL>**` as the final non-empty line of your chat." That rule was the trial-7 break point. Replace with: "The tool's persisted `reviewer-result.json` carries the binding verdict. Your chat is for the human operator — be clear and helpful but do not worry about machine-parseable verdict grammar."
  - [ ] 8.4 Add a soft prose recommendation (NOT a parser contract): "When summarising for the operator, quote each failing AC's `reason` field verbatim — especially the artifact path. The operator's first question is 'what's missing?'." This is best-effort. The structured file already carries `reason` verbatim for the manifest stamp.
  - [ ] 8.5 Add a soft prose recommendation for manual-check ACs: "If any AC has `applicability: 'manual-check-required'`, surface it under a 'Manual checks required before merge' section so the operator can act."
  - [ ] 8.6 **Locked-phrase catalogue entry `verdict` (decision recorded — revision 2):** keep the entry declared in the catalogue YAML (`locked_phrases:` block) as a documentation guideline — useful for humans authoring future reviewer personas — but the parser no longer enforces it. Add a `# enforcement: deprecated — see Story 4.6 revision 2` comment alongside the entry so future readers understand its status. Do NOT delete the entry in this story (cross-cutting catalogue cleanup belongs in a separate housekeeping story).

- [ ] **Task 8b: Rewrite `processReviewerTranscript` to read from `reviewer-result.json` (NEW — revision 2)** (AC: #3, #4, #5)
  - [ ] 8b.1 Open `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`. **Drop the `reviewerTranscript` parameter** (rationale: the chat is no longer load-bearing; keeping it as a vestigial param would invite future drift where someone tries to consult it again). The public input shape becomes `{ targetRepoRoot, sessionUlid, ref }`. Update all callers (SKILL.md prose builders, `register.ts` envelope, any tests).
  - [ ] 8b.2 Replace the `parseVerdict(reviewerTranscript)` call (line ~99) with a `readReviewerResultFile({ targetRepoRoot, sessionUlid })` helper that reads, parses, and Zod-validates `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json`. On `ENOENT`, return the new `done-blocked-no-session-result` variant (see 8b.4). On JSON parse error or Zod-validation failure, raise a typed `ReviewerResultFileMalformedError` and let it propagate.
  - [ ] 8b.3 Switch on `recommendedVerdict`:
    - `"READY FOR MERGE"` → existing happy-path (call `completeStory`, return the done-merged variant). Manifest moves to `done/`.
    - `"NEEDS CHANGES"` → stamp `blocked_by: "reviewer-verdict-needs-changes"` on the in-progress manifest; return a new `done-blocked-reviewer-needs-changes` variant. Manifest stays in `in-progress/`.
    - `"BLOCKED"` → stamp `blocked_by: "reviewer-verdict-blocked"`; return `done-blocked-reviewer-blocked`. Manifest stays in `in-progress/`.
  - [ ] 8b.4 Add the new result variant `done-blocked-no-session-result` to the return-union. Behavior: stamp `blocked_by: "reviewer-no-session-result"` on the in-progress manifest; surface a chat message instructing the operator that the reviewer subagent skipped the mandatory `runReviewerSession` call. This is the rubber-stamp protection analogous to 4.3c's reviewer-grammar guard.
  - [ ] 8b.5 **Deprecate (delete, not just stop calling) the verdict-grammar variants** `done-blocked-reviewer-verdict` and `done-blocked-reviewer-grammar` from the return-union. Rationale: `runReviewerSession` is now the ONLY valid reviewer path; there is no backward-compat shape to preserve. The verdict-grammar guard is structurally subsumed by `done-blocked-no-session-result`. Migrate any existing tests that asserted those variants — they now assert `done-blocked-no-session-result` where the scenario was "reviewer didn't emit a parseable verdict".
  - [ ] 8b.6 Remove the `import { parseVerdict } from "../skills/verdict-parser.js"` statement. The function is no longer called.
  - [ ] 8b.7 Update the file-level JSDoc to cite Story 4.6 revision 2 as the source of the deterministic-verdict-transport contract. Cross-reference Story 4.3c's `completeStory` side-effect pattern as the precedent.
  - [ ] 8b.8 Add `ReviewerResultFileMalformedError` to `plugins/crew/mcp-server/src/errors.ts`: constructor `{ path: string; cause: unknown }`; message: `"reviewer-result.json at <path> is malformed or fails schema validation. Cause: <cause>. This is a bug in runReviewerSession; the file should always be schema-valid when present."`.

- [ ] **Task 8c: Verdict-parser disposition (NEW — revision 2)** (no AC; cleanup)
  - [ ] 8c.1 Audit callers of `parseVerdict` after Task 8b lands: `grep -rn "parseVerdict\|verdict-parser" plugins/crew/mcp-server/src plugins/crew/skills`. Expected post-8b state: only the `verdict-parser.test.ts` unit suite and the `parsers-content.test.ts` structural-anchor test reference it.
  - [ ] 8c.2 **Decision recorded — keep but mark deprecated (Option c).** Rationale: no runtime caller after 8b, but two test suites (`verdict-parser.test.ts`, `parsers-content.test.ts` AC5(ii)) assert the file's existence/exports. Deleting the file would cascade test deletions and might mask a future regression where someone re-introduces verdict-grammar parsing. Mark deprecated by adding a top-of-file JSDoc to `verdict-parser.ts`: `/** @deprecated Story 4.6 revision 2 moved verdict transport to the persisted reviewer-result.json file. No runtime caller. Retained for documentation of the historical grammar; remove in a future housekeeping story once the parsers-content structural-anchor test is also retired. */`. Do NOT delete in this story.
  - [ ] 8c.3 Add a brief note to `plugins/crew/mcp-server/src/skills/verdict-parser.ts`'s exports comment that the locked-phrase grammar is now an authoring guideline, not a runtime parser contract.


  - [ ] 9.1 Create `plugins/crew/mcp-server/src/tools/__tests__/run-reviewer-session.test.ts`. Build the fixture from (4a) in a `beforeEach` using `mkdtempSync`. Tear down with `rmSync(..., { recursive: true })`.
  - [ ] 9.2 Implement the three-reads-ordering assertion (4c) using `vi.spyOn` on the adapter's `readSourceStory`, the injected `execaImpl`, and `lookupStandards`. Assert `invocationCallOrder` strict-less-than triples.
  - [ ] 9.3 Implement the structured-result assertions (4d), (4e).
  - [ ] 9.4 Implement each negative path (4f), (4g), (4h), (4i), (4j) as separate `it()` cases.
  - [ ] 9.5 Use the existing test-cache reset (`__resetGhErrorMapCacheForTests` from Story 4.5) in `beforeEach` to keep the gh-error-map cache deterministic across cases.
  - [ ] 9.6 **File-persistence assertions (NEW — revision 2):** implement (4k) — assert `<tmp>/.crew/state/sessions/<sessionUlid>/reviewer-result.json` exists and parses to the expected shape after each happy/fail/blocked variant; assert `recommendedVerdict` matches the deterministic algorithm in (3f) for each fixture.
  - [ ] 9.7 **`processReviewerTranscript` file-read coverage (NEW — revision 2):** extend `process-reviewer-transcript.test.ts` per (4l) and (4m): pre-populated-file cases for each `recommendedVerdict` literal, missing-file case asserting `done-blocked-no-session-result`, malformed-JSON case asserting `ReviewerResultFileMalformedError`. Drop or migrate any existing tests that exercised the now-deleted `done-blocked-reviewer-verdict` and `done-blocked-reviewer-grammar` variants.

- [ ] **Task 10: Operator-smoke wiring for AC5** (AC: #5)
  - [ ] 10.1 Extend the existing operator-smoke harness (in `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/`) with the reproducer scenario from (5a): scratch repo, one ready story with `artifact: target-file.txt`, a stubbed dev-persona override that handoffs without creating the artifact.
  - [ ] 10.2 Drive `/crew:start` end-to-end against the scratch repo (the harness already drives the inner cycle for 4.3b/4.3c; extend it to capture the reviewer's verdict transcript).
  - [ ] 10.3 **Revised 2026-05-24 (revision 2).** Assert per (5b): the in-progress manifest's `blocked_by` field is `"reviewer-verdict-needs-changes"` (or `"reviewer-verdict-blocked"`). The reviewer's chat verdict line is no longer asserted — the file-derived stamp is the contract. Assert per (5d): the literal `target-file.txt` and a fail-signal word appear in EITHER the captured chat transcript OR `.crew/state/sessions/<sessionUlid>/reviewer-result.json`'s `acResults[<index>].reason` field. The persisted-file branch is mechanically guaranteed by the artifact-check runner's reason format (2c).
  - [ ] 10.4 Assert per (5c): the manifest is at `.crew/state/in-progress/<ref>.yaml` AND NOT at `.crew/state/done/<ref>.yaml` after the inner cycle exits. Additionally assert `.crew/state/sessions/<sessionUlid>/reviewer-result.json` exists and `recommendedVerdict === "NEEDS CHANGES"`.
  - [ ] 10.5 Tag the test file so it runs in the pre-PR smoke gate per `plugins/crew/docs/user-surface-acs.md`. Operator may substitute manual-paste evidence in lieu of automated smoke per § Pre-PR gate.

- [ ] **Task 11: Update CLAUDE.md / docs (if affected)** (no AC; housekeeping)
  - [ ] 11.1 Skim `plugins/crew/docs/` for any reviewer-flow doc that names "the reviewer reads X" in prose. Update to reference `runReviewerSession` if such doc exists. Do NOT create new docs; only update if a doc with this content already exists.

---

## Behavioural contract (user-surface)

**These invariants are the contract this story makes. They MUST hold at all times in the running plugin. If a future change appears to break one, the change is wrong — revisit the story or open a follow-up to revise the contract explicitly.**

### MUST

- **MUST complete all three reads (source story via active adapter, PR diff via `gh pr diff`, standards.md via `lookupStandards`) before any verdict reasoning.** Verified mechanically by the `runReviewerSession` composite tool returning the structured `ReviewerSessionResult` to the persona prose; the persona has no access to verdict-relevant data except via that return value. The reads are sequential and ordered per (1e).
- **MUST execute every AC against the diff per the applicability classifier (2b), and capture structured pass/fail in `acResults` keyed by AC index.** `runnable-artifact-check` resolves via `fs.access`; `runnable-vitest` resolves via `pnpm vitest --run -t`; `manual-check-required` is flagged but not silently passed.
- **MUST hold the standards-doc criteria array in memory as a `Record<criterionId, Criterion>` keyed by `slugify(name)`.** Duplicate ids raise `DuplicateStandardsCriterionIdError` and propagate to the operator.
- **MUST propagate any read or execution error verbatim.** `SourceFileNotFoundError`, `StandardsDocMissingError`, `StandardsDocMalformedError`, `GhRecoverableError`, and `GhSubcommandDeniedError` all reach the SKILL.md prose unchanged. The composite tool does not swallow, retry, or paper over.
- **MUST stop the reviewer cycle on any read error.** The persona never composes a verdict against an incomplete read. The operator sees the typed error verbatim.
- **MUST derive `recommendedVerdict` deterministically from `acResults` (revision 2).** The algorithm in (3f) is closed: any-fail → `NEEDS CHANGES`; else any-manual → `BLOCKED`; else `READY FOR MERGE`. The LLM does not decide; the tool does.
- **MUST persist `reviewer-result.json` to `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/` before returning (revision 2).** Atomic write via Story 1.6's helper. Schema per (3g). This is the verdict transport.
- **MUST read `reviewer-result.json` in `processReviewerTranscript` (revision 2).** No chat-scraping. Missing file → `done-blocked-no-session-result`. Present file → switch on `recommendedVerdict`.

### MUST NOT

- **MUST NOT return `**Verdict: READY FOR MERGE**` if any `acResults[*].status === "fail"`.** Enforced by the updated persona prompt (Task 8.3). The persona has the structured result; "I checked and everything passed" is not a permitted prose path when a fail exists in memory.
- **MUST NOT fabricate AC results.** ACs that match neither runnable shape are flagged `applicability: "manual-check-required"` with a reason; they are NOT silently marked `pass`. The persona is required (Task 8.4) to surface manual-check ACs in the summary and reflect them in the verdict.
- **MUST NOT mutate the manifest from `runReviewerSession`.** This tool is informational (read-only). All manifest mutations (rework_count, blocked_by, completion-move) stay in `processReviewerTranscript` and `completeStory` per Stories 4.3 / 4.3c. (Locked.)
- **MUST NOT skip the `runReviewerSession` invocation.** The persona prompt's first instruction is to call it; the persona has no `Read`/`Bash` paths to substitute (the reviewer's `tools_allow` per `generalist-reviewer.md` is `Read`/`Bash`/`Task` plus the MCP tools — even if the persona reaches for `Read` on the standards doc directly, that does not produce `standardsByCriterionId`, `acResults`, or any structured input the verdict-composition rules require). The mechanical compulsion is that the verdict cannot be composed from prose alone.
- ~~**MUST NOT add new locked phrases to the reviewer's output grammar.** The verdict line shape (`**Verdict: <SENTINEL>**`) is owned by `processReviewerTranscript` (Story 4.3c) and locked. This story changes WHAT the reviewer composes (structured-result-derived) without changing HOW it terminates.~~ **REVISED 2026-05-24 (revision 2):** the verdict line shape is no longer parsed. `processReviewerTranscript` reads the persisted file. The reviewer's chat is unconstrained after the `runReviewerSession` invocation. The `verdict` locked-phrase catalogue entry is kept as documentation but the parser is retired.
- **MUST NOT scrape the reviewer's chat for verdict text (revision 2).** All verdict transport is via the persisted `reviewer-result.json` file. Any reintroduction of chat-scraping reopens the trial-7 failure mode.
- **MUST NOT touch sprint-status.yaml or any orchestrator-state file.** The dev agent implementing this story is forbidden from editing `_bmad-output/implementation-artifacts/sprint-status.yaml`. State transitions are owned by the workflow harness.

### NEVER

- **NEVER infer artifact existence from the PR diff alone.** A diff that ADDS a file does not prove the file exists at HEAD on the dev's branch — the branch could have been amended, the file could be `.gitignore`d, the diff could be against a different base. `fs.access` is the authoritative check. (Rationale: this is the 4.3c rubber-stamp shape — the dev "claimed" to add the file; the diff showed an `+++` line; the file didn't exist on disk. The fix is artifact-existence verification, not diff inspection.)
- **NEVER spawn subagents from `runReviewerSession` or any MCP tool.** Subagent spawn is owned exclusively by the SKILL.md prose layer (Stories 4.2 / 4.3b). The composite tool is a pure read-and-execute function. (Same invariant as `processDevTranscript` / `processReviewerTranscript`.)
- **NEVER swallow a `DuplicateStandardsCriterionIdError`.** A standards doc with collision-prone names is a real authoring bug; suppressing the error would let the reviewer silently drop a criterion's `Criterion` value when a slug collision occurs. Raise and stop.

---

## Implementation strategy

### Why a composite tool, not extended prose

The prose-flake lesson (`feedback_prose_mut_steps_need_seam.md`) was originally written about mutating side-effects. The 4.6 situation is softer — reading and AC-running are read-only — but the same shape of failure applies to read-only orchestration when downstream verdict composition depends on it: prose-level "read three things and run N ACs" is N+3 places the LLM can skip and still emit plausible output.

The right cut is: prose drives the persona, persona invokes ONE tool, tool returns ONE structured object, persona composes the verdict from the structure. The persona has one prose decision ("call the tool"); failure to make that decision is loud (no `acResults` to compose from); the verdict-composition rules (Task 8.3, 8.4) are derived mechanically from the structure rather than from a parallel set of prose MUSTs.

This is the same shape as `processReviewerTranscript`'s internal `completeStory` call (Story 4.3c): the mutating step moved off the prose. Story 4.6 applies the analogous pattern to the read-and-execute step.

### Why the persona still composes the verdict text

The verdict text — "what to say in the summary comment, in what order, with what emphasis" — is genuinely a prose task. The structured result tells the persona WHAT failed; the persona's prompt instructs it HOW to surface that to the operator. That decision belongs in the persona (English-language framing of a finding), not in the tool (mechanical execution). Story 4.6b will move the *posting* of the prose to the inline-comment-and-summary surface; the prose generation stays in the persona.

### Why the runner only supports two markers (`artifact:` and `vitest:`)

The minimal viable runner. The rubber-stamp scenario the 4.3c smoke caught is exactly the `artifact:` shape (file should exist; didn't). The `vitest:` shape covers integration ACs whose behaviour is encoded in a named test. Any other shape — running scripts, hitting APIs, asserting prose properties — is `manual-check-required` for v1. Pattern §11 (calibration) will iterate the marker grammar in Epic 6 retros if real stories surface other check shapes.

A common temptation will be to add `bash:` for "run this command and check exit code". Resist for v1. `bash:` opens a wide attack surface (the AC body is user-authored; running arbitrary commands from it is risky) and the only motivating use case (run a binary, check exit) is well-served by writing a vitest test that wraps the binary. Defer.

### Why `pr-diff` (kebab) not `pr diff`

The Story 4.4 `gh` wrapper normalises kebab subcommands by splitting on `-` (`pr-view` → `["pr", "view"]`). The role-spec entry is `pr-diff`; the spawned command is `gh pr diff`. Same pattern as the other reviewer subcommands.

### Why the `prNumber` lookup lives in `processDevTranscript`

Two options were considered:

1. **`processDevTranscript` extracts and returns `prNumber`** (chosen): the dev transcript is the source of truth for "what PR did the dev open"; parsing it once and passing it via the spawn-reviewer result is the natural seam.
2. **Reviewer subagent calls `gh pr list` to find its own PR.** Rejected: introduces a network round-trip on every reviewer spawn, and "which PR is mine" requires the reviewer to know its story ref AND parse a PR-list response — more failure surface than parsing one URL out of a transcript.

The chosen approach localises the change to one MCP tool's return shape (declared-locked-file change) and keeps the reviewer's path read-only and deterministic.

### Why this story is `user-surface`

ACs 1–4 describe internal reviewer behaviour. On the surface, that reads as substrate. But the contract this story is making is "the reviewer's verdict is now trustworthy" — and trust is observed at the operator's chat surface. Operator-smoke is the only gate that can verify the rubber-stamp failure mode is closed; substrate-budget (three review passes per `plugins/crew/docs/user-surface-acs.md`) is too narrow given the LLM-determinism risk inherent in reviewer behaviour. AC5 makes that user-surface contract explicit and gateable.

---

## Locked files

The following files are off-limits to this story's implementation (mutations would break previously-shipped contracts). If a change to any of these appears necessary, STOP and surface the conflict — do not edit.

- `plugins/crew/mcp-server/src/tools/complete-story.ts` (Story 4.1; the atomic-move primitive)
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` (Story 4.1 / 4.2)
- `plugins/crew/mcp-server/src/tools/claim-story.ts` (Story 4.1)
- `plugins/crew/permissions/gh-error-map.yaml` (Story 4.5; v1 row set is fixed)
- ~~`plugins/crew/skills/verdict-parser.js` and `plugins/crew/mcp-server/src/skills/verdict-parser.ts` (the verdict-grammar surface; Story 4.3b/4.3c)~~ **Revision 2:** no longer fully locked — Task 8c.2 adds a deprecation JSDoc to the source file. No code change to exports; the file's runtime callers are removed by Task 8b.6. See declared-locked-file changes below.
- `plugins/crew/skills/handoff-parser.js` and `plugins/crew/mcp-server/src/skills/handoff-parser.ts` (the handoff-grammar surface; Story 4.3)
- ~~`plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.3b/4.3c; the verdict-parse-and-mutate path is unchanged)~~ **Revision 2 — REMOVED FROM LOCKED LIST.** This file is substantively rewritten by Task 8b. See declared-locked-file changes below for the bounded scope.

### Declared-locked-file changes (explicit exceptions)

The following files would otherwise be locked but MUST be modified by this story; the change is bounded and described explicitly to make the deviation auditable.

- **`plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`** (Stories 4.3b / 4.5) — extended in Task 6 to parse the PR URL out of the dev transcript on the happy-path `spawn-reviewer` branch and add `prNumber: number` to that result variant. Existing `done-blocked-handoff-grammar`, `done-blocked-gh-defer`, `done-blocked-gh-retry`, `done-blocked-gh-needs-human` branches and the recoverable-error pre-check are UNTOUCHED. The new `PrUrlNotFoundInDevTranscriptError` raises only on the happy path when the dev claims handoff but did not push a PR. Rationale: `processDevTranscript` is the unique consumer of the dev transcript; the PR URL lives only in that transcript; localising the extraction to one tool is the minimum-surface change.
- **`plugins/crew/mcp-server/src/lib/extract-acs-from-spec.ts`** (Story 4.4) — extended in Task 1 with two additive fields on `AcEntry` (`tag`, `body`). Existing callers that destructure `{ index, firstLine }` are unaffected. Rationale: avoiding a parallel parser is a deliberate reuse-not-reinvent choice (CLAUDE.md anti-pattern: "wheel reinvention").
- **`plugins/crew/skills/start/SKILL.md`** (Stories 4.2 / 4.3b / 4.3c) — extended in Task 7 with one new entry in `allowed_tools` (`runReviewerSession`) and one new field in the reviewer-spawn `initial_context` block (`prNumber`). The inner-cycle steps and the completion seam (4.3c) are UNTOUCHED. (Revision 2: the SKILL.md prose call to `processReviewerTranscript` now omits the `reviewerTranscript` arg per Task 8b.1 — adjust the call site only; the surrounding prose is unchanged.)
- **`plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`** (Stories 4.3b / 4.3c) — **substantively rewritten by Task 8b (revision 2).** Bounded scope: (i) drop the `reviewerTranscript` input parameter (deliberate choice — see Task 8b.1 rationale); (ii) replace the chat-scraping `parseVerdict` call with a `reviewer-result.json` file read; (iii) switch on the file's `recommendedVerdict` literal to drive manifest mutations; (iv) add `done-blocked-no-session-result` to the return-union; (v) delete `done-blocked-reviewer-verdict` and `done-blocked-reviewer-grammar` variants from the return-union (no backward-compat path — `runReviewerSession` is now the only valid reviewer entrypoint); (vi) preserve the existing `completeStory` call on the `READY FOR MERGE` branch byte-identical; (vii) preserve the existing recoverable-error / rework-signal branches unrelated to verdict parsing. The public output shape changes in two ways: the input parameter `reviewerTranscript` drops, and the return-union swaps two variants for one. Document the migration in the file-level JSDoc.
- **`plugins/crew/mcp-server/src/skills/verdict-parser.ts`** (Story 4.3) — Task 8c.2 adds a top-of-file `@deprecated` JSDoc. No code change to exports. The `.js` sibling at `plugins/crew/skills/verdict-parser.js` is NOT modified (the catalogue is documentation-only post-revision-2).

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Task 4)
- `plugins/crew/mcp-server/src/tools/__tests__/run-reviewer-session.test.ts` (Task 9)
- `plugins/crew/mcp-server/src/lib/slugify-standards-criterion.ts` (Task 3.1)
- `plugins/crew/mcp-server/src/lib/__tests__/slugify-standards-criterion.test.ts` (Task 3.2)
- `plugins/crew/mcp-server/src/lib/__tests__/extract-acs-from-spec.test.ts` (Task 1.5; create if absent)
- Operator-smoke fixture additions under `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/` (Task 10)

### Files this story will modify

- `plugins/crew/mcp-server/src/lib/extract-acs-from-spec.ts` (Task 1; additive fields)
- `plugins/crew/mcp-server/src/errors.ts` (Task 3.3, 3.4, 8b.8; three new error classes — adds `ReviewerResultFileMalformedError` in revision 2)
- `plugins/crew/mcp-server/src/tools/register.ts` (Task 5; register the new tool; revision 2: also adjust `processReviewerTranscript` envelope to match its new input shape)
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (Task 6; PR-URL parsing + new error)
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Task 8b — NEW in revision 2; substantive rewrite per declared-locked-file change)
- `plugins/crew/mcp-server/src/skills/verdict-parser.ts` (Task 8c — NEW in revision 2; @deprecated JSDoc only, no code change)
- `plugins/crew/permissions/generalist-reviewer.yaml` (Task 2; add `pr-diff`)
- `plugins/crew/catalogue/generalist-reviewer.md` (Task 8; persona prompt rewrite — revision 2 removes the locked-phrase MUST and softens to authoring guidelines)
- `plugins/crew/skills/start/SKILL.md` (Task 7; allowed_tools + initial_context; revision 2: also drop the `reviewerTranscript` arg from the `processReviewerTranscript` call site)

### Current-state notes on files being modified

- **`process-dev-transcript.ts`** (current state per Story 4.5): exports `processDevTranscript({ targetRepoRoot, sessionUlid, ref, devTranscript })` returning a discriminated union of six `next` literals. Recoverable-error pre-check via regex runs BEFORE `parseHandoff`. Happy path returns `{ next: "spawn-reviewer", reviewerPrompt, chatLog }`. Story 4.6 adds `prNumber` to that one variant only. Read the file end-to-end before editing.
- **`gh.ts`** (current state per Stories 4.4 / 4.5): single `gh()` entrypoint enforcing `gh_allow`, refusing negative flags, classifying recoverable errors. The reviewer-side `pr diff` call piggybacks on this wrapper unchanged; no wrapper-side changes for this story.
- **`generalist-reviewer.md`** (current state): persona prompt instructs reviewer to "read the source story, the PR diff, and `docs/standards.md`" in prose. Story 4.6 replaces that prose imperative with a structured `runReviewerSession({...})` invocation. The prompt's "you cannot merge, close, push, or edit" negative-capability statement is retained verbatim.
- **`SKILL.md`** (current state per Story 4.3c): seven-tool `allowed_tools` set. Reviewer-spawn step 8 carries `ref`, `title`, `sessionUlid`, `targetRepoRoot` in `initial_context`. Story 4.6 widens to eight tools and adds `prNumber` to the context.

### Testing standards

- vitest with the existing pattern: `pnpm vitest --run` from the mcp-server directory.
- `vi.fn()` / `vi.spyOn()` for stubbing; no global mocks.
- tmpdir fixtures via `mkdtempSync` with `rmSync` teardown.
- `execaImpl` test seam for any `execa` call; never spawn real `gh` or `pnpm` in tests.
- AC4's integration suite lives in `tools/__tests__/`; unit suites live in `lib/__tests__/`.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md#Story 4.6`]
- [Source: `plugins/crew/docs/user-surface-acs.md`] (user-surface tag conventions)
- [Source: `_bmad-output/implementation-artifacts/4-3c-call-completestory-after-ready-for-merge.md`] (the rubber-stamp evidence this story closes)
- [Source: `_bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md`] (reviewer-spawn surface)
- [Source: `_bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md`] (gh wrapper + recoverable-error contract)
- [Source: `_bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md`] (PR-URL emission in dev transcript)
- [Source: `_bmad-output/implementation-artifacts/3-4-native-adapter-planner-subagent-and-plan-skill.md`] (adapter `readSourceStory` contract)
- [Source: `_bmad-output/implementation-artifacts/1-3-standards-doc-lookup-parser-and-shipped-example-template.md`] (`lookupStandards` + StandardsDoc schema)
- [Source: `plugins/crew/mcp-server/src/state/lookup-standards.ts`] (function the new tool calls)
- [Source: `plugins/crew/mcp-server/src/schemas/standards-doc.ts`] (Criterion / StandardsDoc shape)
- [Source: `plugins/crew/mcp-server/src/lib/gh.ts`] (gh wrapper)
- [Source: `plugins/crew/mcp-server/src/lib/extract-acs-from-spec.ts`] (AC extractor — Task 1 extends)
- [Source: `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`] (locked; verdict-parse surface unchanged)
- [Source: `plugins/crew/skills/start/SKILL.md`] (the prose layer Task 7 widens)
- Project memory: `project_reviewer_rubber_stamps.md` (the originating evidence)
- Project memory: `feedback_prose_mut_steps_need_seam.md` (the pattern being applied)

---

## Previous story intelligence

### From Story 4.5 (just shipped)

- The `gh` wrapper now raises `GhRecoverableError` on classified non-zero exits. Reviewer-side `gh pr diff` calls inherit this behaviour for free. v1 does not route reviewer-side recoverable errors into a `blocked_by: gh-<class>` stamp — the error propagates uncaught from `runReviewerSession` to the SKILL.md prose, which surfaces it. Future story can add reviewer-side routing analogous to `processDevTranscript`'s recoverable-error pre-check.
- The `gh-error-map.yaml` v1 row set (auth-expiry, rate-limit, network-blip) is sufficient for `gh pr diff` failure modes — the same classes apply (rate limits hit `pr diff` as readily as `pr create`). No new entries needed.

### From Story 4.3c

- The rubber-stamp scenario is reproducible: PR #105 retro confirmed two trials, one rubber-stamped. The operator-smoke harness already drives `/crew:start` end-to-end against a scratch repo; Story 4.6's AC5 smoke extends it minimally.
- `processReviewerTranscript` is the verdict-parse surface and is locked. This story does not alter how the verdict is parsed; only what the reviewer composes before emitting.

### From Story 4.3b

- The `Task` tool's transcript-capture pattern works: SKILL.md prose calls `Task`, captures the returned final message, passes it verbatim to `processDevTranscript` / `processReviewerTranscript`. The reviewer-side `initial_context` block is the binding contract for what the reviewer subagent sees at boot — Story 4.6 extends it with `prNumber`.

### From Story 4.4

- The dev subagent emits the PR URL after `gh pr create`. The exact format is per `gh`'s stdout: a single-line URL like `https://github.com/<org>/<repo>/pull/<n>`. Multiple URL mentions may appear (e.g. operator pasted reference). v1 takes the rightmost match.
- `extractAcsFromSpec` already parses AC headings including the parenthetical tag — Task 1's extension surfaces what the regex already captures plus the body lines.

### From Story 1.3

- `lookupStandards(targetRepoRoot)` returns `{ version, updated, criteria[], sourcePath }`. The `Criterion` schema is `.strict()` — unknown keys raise. v1 does not add keys; just slugifies `name` for the keyed record.

### Git intelligence (recent commits)

Recent commits on `main`:

- `5018a82 test(4.3b): add claim-next-story coverage and AC suite` (test-only)
- `56afa67 feat(4.3b): harness-side Task-spawn seam for runDevSession` (the prose-vs-tool seam reorganisation)
- `b43af2c feat(4.3): dev→reviewer handoff, spawn, rework signal` (the reviewer-spawn surface this story builds on)
- `9af497b feat(4): /start skill and per-story dev subagent spawn` (the outer-loop surface)

Pattern: every Epic 4 commit is a Story-N feature commit. Story 4.6's commits should follow `feat(4.6): <subject>` — see Story 4.4's commit-convention spec for body format.

---

## Latest tech information

### `gh pr diff <number>` behaviour (verified 2026-05-24)

- Exits 0 with the unified diff on stdout on success.
- Exits non-zero on auth issues (mapped by Story 4.5's `gh-error-map.yaml`).
- The `<number>` arg is the PR integer. No `--repo` needed when run inside the repo (the workspace root of the target repo is the cwd for the `gh` invocation — verified against Story 4.4's pattern).
- Token usage: diffs can be large. v1 does not truncate the diff; downstream comment-posting (Story 4.6b) will paginate if needed. The composite tool returns the raw string; callers handle size.

### `pnpm vitest --run -t "<name>"`

- `--run` disables watch mode (single-shot, exit code reflects pass/fail).
- `-t "<name>"` filters tests by name substring. Wildcards not supported; substring match.
- Exit 0 on all-filtered-tests-passing; non-zero otherwise (including "no tests matched filter" — important: a typo in the AC's `vitest:` marker that matches no test fails the AC with exit 1, which is the right shape).

---

## Project context reference

This story is part of **Epic 4 (Dev + Review Loop)** — the engineering heart of the v1 plugin. The product vision (per `CLAUDE.md`) is "replace the traditional product engineering team with AI tooling": Epic 4's job is making the dev-and-review cycle trustworthy so a non-engineer can let the loop run unsupervised.

Story 4.6's specific contribution is closing the "reviewer rubber-stamps green verdicts" failure mode — the 4.3c smoke caught it; left unfixed, the trust contract Epic 4 is making to the operator is broken. Without 4.6, every PR the operator sees with `**Verdict: READY FOR MERGE**` is potentially lying about whether the artifact exists.

The sequencing matters: 4.6 must land before 4.6b (which posts the reviewer's findings as inline + summary comments), 4.7 (which version-stamps verdicts), and 4.10b (which auto-merges low-risk PRs with high-agreement verdicts). Each downstream story compounds the cost of an untrustworthy verdict — 4.10b would auto-merge a rubber-stamp.

---

## Reviewer Findings — Decisions (added during fix pass 2026-05-24)

### M1: PR URL regex approach

Two options were evaluated for extracting the PR number in `processDevTranscript`:

1. Anchor the regex to `org/repo` from `git config --get remote.origin.url` (more precise, avoids matching unrelated PR URLs the dev may have pasted in prose).
2. Move PR URL extraction to immediately after `gh pr create` in `runDevTerminalAction` (structured field, not transcript scraping).
3. Keep the current regex `https://github.com/[^/\s]+/[^/\s]+/pull/(\d+)` and take the rightmost match (simplest, already implemented).

**Choice: option 3 (keep current).** The dev subagent's transcript in v1 is a short, purpose-built string. The "rightmost match" rule already handles multiple URL mentions correctly. Anchoring to `origin.url` would add a `git config` subprocess to every `processDevTranscript` invocation. Moving extraction to `runDevTerminalAction` would require threading `prNumber` through the tool's return shape, `register.ts`'s envelope, and the SKILL.md prose — wider surface than the risk warrants. The current approach is validated by the existing `processDevTranscript` unit tests (two-URL scenario). Revisit in Story 4.9 if real stories produce false positives.

### M3: `generalist-reviewer.yaml` tool names

The `tools_allow` list previously contained stale dead entries (`readSourceStory`, `lookupStandards`, `recordVerdict`, `classifyRiskTier`, `computeAgreement`, `recordYield`, `heartbeat`) that were never registered in `register.ts`. Replaced with the single active tool: `runReviewerSession`. The `gh_allow` entries are unchanged.

### M4: `pluginRootOverride` test seam

`RunReviewerSessionOptions.pluginRootOverride` is an optional test seam that overrides the `getPluginRoot()` call used by `loadRolePermissions`. Production callers do not pass it. It was added to allow `runReviewerSession` integration tests to point at the project's real `plugins/crew/permissions/` directory from a tmpdir context without requiring a full plugin install. A JSDoc comment on the param in `run-reviewer-session.ts` marks it as a test seam. Future stories that add new tools with a `pluginRootOverride` seam should follow the same pattern.

### Issue 2: discriminating execaImpl stub

The original `makeGhExecaStub` in `run-reviewer-session.test.ts` returned identical stubbed output for every `execaImpl` invocation — including `pnpm vitest` calls. The production code passes the same `execaImpl` to both the `gh` wrapper and the `runVitestCheck` function. The stub was replaced with `makeDiscriminatingStub`, which routes by `cmd` argument: `"gh"` calls return the fake diff, `"pnpm"` calls return a configurable exit code. This makes AC4(d) (pass path) and AC4(g) (fail path) deterministic and removes the 60-second timeout hack. The production code's `execaImpl` calling convention is unchanged.

### Issue 1: AC5 operator-smoke harness

AC5's operator-smoke contract is covered by a deterministic CI harness under `src/__tests__/operator-smoke-helpers/` that drives the inner cycle with a stubbed dev persona (claims handoff but does not create `target-file.txt`) and a stubbed reviewer `runReviewerSession` that returns a structured fail for the missing artifact. The harness asserts the reviewer returns a non-`READY FOR MERGE` verdict and the manifest stays in `in-progress/`. The operator-driven step (Step 8.5) remains the gate for human evidence before merge, per `plugins/crew/docs/user-surface-acs.md`.

---

## Mid-flight revision history

### Revision 1 (initial draft + validation, shipped earlier 2026-05-24)

Spec authored, validated, marked ready-for-dev. AC1–AC4 (internal reviewer behaviour) + AC5 (operator-surface). Architecture: SKILL.md prose spawns reviewer subagent → reviewer invokes `runReviewerSession` → reviewer composes verdict text including `**Verdict: <SENTINEL>**` as final non-empty chat line → `processReviewerTranscript` calls `parseVerdict` to scrape the sentinel → manifest mutated accordingly.

The "Reviewer Findings — Decisions" section above captures the fix-pass decisions (M1, M3, M4, Issue 1, Issue 2) from validation.

### Revision 2 (post-operator-smoke, 2026-05-24 — this revision)

**Smoke evidence — trial 7 of 7.** Operator-smoke on 2026-05-24 ran 7 trials of `/crew:start` against the deterministic rubber-stamp reproducer (the `target-file.txt`-missing fixture). The SUBSTANTIVE contract was met on trial 7: `runReviewerSession` correctly detected ENOENT for `target-file.txt`, the AC executor flagged AC1 fail with `reason: "artifact missing at <path> (ENOENT)"`, and the reviewer persona composed `**Verdict: NEEDS CHANGES**` referencing the missing artifact by path. The semantics worked.

**But the user flow broke.** The reviewer LLM appended a courteous footer ("Handoff to generalist-dev — verdict recorded.") AFTER the `**Verdict: NEEDS CHANGES**` sentinel line. The locked-phrase parser in `verdict-parser.ts` requires the sentinel to be the FINAL non-empty line; trial 7's transcript violated that anchor; `processReviewerTranscript` returned `done-blocked-reviewer-grammar` instead of the intended `done-blocked-reviewer-verdict`. In production this means: reviewer correctly catches the bug → operator sees "blocked, needs human intervention" instead of "needs changes, dev should iterate" → the dev iteration cannot auto-proceed. Trust contract intact in semantics, broken in the operator's surface.

**Diagnosis.** Same family as `feedback_prose_mut_steps_need_seam.md`: load-bearing decisions must not live in LLM prose. Revision-1 architecture asked the reviewer LLM to render `**Verdict: <SENTINEL>**` as the final non-empty line and `processReviewerTranscript` to scrape it. The LLM-generates-final-line step is the unreliability point — paraphrase, trailing punctuation, footer prose, helpful closers all break it. Loosening the parser (e.g. "find the rightmost `**Verdict:` line") is patching the symptom; the fix is to move the load-bearing transport into the tool layer where determinism is free.

**Architectural shift (this revision folds in).**

1. `runReviewerSession` derives `recommendedVerdict: "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED"` deterministically from `acResults` per the closed algorithm in (3f). The tool decides; the LLM does not.
2. `runReviewerSession` persists `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json` as a side-effect before returning (atomic write per Story 1.6's helper). Same shape pattern as Story 4.3c's `completeStory` call inside `processReviewerTranscript`.
3. `processReviewerTranscript` reads the persisted file and switches on `recommendedVerdict`. The `reviewerTranscript` parameter is dropped — the chat is no longer load-bearing. Missing file → `done-blocked-no-session-result` (rubber-stamp protection analogous to 4.3c's verdict-grammar guard, but at the structural seam).
4. Reviewer persona chat becomes purely informational. The persona's only verdict-related obligation is to invoke `runReviewerSession`. Locked-phrase `verdict` entry remains in the catalogue as a documentation guideline; the parser is retired.
5. AC3, AC4, AC5 reworked per the sections above to assert the file-based transport.
6. Locked-files: `process-reviewer-transcript.ts` is removed from the locked list and added to declared-locked-file changes with bounded scope. `verdict-parser.ts` keeps its `@deprecated` JSDoc; no exports change.

**Lesson restated.** The original "tool-seam over prose" decision was made for the `completeStory` mutation (good). This revision extends the same lesson one step earlier in the pipeline — to the verdict-emission step itself. Anywhere a downstream tool needs to make a load-bearing decision based on an upstream LLM's output, the load-bearing artifact must be a structured file written by a deterministic tool, not a prose line the LLM is "instructed" to emit. Pattern §11 (calibration) should fold this in for Epic 6.

**Cost of revision 2.** One new task block (Task 8b — `processReviewerTranscript` rewrite), one new audit task (Task 8c — verdict-parser disposition), one new error class (`ReviewerResultFileMalformedError`), file-persistence assertions added to Task 9 and Task 10. Net dev work increase: estimated +1.5h vs revision 1 — small price for closing the trial-7 failure mode mechanically rather than by parser-loosening whack-a-mole.

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
