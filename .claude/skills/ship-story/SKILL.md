---
description: Ship one story end-to-end through the BMad cycle in an isolated worktree, verifying every acceptance criterion before opening a PR. Use when the user says "ship story X", "/ship-story", or asks to run the per-story implementation cycle.
---

# Ship Story

Drive a single story from `backlog` → open PR using sequential BMad subagents in an isolated git worktree. Deterministic plumbing (story resolution, AC extraction, status mutation, PR body assembly, run state) is handled by `scripts/ship.py`. Your job as orchestrator is the judgment work: spawning subagents and gating on their results.

## Invocation

- `/ship-story` — picks the next eligible `backlog` story
- `/ship-story 1-1` — works that story (prefix-matched against story keys)

**Post-merge cleanup is conversational, not a slash command.** When Jack says any of "merged", "I merged it", "PR merged", "shipped", "it's in", etc., treat it as the single-story cleanup trigger. When he says "reconcile" or "fix the sprint status", run the batch sweeper. Both are in [Step 12](#step-12--post-merge-cleanup-conversational-trigger) below.

## Architecture

You are the orchestrator. You do NOT write story specs, code, tests, or reviews — you spawn subagents for each. You call `scripts/ship.py <subcommand>` for every deterministic operation. The script is the source of truth for: which story is next, what its ACs are, what the worktree path is, when an AC table counts as green, what the PR body looks like, what status transitions are legal.

Run-state is persisted as JSONL in `.claude/skills/ship-story/.runs/<story-key>.jsonl`. Every milestone is recorded; on a halt, you can resume by reading state.

## Model selection

Each subagent spawn below specifies an explicit `model:` to pass to the Agent tool. The bet: a well-specced story is well within Sonnet's reach for execution, so reserve Opus for the judgement-heavy phases (spec authoring, adversarial review). The reviewer is the quality gate — if Sonnet dev produces something weak, the Opus reviewer catches it and the rework loop fires.

| Phase | `model` | Rationale |
|---|---|---|
| Step 4 — spec authoring | `opus` | Sets up everything downstream; a bad spec wastes a full dev+review cycle. Pay here. |
| Step 5 — spec validation | `sonnet` | Structural check; cheap. |
| Step 6 — dev / implementation | `sonnet` | Well-specced execution. Planning-discipline rules are doing the heavy lifting. |
| Step 7 — code review | `opus` | Adversarial reasoning; lowest call volume, highest leverage. |
| Step 7 — dev rework | `sonnet` | Scope bounded by reviewer's issue list. |
| Step 8 — QA test generation | `sonnet` | Pattern-matchy given the AC list. |
| Step 10 — CI rework dev | `sonnet` | Same shape as Step 6. |

Notes:
- The Agent tool's `model` param only exposes the family (`opus` / `sonnet` / `haiku`), not the specific version. Pin 4.7 vs 4.6 at the CLI/launch level (whichever model the orchestrator itself is running on supplies the specific version for inheriting subagents).
- Reasoning effort is not exposed per-Agent in the tool schema; rely on family selection. If a reviewer pass feels under-considered, escalate that phase by re-running it explicitly rather than reaching for a thinking knob.
- **Canary signal:** if average review passes per story climbs above ~1.5, the Sonnet-dev bet is hurting. Surface this in retros — it usually means planning discipline has slipped, not that Sonnet has.

## Execution

Let `SH=python3 .claude/skills/ship-story/scripts/ship.py` for brevity below.

**Worktree-relative paths (read this once).** From Step 3 onward, every file path passed to a subagent — spec, sprint-status, anything under `_bmad-output/` — MUST be the **worktree-absolute** form: `<worktree_path>/<rel>`. Concretely: `ship.py resolve` returns `spec_path` as `_bmad-output/implementation-artifacts/<story_key>.md` (repo-relative); your prompts should pass `<worktree_path>/<spec_path>`. The same applies to every `$SH set-status` invocation during the in-flight phases — pass `--worktree <worktree_path>` so the flip lands inside the story branch and ships in the PR rather than as uncommitted drift on main. Bookkeeping committed in the story branch ships with the PR; bookkeeping written to the main repo's working tree does not, and turns into a "chore: mark X done" follow-up PR (the chore-PR pattern Jack flagged).

### Step 1 — Preflight

```bash
$SH preflight
```

Halts if working tree is dirty, gh is unauthed, or required paths are missing. Non-zero exit → halt the skill and surface stderr.

**Watch-build check.** After preflight, check whether the TypeScript watch compiler is running:

```bash
pgrep -f "tsc.*--watch" > /dev/null 2>&1
```

If the process is not found (exit non-zero), do **not** halt — but pause and tell the user:

> `pnpm build:watch` is not running. The dev loop needs it to recompile TypeScript changes before each `/reload-plugins`.
>
> Start it in a separate terminal:
> ```sh
> pnpm --dir plugins/flow/mcp-server build:watch
> ```
> Or from inside the mcp-server directory:
> ```sh
> cd plugins/flow/mcp-server && pnpm build:watch
> ```
> Reply **go** when it's running (or **skip** to proceed without it — fine if you're only editing SKILL.md files).

Wait for the user's reply before continuing to Step 2.

### Step 2 — Resolve story

```bash
$SH resolve [<story_id>]
```

Returns JSON with `story_key`, `story_short`, `title`, `epic_num`, `epic_file`, `spec_path`, and `acceptance_criteria[]`. The script also persists the JSON to `/tmp/ship-<story_key>.resolve.json` (path echoed back as `resolve_json_path`) for reuse in Step 9 — you don't need to write it yourself.

Print the story title and AC count to the user.

```bash
$SH record <story_key> resolved
```

### Step 3 — Create the worktree

```bash
$SH worktree <story_key>
```

Fails closed if path exists, branch exists, or origin/main can't be fetched. Returns JSON with `worktree` path, `branch`, and a `plugin_dir` block containing the exact `claude --plugin-dir <worktree>/plugins/flow` invocation the operator should use when any user-surface AC needs operator-smoke verification (Step 8.5). Epic 3 retro (2026-05-21) replaced the prior `pnpm dev:install` symlink approach — the symlink survived only the current session because Claude Code's plugin healer treats it as corruption and wipes the cache on restart. The `--plugin-dir` flag is Anthropic's blessed dev workflow ([anthropics/claude-code#17361](https://github.com/anthropics/claude-code/issues/17361), [#23819](https://github.com/anthropics/claude-code/issues/23819)) and survives restarts. All subsequent file/test/git ops happen inside the worktree.

```bash
$SH record <story_key> worktree_ready --data '{"path":"..."}'
```

### Step 4 — Author the story spec (subagent: bmad-create-story)

**Pre-authored spec check.** Before spawning, check whether `<spec_path>` already exists on disk. If it does, an upstream authoring path (the spec-authoring routine, an `/author-next` run, or a hand-written draft) has produced it. **Skip the authoring subagent entirely** and proceed to the verify/status/record block below. Step 5's validation is the gate that decides whether the pre-authored spec is usable — if it's malformed or mis-tagged, validation halts the run with `SPEC_VALIDATION_FAILED` exactly as it would for a freshly-authored spec. Record the reuse:

```bash
$SH record <story_key> spec_reused
```

Then jump to the `Verify <spec_path> exists` block below.

Otherwise (the common case — no spec on disk), spawn ONE subagent with `model: opus`. Prompt:

> Run the `bmad-create-story` skill (action: `create`) for story key `<story_key>`. The epic source is `<worktree_path>/<epic_file>`. Output the spec to `<worktree_path>/<spec_path>` (worktree-absolute — do NOT write to the main repo's copy). Do NOT implement code — spec only. Do NOT modify `sprint-status.yaml` or any other status/state file — the orchestrator owns status transitions. Do NOT pause for clarifying questions; make reasonable defaults and proceed.
>
> **Story shape tag (required).** Immediately after the story title (the first `#` heading), add a line:
> ```
> story_shape: user-surface
> ```
> or
> ```
> story_shape: substrate
> ```
> Use `user-surface` if the story's primary deliverable is a Claude Code slash command, CLI behaviour, or any other LLM-driven output the end user observes directly. Use `substrate` for internal wiring, data models, adapters, and plumbing that users don't interact with directly. This tag controls the review-pass budget (substrate=3, user-surface=5) — choose honestly.
>
> **Behavioural contract section (user-surface stories only).** If `story_shape: user-surface`, the spec MUST include a "Behavioural contract" section listing prompt-level invariants in absolute modals (MUST / MUST NOT / NEVER). Additionally, at least one AC must be a deterministic content-structure check — e.g. "the catalogue file at path X contains substring Y" — rather than purely behavioural assertions. This is required because LLM outputs are non-deterministic; a structural anchor makes the AC verifiable without human judgment. (Epic 2 retro, #76.)
>
> **User-surface AC tagging (Story 1.8 convention).** Consult `plugins/flow/docs/user-surface-acs.md` for the canonical rules; the summary below is the contract. When drafting each AC, explicitly judge whether it names a user-invocable surface and emit the tag inline:
>
> - Tag an AC `**AC<n> (user-surface):**` if and only if it references at least one of:
>   - (i) a slash command literal (e.g. `/flow:status`, `/ship-story`);
>   - (ii) a CLI command the operator types verbatim (e.g. `pnpm install`, `git clone`);
>   - (iii) a file path the README/install docs instruct the user to copy or open by name;
>   - (iv) any Claude Code UI element (TUI panel, toast, tab-complete, slash-command picker) the user is expected to observe.
> - Otherwise tag it `**AC<n>:**` (no parenthetical).
> - Do NOT ask the user — make the judgement yourself per the standing "no clarifying questions" rule. Where the judgement is non-obvious, add a one-line HTML comment under the AC explaining your reasoning, e.g. `<!-- user-surface: AC2 names the /flow:status slash command, rubric (i). -->`.
> - The numeric prefix (`AC1`, `AC2`, …) is canonical; the gate's regex is `^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*`. ACs naming only internal functions, schemas, MCP tools, or implementation files are NOT `user-surface`.

Verify `<worktree_path>/<spec_path>` exists. Then flip status inside the worktree and commit so the transition ships with the PR:

```bash
$SH set-status <story_key> ready-for-dev --worktree <worktree_path>
git -C <worktree_path> add _bmad-output/implementation-artifacts/sprint-status.yaml _bmad-output/implementation-artifacts/<story_key>.md
git -C <worktree_path> diff --cached --quiet || git -C <worktree_path> commit -m "chore(<story_short>): scaffold story spec + mark ready-for-dev"
$SH record <story_key> spec_authored
```

The `git diff --cached --quiet || commit` pattern is a no-op when nothing changed (e.g. the spec was already at `ready-for-dev` and was reused); when there is something to commit, it captures both the spec scaffold and the status flip in one bookkeeping commit.

**Status writes:** Only `ship.py set-status` mutates `sprint-status.yaml`. Every subagent prompt in this skill must include the "do not touch sprint-status.yaml" clause. If a subagent reports having moved status, the orchestrator's `set-status` call is the authoritative one — verify post-run via `$SH state <story_key>`. Interim transitions (`in-progress`, `review`) are NOT written; the run log JSONL is the authoritative resume signal. Only `ready-for-dev` (Step 4) and `done` (Step 8 bookkeeping commit) hit sprint-status.

### Step 5 — Validate the spec (subagent: bmad-create-story validate)

Cheap insurance — a malformed spec wastes a full dev+review cycle. Spawn ONE subagent with `model: sonnet`. Prompt:

> Run the `bmad-create-story` skill with action `validate` against `<worktree_path>/<spec_path>` (worktree-absolute — do NOT read or modify the main repo's copy). Return the validation report verbatim and a single-word verdict: `pass` or `fail`. Do NOT modify `sprint-status.yaml`. Do NOT pause for clarifying questions.
>
> **In addition to the skill's own checks, verify that every example in the spec actually satisfies the rules it illustrates.** Examples: if the spec defines a commit-message regex AND gives a sample commit message, the sample must match the regex. If the spec defines a schema AND gives a sample event, the sample must validate. Flag any example-vs-rule contradiction as `fail` — these waste a full dev pass when the dev hits the contradiction at implementation time.
>
> **Also verify user-surface AC tagging.** Per `plugins/flow/docs/user-surface-acs.md`, every AC that names a slash command (e.g. `/flow:status`), a CLI invocation the operator types verbatim (e.g. `pnpm install`), a file the user is asked to copy or open by name (e.g. README install instructions), or any Claude Code UI element the user is expected to observe MUST carry the `(user-surface)` parenthetical immediately after the AC number (e.g. `**AC1 (user-surface):**`). Conversely, ACs that name only internal functions, schemas, MCP tools, or implementation files MUST NOT carry the tag. Flag any AC that appears mis-tagged as `fail` and name the AC index; the pre-PR gate uses these tags to decide which ACs need real-Claude-Code evidence before a PR opens.

If verdict is `fail` → halt with `SPEC_VALIDATION_FAILED`, surface the report, and record:

```bash
$SH record <story_key> spec_validation_failed --data '{"report":"..."}'
```

If `pass`:

```bash
$SH record <story_key> spec_validated
```

### Step 6 — Implement (subagent: bmad-dev-story)

Spawn ONE subagent with `model: sonnet`. Prompt:

> Run `bmad-dev-story` against `<worktree_path>/<spec_path>` (worktree-absolute — every read and write you do on the spec must hit the worktree copy, never the main repo's). Your working directory is the worktree at `<worktree_path>`. Implement code and unit tests. Run `pnpm install && pnpm build && pnpm test` (or the project's equivalent) from the relevant package directory and confirm all green before returning.
>
> **Before returning, commit your work to branch `story/<story_key>` using conventional-commit style (e.g. `feat(<story_short>): <one-line summary>`). Use a HEREDOC for the message. Do NOT push, do NOT open a PR, do NOT modify `sprint-status.yaml` or any other status/state file. Verify `git status` is clean and `git log --oneline origin/main..HEAD` shows your commit(s) before returning.**
>
> Do NOT pause for clarifying questions; make reasonable defaults and proceed. When done, return a one-paragraph summary including the commit SHA(s).

```bash
$SH record <story_key> implemented
```

No sprint-status flip here. Interim states (`in-progress`, `review`) live in the run log JSONL; sprint-status only flips at `ready-for-dev` (Step 4) and `done` (Step 8 bookkeeping).

If the returned summary reports no commit (or `git -C <worktree_path> log --oneline origin/main..HEAD` is empty), do NOT proceed to Step 7 — re-spawn the dev subagent with "your previous run left no commits on the branch; commit your scaffold per the prompt above." Burning a review pass on an empty diff is the failure mode this guard exists for.

### Step 7 — Review ↔ rework cycle (subagent: bmad-code-review, variable budget)

Maintain a local counter `passes = 0`. Read the budget before the loop:

```bash
$SH review-budget <spec_path>
# → {"story_shape": "substrate"|"user-surface", "budget": 3|5}
```

<!-- Variable budget rationale (Epic 2 retro #76, #80): user-surface stories require more review cycles because
     LLM-driven outputs are non-deterministic and stub-vs-real gaps are harder to catch statically. -->

Loop:

1. `passes += 1`. Halt with `REVIEW_BLOCKED` if `passes > 3` (substrate) or `passes > 5` (user-surface).
2. Spawn a fresh subagent with `model: opus`: "Run `bmad-code-review` against the diff on branch `story/<story_key>`. Return verdict (`approve` / `request-changes` / `block`) and an itemised issue list, where each item has `severity` (Critical/High/Medium/Low/Info), `location` (`file:line` if applicable), and `description`.\
   \
   **Severity guidance — stub-vs-real (from Epic 2 retro #80):** If a test stubs or mocks production code that the user-facing surface relies on (e.g. mocking the MCP handler the slash command invokes), the AC is not really verified — the stub proves the test harness, not the product. This is `High` severity, not `Info`. Flag it as `request-changes`.\
   \
   **Reviewer clause — lock-vs-contract (from Epic 2 retro #77):** If the story spec contains a 'MUST NOT modify file X' lock, confirm the user-surface contract still works under that lock — i.e. verify the lock didn't silently break the contract by checking that the feature the locked file supports still behaves correctly. Flag any breakage as `High`.\
   \
   Do NOT modify `sprint-status.yaml`. Do NOT pause for questions."
3. Record the verdict AND the issue list — this is how Step 11 surfaces non-blocker issues that shipped:
   ```bash
   $SH record <story_key> review_pass --data '{"pass":N,"verdict":"...","issues":[{"severity":"Low","location":"foo.ts:12","description":"..."}, ...]}'
   ```
   If the reviewer returned no issues, omit `issues` (or pass `[]`).
4. If `approve` → break; continue to Step 8.
5. If `block` → halt with `REVIEW_BLOCKED`. No PR.
If `request-changes` → spawn a fresh dev subagent with `model: sonnet` (running `bmad-dev-story`) with the issue list and `<worktree_path>/<spec_path>` (worktree-absolute): "Address each issue. Do not change scope beyond what was flagged. Commit your fixes to `story/<story_key>` before returning (do not push, do not touch sprint-status.yaml). Confirm tests still green." Then loop to step 1.

### Step 8 — Systematic AC verification (subagent: bmad-qa-generate-e2e-tests)

Spawn ONE fresh subagent with `model: sonnet`. Prompt (with the AC list pasted verbatim from `/tmp/ship-<story_key>.resolve.json`):

> Story: `<story_key>`. Spec at `<worktree_path>/<spec_path>` (worktree-absolute). Acceptance criteria:
> <numbered AC list>
>
> Step 1 — Run the `bmad-qa-generate-e2e-tests` skill against the implemented code on branch `story/<story_key>`. Generate API/E2E tests that exhaustively cover every AC above. If an existing unit test already covers an AC, reuse it; do not duplicate.
>
> Step 2 — Run the full test suite (the QA-generated tests plus any pre-existing unit tests).
>
> Step 3 — Output a single JSON array to `/tmp/ship-<story_key>.acs.json` with objects of shape:
> `{"ac": "<verbatim AC>", "test": "<test name/path>", "result": "pass" | "fail", "evidence": "<short string: output snippet or file:line of assertion>"}`
> Exactly one row per AC, in original order. Then output the same JSON to stdout.
>
> Do NOT skip ACs. Do NOT mark an AC `pass` without a runnable test that asserts it. If you cannot make an AC green, mark it `fail` and explain in `evidence` — do not retry forever.
>
> **Before returning, commit any new or modified test files to `story/<story_key>` using a conventional-commit message (e.g. `test(<story_short>): add acceptance suite covering all ACs`). Use a HEREDOC. Do NOT push, do NOT open a PR, do NOT modify `sprint-status.yaml`. Verify `git status` is clean before returning.**
>
> Do NOT pause for clarifying questions.

Then gate:

```bash
$SH verify-ac-table /tmp/ship-<story_key>.acs.json
```

Non-zero exit → halt with `AC_VERIFICATION_FAILED`. No PR. Record:

```bash
$SH record <story_key> ac_verified
```

After recording, verify the worktree is clean (`git -C <worktree_path> status --porcelain` empty). If any QA-generated files are still uncommitted, halt with `AC_VERIFICATION_FAILED` and surface the unstaged paths — never paper over by committing them yourself.

Then write the **bookkeeping commit** so the `done` flip ships in the PR (rather than landing on main post-merge as a chore-PR):

```bash
$SH set-status <story_key> done --worktree <worktree_path>
git -C <worktree_path> add _bmad-output/implementation-artifacts/sprint-status.yaml _bmad-output/implementation-artifacts/<story_key>.md
git -C <worktree_path> diff --cached --quiet || git -C <worktree_path> commit -m "chore(<story_short>): mark <story_key> done in sprint-status"
```

The `diff --cached --quiet || commit` guard means: only commit if something actually changed. If the dev/QA agents already updated the spec's `Status:` field inside the worktree and `set-status` flipped sprint-status, you get one bookkeeping commit. If they didn't touch the spec (e.g. pre-authored spec already at `done`), you may get only the sprint-status delta. Either is fine.

If sprint-status is already at `done` when you run `set-status` (idempotent no-op — script returns `"noop": true`), the `git add` may still stage the spec file's `Status:` flip from the dev agent. The guard handles both the "nothing to commit" and "only spec changed" cases cleanly.

### Step 8.5 — Pre-PR user-surface smoke gate

Document-driven verification has a known blind spot: every gate in this skill reasons from artefacts (epic, spec, diff, AC table) — none of them is the end user. Story 1.8 closes that loop by tagging ACs whose verification requires real-Claude-Code observation as `(user-surface)` and requiring end-to-end evidence before any PR opens.

```bash
$SH pre-pr-gate <story_key>
```

The gate resolves the spec path in order: `--spec-path <p>` flag if provided (test hook), else `spec_path` from `/tmp/ship-<story_key>.resolve.json` (the orchestrator's persisted payload from Step 2), else the convention fallback `_bmad-output/implementation-artifacts/<story_key>.md`. The gate parses the story spec, extracts the set of `(user-surface)`-tagged ACs, and:

- **No `user-surface` ACs** → exits 0 with `{"status":"skipped"}`. Proceed to Step 9 unchanged.
- **All `user-surface` ACs covered** by a valid `automated_e2e_verified` or `user_surface_verified` event in the run log → exits 0 with `{"status":"passed","route":"automated|operator|mixed"}`. Record and proceed:
  ```bash
  $SH record <story_key> pre_pr_gate_passed --data '<the gate JSON>'
  ```
- **Otherwise** → exits `42` (`USER_SURFACE_UNVERIFIED`) and prints to stderr which ACs are missing evidence. Do NOT push, do NOT open a PR.

**On exit 42 — the two evidence routes.** Decide based on which user surface the AC touches:

1. **Automated route.** If the surface has a programmatic harness (a CLI we can shell out to, an HTTP endpoint, a file we can read), instruct a dev/QA subagent to write a test that drives that surface end-to-end, run it, and record:
   ```bash
   $SH record-verification <story_key> --type automated_e2e_verified --data '{"ac_refs":[<n>,...],"test_path":"<path>","test_command":"<cmd>"}'
   ```
2. **Operator-smoke route.** If the surface is a slash command, an install path, or any Claude Code TUI behaviour that has no programmatic driver, you (orchestrator) MUST set up the smoke environment for Jack — do not just ask him to "run it somewhere." The setup is small but specific:

   **a. Mint a scratch target repo** with whatever `.flow/config.yaml` the AC needs. Example for `adapter: native`:
   ```bash
   SCRATCH=$(mktemp -d -t flow-smoke-XXXX)
   mkdir -p "$SCRATCH/.flow"
   printf 'adapter: native\n' > "$SCRATCH/.flow/config.yaml"
   git -C "$SCRATCH" init -q
   # initial commit so HEAD resolves (avoids `git rev-parse failed` noise in the planner):
   git -C "$SCRATCH" commit --allow-empty -q -m 'init'
   echo "$SCRATCH"
   ```

   **b. Launch Claude Code against the worktree's plugin via `--plugin-dir`** — NOT via the dev-install symlink, NOT via `/plugin install`. The `--plugin-dir` flag is Anthropic's officially-blessed dev workflow (`Load a plugin from a directory or .zip for this session only`); it bypasses the marketplace cache that gets nuked on Claude Code restart. Give Jack the exact invocation:
   ```sh
   cd $SCRATCH
   claude --plugin-dir /Users/jackmcintyre/projects/crew/.worktrees/<story_key>/plugins/flow
   ```

   **Do NOT recommend `pnpm dev:install` or symlink dancing here.** Story 1.11's symlink approach works once but gets deleted on every Claude Code restart by the plugin healer (it sees a symlink where it expects a directory-copy install and removes it). See `anthropics/claude-code` issues [#17361](https://github.com/anthropics/claude-code/issues/17361) and [#23819](https://github.com/anthropics/claude-code/issues/23819) for the underlying mechanism, and PR #94's retro comment for the trace.

   **c. Tell Jack what to run and what to paste back.** Be specific about which slash command, what input, and what verbatim output to capture (planner messages, file contents, error text, etc.). One paragraph max.

   **d. After Jack pastes back, record:**
   ```bash
   $SH record-verification <story_key> --type user_surface_verified --data '{"ac_refs":[<n>,...],"operator":"jack","observations":[{"ac_ref":<n>,"pasted_output":"<verbatim>"},...]}'
   ```
   `record-verification` schema-validates the payload at write time; on schema failure it exits 2 and refuses to append. After a successful write, re-run `$SH pre-pr-gate <story_key>`.

   **e. Tear down the scratch repo as part of cleanup messaging:** include `rm -rf $SCRATCH` in your end-of-story summary so Jack can wipe it after merge. `ship.py cleanup` does not touch scratch dirs.

**Dog-fooding clause for Story 1.8 itself.** Story 1.8 introduces this gate AND has one `user-surface` AC (AC1 — it touches `bmad-create-story`). The orchestrator (not the dev agent) is responsible for: invoking `bmad-create-story` in a real Claude Code session against a throwaway story idea after dev sign-off, confirming the skill prompts for `user-surface` tagging per AC, capturing the verbatim output, and writing it via `record-verification` against story key `1-8-user-surface-ac-type-and-smoke-gate-in-ship-story`. Story 1.10 is the first non-self-referential production user.

### Step 9 — Open the PR

PR base resolves from `<repo>/.claude/skills/ship-story/config.yaml` `default_base` (fallback: `main`).

Build the body deterministically:

```bash
$SH pr-body /tmp/ship-<story_key>.resolve.json /tmp/ship-<story_key>.acs.json <passes> > /tmp/ship-<story_key>.body.md
```

Run from the main repo cwd — do NOT `cd` into the worktree. Bash-tool cwd persists across calls, and `$SH` resolves `REPO` from its script path: a stray `cd <worktree_path>` will redirect later `record` events into `<worktree>/.claude/skills/ship-story/.runs/`, breaking Step 12's `pending-cleanup`.

```bash
git -C <worktree_path> push -u origin "story/<story_key>"
# Resolve the base in the MAIN repo cwd — NOT inside the subshell below. ship.py
# refuses to run from inside .worktrees/, so a `$(… default-base)` evaluated after
# `cd <worktree_path>` returns empty and gh silently falls back to the default branch.
base="$(python3 .claude/skills/ship-story/scripts/ship.py default-base)"
(cd <worktree_path> && gh pr create \
  --title "feat(<epic_num>): <title>" \
  --base "$base" \
  --body-file /tmp/ship-<story_key>.body.md)
```

(`gh pr create` needs to be invoked from within a repo checkout, hence the subshell; `git push` accepts `-C`. Neither leaks cwd back to the parent.)

Capture the PR URL **and PR number** (extract from the URL — Step 10 needs `<pr_number>` for `gh pr checks`). Record:

```bash
$SH record <story_key> pr_opened --data '{"url":"...","number":N}'
```

Note: status stays at `review` — Jack gates the merge, not this skill.

### Step 10 — CI watch ↔ resolve cycle (max 3 passes)

Mirrors Step 7's review/rework structure. Maintain a local counter `ci_passes = 0`. Loop:

1. `ci_passes += 1`. Halt with `CI_BLOCKED` if `ci_passes > 3`.
2. Wait for CI to settle on the PR (poll every 60s, cap 15min). The cheap check:
   ```bash
   gh pr checks <pr_number> --watch
   ```
   If the command itself exits non-zero because checks are still queued/running past the cap, halt with `CI_TIMEOUT` (not `CI_BLOCKED` — Jack can resume manually).
3. `$SH record <story_key> ci_pass --data '{"pass":N,"conclusion":"success|failure|timeout"}'`
4. If all required checks are `success` → break; continue to Step 11.
5. If any required check is `failure`:
   - Pull failing-job logs: `gh run view <run_id> --log-failed` for each failing run.
   - Spawn a fresh dev subagent with `model: sonnet` (running `bmad-dev-story`) with: the failing-check names, the captured logs, the worktree-absolute spec path, and the worktree path. Prompt:
     > CI failed on PR #<pr_number> for branch `story/<story_key>` (worktree `<worktree_path>`, spec at `<worktree_path>/<spec_path>`). Failures: <list>. Logs: <paste>. Diagnose the root cause, fix it inside the worktree, and re-run `pnpm install && pnpm build && pnpm test` locally to confirm green. **Before returning, commit your fix to `story/<story_key>` with a conventional-commit message (e.g. `fix(<story_short>): <one-line>`) and push to origin so CI re-runs. Do NOT modify `sprint-status.yaml`. Do NOT widen scope beyond what the failing checks demanded. Do NOT pause for clarifying questions.**
   - Then loop to step 1.

When CI is green, record:

```bash
$SH record <story_key> ci_green
```

### Step 11 — Retro comment + summarise

**Step 11a — Post the retro comment on the PR (mandatory, every story).** Telling the user "remember to post a retro" doesn't work — the retro evaporates between merge and the next sprint (#80 lesson). The orchestrator posts the comment directly via `gh pr comment` so it lives in the PR's permanent record.

1. Gather the inputs:
   ```bash
   $SH reviewer-issues <story_key>
   ```
2. Compose the body and write to `/tmp/ship-<story_key>.retro.md`. The body MUST include:
   - **Header:** `## Ship-story retro` (level-2; PR comments don't get TOCs).
   - **Run stats line:** `Review passes: N of <budget> · CI passes: M of 3 · Run log: .claude/skills/ship-story/.runs/<story_key>.jsonl`.
   - **Reviewer notes (shipped anyway):** verbatim output of `$SH reviewer-issues`. If the script lists items addressed in a later rework pass (the script dumps *all* recorded issues, including resolved ones), annotate each item inline with `_(resolved in <sha>)_` or `_(unresolved — Info-only, shipped)_` so the merged record is honest. Omit the heading if the tool's output is empty.
   - **For `story_shape: user-surface`:** a **Smoke observations** subsection summarising what was observed during the operator-smoke pass (pulled from `user_surface_verified` events in the run log) — prompt-level surprises, stub-vs-real gaps, behavioural-contract drift, anything the reviewer wouldn't have caught from static analysis. Omit the subsection if there are no notable observations.
   - **Process gotchas (this run only):** anything that bit the orchestrator during *this* execution that would bite future runs — e.g. `cd`-leak that put a record in the wrong path, a broken dev-loop, a misconfigured marketplace install. Two or three lines, no more. Omit the subsection if nothing of note happened.
   - **Follow-ups proposed (if any):** bullets of new stories or fixes this run surfaced, with one-line justification. Omit the subsection if none.
3. Post the comment:
   ```bash
   gh pr comment <pr_number> --body-file /tmp/ship-<story_key>.retro.md
   ```
   Run from the main repo cwd (not the worktree — `gh` resolves the repo from cwd's git remote, and the main repo's remote is the right one). Capture the returned comment URL.
4. Record:
   ```bash
   $SH record <story_key> retro_posted --data '{"comment_url":"..."}'
   ```

If `gh pr comment` fails (network, auth, etc.), halt with `RETRO_POST_FAILED`, surface stderr, and do NOT proceed to the chat summary — the retro is the audit trail; a quiet skip undermines its whole purpose. Jack can retry the post after fixing the underlying issue.

**Step 11b — Summarise to the user.** 2-3 sentences max:
- which story shipped + PR URL
- review passes consumed (`N of <budget>`, where `<budget>` comes from `$SH review-budget <spec_path>`) and CI passes consumed (`M of 3`)
- retro comment URL (from Step 11a)
- one-line reminder: "Tell me when you've merged and I'll clean up."

Do NOT re-render the reviewer notes block in the chat summary — they're now in the PR retro comment, which is the durable surface. The chat summary is ephemeral; the retro is the record.

### Step 12 — Post-merge cleanup (conversational trigger)

This step is **not** auto-run at the end of Step 11 — merge timing is unbounded (could be minutes, could be days). Instead, it fires when Jack signals the merge in conversation. Two flavours: **single-story cleanup** (the normal path) and **batch reconcile** (drift sweeper).

**Trigger phrases for single-story cleanup** (case-insensitive, fuzzy): "merged", "I merged", "I've merged", "PR merged", "it's merged", "shipped", "it's in", "landed". Use judgment; if ambiguous, ask "which story?" rather than guess.

**Trigger phrases for batch reconcile**: "reconcile", "sync status", "statuses are off", "fix the sprint status", "clean up all the merged ones".

**Single-story procedure:**

1. **Identify the story.** Run:
   ```bash
   $SH pending-cleanup
   ```
   - Zero entries → may be drift from a manual merge or pre-skill history. Offer to run `reconcile` (below) instead of guessing.
   - One entry → that's the target. Confirm to Jack in one line before proceeding ("Cleaning up `<story_key>` (PR #<n>)").
   - Multiple entries → list them and ask which (or "all").

2. **Run cleanup:**
   ```bash
   $SH cleanup <story_key>
   ```
   This atomically does: verify PR is merged via `gh pr view`, **fetch + fast-forward local `main` FIRST** (so the Step 8 bookkeeping commit's `status: done` flip lands without colliding with a redundant local write — the race that surfaced cleaning up PR #122), then idempotent `status → done` (no-op verification under the post-2026-05-24 flow; write fallback for legacy stories shipped before bookkeeping commits existed), `git worktree remove .worktrees/<story_key>`, `git branch -D story/<story_key>`, `git push origin --delete story/<story_key>` (best-effort — silent if GitHub already auto-deleted), tidy `/tmp/ship-<story_key>.*`, re-point the Claude Code plugin cache back at main via `pnpm --dir plugins/flow dev:install` (defensive: silently skipped if the script is missing), append `cleaned` event to the run log.

3. **Report.** One line per story cleaned, plus any of the halt codes below.

**Batch reconcile procedure:**

Use when sprint-status has drifted — e.g. stories show `review` but their PRs are actually merged, or stories were merged before ship-story existed (no run log).

```bash
$SH reconcile
```

This scans `sprint-status.yaml` for every story in `review`, looks up its PR via `gh pr list --head story/<key>`, and runs the full `cleanup` flow on each merged one. Stories with no PR, with an open PR, or with a closed-not-merged PR are reported in `skipped` with a reason — none of them are touched.

Report the JSON summary: number reconciled, any skipped with reasons. Do NOT re-run reconcile in a loop if some skipped — surface those to Jack and let him decide.

**Halt codes (script exit codes for `cleanup`):**

| Code | Exit | Meaning | Suggested next step |
|------|------|---------|---------------------|
| `NOT_MERGED` | 10 | `gh pr view` says PR is open or closed-without-merge | Tell Jack — likely a false trigger |
| `MAIN_NOT_FAST_FORWARD` | 11 | Local `main` has diverged from `origin/main` | Surface to Jack — needs a manual rebase/merge call |
| `WORKTREE_DIRTY` | 12 | Worktree has uncommitted changes | Surface paths; do NOT silently `--force` |

`reconcile` collects these per-story under `skipped` rather than halting the whole sweep.

**Do NOT** trigger cleanup or reconcile speculatively (e.g. on "I'm happy with the PR" — that isn't a merge signal). When in doubt, ask.

## Halt taxonomy

The skill halts (no PR) on any of these. Each is recorded in the run log before exit:

| Code | Meaning | Suggested next step |
|------|---------|---------------------|
| `PREFLIGHT_FAIL` | Step 1 caught dirty tree / unauthed gh / missing files | Address what stderr listed |
| `NO_ELIGIBLE_STORY` | No backlog stories remain or arg matched nothing | Check sprint-status.yaml |
| `MISSING_ACS` | Story has no Acceptance Criteria section | Author the epic before shipping |
| `WORKTREE_CONFLICT` | Path or branch already exists | Clean up old run before retry |
| `SPEC_VALIDATION_FAILED` | Step 5 caught spec issues before any code burned | Re-run `bmad-create-story` and re-author, then retry |
| `REVIEW_BLOCKED` | Reviewer said `block` or budget passes elapsed without `approve` (3 for substrate, 5 for user-surface) | Jack decides: iterate manually or `/bmad-correct-course` |
| `AC_VERIFICATION_FAILED` | One or more ACs not green, or QA left uncommitted files | Fix the failing AC's code/test (or commit the QA artefact); rerun from Step 8 |
| `CI_BLOCKED` | 3 CI-fix passes elapsed and required checks still failing | Jack decides: iterate manually on the PR, or `/bmad-correct-course` |
| `CI_TIMEOUT` | CI didn't settle within 15min poll cap | Re-run Step 10 once checks complete |
| `RETRO_POST_FAILED` | `gh pr comment` failed in Step 11a (network / auth / etc.) | Fix the underlying issue and re-run Step 11a manually; the retro body is at `/tmp/ship-<story_key>.retro.md` |

## Resume after halt

```bash
$SH state <story_key>
```

Returns the JSONL event history. The latest event tells you which step succeeded last — pick up at the next one. (Full automatic resume is out of scope for v1; this surface is for Jack and the orchestrator to decide what to do.)

## Why scripts and not pure prose

- **Deterministic plumbing**: story picking, AC extraction, status mutation, AC-table gating, and PR-body templating must be byte-identical run to run. Subagents shouldn't reinvent them.
- **Auditable**: every milestone is JSONL — easy to grep, replay, post-mortem.
- **Cheap to evolve**: change AC heading conventions? Update one regex in `ship.py`, not every orchestrator prompt.
- **Fail closed**: invalid status transitions, missing ACs, unauthed gh, and malformed specs all fail at the script or VS layer before tokens burn.
