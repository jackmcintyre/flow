# Story 1.8: User-surface AC type and smoke gate in ship-story

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the **orchestrator running ship-story for any user-facing slash command or installable artifact**,
I want **a mandatory "did anyone actually run this?" gate that requires end-to-end evidence of the user surface working in real Claude Code before a PR opens**,
so that **document-driven verification (spec author → validator → dev → reviewer → QA) can never again ship a manifest, command, or install path that fails the moment a real user tries it.**

### What this story fixes (and why it needs its own story)

Stories 1.7 and 1.7a each shipped under 4/4 green ACs and approved code review. Both contained user-facing surfaces (a slash command, an install path) that no agent ever actually ran against real Claude Code. Eight bugs from one root cause surfaced when Jack tried the install live — `plugin.json`'s `skills` field shape was wrong, flat skill files didn't auto-discover, relative `mcpServers.args` paths failed under Claude Code's spawn CWD, our own schema required fields Claude Code rejects, the install-contract test locked in the wrong contract, and so on.

The defect is **structural**, not tactical: every gate in ship-story reasons from documents — spec author reads epic; validator reads spec; dev reads spec; reviewer reads diff; QA reads ACs. None of them is the end-user. The product passes every gate and still doesn't run.

This story closes the loop by:

1. **Tagging.** Adding a `user-surface` AC type to the story-spec template, and updating `bmad-create-story` to prompt the author to make this judgement explicitly for every AC.
2. **Gate.** Adding a new pre-PR gate in `ship.py` that, for any story containing at least one `user-surface` AC, requires either (a) an automated end-to-end test that drives the user-invocable surface, OR (b) a `user_surface_verified` event in the run log carrying pasted real-Claude-Code output for each `user-surface` AC.
3. **Fail-closed.** When neither is present, `ship.py` halts with exit code `USER_SURFACE_UNVERIFIED`, names the missing ACs, and refuses to push or open the PR.
4. **Test harness.** vitest covers the four gate behaviours (missing evidence fails, valid event passes, no-user-surface unaffected, malformed evidence rejected with a typed error).

### What this story is, in one sentence

Introduce a typed AC kind (`user-surface`), teach `bmad-create-story` to elicit and emit it, add a pre-PR gate in `ship.py` that demands end-to-end evidence for every `user-surface` AC, and pin the gate's behaviour with a four-case vitest suite.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions for this story (per the constraints handed to story creation).
- (b) Backfill `user-surface` tags onto already-shipped stories (1.1 through 1.7a). The gate applies prospectively from the first story authored under the updated template. Existing stories are grandfathered as "no user-surface ACs declared" and pass the gate trivially. Story 1.10 (README rewrite) is the first concrete production user of the new gate; Story 1.9 also rides on it per its AC1.
- (c) Build a Claude Code automation harness. AC2's "automated end-to-end test that drives the user-invocable surface" is the **escape hatch** for surfaces that have one (e.g. a CLI we can shell out to); it does NOT require us to invent a way to drive Claude Code from vitest. For slash commands and install paths where no such harness exists, the operator-smoke route (`user_surface_verified` event with pasted output) is the canonical path.
- (d) Change any existing `ship.py` subcommand's behaviour for stories without `user-surface` ACs. The gate is a no-op on those.
- (e) Define a UI/UX for the operator-smoke step beyond "the orchestrator prompts the operator to paste output, then records it via `$SH record <key> user_surface_verified --data '<json>'`". The ergonomics of that conversation live in `SKILL.md` orchestration text, not in `ship.py`.
- (f) Touch the spec-validator skill (`bmad-create-story` action: `validate`). The validator MAY in a follow-up be taught to flag specs that look like they should have `user-surface` ACs but don't; for now, the elicitation prompt in `create` mode is the only enforcement.
- (g) Introduce or modify any MCP tool. This is all skill-layer plumbing (Markdown template + Python script + vitest).

---

## Acceptance Criteria

> **Verbatim from epic.** The four ACs below match `_bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md` § Story 1.8 exactly. AC1 is `user-surface` (it touches the spec-authoring skill the operator invokes via `bmad-create-story`); AC2, AC3, AC4 are not (they govern internal gate behaviour and are covered by the vitest harness in AC4).

**AC1 (user-surface):**
**Given** the story-spec template and the `bmad-create-story` skill,
**When** I author a new story spec,
**Then** every AC that names a user-invocable surface (slash command, CLI invocation, installed-plugin artifact, file the user is asked to copy by name) must be tagged `user-surface`, and the skill prompts the author to make this judgement explicitly for each AC.

**AC2:**
**Given** a story whose spec contains at least one `user-surface` AC,
**When** ship-story reaches the gate between AC-verification and PR-open,
**Then** the gate requires either (a) an automated end-to-end test that drives the user-invocable surface (not the implementation layer beneath it), OR (b) an explicit `user_surface_verified` event in the run log carrying pasted output from a real Claude Code session run by Jack (or an operator), naming each `user-surface` AC and its observed result.

**AC3:**
**Given** neither (a) nor (b) is present,
**When** ship-story attempts to open the PR,
**Then** `ship.py` halts with exit code `USER_SURFACE_UNVERIFIED`, surfaces which `user-surface` ACs are missing evidence, and refuses to push or open the PR.

**AC4 (integration):**
vitest harness asserts:
- (i) a synthetic story spec with a `user-surface` AC and no smoke evidence in the run log causes `ship.py pre-pr-gate` to exit `USER_SURFACE_UNVERIFIED`;
- (ii) the same story with a `user_surface_verified` event passes the gate;
- (iii) a synthetic story with no `user-surface` ACs is unaffected by the gate;
- (iv) the gate's event-schema rejects malformed evidence with a typed error, in two explicit sub-cases:
  - (iv-a) a `user_surface_verified` event whose `data.ac_refs` field is missing;
  - (iv-b) a `user_surface_verified` event whose `data.observations[].pasted_output` field is missing.
  Each sub-case independently triggers `MalformedVerificationEvent` and causes the gate to fail with `USER_SURFACE_UNVERIFIED`.

---

## Tasks / Subtasks

- [ ] **Task 1 — Publish the user-surface convention inside the crew plugin (AC: 1)**
  - [ ] 1.1 Add `plugins/crew/docs/user-surface-acs.md` containing the canonical rules verbatim: what counts as a user-surface (the four rubric items i–iv), the `**AC<n> (user-surface):**` tag syntax, the gate's extraction regex (`^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*`), examples of tagged and untagged ACs, and the gate's pass/fail semantics. This is the only checked-in copy of the rules; `bmad-create-story` is treated as a third-party dependency and is NOT edited in this story (its tree is gitignored at the repo boundary).
  - [ ] 1.2 The doc is the spec; the ship-story orchestrator prompt is the carrier. Subagents invoked by ship-story consult this file by path.

- [ ] **Task 2 — Carry the convention via the ship-story orchestrator prompts (AC: 1)**
  - [ ] 2.1 Edit `.claude/skills/ship-story/SKILL.md` Step 4 (the prompt that spawns `bmad-create-story`) to inject the user-surface tagging instructions inline: tell the subagent to consult `plugins/crew/docs/user-surface-acs.md`, paste a summary of the rubric (i–iv) into the prompt, instruct the subagent to explicitly judge each AC and tag accordingly, and preserve all existing Step 4 instructions (the `sprint-status.yaml` MUST-NOT clause, the "no clarifying questions" clause, the spec-path output instruction).
  - [ ] 2.2 The "reasonable default" rule (mirrored from `plugins/crew/docs/user-surface-acs.md`): an AC is `user-surface` if and only if it references at least one of — (i) a slash command literal (e.g. `/crew:status`), (ii) a CLI command the operator types verbatim (e.g. `pnpm install`, `git clone`), (iii) a file path the README/install docs instruct the user to copy or open by name, or (iv) any Claude Code UI element (TUI panel, toast, tab-complete) the user is expected to observe. ACs that name only internal functions, schemas, MCP tools, or implementation files are NOT `user-surface`.
  - [ ] 2.3 Edit `.claude/skills/ship-story/SKILL.md` Step 5 (the validate prompt) to also ask the validator to check tagging correctness — every AC that names a slash command, CLI invocation, or file the user is asked to copy by name MUST carry the tag, and ACs that name only internals MUST NOT. Validator returns `fail` if tagging is wrong.
  - [ ] 2.4 The subagent (and validator) MUST NOT modify any status/state file (per ship-story's invariant inherited from Step 4 of `SKILL.md`).

- [ ] **Task 3 — Implement the `pre-pr-gate` subcommand in `ship.py` (AC: 2, 3)**
  - [ ] 3.1 Add a new subcommand `pre-pr-gate <story_key>` to `.claude/skills/ship-story/scripts/ship.py`. It is invoked by the orchestrator (ship-story `SKILL.md`) immediately after `verify-ac-table` returns green and immediately before `gh pr create`.
  - [ ] 3.2 The subcommand:
    1. Loads the resolved story JSON from `/tmp/ship-<story_key>.resolve.json` (already persisted by `resolve`).
    2. Parses the story spec at `spec_path` and extracts the set of AC indexes tagged `(user-surface)`. Tag-extraction regex pinned in "Tag-extraction regex" below.
    3. If the set is empty → exit 0 with stdout JSON `{"gate":"pre-pr","status":"skipped","reason":"no user-surface ACs"}` (covers AC4 case iii).
    4. Otherwise, loads the run log JSONL at `.claude/skills/ship-story/.runs/<story-key>.jsonl` and:
       - Checks for any event of type `automated_e2e_verified` with `data.ac_refs` covering the full set of `user-surface` AC indexes (route (a)), OR
       - Checks for any event of type `user_surface_verified` with `data.ac_refs` covering the full set AND `data.observations[]` each carrying `{ac_ref, pasted_output}` (route (b)).
    5. If either route covers every `user-surface` AC → exit 0 with stdout JSON `{"gate":"pre-pr","status":"passed","route":"automated|operator","ac_refs":[...]}`.
    6. Otherwise → exit with code `USER_SURFACE_UNVERIFIED` (defined as integer `42` — see "Exit code mapping" below; Python convention is to map symbolic name → constant), print to stderr a human-readable enumeration: `Missing user-surface verification for AC<n>, AC<m>. Provide either an automated_e2e_verified event covering these ACs, or a user_surface_verified event with pasted Claude Code output for each.` Do not push, do not open PR.
  - [ ] 3.3 Add helper `_parse_user_surface_acs(spec_text: str) -> set[int]` and `_load_verification_events(story_key: str) -> dict` for unit testability.
  - [ ] 3.4 The subcommand does NOT mutate `sprint-status.yaml`, the run log, or any other state file; it is read-only.

- [ ] **Task 4 — Define and enforce the event schema for verification evidence (AC: 4 case iv)**
  - [ ] 4.1 Add a schema-validation helper `_validate_verification_event(event: dict) -> None` that raises `MalformedVerificationEvent` (new typed exception, subclass of `ValueError`) when an `automated_e2e_verified` or `user_surface_verified` event payload fails its expected shape. Exact shape pinned in "Verification event schemas" below.
  - [ ] 4.2 Wire the validator into `_load_verification_events`: any event of the two types that fails validation is **NOT** silently dropped — it is collected as a malformed-event diagnostic; if the gate would otherwise have passed using a malformed event, the gate fails with `USER_SURFACE_UNVERIFIED` AND prints the typed error to stderr (`MalformedVerificationEvent: <reason>`). This satisfies AC4 case iv ("malformed evidence rejected with a typed error").
  - [ ] 4.3 Add a `record-verification` subcommand wrapper (thin shell over `record`) that validates the event payload at write time too. Signature: `ship.py record-verification <story_key> --type automated_e2e_verified|user_surface_verified --data '<json>'`. On schema failure, exit 2 with the typed error on stderr; do not write. Rationale: catching malformed evidence at write time is friendlier than catching it at gate time, but the gate-time check is still required (AC4 case iv tests the gate, not just the writer).

- [ ] **Task 5 — Wire the gate into the ship-story orchestrator (AC: 2, 3)**
  - [ ] 5.1 Edit `.claude/skills/ship-story/SKILL.md` to insert a new step between `verify-ac-table` (current Step 8 area) and `gh pr create` (current Step 10 area). The new step invokes `$SH pre-pr-gate <story_key>`.
  - [ ] 5.2 On exit 0 with `status:"skipped"` or `status:"passed"`: the orchestrator records the event via `$SH record <story_key> pre_pr_gate_passed --data '<gate_json>'` and proceeds to PR open.
  - [ ] 5.3 On exit `42` (`USER_SURFACE_UNVERIFIED`): the orchestrator halts. The SKILL.md text instructs the orchestrator how to prompt the operator: either point them to an automated harness path, or prompt the operator to run the named surfaces in a real Claude Code session and paste output, which the orchestrator then writes via `$SH record-verification`. After successful write, the orchestrator re-runs `$SH pre-pr-gate`. (Loop terminates because the operator either provides evidence or aborts the story.)
  - [ ] 5.4 No change to `verify-ac-table`, `pr-body`, or any other existing subcommand.
  - [ ] 5.5 **Dog-food sub-task (orchestrator-executed, NOT dev-agent-executed).** Once the dev work for Tasks 1–7 is complete and AC-table is green, the orchestrator (Step 8/8.5 of ship-story `SKILL.md`) MUST itself: (a) invoke `bmad-create-story` in a real Claude Code session against a throwaway story idea, (b) confirm the updated skill prompts for `user-surface` tagging per AC, (c) capture the verbatim Claude Code output, and (d) call `$SH record-verification <this-story-key> --type user_surface_verified --data '{"ac_refs":[1],"operator":"<id>","observations":[{"ac_ref":1,"pasted_output":"<verbatim>"}]}'`. The dev agent does NOT generate this evidence — Task 5.5 is a marker to the orchestrator that the dog-food smoke happens at Step 8/8.5, after dev sign-off and before `gh pr create`. Update the SKILL.md text in 5.1 to make this responsibility explicit.

- [ ] **Task 6 — vitest harness for the gate (AC: 4)**
  - [ ] 6.1 Add `plugins/crew/mcp-server/tests/pre-pr-gate.test.ts`. The test shells out to `python3 .claude/skills/ship-story/scripts/ship.py pre-pr-gate <story_key>` against synthetic fixtures, since the gate is implemented in Python; the vitest test acts as a driver. Use `execa` (already in `mcp-server` deps; if not, add as devDependency — confirm via `pnpm --dir plugins/crew/mcp-server view`).
  - [ ] 6.2 Fixture layout: `plugins/crew/mcp-server/tests/fixtures/pre-pr-gate/` with subdirs per case:
    - `case-i-missing/` — spec with one `(user-surface)` AC, empty run log → expect exit `42`, stderr names the missing AC.
    - `case-ii-passing/` — same spec, run log contains one well-formed `user_surface_verified` event covering the AC → expect exit `0`, stdout JSON `status:"passed"`.
    - `case-iii-no-surface/` — spec with no `(user-surface)` ACs, empty run log → expect exit `0`, stdout JSON `status:"skipped"`.
    - `case-iv-a-malformed-missing-ac-refs/` — same spec as ii but the `user_surface_verified` event is missing `data.ac_refs` → expect exit `42` AND stderr contains literal `MalformedVerificationEvent`.
    - `case-iv-b-malformed-missing-pasted-output/` — same spec as ii but the `user_surface_verified` event's `data.observations[0]` is missing `pasted_output` → expect exit `42` AND stderr contains literal `MalformedVerificationEvent`.
    Both sub-cases are independent test cases; the suite asserts each one separately (do not collapse into a parameterised single assertion that would pass if only one branch fires).
  - [ ] 6.3 The test sets `RUNS_DIR_OVERRIDE` / `STATUS_FILE_OVERRIDE` env vars (add support in `ship.py` so tests don't pollute real run logs); if Task 3's implementation prefers a flag like `--runs-dir <path>` and `--spec-path <path>`, use that. Confirm the chosen approach with the Task 3 author.
  - [ ] 6.4 Run with `pnpm --dir plugins/crew test` and confirm all four cases pass alongside the existing suites listed in 1.7a's AC4 epilogue.

- [ ] **Task 7 — Documentation and authoring guidance**
  - [ ] 7.1 Add a short "User-surface ACs and the pre-PR smoke gate" subsection to `.claude/skills/bmad-create-story/SKILL.md` (or a sibling `user-surface-acs.md` referenced from `SKILL.md`) explaining: the four surface examples, the tag syntax, what the gate does, and how the operator-smoke path works in practice.
  - [ ] 7.2 Add a corresponding subsection to `.claude/skills/ship-story/SKILL.md` describing the new step and the two evidence routes.
  - [ ] 7.3 Update no other documentation. The user-facing README is rewritten in Story 1.10, which itself will flow through this gate as its first production user (per its AC4).

- [ ] **Manual smoke step (post-merge, NOT automatable in vitest)**
  - [ ] M.1 **This story dog-foods its own gate.** AC1 is `user-surface` — it touches `bmad-create-story`, which the operator invokes by name. Because this story implements the `record-verification` command and the `pre-pr-gate`, the gate runs against THIS story's own AC1 before its PR opens. The orchestrator (ship-story Step 8/8.5, NOT the dev agent) is responsible for: (1) invoking `bmad-create-story` against a throwaway story idea in a real Claude Code session after the dev work lands, (2) confirming the skill now prompts for `user-surface` tagging per AC, (3) capturing the verbatim Claude Code output, and (4) writing a `user_surface_verified` event covering AC1 via `$SH record-verification <this-story-key> --type user_surface_verified --data '<json with ac_refs:[1] and one observation pasting the bmad-create-story output>'`. The dev agent does NOT have to produce or paste that evidence; that step is the orchestrator's responsibility per Step 8/8.5 of the updated ship-story `SKILL.md`. Once recorded, `pre-pr-gate` re-runs green and the PR opens. Story 1.10 remains the first non-self-referential production user of the gate.

---

### Tag convention

In the story-spec Markdown, every AC item is one of:

```
**AC1 (user-surface):**
**Given** ...
```

or

```
**AC1:**
**Given** ...
```

The numeric prefix (`AC1`, `AC2`, ...) is canonical; the parenthetical tag immediately after the AC number is either `(user-surface)` or absent; the gate ignores all other parentheticals (e.g. `(integration)`). No other tags trigger gate behaviour in this story. Future stories MAY add additional tag values (e.g. `(perf-critical)`) but the gate considers only `(user-surface)`.

### Tag-extraction regex

```python
USER_SURFACE_AC_RE = re.compile(r"^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*", re.MULTILINE)
```

Extract `int(match.group(1))` for each match in the spec body. Result is a `set[int]` of AC indexes.

### Verification event schemas

Both event types ride the existing JSONL run-log format used by `$SH record`. Top-level shape is `{type, ts, story_key, data}` (existing convention). The two new types pin `data` as follows:

**`automated_e2e_verified`:**
```json
{
  "ac_refs": [1, 3],
  "test_path": "plugins/crew/mcp-server/tests/<file>.test.ts",
  "test_command": "pnpm --dir plugins/crew test <file>"
}
```
- `ac_refs`: non-empty array of positive integers (AC indexes).
- `test_path`: string, non-empty.
- `test_command`: string, non-empty.
- All three fields required; any missing → `MalformedVerificationEvent`.

**`user_surface_verified`:**
```json
{
  "ac_refs": [1, 2],
  "operator": "jack",
  "observations": [
    {"ac_ref": 1, "pasted_output": "<verbatim claude code output>"},
    {"ac_ref": 2, "pasted_output": "<verbatim claude code output>"}
  ]
}
```
- `ac_refs`: non-empty array of positive integers.
- `operator`: string, non-empty (free-form identifier).
- `observations`: non-empty array; each element MUST have both `ac_ref` (positive integer, present in `ac_refs`) and `pasted_output` (non-empty string).
- The set of `observations[].ac_ref` MUST equal the set of `ac_refs` (every claimed AC has a pasted observation).
- Any missing or mismatched field → `MalformedVerificationEvent`.

### Exit code mapping

```python
EXIT_USER_SURFACE_UNVERIFIED = 42  # mnemonic: gate halts before PR
```

Define as a module-level constant in `ship.py`. Use `sys.exit(EXIT_USER_SURFACE_UNVERIFIED)` (NOT `die(..., code=...)` if `die` is reserved for exit 1). The vitest harness asserts on the integer `42`.

### Coverage of the user-surface AC set

The gate passes only when **every** `user-surface` AC index is covered by at least one valid verification event (either route). Coverage is the **union** of `ac_refs` across all valid events: it is legal to verify AC1 via an automated test and AC2 via operator-smoke in the same run, as long as the union covers `{1, 2}`. The gate reports the precise missing set on failure.

---

## Dev Notes

### What the dev needs to know about ship.py's current shape

- `ship.py` is a single CLI dispatcher with a subcommand-per-function shape. New subcommands attach via the existing argparse subparser pattern. Read the `__main__` block for the exact convention.
- `record` already exists and appends to the JSONL run log. The new `record-verification` is a thin wrapper that calls `_validate_verification_event` and then delegates to the existing `record` write path. Do not duplicate the write code; refactor `record`'s internal helper if needed so `record-verification` can reuse it.
- `RUNS_DIR` is resolved at module load from `REPO / ".claude/skills/ship-story/.runs"`. For testability, accept an override via env var `CREW_SHIP_RUNS_DIR` (preferred) or a `--runs-dir` flag — pick one and document. The override is read-only at module init: `RUNS_DIR = Path(os.environ.get("CREW_SHIP_RUNS_DIR", REPO / ".claude/skills/ship-story/.runs"))` is the lightest-touch pattern.
- `verify-ac-table` (existing) is the gate immediately before `pre-pr-gate` in the orchestrator. It currently fails closed on any non-green AC row. `pre-pr-gate` runs only if `verify-ac-table` passed.

### What the dev needs to know about `bmad-create-story`

- The skill currently writes specs from `template.md` plus inline elicitation in `SKILL.md` step 5. The template's Acceptance Criteria section is currently `1. [Add acceptance criteria from epics/PRD]` — a placeholder. The dev should preserve the existing pattern (numbered list of `**AC<n>:**` items, each followed by Given/When/Then) seen in shipped specs like `1-7-status-skill-and-readme-install-path-through-the-plugin-sees-my-repo.md` and `1-7a-hotfix-make-the-install-path-actually-work-end-to-end.md`.
- The skill is invoked by ship-story Step 4 with an explicit "do not pause for clarifying questions" clause. The new elicitation must be implemented as **internal judgement by the skill**, NOT as a question to the user.

### What's NEW vs UPDATE

**NEW files:**
- `plugins/crew/docs/user-surface-acs.md` — checked-in, canonical, author-facing reference for the `(user-surface)` tag and the pre-PR gate (the only on-disk home for the rules; `bmad-create-story` is a gitignored dependency and is not edited).
- `plugins/crew/mcp-server/tests/pre-pr-gate.test.ts` — the four-case vitest harness.
- `plugins/crew/mcp-server/tests/fixtures/pre-pr-gate/` — fixture tree (four subdirs as described in Task 6.2).

**UPDATE files:**
- `.claude/skills/ship-story/scripts/ship.py` — add `pre-pr-gate` and `record-verification` subcommands, the schema helper, the typed exception, the exit-code constant, and the env-var-driven `runs_dir()` accessor. Existing subcommands unchanged.
- `.claude/skills/ship-story/SKILL.md` — insert the new pre-PR gate step between `verify-ac-table` and `gh pr create`; extend Step 4's `bmad-create-story` prompt to carry the user-surface tagging instructions inline (citing `plugins/crew/docs/user-surface-acs.md` and pasting a rubric summary); extend Step 5's validate prompt to also check tagging correctness.

**MUST NOT TOUCH:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.
- Any other story spec file under `_bmad-output/implementation-artifacts/`.
- `plugins/crew/.claude-plugin/plugin.json`, `marketplace.json`, or any plugin manifest.
- The existing `verify-ac-table`, `resolve`, `worktree`, `set-status`, `pr-body`, `record`, `state`, `cleanup`, `pending-cleanup`, `reviewer-issues` subcommands of `ship.py` (except the minor `RUNS_DIR` override refactor, which must remain backward-compatible).

### Testing standards

- vitest, run via `pnpm --dir plugins/crew test`. Existing suites: smoke (1.1), resolver (1.2), validate-active-adapter (1.2b), standards-doc (1.3), permissions/canonical-fs (1.4), telemetry + git-commit (1.5), manifest-state-machine (1.6), get-status (1.7), install-contract (1.7a). The new `pre-pr-gate.test.ts` joins this list. All must remain green; zero skips.
- The Python `ship.py` is currently exercised only indirectly via the ship-story flow. This story is the first to test its internals via fixtures. If a Python unit-test framework isn't already in the repo for skills, the chosen pattern is **vitest-driven subprocess invocation** (the test shells out via `execa`) — this avoids introducing pytest just for this one piece. Document this choice in Task 6's test file header.
- The malformed-event tests (case iv-a and iv-b) must each assert on a specific stderr substring (`MalformedVerificationEvent`) rather than the full message, to avoid brittleness on wording tweaks. Each sub-case is a discrete test so a regression in one branch (missing `ac_refs` vs missing `pasted_output`) cannot hide behind the other.

### Project Structure Notes

- `.claude/skills/bmad-create-story/` already exists (`template.md`, `SKILL.md`, `checklist.md`, `customize.toml`, `discover-inputs.md`).
- `.claude/skills/ship-story/scripts/ship.py` already exists and is the canonical dispatcher.
- `plugins/crew/mcp-server/tests/` is the canonical vitest home for all crew suites; adding a new `.test.ts` follows the established pattern from 1.1–1.7a.
- No new pnpm dependencies expected; if `execa` is not already a devDependency of `plugins/crew/mcp-server/`, add it at the latest stable (resolve via `pnpm view execa version`).

### References

- Epic: [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md § Story 1.8]
- Precursor failure analysis: [Source: epic-1 § Story 1.7a post-story note (2026-05-20)]
- Ship-story dispatcher: [Source: .claude/skills/ship-story/scripts/ship.py § module docstring]
- Ship-story orchestrator: [Source: .claude/skills/ship-story/SKILL.md § Execution]
- Story-spec template: [Source: .claude/skills/bmad-create-story/template.md]
- Sibling stories using this gate: [Source: epic-1 § Story 1.9 AC1, § Story 1.10 AC4]

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
