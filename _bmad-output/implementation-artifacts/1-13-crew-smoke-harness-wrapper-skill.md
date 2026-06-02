# Story 1.13: `/flow:smoke` harness wrapper skill

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **operator running per-story operator-smokes against the plugin**,
I want **a single `/flow:smoke <label>` skill that stands up a clean scratch repo and chains `skip-hiring → plan → scan` with a tool-layer checkpoint between every step**,
so that **smoke runs start from a known-good state instead of burning 1–3 trials on setup drift (missing persona frontmatter, missing standards.md, planner failing on a no-commit repo) before the actual subject-under-test is ever exercised**.

### What this story is, in one sentence

Ship a new MCP tool `createSmokeScratchRepo` (mkdtemp + git-init + `.flow/config.yaml` + `.crew/standards.md` + cleanup closure) plus a new skill `plugins/flow/skills/smoke/SKILL.md` (frontmatter `name: crew:smoke`) that chains four MCP-tool checkpoint steps in order — `createSmokeScratchRepo`, `getTeamSnapshot`, `readBacklogInventory`, `listClaimableTodos` — with `[smoke] step N (<name>): ok` log lines between each, then halts at a fifth `start` step that prints `Ready. Run /flow:start in this scratch repo.` and returns control to the operator without auto-invoking `/flow:start`.

### What this story does (and why it needs its own story)

Operator-smokes are the only artefact that catches user-surface regressions before merge (the dev/reviewer loop only sees the code path). Every operator-smoke this epic has paid a setup tax — Story 4.6 alone took seven trials before the smoke even reached the subject-under-test. The root cause is the same every time: a tiny shape defect in step-zero scaffolding (missing persona frontmatter, missing `.crew/standards.md`, planner choking on a repo with no commits) that has nothing to do with the story actually being smoked.

The memory entry `project_smoke_harness_wrapper` flagged this as "overdue" twice. Story 4.14 (PR #146) implemented exactly this wrapper but was closed unmerged in the 2026-05-25 rollback. The implementation logic transfers cleanly to current `dev` HEAD; the rebase work is:

1. **Rename `/flow:smoke-setup` → `/flow:smoke`** to match the `/flow:<verb>` catalogue convention (the original predated the convention). Log prefix `[smoke-setup]` → `[smoke]` follows.
2. **Tool-count assertion rebase** — PR #146 bumped 29 → 30. Current `dev` HEAD is 31 (Story 4.10b's `runAutoMergeGate` landed since). 1.13 bumps 31 → 32 across six assertion sites.
3. **No skill-name collision check** — `plugins/flow/skills/` does not currently contain a `smoke/` directory (verified pre-authoring), so the rename is a clean create rather than a move.

The skill stops before `/flow:start`. The whole point of the smoke is for the operator to observe `/flow:start`; chaining it through the skill would defeat the purpose.

### Substrate decisions worth pinning

1. **Skill name is `/flow:smoke`, log prefix is `[smoke]`.** Convention rationale: every other crew skill is `/flow:<single-verb>` (`/flow:plan`, `/flow:scan`, `/flow:status`, `/flow:hire`, `/flow:start`, `/flow:team`, `/flow:ask`, `/flow:skip-hiring`). `/flow:smoke-setup` would be the only two-word verb. The `smoke` verb itself is sufficient — the operator already knows this is the pre-roll for a smoke run.

2. **`createSmokeScratchRepo` is an MCP tool, not a script.** Three reasons: (a) `writeManagedFile` for `.flow/config.yaml` and `.crew/standards.md` is only available inside the MCP server; (b) the static guard `tests/canonical-fs-guard.test.ts` requires all `git` spawns to live in `lib/git.ts`, so the helper has to compose with the existing MCP `lib/`; (c) the skill needs a tool to call as its step-1 checkpoint and the tool _is_ the checkpoint.

3. **`gitInitWithEmptyCommit` is added to `lib/git.ts`.** Required by the canonical-fs-guard. Two commands: `git init -b main` (deterministic default branch, no dependency on operator's `init.defaultBranch`), then `git -c user.email=… -c user.name=… commit --allow-empty -m "<msg>"` (inline identity so the call succeeds on fresh CI containers / containers with no global git config; the `-c` flag scopes identity to this one `commit` invocation, repo persistent config untouched).

4. **`.crew/standards.md` is copied from `plugins/flow/docs/standards-example.md`** (the shipped template per Story 1.3). No new template file — reuse the existing one.

5. **Step 5 does NOT auto-invoke `/flow:start`.** Verified structurally by AC3(vi) — the SKILL.md body must not contain a literal `/flow:start` invocation pattern. The string `/flow:start` appears in the `Ready. Run /flow:start in this scratch repo.` handoff line only.

## Acceptance Criteria

**AC1:**

A new MCP tool `createSmokeScratchRepo({ label, parentDir? })` lives at `plugins/flow/mcp-server/src/tools/create-smoke-scratch-repo.ts` and is registered in `register.ts` (bringing the tool count from 31 → 32). The tool:

- mkdtemps a directory under `<parentDir>` whose name starts with `crew-smoke-<label>-` followed by the random suffix Node's `fs.mkdtemp` appends (no ULID — Node's suffix is already collision-free); default `parentDir = os.tmpdir()`. `label` is validated as kebab-case (lowercase letters, digits, hyphens; min length 1).
- Runs git-init + an initial empty commit via `gitInitWithEmptyCommit(scratchRoot)` from `lib/git.ts` so the canonical-fs-guard static check (`plugins/flow/mcp-server/tests/canonical-fs-guard.test.ts`, from Story 1.5) stays satisfied — no `git` spawns outside `lib/git.ts`.
- Writes a minimal native-adapter `.flow/config.yaml` via `writeManagedFile` (`adapter: native`, `standards: {}`).
- Copies `plugins/flow/docs/standards-example.md` to `<scratchRoot>/.flow/standards.md` via `writeManagedFile`.
- Returns `{ scratchRoot: string, cleanup: () => Promise<void> }` where `cleanup` is an idempotent `fs.rm(scratchRoot, { recursive: true, force: true })` closure.

Verifiable via `plugins/flow/mcp-server/tests/create-smoke-scratch-repo.integration.test.ts` exercising real `os.tmpdir()` (no fs stubs). Tests cover: happy path (returns valid `scratchRoot` containing both `.flow/config.yaml` and `.crew/standards.md`); idempotent cleanup (calling twice succeeds); label validation (rejects empty string and non-kebab-case); `parentDir` override; git repo is initialised (HEAD ref resolvable); standards.md contents match the shipped template byte-for-byte.

**AC2:**

A new skill file at `plugins/flow/skills/smoke/SKILL.md` with YAML frontmatter:

```yaml
---
name: flow:smoke
description: Stand up a clean smoke-harness scratch repo and chain skip-hiring → plan → scan with assertion checkpoints so smokes start from a known-good state.
allowed_tools: [createSmokeScratchRepo, getTeamSnapshot, readBacklogInventory, listClaimableTodos]
---
```

The body contains five numbered steps in order, each with the listed checkpoint tool call before advancing:

1. **scratch-repo** — call `createSmokeScratchRepo({ label })`; capture `scratchRoot`. Checkpoint: confirm the returned path exists and contains both `.flow/config.yaml` and `.crew/standards.md`. On success: print `[smoke] step 1 (scratch-repo): ok` followed by `scratch_root: <scratchRoot>`. On failure: print `[smoke] step 1 (scratch-repo): FAILED — <reason>` and halt.

2. **skip-hiring** — operator invokes `/flow:skip-hiring` against the scratch repo. Checkpoint: call `getTeamSnapshot({ targetRepoRoot: scratchRoot })` and assert the returned roster has ≥1 role whose persona frontmatter populates both `hired_at` and `catalogue_version` (the exact frontmatter that bit Story 4.6 — verify it here, fail fast if drift returns). On success: print `[smoke] step 2 (skip-hiring): ok`. On failure: print `[smoke] step 2 (skip-hiring): FAILED — <reason>` and halt.

3. **plan** — operator invokes `/flow:plan` against the scratch repo, exits planner with a minimal authored backlog (1 trivial source story suffices). Checkpoint: call `readBacklogInventory({ targetRepoRoot: scratchRoot })` and assert ≥1 source story is now present. On success: print `[smoke] step 3 (plan): ok`. On failure: print `[smoke] step 3 (plan): FAILED — <reason>` and halt.

4. **scan** — operator invokes `/flow:scan` against the scratch repo. Checkpoint: call `listClaimableTodos({ targetRepoRoot: scratchRoot })` and assert ≥1 manifest is now present in `.flow/state/to-do/`. On success: print `[smoke] step 4 (scan): ok`. On failure: print `[smoke] step 4 (scan): FAILED — <reason>` and halt.

5. **start** — print `[smoke] step 5 (start): ok` followed by `Ready. Run /flow:start in this scratch repo.` and return control to the operator. Do NOT auto-invoke `/flow:start`.

The body also contains a `# Failure modes` section documenting (a) scratch-repo creation failure (filesystem error propagated verbatim), (b) `hired_at` / `catalogue_version` missing from persona frontmatter (Story 4.6 regression signal — re-check `instantiatePersona`'s frontmatter writer), (c) planner exited without authoring any source story, (d) `/flow:scan` produced zero claimable manifests (most often a source-story shape defect — see memory `project_native_scan_silent_skip`), (e) operator forgot `--plugin-dir` (every MCP-tool call will fail with `tool not found`).

**AC3:**

A new test at `plugins/flow/mcp-server/src/skills/__tests__/smoke-skill-content.test.ts` mirrors the shape of `start-skill-content.test.ts` (same `splitFrontmatter` helper, same path-resolution pattern walking `..` segments from `__dirname` to the repo-root SKILL.md). It reads `plugins/flow/skills/smoke/SKILL.md` and asserts:

- (i) Frontmatter `name` equals `flow:smoke`.
- (ii) Frontmatter `allowed_tools` is exactly `[createSmokeScratchRepo, getTeamSnapshot, readBacklogInventory, listClaimableTodos]` — four tools, no extras.
- (iii) All five step labels appear in the body, each paired with its expected checkpoint tool name (or `null` for step 5):

  ```ts
  const STEPS: ReadonlyArray<{ stepNumber: number; name: string; tool: string | null }> = [
    { stepNumber: 1, name: "scratch-repo", tool: "createSmokeScratchRepo" },
    { stepNumber: 2, name: "skip-hiring", tool: "getTeamSnapshot" },
    { stepNumber: 3, name: "plan", tool: "readBacklogInventory" },
    { stepNumber: 4, name: "scan", tool: "listClaimableTodos" },
    { stepNumber: 5, name: "start", tool: null },
  ];
  ```

- (iv) For each entry in `STEPS` (steps 1–4 only — step 5 is its own check in (v)), the body contains the concrete success line for that step: e.g. `[smoke] step 1 (scratch-repo): ok`, `[smoke] step 2 (skip-hiring): ok`, … Assert each of the four concrete strings as a substring. Additionally, the body contains the failure-shape template `[smoke] step N (<name>): FAILED — <reason>` (the literal `N` and `<name>` placeholders are present here — this is the documented shape, not a per-step line).
- (v) The body contains the literal handoff line `Ready. Run /flow:start in this scratch repo.`.
- (vi) The body does NOT contain a literal Claude-Code-style invocation of `/flow:start` (i.e. `/flow:start` appears only inside the handoff line, never on its own line as an instruction the LLM would obey). Implementation: count occurrences of `/flow:start` and assert the count equals the number of occurrences inside the handoff line (today: 1).

**AC4:**

The tool-count assertions in the following six locations are updated from 31 → 32:

- `plugins/flow/mcp-server/tests/ask-mode-enforcement.test.ts:461`
- `plugins/flow/mcp-server/tests/ask-skill.test.ts:525`
- `plugins/flow/mcp-server/tests/get-team-snapshot.test.ts:641`
- `plugins/flow/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts:588`
- `plugins/flow/mcp-server/src/tools/__tests__/compute-agreement.test.ts:604`
- `plugins/flow/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts:695`

Where the assertion sits next to an inline `// Story 4.x added …` comment trail (the `inner-cycle.integration.test.ts` one is the canonical example), extend the trail with `; Story 1.13 added createSmokeScratchRepo (32)`. Any missed assertion will fail CI — verifiable by running `pnpm test` from `plugins/flow/mcp-server/` and seeing 0 failures.

**AC5:**

The `[smoke] step N (<name>): ok` and `[smoke] step N (<name>): FAILED — <reason>` prefixes do not collide with the dev/reviewer parser sentinels. Verifiable by `grep -E '\[smoke\]|Handoff to reviewer|Verdict:|READY FOR MERGE|done-blocked' plugins/flow/mcp-server/src/tools/process-dev-transcript.ts plugins/flow/mcp-server/src/tools/process-reviewer-transcript.ts plugins/flow/skills/smoke/SKILL.md` returning the `[smoke]` literals only in `SKILL.md` and the sentinel literals only in the parser sources. The `[smoke]` token does not appear in either parser source.

**AC6:**

Covered structurally by AC3(vi). Called out separately because this is the load-bearing design choice: the operator is here to observe `/flow:start` themselves. The dev agent MUST NOT add a step 5 instruction like "Now invoke `/flow:start`" — step 5's only output is the handoff line.

## Tasks / Subtasks

- [x] **Task 1** — Add `gitInitWithEmptyCommit(cwd)` to `plugins/flow/mcp-server/src/lib/git.ts` (AC1)
  - [x] 1.1 — Two-command implementation: `git init -b main`, then `git -c user.email=<inline> -c user.name=<inline> commit --allow-empty -m "<msg>"`. Use the inline-identity pattern from the PR #146 diff (commit message: `chore: initial empty commit for smoke scratch repo`).
  - [x] 1.2 — Export from `lib/git.ts`. Note: the existing `lib/git.ts` JSDoc block in PR #146 (lines 4–22 of the diff) is a good template for the helper's docstring; keep it short.

- [x] **Task 2** — Create `plugins/flow/mcp-server/src/tools/create-smoke-scratch-repo.ts` (AC1)
  - [x] 2.1 — Define `CreateSmokeScratchRepoOptions = { label: string; parentDir?: string }` and `CreateSmokeScratchRepoResult = { scratchRoot: string; cleanup: () => Promise<void> }`.
  - [x] 2.2 — Validate `label` is kebab-case via Zod (`z.string().regex(/^[a-z0-9-]+$/).min(1)`); validate `parentDir` is optional non-empty string.
  - [x] 2.3 — mkdtemp under `<parentDir ?? os.tmpdir()>/crew-smoke-<label>-` (Node `fs.mkdtemp` adds the random suffix; the ULID flavour in PR #146 is unnecessary — Node's suffix is already collision-free).
  - [x] 2.4 — Call `gitInitWithEmptyCommit(scratchRoot)`.
  - [x] 2.5 — Write `.flow/config.yaml` via `writeManagedFile` (skip `mcpToolContext` since `.flow/config.yaml` is a non-canonical path; confirm by checking `writeManagedFile`'s call signature in current `dev` HEAD).
  - [x] 2.6 — Copy `plugins/flow/docs/standards-example.md` to `<scratchRoot>/.flow/standards.md` via `writeManagedFile`. Read the template via `fs.readFile` from the bundled location (resolve path the same way `start-skill-content.test.ts` does — `import.meta.url` + `..` segments).
  - [x] 2.7 — Return `{ scratchRoot, cleanup }` where `cleanup` does `await fs.rm(scratchRoot, { recursive: true, force: true })` (idempotent — the `force: true` flag swallows ENOENT on second call).

- [x] **Task 3** — Register the new tool in `plugins/flow/mcp-server/src/tools/register.ts` (AC1, AC4)
  - [x] 3.1 — Import `createSmokeScratchRepo` from `./create-smoke-scratch-repo.js`.
  - [x] 3.2 — Use the project's `server.registerTool({ name, description, inputSchema, handler })` pattern (verified against current `dev` HEAD's `register.ts`; the `server.tool(...)` positional form from PR #146 predates this repo's API and does not exist on `AiEngineeringTeamServer`). Example shape, modelled on the existing `getStatus` registration at `register.ts:48`:

    ```ts
    server.registerTool({
      name: "createSmokeScratchRepo",
      description:
        "Create a disposable smoke-harness scratch repo seeded with git init + empty commit + minimal .flow/config.yaml + .crew/standards.md. Used by the /flow:smoke skill as the first checkpoint step.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          parentDir: { type: "string" },
        },
        required: ["label"],
      },
      handler: async (args) => {
        const parsed = z
          .object({ label: z.string().min(1), parentDir: z.string().min(1).optional() })
          .parse(args);
        const result = await createSmokeScratchRepo(parsed);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ scratchRoot: result.scratchRoot }) },
          ],
        };
      },
    });
    ```

- [x] **Task 4** — Author `plugins/flow/skills/smoke/SKILL.md` (AC2, AC5, AC6)
  - [x] 4.1 — Frontmatter exactly as in AC2.
  - [x] 4.2 — Body sections: `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes`, `# Out of scope (deferred)`. Use PR #146's smoke-setup SKILL.md as a structural template (it's in `/tmp/pr146.diff` from the create-story session; if not available, regenerate via `gh pr diff 146 | awk '/skills\/smoke-setup\/SKILL.md/,0'`).
  - [x] 4.3 — Find-and-replace `smoke-setup` → `smoke` and `[smoke-setup]` → `[smoke]` throughout. Verify no `smoke-setup` remains via grep.
  - [x] 4.4 — Step 5 wording is exactly `[smoke] step 5 (start): ok` followed by `Ready. Run /flow:start in this scratch repo.` — and nothing else. Do NOT add "now run …" or "next: …" prose; that would tempt the LLM to auto-invoke.

- [x] **Task 5** — Author `plugins/flow/mcp-server/src/skills/__tests__/smoke-skill-content.test.ts` (AC3)
  - [x] 5.1 — Copy `start-skill-content.test.ts` as a template. Replace the SKILL_FILE path constant to point at `plugins/flow/skills/smoke/SKILL.md`.
  - [x] 5.2 — Replace the assertions with AC3's six checks (i–vi). The `STEPS` constant is the central anchor — keep it as a `ReadonlyArray<{ stepNumber, name, tool }>` literal and iterate.
  - [x] 5.3 — For AC3(vi), use a regex count: `(skillBody.match(/\/flow:start/g) ?? []).length` and assert it equals the count inside the handoff line (today: 1).

- [x] **Task 6** — Rebase tool-count assertions (AC4)
  - [x] 6.1 — Bump each of the six assertion sites listed in AC4 from `31` → `32`.
  - [x] 6.2 — Extend the `inner-cycle.integration.test.ts` inline comment trail at line 588 with `; Story 1.13 added createSmokeScratchRepo (32)`. The other five sites have shorter or no comments — leave them alone.

- [x] **Task 7** — Integration tests (AC1)
  - [x] 7.1 — Create `plugins/flow/mcp-server/tests/create-smoke-scratch-repo.integration.test.ts`. Six scenarios: happy path; idempotent cleanup; kebab-case label validation; `parentDir` override; git repo initialised (HEAD resolvable via `git -C <scratchRoot> rev-parse HEAD` returning a 40-char SHA); standards.md byte-equals the shipped template.
  - [x] 7.2 — Use real `os.tmpdir()` and real `fs` calls — no stubs. Each test cleans up via vitest's `afterEach` hook so failed runs don't leak directories (mirror the existing pattern in `tests/scan-sources.test.ts` / `tests/read-custom-role.test.ts`).

- [x] **Task 8** — Local verification (process)
  - [x] 8.1 — `pnpm build` from `plugins/flow/mcp-server/` — clean.
  - [x] 8.2 — `pnpm test` from `plugins/flow/mcp-server/` — 100% green; ≥6 new tests passing.
  - [x] 8.3 — Commit `dist/` updates alongside `src/` (per CLAUDE.md § Plugin build output).

## Dev Notes

- **Seed PR (closed unmerged):** PR #146 (`feat(4.14): smoke-harness wrapper skill`). The diff is salvageable as a structural template; the rename (`smoke-setup` → `smoke`, `[smoke-setup]` → `[smoke]`) and the tool-count rebase (29 → 30 → 32) are the only material differences. Pull the diff with `gh pr diff 146` if not still cached at `/tmp/pr146.diff`.

- **Memory grounding (auto-loaded):** `project_smoke_harness_wrapper`, `project_operator_smokes_via_plan`, `project_native_scan_silent_skip` (Failure mode (d) in AC2 references this). Memory `feedback_planner_prose_must_match_manifest` is also relevant — the scan-step checkpoint is the safety net for that class of defect.

- **Static guard to respect:** `plugins/flow/mcp-server/tests/canonical-fs-guard.test.ts` asserts that no file outside `lib/git.ts` spawns a `git` subprocess. The new `gitInitWithEmptyCommit` helper is the only place `git init` / `git commit` may be invoked from.

- **`writeManagedFile` usage:** `.flow/config.yaml` and `.crew/standards.md` are non-canonical paths (canonical = files the MCP server's path validator enforces, like `.flow/state/to-do/<ulid>.json`). They don't need an `mcpToolContext` arg. Verify the call signature against current `dev` — PR #146 was authored against pre-rollback state and the signature may have evolved.

- **Standards template:** `plugins/flow/docs/standards-example.md` is the shipped template per Story 1.3. Resolve its path the same way `start-skill-content.test.ts` resolves the SKILL.md path — `import.meta.url` + `..` segments to `plugins/flow/docs/`.

- **Skill directory placement:** `plugins/flow/skills/smoke/SKILL.md`. The existing `plugins/flow/skills/` contains `ask/`, `hire/`, `plan/`, `scan/`, `skip-hiring/`, `start/`, `status/`, `team/`. No collision.

- **Verification command for AC3:** `pnpm vitest run src/skills/__tests__/smoke-skill-content.test.ts` from `plugins/flow/mcp-server/`.

### Project Structure Notes

- Skill lives at `plugins/flow/skills/smoke/SKILL.md` (alongside other crew skills).
- Tool lives at `plugins/flow/mcp-server/src/tools/create-smoke-scratch-repo.ts` (next to the other `*-scratch-*`-style helpers if any, otherwise alongside `claim-next-story.ts` etc.).
- Tests:
  - Structural-anchor: `plugins/flow/mcp-server/src/skills/__tests__/smoke-skill-content.test.ts` (mirror of `start-skill-content.test.ts`).
  - Integration: `plugins/flow/mcp-server/tests/create-smoke-scratch-repo.integration.test.ts` (top-level `tests/` like other integration tests).
- No conflicts with existing structure. The skill name `smoke` and the tool name `createSmokeScratchRepo` were both unused on `dev` as of the authoring scan.

### References

- [Epic 1 § Story 1.13](/_bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md) — story block with AC1–AC6 source-of-truth.
- [PR #146 diff](https://github.com/jackmcintyre/crew/pull/146) (closed unmerged 2026-05-25) — structural template for tool + SKILL.md + tests. Pull via `gh pr diff 146`.
- [Story 4.6 retrospective](/_bmad-output/implementation-artifacts/epic-4-retrospective.md) — the seven-trial smoke that motivated this story.
- [Memory: project_smoke_harness_wrapper](/Users/jackmcintyre/.claude/projects/-Users-jackmcintyre-projects-crew/memory/project_smoke_harness_wrapper.md) — "overdue" flag.
- [`start-skill-content.test.ts`](/plugins/flow/mcp-server/src/skills/__tests__/start-skill-content.test.ts) — structural-anchor test template to mirror.
- [`canonical-fs-guard.test.ts`](/plugins/flow/mcp-server/tests/canonical-fs-guard.test.ts) — static guard requiring all `git` spawns in `lib/git.ts`.
- [`docs/standards-example.md`](/plugins/flow/docs/standards-example.md) — the shipped standards template (copied to `.crew/standards.md` in step 1).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7

### Debug Log References

### Completion Notes List

All ACs satisfied. Tool count is now 32. `pnpm test` runs 1267 tests across 102 files with 0 failures. Key design note: SKILL.md was carefully authored so `/flow:start` appears exactly once (only inside the handoff line `Ready. Run /flow:start in this scratch repo.`), verified by AC3(vi) assertion. The `[smoke]` prefix has no collision with dev/reviewer parser sentinels (AC5).

### File List

- plugins/flow/mcp-server/src/lib/git.ts (modified — added gitInitWithEmptyCommit)
- plugins/flow/mcp-server/src/tools/create-smoke-scratch-repo.ts (new)
- plugins/flow/mcp-server/src/tools/register.ts (modified — registered createSmokeScratchRepo)
- plugins/flow/skills/smoke/SKILL.md (new)
- plugins/flow/mcp-server/src/skills/__tests__/smoke-skill-content.test.ts (new)
- plugins/flow/mcp-server/tests/create-smoke-scratch-repo.integration.test.ts (new)
- plugins/flow/mcp-server/tests/ask-mode-enforcement.test.ts (modified — 31→32)
- plugins/flow/mcp-server/tests/ask-skill.test.ts (modified — 31→32)
- plugins/flow/mcp-server/tests/get-team-snapshot.test.ts (modified — 31→32)
- plugins/flow/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts (modified — 31→32 + comment trail)
- plugins/flow/mcp-server/src/tools/__tests__/compute-agreement.test.ts (modified — 31→32)
- plugins/flow/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts (modified — 31→32)
- plugins/flow/mcp-server/dist/ (rebuilt)
