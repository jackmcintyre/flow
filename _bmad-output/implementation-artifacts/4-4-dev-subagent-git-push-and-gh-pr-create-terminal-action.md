# Story 4.4: Dev subagent `git push` and `gh pr create` terminal action

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **the dev subagent's terminal action to branch, commit, push, and open a PR following the pinned commit/PR conventions through a permission-gated execa wrapper**,
so that **downstream stories (reviewer read, label, auto-merge gate) have a consistent PR shape to operate on, and `--no-verify` / unsanctioned `--force-with-lease` never reach a subprocess**.

### What this story is, in one sentence

Add a single MCP-tool entrypoint `runDevTerminalAction` that, given a finished dev subagent's story ref and a list of staged paths, (a) creates a branch `story/<ref-slug>-<title-slug>`, (b) commits in conventional-commits format with body wrapping at 72 columns, (c) `git push -u`, and (d) opens a PR via `gh pr create` with title `<type>(<ref>): <story title>` and a body whose first section is a machine-readable block (story link, ACs checklist mirrored from the story file) followed by a free-form summary — all gated through the existing `execa` wrappers in `plugins/crew/mcp-server/src/lib/git.ts` and `plugins/crew/mcp-server/src/lib/gh.ts`, extended where necessary to refuse `--no-verify` and unsanctioned `--force-with-lease` before any subprocess spawn.

### What this story fixes (and why it needs its own story)

Today, the dev subagent's permission spec at `plugins/crew/permissions/generalist-dev.yaml` lists `pr-create` in `gh_allow`, but no plugin code actually composes a branch name, a commit message, a PR title, or a PR body that matches `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md §9`. The shipped `gitCommit` helper (Story 1.5 AC4) constrains commit messages to the plugin-internal shape `<tool-name>: <ref>` — that shape is correct for plugin-side housekeeping commits (e.g. `regenerateStandards: bmad:1.2.3`) but is **NOT** the conventional-commits shape the dev subagent must use when shipping a story PR. The current `gh` wrapper enforces the `gh_allow` allowlist but does NOT inspect args for `--no-verify` or `--force-with-lease`, and `gitCommit` has no `push` partner at all.

Three concrete gaps:

- **No branch-name composer.** Pattern §9 declares the branch shape `story/<story-id>-<slug>` where slug is kebab-case-from-title trimmed to 40 chars. No code today produces it.
- **No PR-body composer.** Pattern §9 declares the PR body must have a machine section (story link, ACs checklist) followed by free-form summary. No code today produces it, and downstream Stories 4.6 / 4.6b / 4.7 will parse this body for inline-comment placement and footer-marker idempotent reruns.
- **No `--no-verify` / `--force-with-lease` refusal.** NFR16 says these are negative capabilities for the dev role. Today the `gh` wrapper inspects `gh_allow` for subcommand names but does not refuse arg-level flags; the `git` wrapper is single-purpose (`add` + `commit` + `rev-parse`) and has no branch/push surface at all. The story must extend both wrappers to refuse these arg patterns before any subprocess spawn.

This story closes those gaps by adding one composite MCP tool and three small helpers, plus extending the `git`/`gh` wrappers' refusal logic.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status / state file when implementing this story.
- (b) Change the conventional-commits regex set or invent new conventional types. The accepted set is `feat | fix | refactor | test | docs | chore | build | ci | perf | style | revert` — i.e. the standard conventional-commits prefix set. The dev role decides which type via heuristic in its persona prompt; this story does NOT carry the heuristic, only the shape-enforcement regex.
- (c) Change the `gitCommit` helper's existing plugin-internal commit-message shape (`<tool-name>: <ref>`). That shape stays available for plugin-side housekeeping commits (Story 1.5 AC4). This story adds a SECOND commit message shape — conventional-commits — and the wrapper picks the right validator based on caller-supplied `messageShape: "plugin-internal" | "conventional"`.
- (d) Change the existing `gh` wrapper's `gh_allow` enforcement. The new arg-level refusal logic is additive — `gh_allow` still gates subcommand names; the new logic ADDITIONALLY refuses `--no-verify` and `--force-with-lease` in the `args` array regardless of `gh_allow_args` content. (Rationale: `--no-verify` is a global git flag that can ride along on any push-capable command, and `--force-with-lease` is a destructive variant of `--force` that we want to keep behind an explicit operator-set escape hatch later; in v1 we hard-refuse them both.)
- (e) Implement the reviewer's PR-read or PR-comment-post side of the loop. Stories 4.6 / 4.6b own those. This story produces the PR shape they consume.
- (f) Implement risk-tier stamping, auto-merge, or any verdict-gating logic. Stories 4.9 / 4.9b / 4.10b own those.
- (g) Implement `gh-error-map.yaml` recoverable-error classification. Story 4.5 owns that. This story's `gh pr create` failures propagate as raw typed errors; Story 4.5 will wrap them.
- (h) Spawn the dev subagent itself, parse the handoff phrase, or own any inner-cycle plumbing. Stories 4.2 / 4.3 / 4.3b own those. This story is the **terminal action** that the dev subagent emits AFTER its implementation work is done and BEFORE it emits the locked handoff phrase. The subagent calls `runDevTerminalAction` via the MCP tool surface (added to the dev role's `tools_allow` in this story); on success the tool returns the PR URL, which the subagent includes verbatim in its final message before emitting the handoff phrase. The handoff parser (Story 4.3) does NOT need to be aware of the PR URL — it only checks for the locked phrase.
- (i) Add a separate `git push` MCP tool. The push is performed inside `runDevTerminalAction` between commit and `gh pr create`. There is no standalone push tool — push only happens via this terminal-action entrypoint.
- (j) Persist the PR URL anywhere in the manifest. The URL is returned to the dev subagent in the tool's response and surfaces in the subagent's final transcript. Story 4.6 will fetch the PR via `gh pr list` keyed by branch name; the manifest does not store the URL in v1. (A future story may add `pr_url` to the manifest for faster reviewer-side lookup; not in scope here.)
- (k) Implement a recovery path for partial failures (commit succeeds, push fails; push succeeds, `gh pr create` fails). v1 returns a typed error and leaves the local branch in place — operator inspects, recovers manually, and re-runs `/crew:start`. Story 4.5 (`gh-error-map.yaml`) will refine the recoverable-error classification.
- (l) Sign commits (`-S`). The existing `gitCommit` helper explicitly forbids `-S` and we preserve that.
- (m) Touch `plugins/crew/skills/start/SKILL.md` or any other skill prose. The terminal action is invoked by the dev subagent itself (via its persona prompt's instruction set) — not by the outer `/crew:start` prose layer. SKILL.md's inner-cycle section (Story 4.3b) hands control to the dev subagent; the subagent does the implementation work, calls `runDevTerminalAction`, and only then emits the handoff phrase.
- (n) Add a `dry-run` mode. v1 either runs the terminal action end-to-end or fails fast.
- (o) Modify the `generalist-dev` persona body (`plugins/crew/catalogue/generalist-dev.md`). The persona's instruction set already says "open a PR as your terminal action"; this story adds the MCP tool that the persona reaches for. (A small follow-up edit to the persona prompt may be warranted to name `runDevTerminalAction` explicitly, but that is a knowledge-edit, not a code change, and the dev agent may make it in passing — see § Implementation strategy.)

---

## Acceptance Criteria

> AC1 and AC2 are verbatim from the epic; AC3 is verbatim from the epic and is the integration-test AC. None of the three reference a slash command, CLI command Jack types, install-doc path, or Claude Code UI element — they describe internal git/gh execa-wrapper plumbing the dev subagent invokes. Per `plugins/crew/docs/user-surface-acs.md`, this story is substrate; no `(user-surface)` tags apply.

**AC1:**
**Given** a finished implementation,
**When** the dev subagent emits its terminal action,
**Then** it creates a branch `story/<ref-slug>-<title-slug>`, commits in conventional-commits format with body wrapping at 72, and opens a PR via `gh pr create` with title `<type>(<ref>): <story title>` and a machine-section body (story link, ACs checklist) followed by a free-form summary. _(FR29, Pattern §9)_

<!-- Not user-surface: AC1 names branch / commit / PR shape created by the dev subagent (an internal agent), not commands Jack types. The PR is an artefact downstream tools consume, not a Claude Code UI surface. -->

**AC2:**
**Given** the dev subagent's permission spec,
**When** it attempts `--no-verify` or unsanctioned `--force-with-lease`,
**Then** the execa wrapper refuses the call. _(Pattern §9, NFR16)_

<!-- Not user-surface: AC2 describes wrapper-internal refusal logic exercised by the dev subagent's tool calls. -->

**AC3 (integration):**
vitest runs the dev terminal action against a fixture repo and asserts branch name, commit shape, and PR shape match conventions.

<!-- Not user-surface: AC3 is the vitest integration suite — internal harness only. -->

### Expanded acceptance specifics (folded into AC1–AC3 above; each clause maps to an AC for the AC-table gate)

**AC1 unpacked.** The following assertions all roll up under AC1's "branch / commit / PR shape" contract and are the load-bearing structural checks for the integration suite:

- (1a) **Branch name:** `story/<ref-slug>-<title-slug>` where `ref-slug` is the story ref lowercased with non-`[a-z0-9-]` chars replaced by `-` and collapsed; `title-slug` is kebab-case-from-title with non-`[a-z0-9-]` chars replaced by `-`, collapsed, and trimmed to 40 chars (per Pattern §9). Example: ref `4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action`, title `Dev subagent git push and gh pr create terminal action` → branch `story/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action-dev-subagent-git-push-and-gh-pr-create-t` (title-slug trimmed at 40 chars). The slug-builder is a pure function with deterministic output; the test asserts the exact string.
- (1b) **Commit type:** the caller passes a `type` argument; the tool validates it is in the conventional-commits set `{feat, fix, refactor, test, docs, chore, build, ci, perf, style, revert}`. Unknown types raise `ConventionalCommitTypeUnknownError` before any subprocess spawn.
- (1c) **Commit subject:** the first line of the commit message is `<type>(<ref>): <story title>` — same shape as the PR title. The tool composes this from the caller's `type`, `ref`, and `title` arguments; the caller does NOT pass a raw subject line.
- (1d) **Commit body wrap at 72:** the caller passes a `body` string (free-form, may contain `\n`). The tool's composer hard-wraps every line longer than 72 chars at the nearest preceding space boundary; lines containing `http://` / `https://` URLs longer than 72 are left untouched (URLs are not broken). Wrapped output is the string passed to `git commit -m <subject>` `-m <wrapped-body>` (two `-m` flags, the conventional way to express subject + body).
- (1e) **Push:** the tool runs `git push -u origin <branch>` after commit succeeds and before `gh pr create`. The `-u` flag is mandatory (sets upstream) so the first push is also the only push needed. The tool does NOT pass `--force`, `--force-with-lease`, or `--no-verify` in any code path. (If the operator's remote branch already exists, the push fails and the tool raises `GitPushFailedError`; recovery is operator-side.)
- (1f) **PR title:** `<type>(<ref>): <story title>` — identical to commit subject.
- (1g) **PR body:** two sections separated by a single blank line.
  - **Section 1 (machine block):** verbatim shape:
    ```
    <!-- crew:pr:machine -->
    Story: <ref>
    Spec: <relative path to story spec file from repo root>
    ACs:
    - [ ] AC1: <verbatim AC1 first line, truncated to 120 chars>
    - [ ] AC2: <verbatim AC2 first line, truncated to 120 chars>
    - [ ] AC3: <verbatim AC3 first line, truncated to 120 chars>
    ...
    <!-- /crew:pr:machine -->
    ```
    The opening and closing HTML comments are the parse anchors Story 4.6's reviewer side keys on. The ACs checklist is mirrored from the story spec file — the tool reads the spec at `manifestPath` → derived `specPath` (see § Implementation strategy), greps every `^\*\*AC(\d+)(\s*\([^)]+\))?\s*:\*\*` line, extracts the first non-blank line of each AC's body, and emits the checklist entries in numeric order. Checkbox state is always unchecked (`[ ]`) — reviewer will tick boxes in a later story when ACs pass.
  - **Section 2 (free-form summary):** the caller passes a `summary` string verbatim; the tool emits it after the blank line. No 72-char wrap is applied to the summary (PRs render Markdown; the wrap is commit-message-specific).
- (1h) **`gh pr create` invocation:** the tool calls `gh pr create --title <title> --body <body>`. No `--draft`, no `--reviewer`, no `--label` flags in v1. (Story 4.8 will add `--label reviewed-by-agent` on the reviewer side; this story's PR is unlabelled at creation time.) The current branch IS the source branch — `gh pr create` infers it from the local HEAD.
- (1i) **Return value:** on success the tool returns `{ ok: true, branch, commitSha, prUrl }` where `prUrl` is the stdout of `gh pr create` trimmed. On failure at any step the tool returns nothing — it raises a typed error.

**AC2 unpacked.** The "execa wrapper refuses" contract has two refusal points, both BEFORE any subprocess spawn:

- (2a) **`--no-verify` refusal:** if `args` (passed to the `gh` wrapper OR the `git` wrapper) contains the literal string `--no-verify`, the wrapper raises `NegativeCapabilityDeniedError` with `attempted_flag: "--no-verify"` and `role: <calling-role>`. Static check: a spy on `execaImpl` is NOT called. Applies symmetrically to `gh` and `git` wrappers — neither tolerates the flag in any subcommand, in any position in the `args` array.
- (2b) **Unsanctioned `--force-with-lease` refusal:** if `args` contains `--force-with-lease` OR any string starting with `--force-with-lease=` (the `=`-suffixed variant), the wrapper raises `NegativeCapabilityDeniedError` with `attempted_flag: "--force-with-lease"`. "Unsanctioned" means: in v1 the dev role's permission spec has no opt-in field for force-with-lease; the wrapper refuses unconditionally. (A future story may add `permissions.force_push_allowed: true` as an explicit operator-set escape hatch; not in v1.) The spec MUST NOT make the refusal contingent on `gh_allow_args` being empty or any other indirect signal — the refusal is hard-coded and the v1 wrapper has no path that admits the flag.
- (2c) **`--force` (no `-with-lease`) refusal:** as a defensive supplement, `--force` standalone is also refused via the same error. Pattern §9 only names `--force-with-lease` but the bare `--force` is strictly more dangerous, so refusing both is the safe default. (If a future story wants to allow `--force-with-lease` via an explicit escape hatch, the bare `--force` MUST remain refused — the escape hatch lands on the safer variant only.)
- (2d) **`gh_allow` enforcement unchanged:** the existing `gh_allow` subcommand allowlist still gates `gh` subcommand names. The new refusal logic is ADDITIVE and runs after `gh_allow` check (so a denied subcommand still surfaces as `GhSubcommandDeniedError`, not `NegativeCapabilityDeniedError`). For `git` calls there is no analogous subcommand allowlist in v1 — the wrapper is gated only by being the sole entrypoint for git work; the new flag refusal is the only `git`-side check added by this story.

**AC3 unpacked.** The integration suite covers, against a fixture tmpdir repo with a real `git init` and a stubbed `gh` execa:

- (3a) Happy path: caller passes `{ ref, title, type: "feat", body, summary, manifestPath }` for a fixture story with three ACs; the tool runs the full chain; the test asserts:
  - the branch was created (`git branch --show-current` returns the expected name);
  - the commit subject equals `feat(<ref>): <title>`;
  - the commit body has every line ≤72 chars (URLs excepted);
  - the `gh pr create` execa spy was called with the expected `--title` and a `--body` whose substring includes the machine block (with `<!-- crew:pr:machine -->` and `<!-- /crew:pr:machine -->` anchors), the ACs checklist (three `- [ ] ACn: ...` lines in order), and the free-form summary;
  - the tool's return value is `{ ok: true, branch, commitSha, prUrl }` with `prUrl` equal to the stubbed `gh pr create` stdout.
- (3b) Branch-slug edge cases: title containing punctuation, uppercase, runs of whitespace, and Unicode — slug-builder collapses to kebab and trims to 40 chars; assert exact slug strings for three fixture inputs.
- (3c) Commit-type validation: invalid `type` ("feature") raises `ConventionalCommitTypeUnknownError` before any execa spawn; spy on `execaImpl` confirms zero calls.
- (3d) Body wrap: a fixture body with a 200-char line wraps to ≤72 chars per line at the nearest preceding space; a fixture body containing a 100-char URL on its own line is left untouched.
- (3e) Negative capabilities (AC2 surfacing):
  - (3e-i) Caller passes `args: ["--no-verify"]` to the underlying `gh` wrapper directly (test-only path — production callers do not pass `args`) → raises `NegativeCapabilityDeniedError`; spy on `execaImpl` confirms zero calls.
  - (3e-ii) Same for `--force-with-lease`, `--force-with-lease=refs/heads/main`, and `--force`. Three sub-cases, each asserts zero execa spawn.
  - (3e-iii) Same for the `git` wrapper: caller attempts a push with `--no-verify` in the args → refused at the wrapper before spawn.
- (3f) Push failure: a stubbed `git push` returns non-zero exit code → tool raises `GitPushFailedError` carrying stderr; the local branch and commit are NOT rolled back (operator-side recovery).
- (3g) `gh pr create` failure: a stubbed `gh pr create` returns non-zero exit code → tool raises `GhPrCreateFailedError`. Story 4.5's recoverable-error classification will wrap this later; this story raises the raw typed error.
- (3h) Manifest is NOT mutated: the in-progress manifest at `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` is bytewise unchanged before and after the tool runs. The terminal action is a side-effect on git/gh state, not on plugin state. The story-status transition (in-progress → done) is the responsibility of `completeStory` (Story 4.1) and is invoked by the reviewer/auto-merge gate later, not by this tool.
- (3i) ACs checklist mirroring: the fixture story spec has three ACs (one tagged `(user-surface)`, one tagged `(integration)`, one untagged); the tool's emitted machine block contains three `- [ ] ACn: ...` lines in numeric order, each starting with the verbatim first line of the AC body truncated to 120 chars. (The `(integration)`-tagged AC exposes any regression of the AC-extractor regex to a narrower parenthetical match.)
- (3j) Tool count: the registered MCP tool list contains exactly `<prior baseline + 1>` entries (prior baseline is whatever the codebase has at the time of this story's merge — pull the number from `register.ts` and update the existing tool-count assertions; do NOT hard-code a number in this spec).

---

## Tasks / Subtasks

- [ ] **Task 1 — Extend `gh` and `git` execa wrappers with negative-capability refusal (AC: 2, 3)**
  - [ ] 1.1 Add a `NegativeCapabilityDeniedError` typed error to `plugins/crew/mcp-server/src/errors.ts` with fields `{ attempted_flag, role, callSite: "gh" | "git" }`.
  - [ ] 1.2 In `plugins/crew/mcp-server/src/lib/gh.ts`, add a pre-spawn check: if `args` contains any of `{ "--no-verify", "--force", "--force-with-lease" }` OR any arg starting with `--force-with-lease=`, raise `NegativeCapabilityDeniedError` before the `execaImpl` call. The check runs AFTER `gh_allow` enforcement (so denied subcommands still surface as `GhSubcommandDeniedError`).
  - [ ] 1.3 In `plugins/crew/mcp-server/src/lib/git.ts`, extend the existing `gitCommit` and the new `gitPush` / `gitCheckoutBranch` helpers (Task 2) with the same pre-spawn refusal check. Add an internal `assertNoNegativeFlags(args, role)` helper to avoid duplication.
  - [ ] 1.4 Unit tests in `plugins/crew/mcp-server/src/lib/__tests__/gh.test.ts` and `.../__tests__/git.test.ts`: for each of `{--no-verify, --force, --force-with-lease, --force-with-lease=refs/heads/main}`, assert the wrapper raises `NegativeCapabilityDeniedError` AND the `execaImpl` spy is not called.

- [ ] **Task 2 — Add `gitCreateBranch` and `gitPush` helpers to `lib/git.ts` (AC: 1, 3)**
  - [ ] 2.1 Export `gitCreateBranch({ targetRepoRoot, branchName, execaImpl? })` — runs `git -C <root> checkout -b <branchName>`. Refuses if `branchName` does not match `^story/[a-z0-9-]+$` regex (the slug-builder produces conforming names; this is a defence-in-depth check). Raises `GitBranchNameMalformedError` on regex fail before spawn.
  - [ ] 2.2 Export `gitPush({ targetRepoRoot, branchName, role, execaImpl? })` — runs `git -C <root> push -u origin <branchName>`. No `args` passthrough — the v1 signature is closed (no caller-supplied flags), which structurally prevents `--force-with-lease` / `--no-verify` injection. Raises `GitPushFailedError` on non-zero exit.
  - [ ] 2.3 Extend `gitCommit` to accept a second commit message shape: `messageShape: "plugin-internal" | "conventional"`. When `"conventional"`, validate against the regex `^(feat|fix|refactor|test|docs|chore|build|ci|perf|style|revert)\([a-z0-9-]+\): [^\s].+$` for the subject line; the body (passed as a separate `body` field) is hard-wrapped at 72 chars by the caller before reaching `gitCommit`. When `"plugin-internal"`, the existing shape is preserved (backward-compat).
  - [ ] 2.4 Update the static `canonical-fs-guard.test.ts` AC6f assertion if it cares about new git wrapper exports.
  - [ ] 2.5 Unit tests: slug regex pass/fail, push happy + failure path, commit-message shape switch.

- [ ] **Task 3 — Add slug-builder, body-wrapper, and PR-body-composer pure utilities (AC: 1, 3)**
  - [ ] 3.1 Create `plugins/crew/mcp-server/src/lib/pr-body.ts`. Export:
    - `buildBranchSlug({ ref, title }): string` — composes `story/<ref-slug>-<title-slug>` per AC1a; pure.
    - `wrapCommitBody(body: string, width: number = 72): string` — hard-wraps lines at width on space boundaries; leaves URL-containing lines untouched.
    - `composeCommitSubject({ type, ref, title }): string` — returns `<type>(<ref>): <title>`.
    - `composePrBody({ ref, specPath, acs, summary }): string` — composes the two-section body per AC1g.
  - [ ] 3.2 Create `plugins/crew/mcp-server/src/lib/extract-acs-from-spec.ts`. Export `extractAcsFromSpec(specPath: string): Promise<Array<{ index: number, firstLine: string }>>`. Reads the spec file, greps every `^\*\*AC(\d+)(\s*\([^)]+\))?\s*:\*\*` line, captures the first non-blank line of each AC body, truncates at 120 chars, returns in numeric order.
  - [ ] 3.3 Unit tests for each utility: slug-builder against the three AC3b fixture inputs; body-wrapper against AC3d cases; AC-extractor against a fixture spec with mixed `(user-surface)` / untagged / interleaved-blank-line ACs.

- [ ] **Task 4 — Create `runDevTerminalAction` MCP tool (AC: 1, 3)**
  - [ ] 4.1 Create `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts`. TSDoc top-of-file cites § Behavioural contract by full path.
  - [ ] 4.2 Inputs (all required, JSON-only): `{ targetRepoRoot, ref, title, type, body, summary, manifestPath, sessionUlid }`. `type` is validated against the conventional-commits set before any subprocess spawn.
  - [ ] 4.3 Implementation sequence: (i) compose branch slug via `buildBranchSlug`, (ii) call `gitCreateBranch`, (iii) call `extractAcsFromSpec` on the spec path derived from `manifestPath` (see § Implementation strategy for path derivation), (iv) compose subject via `composeCommitSubject`, wrap body via `wrapCommitBody`, (v) call `gitCommit({ ..., messageShape: "conventional" })`, (vi) call `gitPush`, (vii) compose PR body via `composePrBody`, (viii) call `gh({ role: "generalist-dev", subcommand: "pr-create", args: ["--title", subject, "--body", prBody], permissions })`, (ix) return `{ ok: true, branch, commitSha, prUrl }`.
  - [ ] 4.4 Register in `plugins/crew/mcp-server/src/tools/register.ts` with the eight-field input schema.
  - [ ] 4.5 Add `runDevTerminalAction` to `plugins/crew/permissions/generalist-dev.yaml`'s `tools_allow` list. (The dev subagent now has the MCP tool it needs to perform the terminal action.)
  - [ ] 4.6 Bump tool-count assertions in `ask-mode-enforcement.test.ts`, `ask-skill.test.ts`, `get-team-snapshot.test.ts` from the current baseline to `baseline + 1`. Pull the current number from `register.ts` — do NOT hard-code in spec.

- [ ] **Task 5 — Integration suite for `runDevTerminalAction` (AC: 1, 2, 3)**
  - [ ] 5.1 Create `plugins/crew/mcp-server/src/tools/__tests__/run-dev-terminal-action.integration.test.ts`.
  - [ ] 5.2 Fixture: tmpdir with `git init`, an `.crew/state/in-progress/<ref>.yaml` manifest, a fixture spec file at the manifest's `spec_path` with three ACs (one tagged `(user-surface)`, one tagged `(integration)`, one untagged).
  - [ ] 5.3 Stub `gh pr create` via `execaImpl` injection; assert stdout is captured as `prUrl`.
  - [ ] 5.4 Cover (3a)–(3i) branches from AC3 above. (3j) is asserted in the existing tool-count tests bumped in Task 4.6.
  - [ ] 5.5 The integration test MUST NOT actually push to a remote (no network IO in vitest). Stub `git push` via the same `execaImpl` injection seam used in `gitPush`'s unit tests.

- [ ] **Task 6 — Build, full vitest suite, fs-guard regression (AC: all)**
  - [ ] 6.1 `pnpm build` passes. `dist/` committed per CLAUDE.md.
  - [ ] 6.2 All vitest tests pass; the new test files contribute branches covering AC1 / AC2 / AC3 exhaustively.
  - [ ] 6.3 `canonical-fs-guard.test.ts` still passes — new tool writes nothing to canonical paths (it only spawns `git`/`gh` subprocesses).
  - [ ] 6.4 No telemetry emit added (Story 4.12 owns telemetry; this story is silent on JSONL events).

---

## Implementation strategy

### Why one composite tool, not three smaller ones

A composite tool (`runDevTerminalAction`) was chosen over a chain of smaller tools (`createBranch` → `commitConventional` → `push` → `createPr`) because:

- **The five steps are not independently useful.** A bare `createBranch` without a follow-up commit-and-push leaves the repo in a weird half-state; a bare `createPr` against an unpushed branch fails at `gh`'s side. The five steps are a transaction from the dev subagent's perspective.
- **The dev subagent's persona prompt is simpler with one call.** "Open a PR as your terminal action" maps to one tool name. If the subagent had to chain four tools, the persona prompt would need to encode the order, which is exactly the kind of LLM-driven control flow `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md §12` warns against ("MUST … use the locked phrases verbatim; paraphrasing breaks routing").
- **Partial-failure recovery is operator-side anyway.** If commit succeeds but push fails, the operator inspects the local branch and recovers. There is no v1 automated recovery, so factoring the tool into smaller pieces does not buy us a finer-grained retry surface.

### Why the conventional-commits validator is a regex, not a parser

Conventional-commits has a richer grammar (BREAKING CHANGE footers, scopes with `!`, multiple scopes). v1 supports only the subset Pattern §9 names: `<type>(<ref>): <subject>`. A regex `^(feat|fix|refactor|test|docs|chore|build|ci|perf|style|revert)\([a-z0-9-]+\): [^\s].+$` covers that subset precisely. A future story may swap to a real parser if richer footers are needed; v1 does not.

### How `specPath` is derived from `manifestPath`

The execution manifest at `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` already carries a `spec_path` field (Story 3.2's execution-manifest schema). The tool reads the manifest via `manifest-io.ts`'s `readManifest`, extracts `spec_path`, resolves it relative to `targetRepoRoot`, and passes the absolute path to `extractAcsFromSpec`. No new field is added to the manifest schema.

### Why the body-wrapper leaves URLs alone

Git commit messages render in `git log` and on GitHub's PR view; both surfaces break URLs that span line boundaries. The conventional fix is "don't wrap lines that contain `http://` or `https://`." Implementation: split on `\n`, for each line check `if (/https?:\/\//.test(line)) return line as-is; else wrap`. Simple, deterministic, no edge cases worth a parser.

### Why `gitPush`'s args are closed

The v1 push signature is `gitPush({ targetRepoRoot, branchName, role })` — no caller-supplied flag passthrough. This is structural prevention of `--force-with-lease` / `--no-verify` injection: there is no path for those flags to reach `execa`. The AC2 refusal check is the wrapper-level defence; the closed signature is the call-site defence. Both belt and braces because Pattern §9 lists this as a hard rule.

### Why `gh_allow` is not extended in this story

`pr-create` is already in `plugins/crew/permissions/generalist-dev.yaml`'s `gh_allow`. The new `runDevTerminalAction` calls `gh pr create` via the existing wrapper, which checks `gh_allow` — no spec change needed. We DO add `runDevTerminalAction` to `tools_allow` (it's a new MCP tool the dev role uses), but `gh_allow` is unchanged.

### Why this story does NOT touch the dev persona prompt body

The persona body at `plugins/crew/catalogue/generalist-dev.md` already says "open a PR as your terminal action" (in spirit — Story 4.2 / 4.3 set the persona contract). The dev subagent learns the MCP tool name `runDevTerminalAction` from the `tools_allow` allowlist injected at spawn time (the persona prompt assembly in `buildPersonaSpawnPrompt` includes the allowlist verbatim). A small persona-body edit to NAME the tool explicitly (e.g. "use `runDevTerminalAction` as your terminal action") would be a knowledge-edit and is OK to fold in via a small change to the persona body — but it is not a contract-shape change and does not require a separate AC.

### Risks and mitigations

- **Risk: a story title with non-ASCII chars produces a slug that's empty or all-hyphens.** Mitigation: the slug-builder asserts the trimmed slug has at least one alphanumeric char; if not, raises `BranchSlugUnrenderableError` before any subprocess spawn. The integration test covers a Unicode title fixture.
- **Risk: the spec file's AC numbering has gaps (AC1, AC3, AC4 — no AC2).** Mitigation: the AC-extractor emits checklist entries in the order they appear in the spec, preserving the original numbering. The reviewer side does not assume contiguous numbering.
- **Risk: `gh pr create` exits 0 but stdout is empty (network blip, PR created but URL not returned).** Mitigation: the tool checks stdout is non-empty and matches `^https://github.com/`; if not, raises `GhPrCreateFailedError` with diagnostic `"stdout did not contain a PR URL"`. Story 4.5 will reclassify.
- **Risk: the branch name already exists locally (operator re-runs after a failure).** Mitigation: `gitCreateBranch` fails on non-zero exit from `git checkout -b`; the operator's recovery is to delete the local branch (`git branch -D story/...`) and re-run. v1 does not auto-recover. (A future Story 4.5-related refinement may classify this as `recoverable: defer`.)
- **Risk: someone adds a new conventional-commits type later (e.g. `wip`) and the regex rejects it.** Mitigation: the regex is centralised in `pr-body.ts` and the set is exported as a named constant `CONVENTIONAL_COMMIT_TYPES`. Adding a new type is a one-line change; the unit tests guard against accidental drift in the set.

---

## Dev Notes

### Behavioural contract

Both new utility files and the new MCP tool source file MUST cite this section by full path (`_bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md § Behavioural contract`) in TSDoc at the top of the file.

#### `runDevTerminalAction` invariants

Pure function across the MCP wire of `({ targetRepoRoot, ref, title, type, body, summary, manifestPath, sessionUlid })`. The signature is JSON-only.

- **MUST** validate `type` against the conventional-commits set BEFORE any subprocess spawn.
- **MUST** compose the branch slug via `buildBranchSlug` (pure function). The result MUST match `^story/[a-z0-9-]+$` and have a non-empty alphanumeric component after the `story/` prefix.
- **MUST** execute the five steps strictly in order: createBranch → readManifest → extractAcs → composeSubject + wrapBody → gitCommit → gitPush → composePrBody → gh pr create. No step may be skipped or reordered. (The createBranch happens before extractAcs because branch creation is the only step that can fail for a reason the operator might need to recover from manually before any commit lands; failing fast on a name collision is preferable to wasting effort on AC extraction.)
- **MUST** stop and raise on the first error in the chain. No partial-state cleanup is attempted (no `git branch -D` on push failure, no `git reset --hard` on `gh` failure). The local repo state on error is exactly what the failed step left.
- **MUST NOT** pass any flags to `gitPush` or `gh pr create` beyond the closed v1 signatures (`-u origin <branch>` for push; `--title <subject> --body <body>` for `gh pr create`).
- **MUST NOT** retry any step. Story 4.5's recoverable-error map will sit OUTSIDE this tool — the tool raises the raw typed error; Story 4.5's classifier wraps it.
- **MUST NOT** write to any file outside the git working tree's normal commit/branch state. The manifest at `manifestPath` is read but never written. No telemetry event is emitted in v1.
- **MUST NOT** call `Task` (no subagent spawn). MUST NOT call `claimStory` / `completeStory` / `processDevTranscript` / `processReviewerTranscript`. The terminal action is invoked BY the dev subagent, not the other way around.
- **MUST** return `{ ok: true, branch, commitSha, prUrl }` on success and raise a typed error on failure. There is no `{ ok: false, ... }` return shape — failures are exceptions, success is a flat record.

#### `gh` wrapper invariants (extended by this story)

- **MUST** refuse, before `execaImpl` is called, if `args` contains any of `{ "--no-verify", "--force", "--force-with-lease" }` or any string starting with `--force-with-lease=`. Raises `NegativeCapabilityDeniedError`.
- **MUST** preserve the existing `gh_allow` subcommand enforcement (no behaviour change there). The new negative-capability check runs AFTER `gh_allow` so a denied subcommand still surfaces as `GhSubcommandDeniedError`.
- **MUST NOT** introspect `args` for any other flags. The refusal list is closed and exhaustive in v1.

#### `git` wrapper invariants (extended by this story)

- **MUST** refuse the same flag set in any `args` passed to `gitCommit` (which currently takes no `args`, so this is a forward-compat guard for future callers).
- **MUST** keep `gitPush`'s args closed — the signature has no `args` field, structurally preventing flag injection.
- **MUST** keep `gitCommit`'s existing plugin-internal commit-message shape available via `messageShape: "plugin-internal"` (backward compat with Story 1.5).
- **MUST** validate the conventional-commits subject regex when `messageShape: "conventional"`.

### File map (likely — refine during implementation)

**New files:**
- `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts`
- `plugins/crew/mcp-server/src/lib/pr-body.ts`
- `plugins/crew/mcp-server/src/lib/extract-acs-from-spec.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/run-dev-terminal-action.integration.test.ts`
- `plugins/crew/mcp-server/src/lib/__tests__/pr-body.test.ts`
- `plugins/crew/mcp-server/src/lib/__tests__/extract-acs-from-spec.test.ts`

**Modified files:**
- `plugins/crew/mcp-server/src/lib/git.ts` (add `gitCreateBranch`, `gitPush`, extend `gitCommit` with `messageShape` switch, add `assertNoNegativeFlags` helper)
- `plugins/crew/mcp-server/src/lib/gh.ts` (add pre-spawn negative-capability refusal)
- `plugins/crew/mcp-server/src/lib/__tests__/git.test.ts`
- `plugins/crew/mcp-server/src/lib/__tests__/gh.test.ts`
- `plugins/crew/mcp-server/src/errors.ts` (add `NegativeCapabilityDeniedError`, `GitBranchNameMalformedError`, `GitPushFailedError`, `GhPrCreateFailedError`, `ConventionalCommitTypeUnknownError`, `BranchSlugUnrenderableError`)
- `plugins/crew/mcp-server/src/tools/register.ts` (register the new MCP tool)
- `plugins/crew/permissions/generalist-dev.yaml` (add `runDevTerminalAction` to `tools_allow`)
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` (tool count `+1`)
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` (tool count `+1`)
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` (tool count `+1`)
- `plugins/crew/mcp-server/dist/` (rebuild; commit per CLAUDE.md)

**Optionally modified:**
- `plugins/crew/catalogue/generalist-dev.md` — a one-line knowledge edit naming `runDevTerminalAction` as the terminal-action tool. Knowledge edit, not contract change. OK to skip if the dev agent prefers to land it as a follow-up.

**Untouched:**
- `plugins/crew/mcp-server/src/skills/handoff-parser.ts` / `verdict-parser.ts` (locked-phrase parsers — owned by Stories 4.3 / 4.3b)
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` (`spec_path` already declared by Story 3.2)
- `plugins/crew/mcp-server/src/schemas/role-permissions.ts` (no schema change — `gh_allow` semantics unchanged; the new negative-capability refusal is in the wrapper, not the schema)
- `plugins/crew/permissions/gh-error-map.yaml` (Story 4.5 owns this)

### Dependencies

This story depends on:
- Story 1.4 (permission allowlist scaffolding) — the `gh` wrapper's `gh_allow` enforcement is built on this.
- Story 1.5 (`gitCommit` helper) — extended here with a second message shape.
- Story 3.2 (execution-manifest schema) — `spec_path` field used to locate the story spec for ACs extraction.
- Story 4.1 (`claimStory` / `completeStory`) — the dev subagent is already inside `in-progress/<ref>.yaml` when this tool runs.
- Story 4.3b (transcript-processor seam) — the dev subagent calls this tool AFTER its implementation work and BEFORE emitting the locked handoff phrase; the handoff parser does not need awareness of the terminal action.

Downstream stories that will consume the PR shape this story produces:
- Story 4.5 — wraps the typed errors raised here in the recoverable-error classifier.
- Story 4.6 / 4.6b — reviewer reads the PR diff and the machine block (the `<!-- crew:pr:machine -->` anchors) for inline-comment placement.
- Story 4.7 — verdict version stamping uses the same `<!-- crew:...:<ref> -->` HTML-comment anchor pattern.
- Story 4.8 — reviewer adds the `reviewed-by-agent` label to the PR.
- Story 4.10b — auto-merge gate consumes the PR.

---

## Completion notes

Ultimate context engine analysis completed — comprehensive developer guide created. Branch / commit / PR shape pinned to Pattern §9; negative-capability refusal hard-coded into both `gh` and `git` execa wrappers BEFORE subprocess spawn; one new composite MCP tool (`runDevTerminalAction`) plus three pure utility modules; existing `gitCommit` extended with a second message shape (conventional-commits) without breaking the Story 1.5 plugin-internal shape. Integration suite covers happy path, slug edges, body wrap, push failure, `gh pr create` failure, and all three negative-capability flag refusals at the wrapper level. Story is substrate — no user-surface ACs, no smoke-evidence requirement.
