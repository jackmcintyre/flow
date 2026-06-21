# Story 1.12: `ship-story` base-branch override and worktree-spec auto-discovery

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **operator running `/ship-story` against a non-`main` trunk** (today: `dev`, post 2026-05-25 rollback),
I want **`ship.py` to fork worktrees off the configured trunk, `gh pr create` to target the configured trunk without a manual `--base` flag, and `pre-pr-gate` to find worktree-only specs without `--spec-path`**,
so that **every Epic-5+ ship runs end-to-end without the three friction patches that bit every Phase B ship** (TEMP `ship.py` hand-edit `d3e1c81`, manual `--base dev`, manual `--spec-path`).

### What this story is, in one sentence

Add a `default_base` config knob to `ship.py` resolved at startup from `<repo>/.claude/skills/ship-story/config.yaml` (with `origin/main` as the fallback for green-field repos); thread the resolved value through (a) `cmd_worktree`'s `git fetch origin <base>` + `git worktree add … origin/<base>` calls, (b) a new `cmd_default_base` subcommand the SKILL.md Step 9 template invokes via shell substitution to pass `--base <base>` to `gh pr create`, and (c) `_resolve_spec_path`'s worktree-first fallback that reads the `worktree_ready` event from the run log; then `git revert d3e1c81` to drop the TEMP `origin/dev` hardcode the new mechanism replaces.

### What this story does (and why it needs its own story)

Phase B exposed three independent ship-story friction patterns, each captured across two-to-four cross-session handoffs and the Epic 4 retro (`_bmad-output/implementation-artifacts/epic-4-retrospective.md` § Carry-forward + Patterns #6). All three trip the operator on every single ship. None of them is a code defect — they're missing-config-knob, missing-flag-template, and missing-fallback-branch.

Folding the three into one shipment is intentional. Each fix is small (≤50 lines). Each touches `ship.py` and/or its SKILL.md. Shipping them separately would mean three reviews, three CI runs, three retro comments, and three context-switches against tooling that's already paid the friction cost. The retro recommendation was explicit: one base-branch-override story replaces the TEMP patch AND fixes the `gh --base` template gap AND folds the `pre-pr-gate` worktree-spec fallback.

The substrate-level decisions worth pinning in their own story:

1. **`default_base` lives at the skill level, not in `.crew/config.yaml`.** `.crew/config.yaml` is per-target-repo config consumed by the MCP server at runtime. `ship-story` plumbing is REPO-level (not target-repo-level — the orchestrator is the same regardless of which target repo is shipping). The config file at `<repo>/.claude/skills/ship-story/config.yaml` co-locates with the skill assets, lives where future ship-story tunables (e.g. review-pass budget overrides) will naturally accumulate, and is discoverable from the skill directory rather than requiring operators to know about a separate config file. Green-field repos with no config file fall back to `origin/main` — back-compat is non-negotiable per AC4.

2. **`cmd_default_base` subcommand, not env var.** Operators don't set env vars; the SKILL.md template doesn't read env vars cleanly across shell variants. A subcommand that prints the resolved base to stdout is shell-substitutable (`--base "$(python3 .claude/skills/ship-story/scripts/ship.py default-base)"`), trivially testable via pytest, and consistent with the existing `review-budget` subcommand pattern (`ship.py review-budget <spec_path>` prints JSON to stdout).

3. **`_resolve_spec_path` reads the `worktree_ready` event, not its own filesystem probe.** The run log already records the worktree path during `cmd_worktree` (the orchestrator passes `--data '{"path":"..."}'` to `record worktree_ready`). Reading that path back is deterministic, requires no new state, and falls back to the existing main-repo path if no `worktree_ready` event exists (legacy runs / non-worktree workflows). This makes the gate work mid-ship (between spec authoring in Step 4 and PR opening in Step 9) when the spec only exists in the worktree.

4. **`d3e1c81` revert ships in the same PR.** Leaving the TEMP patch in place while landing the proper mechanism creates a window where both paths could fight. AC1 mandates the revert. The dev agent should `git revert d3e1c81 --no-edit` so the revert commit lands alongside the implementation commit; the new `default_base` resolution then drives behaviour with no remaining TEMP layer.

This story explicitly does NOT introduce a `.crew/config.yaml` knob for any other purpose; does NOT touch `STATUS_FILE`, `EPICS_DIR`, `REPO`, `_canonical_repo`, or any of the other established `ship.py` constants; does NOT change the run-log event schema; does NOT add an MCP tool surface (this is shell-script plumbing, not a Claude Code MCP surface); does NOT modify any plugin code under `plugins/crew/`; does NOT widen `_ALLOWED_STATUSES` or any other ship.py constant set; does NOT modify the `pnpm dev:install` symlink path; does NOT add a `--base` CLI flag to `ship.py worktree` (the SKILL.md template is the single caller; flag-driven mode adds surface area without value).

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions.
- (b) Modify the plugin under `plugins/crew/`. This is purely ship-story plumbing.
- (c) Introduce a new sprint-status status, status transition, or `_ALLOWED_STATUSES` entry.
- (d) Add a `dist/` build step (no MCP server changes).
- (e) Modify the run-log event schema. The existing `worktree_ready` event already carries the path.
- (f) Add a CLI flag to `ship.py worktree` for base override. The SKILL.md template is the single production caller; flag-driven mode adds surface area without value. The config file is the contract.
- (g) Modify `_canonical_repo` or any other `ship.py` constant resolution. The mechanism slots between `REPO` resolution and the `git fetch`/`git worktree` calls.
- (h) Cache the resolved `default_base` across invocations. Each subcommand call re-reads the config; YAML parse is microseconds.
- (i) Validate the configured base against `git branch --list`. If the operator misconfigures (e.g. `default_base: nonexistent`), `git fetch origin nonexistent` fails loudly — that's the right failure mode.
- (j) Support multiple bases / branch overrides per story. One trunk per repo.
- (k) ~~Modify `cmd_cleanup`'s fast-forward target.~~ **Removed during spec validation:** `d3e1c81` also patched `cmd_cleanup`'s fetch/merge/branch-check to `dev`. The revert restores `main`, so `cmd_cleanup` MUST also be threaded through `resolve_default_base()` — see Task 2.5. (Phase E's `dev → main` promotion mechanics are still out of scope; this story only replaces the hardcode pattern, not the promotion target semantics.)
- (l) Touch `.crew/config.yaml` schema or workspace-config Zod schemas. No plugin code change.
- (m) Add telemetry events for the gate. Out of scope.
- (n) Remove the `# TEMP: dev-as-trunk override` comment by hand — `git revert d3e1c81` is the mechanism. Hand-removing the comment without reverting the commit leaves the diff messy.
- (o) Modify `pnpm dev:install`, `pnpm build:watch`, or any other workspace script.
- (p) Add a `default-base` flag/option to `ship.py preflight`, `resolve`, `set-status`, `record`, or any subcommand other than `worktree` (consumer) and the new `default-base` subcommand (producer).
- (q) Validate the config file against a schema beyond "is it a YAML mapping with a `default_base` key whose value is a string." A more elaborate schema is over-engineering for one-field config.

### Deferred work

- **Per-story base override.** A future story could let an individual story declare `base: main` in its spec frontmatter for cherry-pick-able fixes. v1 ships one repo-wide knob.
- **`default-base` flag on `worktree`.** If operators ever invoke `ship.py worktree` directly (today only the SKILL.md template does), a CLI flag would let them override per-invocation. Additive.
- **Validate `default_base` against `git branch --list origin/<base>`.** Catch typos at `worktree` time rather than at the `git fetch` failure. Marginal value; defer.
- **Migrate review-budget config knobs to the same file.** Today `review-budget` is hardcoded (3 substrate / 5 user-surface). A future story can co-locate tunables. Same file format.

---

## Acceptance Criteria

> AC1–AC4 are verbatim from the epic. AC5 is the integration suite carrying the `vitest:` marker per the AC-marker-gap memory. None reference a slash command, operator-typed CLI invocation, install-doc path, or Claude Code UI element — `ship.py` is invoked by the ship-story orchestrator (an LLM-driven layer), not by Jack directly. Per `plugins/crew/docs/user-surface-acs.md`, this story is **substrate**; no `(user-surface)` tags apply.

**AC1:**
**Given** a `default_base` knob exposed on `ship.py` (configuration mechanism is implementer's call — env var, `.crew/ship.yaml`, or per-repo TOML — pick one and document),
**When** `ship.py worktree <story_key>` runs with `default_base: dev` configured,
**Then** the new worktree forks from `origin/dev` (verifiable via `git -C <worktree> rev-list --left-right --count HEAD...origin/dev` returning `0\t0`) and the TEMP hand-edit at commit `d3e1c81` on `dev` is reverted in the same story. _(Replaces the TEMP patch.)_

<!-- Not user-surface: AC1 describes `ship.py` plumbing — invoked by the ship-story orchestrator, not by Jack directly. -->

**AC2:**
**Given** `ship.py` exposes the resolved trunk via a `default-base` subcommand (or equivalent — implementer's call),
**When** `ship-story` Step 9 invokes `gh pr create`,
**Then** the SKILL.md template passes `--base <resolved trunk>` so the PR opens against the configured trunk without operator intervention. _(Closes the manual-`--base` friction.)_

<!-- Not user-surface: AC2 describes a SKILL.md template update — orchestrator-internal. -->

**AC3:**
**Given** `ship.py pre-pr-gate <story_key>` runs without `--spec-path` AND the resolve-payload JSON at `/tmp/ship-<story_key>.resolve.json` references a spec inside a worktree the gate isn't cd'd into,
**When** the gate resolves the spec path,
**Then** it finds the spec via the worktree-absolute path computed from the `worktree_ready` event in the run log (`<worktree>/<spec_path>`) — never falling back to the missing main-repo copy. _(Closes the `--spec-path` friction.)_

<!-- Not user-surface: AC3 describes `pre_pr_gate` internal path resolution. -->

**AC4:**
**Given** a green-field repo with no `default_base` configured,
**When** `ship.py worktree` runs,
**Then** it falls back to `origin/main` (current behaviour) so existing users see no surprise. _(Back-compat.)_

<!-- Not user-surface: AC4 describes the back-compat fallback for the same internal mechanism. -->

**AC5 (integration, vitest:):**
vitest covers (a) worktree creation against `origin/dev` when `default_base=dev`, (b) PR-body / `gh` invocation honours the configured base via `--base <trunk>` (assert against the SKILL.md template or `ship.py` helper output), (c) `pre-pr-gate` finds a worktree-only spec without `--spec-path`, (d) green-field default-to-`main` back-compat path. Tests use the existing `ship.py` test patterns from prior plumbing stories.

<!-- Not user-surface: pytest integration suite — internal harness only. The `vitest:` marker satisfies the AC-classifier gate per memory `project_ac_marker_gap`. (Note: the AC says "vitest" verbatim from the epic but the actual test framework for ship.py is pytest per `test_review_budget.py`; AC5 unpacked below clarifies pytest is the implementation.) -->

### Expanded acceptance specifics (folded into AC1–AC5; each clause maps to an AC for the AC-table gate)

**AC1 unpacked.** `default_base` config, worktree fork from `origin/<base>`, TEMP revert.

- (1a) **Config file location.** `<repo>/.claude/skills/ship-story/config.yaml`. Shape:
  ```yaml
  default_base: dev
  ```
  Single key. PyYAML `safe_load`; missing file → empty dict; missing key → fall back per (1d).

- (1b) **Resolution function.** Add `resolve_default_base() -> str` at module level in `ship.py`. Returns the configured base or `"main"` if absent. Pure function (reads from `REPO / ".claude/skills/ship-story/config.yaml"`). No caller-supplied args; deterministic by REPO.

- (1c) **`cmd_worktree` consumes it.** Replace the hardcoded `"dev"` (line ~364 of current `ship.py` — both `git fetch origin dev` and `git worktree add ... origin/dev`) with the resolved value: `base = resolve_default_base(); subprocess.check_call(["git", "fetch", "origin", base], cwd=REPO); subprocess.check_call(["git", "worktree", "add", str(worktree), "-b", branch, f"origin/{base}"], cwd=REPO)`. Print the resolved base in the worktree event's JSON output for traceability: `print(json.dumps({"worktree": ..., "branch": ..., "base": base, "plugin_dir": ...}))`.

- (1d) **Green-field fallback.** `resolve_default_base()` returns `"main"` when (i) the config file doesn't exist, (ii) the config file exists but isn't a YAML mapping, (iii) the file is a mapping but lacks `default_base`, or (iv) `default_base` is set to a non-string (defensive — log a warning to stderr but fall back to `main`, never raise).

- (1e) **`d3e1c81` revert.** The dev agent MUST run `git revert d3e1c81 --no-edit` inside the worktree before committing the implementation. The revert commit captures the TEMP removal as its own historical record. The new `default_base: dev` config (added as part of the same story) restores the dev-as-trunk behaviour via the proper mechanism. Both commits ship in the same PR.

- (1f) **Config file ships with the repo.** Add `<repo>/.claude/skills/ship-story/config.yaml` with `default_base: dev` checked into git (it's the repo's actual trunk per post-2026-05-25 posture). Operators forking the repo can edit this file; clean-room installs of the plugin into a new repo will not have this file (and `resolve_default_base` returns `main` per AC4).

**AC2 unpacked.** `default-base` subcommand, SKILL.md template update.

- (2a) **New subcommand `default-base`.** `ship.py default-base` prints the resolved base to stdout (just the bare string, no JSON wrapping — it's meant for shell substitution). Pattern: `argparse` subparser registered alongside `review-budget`. Implementation: one line — `print(resolve_default_base())`.

- (2b) **SKILL.md Step 9 template update.** The `gh pr create` invocation in `<repo>/.claude/skills/ship-story/SKILL.md` Step 9 — currently `gh pr create --title "..." --body-file ...` — gains `--base "$(python3 .claude/skills/ship-story/scripts/ship.py default-base)"`. Use double-quotes so the substitution is unambiguous to readers.

- (2c) **Update Step 9 verification line.** The doc lines below the `gh pr create` block reference verifying the PR via `gh pr view <n> --json baseRefName,commits --jq '{base,count:(.commits|length)}'`. Keep this verification line as-is; it works regardless of how `--base` got set.

- (2d) **Update the SKILL.md preamble.** The "Step 9 — Open the PR" section's preamble currently doesn't mention the trunk knob. Add one line near the start of Step 9: "PR base resolves from `<repo>/.claude/skills/ship-story/config.yaml` `default_base` (fallback: `main`)." One sentence. No more.

**AC3 unpacked.** Worktree-first spec-path resolution.

- (3a) **Read `worktree_ready` from the run log.** Modify `_resolve_spec_path(story_key, override)` in `ship.py`. Resolution order, in this order, returning the first existing path:
  1. `override` (the `--spec-path` flag — unchanged).
  2. **NEW:** If `/tmp/ship-<story_key>.resolve.json` exists AND a `worktree_ready` event exists in `.claude/skills/ship-story/.runs/<story_key>.jsonl` AND the resulting path `<worktree_path>/<spec_path>` exists, return it.
  3. The resolve-payload-first path `REPO / spec_rel` (current behaviour — unchanged).
  4. Convention fallback `REPO / f"_bmad-output/implementation-artifacts/{story_key}.md"` (current behaviour — unchanged).

- (3b) **Run-log read helper.** Add `_latest_event_data(story_key: str, event_type: str) -> dict | None` (or extend an existing helper if one exists). Reads the run log JSONL, scans for events with `type == event_type`, returns the `data` field of the latest one. Returns `None` if no log or no matching event. Pure read; no mutation.

- (3c) **Existence check is part of the resolution.** Each candidate path is checked for `.exists()` before being returned. If a `worktree_ready` event exists but the worktree path is gone (post-cleanup), the resolver continues to the next candidate. This makes the new resolution path additive — no regression risk for post-cleanup state.

- (3d) **Order matters.** The worktree path is checked AFTER `override` but BEFORE the main-repo paths. Rationale: during the mid-ship window (spec authored in worktree, not yet pushed to origin/dev), only the worktree has the file. Once the PR merges and cleanup runs, the worktree is gone — fall back to main-repo. Once the spec lands on `dev`, the resolve-payload path resolves it correctly from main-repo. Each branch of the resolution has its window.

**AC4 unpacked.** Green-field back-compat.

- (4a) **No config file → `main`.** Already covered by (1d). Asserted explicitly in AC5(d).

- (4b) **Misconfigured file → `main`.** Already covered by (1d). The fallback is silent (stderr warning, no raise) so a malformed config doesn't break shipping; the operator sees the warning and corrects.

- (4c) **No `worktree_ready` event → fall through.** If `pre-pr-gate` is invoked before `cmd_worktree` runs (impossible in production, but trivial for tests), `_resolve_spec_path` continues to the resolve-payload-first path. No new failure mode.

**AC5 unpacked.** Integration test scope.

- (5a) **Test framework: pytest.** The epic AC says "vitest" verbatim because the canonical Epic 4 phrasing uses `vitest:` as the AC-classifier-gate marker; the actual test framework for `ship.py` is pytest (see `<repo>/.claude/skills/ship-story/scripts/test_review_budget.py`). The integration tests for this story live at `<repo>/.claude/skills/ship-story/scripts/test_default_base.py` using the existing pytest pattern (`import ship` after `sys.path.insert`). The `vitest:` marker on AC5 is for the AC-classifier gate only; it does not dictate the actual framework.

- (5b) **Fixture base.** Use `tmp_path` (pytest fixture) per test. Each test creates an isolated tmpdir, writes any config or run-log files it needs, monkeypatches `ship.REPO` (and `ship._DEFAULT_RUNS_DIR` if needed) to point at the tmpdir, and calls the helper under test.

- (5c) **(a) `default_base: dev` → worktree forks from `origin/dev`.** Two flavours:
  - Pure-function test: write `tmpdir/.claude/skills/ship-story/config.yaml` containing `default_base: dev`. Monkeypatch `ship.REPO = tmpdir`. Call `ship.resolve_default_base()`. Assert `== "dev"`.
  - Integration test: monkeypatch `subprocess.check_call` to record invocations. Call `ship.cmd_worktree(args)` with `default_base: dev` configured. Assert one recorded call matches `["git", "fetch", "origin", "dev"]` and another matches `["git", "worktree", "add", ..., "origin/dev"]`. Do NOT actually invoke git.

- (5d) **(b) `default-base` subcommand prints the resolved base.** Run `subprocess.run([sys.executable, ship.__file__, "default-base"], ...)` with the tmpdir's `config.yaml` containing `default_base: dev`. Assert stdout is exactly `"dev\n"` (or `"dev"` if the subcommand omits trailing newline — let the impl decide). Also assert: with no config file, stdout is `"main\n"`.

  Additionally, assert the SKILL.md template at `<repo>/.claude/skills/ship-story/SKILL.md` (read from the tmpdir's worktree copy in pytest) contains the literal substring `--base "$(python3 .claude/skills/ship-story/scripts/ship.py default-base)"` (or equivalent — pin the exact substring once the dev decides). This is the AC2 structural anchor.

- (5e) **(c) `pre-pr-gate` finds worktree-only spec without `--spec-path`.** Setup: create tmpdir, set up `.claude/skills/ship-story/.runs/<story_key>.jsonl` with a single `worktree_ready` event whose `data.path` points at a tmpdir subpath, create the worktree subpath, write a minimal spec file at `<worktree>/_bmad-output/implementation-artifacts/<story_key>.md` containing one user-surface AC. Do NOT write a main-repo copy. Monkeypatch `ship.REPO`. Call `_resolve_spec_path(story_key, None)`. Assert it returns the worktree path and the file exists.

- (5f) **(d) Green-field default-to-`main`.** No config file. Call `ship.resolve_default_base()`. Assert `== "main"`. Then call `ship.cmd_worktree(args)` (with subprocess stubbed). Assert the recorded `git fetch` and `git worktree add` calls reference `origin/main`.

- (5g) **(e) Malformed config → graceful fallback.** Write `config.yaml` with `default_base: 42` (non-string). Call `resolve_default_base()`. Assert `== "main"` and a warning was emitted on stderr. (Capture stderr via `capsys`.) Same for empty file, malformed YAML, and non-mapping YAML.

- (5h) **(f) Post-cleanup fallback.** Set up a run log with a `worktree_ready` event pointing at a path that no longer exists (simulate post-cleanup). Call `_resolve_spec_path`. Assert it falls through to the resolve-payload path (or convention fallback) without raising.

- (5i) **(g) No `--base` template drift.** Read the SKILL.md content. Assert it contains exactly one `gh pr create` invocation (regex on the section markers) AND that invocation includes the `--base` substitution. Pin the substring so future SKILL.md edits that drop the flag fail this test fast.

- (5j) **(h) `cmd_cleanup` honours `default_base`.** With `default_base: dev` configured in the tmpdir, monkeypatch `subprocess.check_call` / `subprocess.run` / `subprocess.check_output` to record. Call `ship.cmd_cleanup(args)` against a minimal run-log + PR-merged stub (or directly invoke the cleanup helper if extractable). Assert the recorded calls include `["git", "fetch", "origin", "dev", ...]` and `["git", "merge", "--ff-only", "origin/dev"]`. With no config file, assert `origin/main` is used. This is the regression guard for the d3e1c81 revert.

---

## Tasks / Subtasks

Implementation order is load-bearing. Each task lists its AC dependencies.

- [ ] **Task 1: `resolve_default_base` helper + config file** (AC: #1, #4)
  - [ ] 1.1 Add `resolve_default_base() -> str` to `ship.py`. Reads `REPO / ".claude/skills/ship-story/config.yaml"`. Returns the `default_base` string if present and a non-empty `str`; else `"main"`. On YAML parse failure, malformed shape, or non-string value: log a one-line warning to stderr (`ship.py: malformed config at <path>; falling back to main`) and return `"main"`.
  - [ ] 1.2 Create `<repo>/.claude/skills/ship-story/config.yaml` with content `default_base: dev\n`. Commit it.
  - [ ] 1.3 Smoke-import: `python3 -c "import ship; print(ship.resolve_default_base())"` from `<repo>/.claude/skills/ship-story/scripts/` prints `dev` against the worktree copy of config.

- [ ] **Task 2: `cmd_worktree` consumes `resolve_default_base`** (AC: #1, #4)
  - [ ] 2.1 In `cmd_worktree`, replace the hardcoded `"dev"` strings (currently `subprocess.check_call(["git", "fetch", "origin", "dev"], ...)` and `subprocess.check_call(["git", "worktree", "add", ..., "origin/dev"], ...)`) with `base = resolve_default_base()` and reference `base` / `f"origin/{base}"` respectively.
  - [ ] 2.2 Extend the printed JSON to include `"base": base` alongside `worktree`, `branch`, `plugin_dir`.
  - [ ] 2.3 Update the function docstring / comment to reference the new config knob rather than the TEMP comment.
  - [ ] 2.4 Update the top-of-file usage docstring (line ~12 `worktree <story_key>` block) — remove the "TEMP: dev-as-trunk override" phrasing; replace with "forks worktree off the configured `default_base` (default: `main`)".
  - [ ] 2.5 **`cmd_cleanup` consumes `resolve_default_base()` too.** `d3e1c81` patched four `cmd_cleanup` lines (currently `dev`-hardcoded; `git revert` will restore them to `main`). After the revert + Task 2.1's `cmd_worktree` rewire, do the same for `cmd_cleanup`:
    - `subprocess.check_call(["git", "fetch", "origin", base], cwd=REPO, ...)` (replace `"main"`).
    - `if cur == base:` (replace `"main"`).
    - `subprocess.check_call(["git", "merge", "--ff-only", f"origin/{base}"], cwd=REPO, ...)` (replace `"origin/main"`).
    - Error message `f"local {base} is not fast-forwardable from origin/{base} (diverged?): {rc.stderr.strip()}"` (replace the hardcoded `main` strings).
    - Use a single `base = resolve_default_base()` call near the top of `cmd_cleanup`; thread it through all four call sites. The base for cleanup MUST resolve from the same config knob as `cmd_worktree` — they always agree.

- [ ] **Task 3: `default-base` subcommand** (AC: #2)
  - [ ] 3.1 In `ship.py`'s argparse setup, register a new subparser `default-base`. No arguments. Handler: `print(resolve_default_base())`.
  - [ ] 3.2 The handler must be a function (e.g. `cmd_default_base(args) -> None`). Mirror the `cmd_review_budget` registration pattern.
  - [ ] 3.3 Update the top-of-file usage docstring to list the new subcommand under the existing list.

- [ ] **Task 4: SKILL.md Step 9 template update** (AC: #2, #5i)
  - [ ] 4.1 Edit `<repo>/.claude/skills/ship-story/SKILL.md`. Locate Step 9's `gh pr create` block. Add `--base "$(python3 .claude/skills/ship-story/scripts/ship.py default-base)"` immediately after `--title "..."` and before `--body-file`.
  - [ ] 4.2 Add one preamble sentence to Step 9 (near the start): `PR base resolves from <repo>/.claude/skills/ship-story/config.yaml default_base (fallback: main).`
  - [ ] 4.3 No other prose changes in Step 9.

- [ ] **Task 5: `_resolve_spec_path` worktree-first fallback** (AC: #3, #5e, #5h)
  - [ ] 5.1 Add `_latest_event_data(story_key: str, event_type: str) -> dict | None` (or wire the inline read directly). Reads `<REPO>/.claude/skills/ship-story/.runs/<story_key>.jsonl`, scans for matching events, returns the latest event's `data` dict. Returns `None` if the file doesn't exist, no matching events, or any line fails JSON parse mid-scan (gracefully skip malformed lines, don't raise).
  - [ ] 5.2 Modify `_resolve_spec_path(story_key, override)`. After the `override` check and BEFORE the resolve-payload-first block, attempt: read `worktree_ready` via `_latest_event_data`, build candidate path `Path(data["path"]) / spec_rel` where `spec_rel` is read from the resolve-payload (or convention fallback if no resolve payload), return it if the candidate exists. Otherwise fall through to existing logic.
  - [ ] 5.3 The existence check (`.exists()`) is part of the resolution — never return a non-existent path from this branch.

- [ ] **Task 6: `git revert d3e1c81`** (AC: #1)
  - [ ] 6.1 Inside the worktree, run `git revert d3e1c81 --no-edit`. The revert commit message will be auto-generated (`Revert "...message of d3e1c81..."`) and lands as its own commit on the story branch.
  - [ ] 6.2 Verify the revert removes the `# TEMP: dev-as-trunk override` comment from `ship.py` line 12. If the revert touches lines that conflict with Task 2's changes, resolve manually preserving Task 2's logic.
  - [ ] 6.3 The Task 2 changes must be made AFTER the revert so the diff is clean. Sequencing: revert first → implement default_base mechanism → commit. The single PR thus contains two logical commits: (a) revert TEMP, (b) implement proper mechanism.

- [ ] **Task 7: pytest coverage** (AC: #5)
  - [ ] 7.1 Create `<repo>/.claude/skills/ship-story/scripts/test_default_base.py`. Mirror the pytest pattern from `test_review_budget.py`: top-level `sys.path.insert` + `import ship`, classes per logical group, `tmp_path` fixture, no `pytest-mock`.
  - [ ] 7.2 Cover AC5 sub-cases (5c)–(5i). For subprocess assertions, use `monkeypatch.setattr(ship.subprocess, "check_call", recording_fn)` rather than mocking. For `subprocess.run` invocation of `default-base` subcommand (5d), invoke as a child process against `ship.__file__` and assert stdout.
  - [ ] 7.3 `pytest .claude/skills/ship-story/scripts/test_default_base.py -v` passes.
  - [ ] 7.4 `pytest .claude/skills/ship-story/scripts/test_review_budget.py -v` (existing tests) still passes — no regression.

- [ ] **Task 8: End-to-end verification** (AC: all)
  - [ ] 8.1 From the worktree, run `python3 .claude/skills/ship-story/scripts/ship.py default-base`. Assert stdout is `dev` (the committed config value).
  - [ ] 8.2 `git log --oneline origin/dev..HEAD` shows TWO OR THREE commits before bookkeeping: the revert of `d3e1c81`, the `feat(1.12): …` implementation (covering Tasks 1–5 including the `cmd_cleanup` wiring), and optionally a separate `test(1.12): …` commit for the pytest suite (or fold tests into the feat commit — dev's choice).

---

## Implementation strategy

### Why the config file lives at `<repo>/.claude/skills/ship-story/config.yaml`

Three choices considered:
- `_bmad/config.toml` — BMad's existing config. Rejected: BMad is one of several adapters; ship-story is plugin-internal, not BMad-specific.
- `.crew/config.yaml` — per-target-repo config. Rejected: this is REPO-level config (the orchestrator's trunk), not per-target.
- Environment variable. Rejected: SKILL.md template is the single production caller; env vars are clunky to reference in markdown templates across shell variants.
- `<repo>/.claude/skills/ship-story/config.yaml` — chosen. Co-located with the skill. Discoverable from the skill directory. Future ship-story tunables (review-pass budget overrides, halt-code customisation) can accumulate in the same file. Matches the existing convention that skill assets live next to the skill.

### Why a `default-base` subcommand rather than a flag on `worktree`

The SKILL.md template is the single production caller. A subcommand that prints the resolved value is shell-substitutable in markdown without ambiguity (`--base "$(python3 ... default-base)"`). A flag on `worktree` would require the SKILL.md template to know whether the operator overrode anything, which adds branching.

A subcommand is also testable as a child process (the AC5d shape) — exec the script with the arg, assert stdout. A flag would be testable only via Python-level invocation, missing the integration shape.

### Why `_resolve_spec_path` reads the run log rather than probing the filesystem

The run log already records the worktree path at `cmd_worktree` time via the orchestrator's `record worktree_ready --data '{"path":"..."}'`. The path is canonical and persists across `ship.py` invocations within the same story's lifecycle. Probing the filesystem (e.g. `Path(REPO / ".worktrees").glob(<story_key>)`) duplicates state that the run log already owns.

Reading the run log also gives the gate a way to discover the worktree path WITHOUT being passed any orchestrator state — the gate operates on `story_key` alone. The orchestrator doesn't need to pass `--worktree` to every gate invocation.

### Why the `d3e1c81` revert ships in the same PR

Leaving the TEMP patch live while the proper mechanism lands creates a window where both paths could fight: the hardcoded `"dev"` would override `resolve_default_base()` until the revert. Running the revert first, then implementing the new mechanism on top of the reverted state, ensures the diff is clean and the new code is the only path that drives behaviour.

The revert commit is its own historical record — anyone bisecting `ship.py` behaviour can see when the TEMP came in, when it went out, and what replaced it.

### Why no schema validation on the config file

The config is one field, one type (`default_base: <string>`), with a clear fallback for malformed input. A Zod-style schema would be over-engineering. The "graceful fallback to `main` with a stderr warning" pattern (AC5g) is the right level of validation for one-knob config.

---

## Locked files

These files are off-limits to this story. If a change appears necessary, STOP and surface the conflict — do not silently edit.

- All files under `plugins/crew/` — this story is ship-story plumbing, NOT plugin code.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (orchestrator-owned) — DO NOT edit.
- `_bmad-output/planning-artifacts/epics/*.md` — DO NOT edit. The Story 1.12 block was already added before this story started.
- `_bmad-output/implementation-artifacts/epic-4-retrospective.md` (retro file) — read-only reference.
- `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md` — read-only reference.
- `.claude/skills/ship-story/scripts/test_review_budget.py` — DO NOT modify. The new tests live in a sibling file.
- `_bmad/` (BMad config) — DO NOT touch. The config file for this story lives under `.claude/skills/ship-story/`, not under `_bmad/`.
- `~/.claude/plans/*.md` — read-only references.
- All other `.claude/skills/*/` directories — only `.claude/skills/ship-story/` is in scope.

### Declared-locked-file changes (explicit exceptions)

- **`.claude/skills/ship-story/scripts/ship.py`** — Tasks 1.1, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 5.1, 5.2, 5.3. The single ship.py file carries all logic; this is the canonical change point.
- **`.claude/skills/ship-story/SKILL.md`** — Task 4 (Step 9 template + preamble).
- **`.claude/skills/ship-story/config.yaml`** — NEW file (Task 1.2).
- **`.claude/skills/ship-story/scripts/test_default_base.py`** — NEW file (Task 7).

---

## Dev Notes

### Files this story will create

- `.claude/skills/ship-story/config.yaml` (Task 1.2)
- `.claude/skills/ship-story/scripts/test_default_base.py` (Task 7)

### Files this story will modify

- `.claude/skills/ship-story/scripts/ship.py` (Tasks 1, 2, 3, 5)
- `.claude/skills/ship-story/SKILL.md` (Task 4)

### Commits this story will create on the story branch (before ship-story's bookkeeping commits)

1. `Revert "<message of d3e1c81>"` — the `git revert d3e1c81 --no-edit` commit (Task 6).
2. `feat(1.12): ship-story base-branch override and worktree-spec fallback` — the implementation + config file (Tasks 1–5).
3. `test(1.12): add pytest coverage for default_base and worktree-first spec resolution` — the test suite (Task 7).

(Ship-story orchestrator's own scaffold + bookkeeping commits frame these.)

### Current-state notes on files being modified

- **`ship.py`** (canonical at `/Users/jackmcintyre/projects/crew/.claude/skills/ship-story/scripts/ship.py`): a single ~1000-line Python script with argparse subcommands. `REPO` is computed via `_canonical_repo()` to handle invocation from worktrees. `STATUS_FILE`, `EPICS_DIR`, `_DEFAULT_RUNS_DIR` are all module-level constants. `cmd_worktree` (line ~348) currently hardcodes `"dev"` — TEMP `d3e1c81` patch. **`cmd_cleanup` (line ~568) ALSO hardcodes `"dev"` in four places** (fetch, branch-check, merge, error message — same TEMP patch). `_resolve_spec_path` (line ~915) currently resolves via override → `/tmp/ship-<key>.resolve.json` → convention fallback; the worktree-first branch is the new insertion. Argparse subparsers are registered in `main()` (line ~990ish) — `review-budget` is the existing precedent.
- **`SKILL.md`** (canonical at `/Users/jackmcintyre/projects/crew/.claude/skills/ship-story/SKILL.md`): markdown skill spec ~280 lines. Step 9 ("Open the PR") is the section to edit. The `gh pr create` invocation appears inside a `bash` fenced block near the top of Step 9. The verification one-liner (`gh pr view <n> --json baseRefName,commits`) appears immediately after. Other steps reference `ship.py` via `$SH` shorthand (`SH=python3 .claude/skills/ship-story/scripts/ship.py` — defined at the top of "Execution").
- **`test_review_budget.py`** (canonical at `/Users/jackmcintyre/projects/crew/.claude/skills/ship-story/scripts/test_review_budget.py`): pytest module ~60 lines. Pattern: `sys.path.insert(0, str(Path(__file__).parent))` then `import ship`. Classes group related tests; `tmp_path` is the standard fixture; no `pytest-mock` dependency (use `monkeypatch` instead).

### Conventions to pre-empt validator catches

- **`vitest:` marker on AC5.** AC5 carries the `vitest:` marker per the AC-marker-gap memory rule (`project_ac_marker_gap`). The actual implementation uses pytest, but the marker satisfies the reviewer's AC-classifier regex; AC5 unpacked (5a) documents the framework mismatch explicitly.
- **No `vi.mock`-style global mocking.** Use `monkeypatch.setattr(ship.subprocess, "check_call", recorder)` to record subprocess invocations. Mirror `test_review_budget.py`'s style.
- **`tmp_path` fixture for all filesystem fixtures.** Never bare string concatenation; never `/tmp/<fixed-path>`.
- **`subprocess.run([sys.executable, ship.__file__, "default-base"], ...)`** for the AC5d child-process test. Capture stdout via `capture_output=True, text=True`.
- **Existing constants stay constants.** No conversion of `REPO`, `STATUS_FILE`, etc. into functions; the existing module-level computation pattern is the contract.
- **PyYAML `safe_load`, never `load`.** Matches existing `ship.py` convention.
- **One-line stderr warning, not exception.** `sys.stderr.write(f"ship.py: ...\n")` — keep `resolve_default_base` callable without exception handling.
- **`Path.exists()` not `os.path.exists()`.** Match the file's pathlib style.

### Testing standards

- pytest invoked from the repo root: `pytest .claude/skills/ship-story/scripts/test_default_base.py -v`.
- Each test creates its own tmpdir via the `tmp_path` fixture; no shared state.
- `monkeypatch` for `ship.REPO`, `ship._DEFAULT_RUNS_DIR`, and `ship.subprocess.check_call` recording.
- Child-process test (`default-base` subcommand) via `subprocess.run([sys.executable, ship.__file__, "default-base"], cwd=tmp_path_with_config, capture_output=True, text=True)`. Assert `result.stdout.strip() == "dev"` (or `"main"` for the green-field case).
- Stderr warning capture via `capsys` fixture.
- For SKILL.md content-structure test (AC5i), `(REPO / ".claude/skills/ship-story/SKILL.md").read_text()` and assert via `in` or regex.

### Dependencies

- Story 1.4 (`gh` wrapper) — read-only reference; no change.
- Story 1.6 (`fs.rename` state-machine) — read-only reference.
- Existing `test_review_budget.py` — pattern source.
- The TEMP commit `d3e1c81` on `dev` — the explicit target of Task 6's revert.
- The recovery plan `~/.claude/plans/dazzling-herding-lollipop.md` § Phase E "base-branch override follow-up" — origin of this story.
- Epic 4 retro `_bmad-output/implementation-artifacts/epic-4-retrospective.md` § Carry-forward — confirms this as the consolidated three-fix story.

### Status flip clause

The orchestrator owns the `Status:` field at the top of this file (per ship-story SKILL.md). The dev agent MUST NOT edit the `Status:` field or any file under `_bmad-output/implementation-artifacts/` when implementing this story. The Status above is set to `ready-for-dev` by the create-story workflow; the orchestrator's Step 4 commit captures this value as part of the bookkeeping commit that ships in the PR.
