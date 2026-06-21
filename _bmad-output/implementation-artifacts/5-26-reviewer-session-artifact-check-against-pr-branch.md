# Story 5.26: `runReviewerSession` artifact-check against PR branch

story_shape: substrate
Status: review

<!-- Authored 2026-05-28 after bmad:5.24 re-roll exposed the gap. Sourced from carry-forward entry 13. -->

## Story

As a **plugin operator**,
I want **the reviewer's artifact-presence and vitest checks to verify against the PR branch's filesystem (not the orchestrator's local `dev`)**,
So that **the reviewer returns a true verdict on dev-shipped code without requiring an operator-side pre-merge**.

### What this story is, in one sentence

`runReviewerSession.runArtifactCheck` and `runVitestCheck` currently do `fs.access(path.resolve(targetRepoRoot, ...))` and `pnpm vitest ... cwd: targetRepoRoot` — both assume the dev's new files exist at `targetRepoRoot`. They don't: dev's work lives on the PR's head branch in a sibling worktree that gets torn down after handoff. This story makes the reviewer fetch the PR's head ref via `gh`, materialise it in a temporary worktree, and use that worktree as the check root for the duration of the AC walk.

### Why this matters now

Every code-changing story to date has reached `done/` via operator override of a BLOCKED verdict — the proximate cause was the marker classifier (carry-forward entry 7) returning `manual-check-required` for backticked-marker ACs. After 2026-05-28's spec-authoring-discipline fix (plain markers in 6.1/6.2/6.3 and going forward), the artifact-check filesystem path becomes reachable for the first time — and immediately fails (see bmad:5.24 PR #171 reviewer cycle for the full exposure). Without this story, every Epic 6+ story will return NEEDS CHANGES on false-negative grounds, defeating the calibration loop's proof point.

This story is the FIRST half of a two-part fix; Story 5.27 (`runVitestCheck` workspace-aware cwd) sits on top of it. 5.26 ships the PR-branch worktree seam; 5.27 makes vitest invocation workspace-aware within that worktree.

---

## Acceptance Criteria

**AC1:**

Before running any per-AC artifact or vitest check, `runReviewerSession` fetches the PR's head ref via `gh pr view <prNumber> --json headRefName,headRefOid`. The fetched `headRefOid` (sha) is materialised into a temporary worktree at `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/review-worktree/` (under the session dir so cleanup is co-located with the rest of the session's state).
artifact: plugins/crew/mcp-server/src/tools/run-reviewer-session.ts

**AC2:**

`runArtifactCheck` and `runVitestCheck` use the PR-branch worktree path (from AC1) as their check root — NOT `targetRepoRoot`. The path is plumbed through as an additional parameter rather than overwriting `targetRepoRoot` in the calling code (so the rest of `runReviewerSession`'s reads — source story, standards doc — continue to use `targetRepoRoot` as before). The two functions get a new required parameter `checkRoot: string`; their existing `targetRepoRoot` parameter is removed where it was only used for the filesystem check.
artifact: plugins/crew/mcp-server/src/tools/run-reviewer-session.ts

**AC3 (integration):**

A vitest at `plugins/crew/mcp-server/src/tools/__tests__/reviewer-pr-branch-check.test.ts` seeds a tmp git repo with two branches: an `orchestrator-side` branch lacking the artifact, and a `pr-head` branch containing it. Drives `runReviewerSession` against a stub PR number with `gh` mocked (via `execaImpl`) to return the pr-head ref. Asserts: (a) the temporary worktree is created at `<sessionDir>/review-worktree/` and contains the artifact at the expected path; (b) `runArtifactCheck` returns `status: "pass"` on the artifact-present case; (c) repeat with the pr-head branch missing the artifact — asserts `status: "fail"` with the correct reason; (d) the temporary worktree is torn down after the reviewer session completes (no leftover files); (e) a stale worktree from a prior interrupted session at the same path is detected and reaped before the new worktree is created.
vitest: plugins/crew/mcp-server/src/tools/__tests__/reviewer-pr-branch-check.test.ts

**AC4:**

On any `gh` failure during the head-ref fetch — recoverable (`GhRecoverableError`) or otherwise — `runReviewerSession` surfaces a typed `ReviewerPrBranchFetchError` (NEW, added to `errors.ts`) and halts the reviewer session. Do NOT silently fall back to the local-filesystem check; do NOT swallow the error. The error carries `prNumber`, the underlying gh error message, and the gh subcommand that failed. `processReviewerTranscript`'s caller (the inner cycle in `/crew:start` SKILL.md) surfaces the error verbatim and halts the inner cycle per existing error-handling pattern.
vitest: plugins/crew/mcp-server/src/tools/__tests__/reviewer-pr-branch-check.test.ts

**AC5:**

Cleanup is unconditional via `try/finally` wrapped around the AC-walk phase: the worktree is removed on success, on per-AC failure, AND on any thrown error (including `GhRecoverableError`, `MalformedExecutionManifestError`, anything). Cleanup uses `git worktree remove <path> --force` (force handles uncommitted changes the AC-walk's vitest-run may have produced). On worktree-remove failure, log a warning to the returned `chatLog` and continue — cleanup failures are NOT fatal (the worktree lives under `<sessionDir>/` which is already operator-collectable garbage).
vitest: plugins/crew/mcp-server/src/tools/__tests__/reviewer-pr-branch-check.test.ts

---

## Implementation Notes

### Why this design (vs. alternatives)

Three approaches were considered:

**(a) Temporary `git worktree add`** — chosen. Creates a real filesystem at a sha, runs vitest against it (which needs a real source tree for module resolution), supports both artifact-presence and runnable-vitest paths from the same root. Cleanup via `git worktree remove` is well-supported and atomic. Costs ~50-200ms per session for the worktree creation/teardown. This is the same primitive the dev subagent already uses for its own work, so the operational shape is familiar.

**(b) `git cat-file -e <sha>:<path>`** — rejected. Fast for artifact-presence (no checkout needed) but cannot satisfy AC3's vitest requirement (vitest needs the source tree on disk). Adopting (b) would force a per-AC branch on applicability — adds complexity for marginal speed gain.

**(c) Pre-merge to a local "review" branch via `git merge --no-ff`** — rejected. Mutates the orchestrator's git state, requires undo on cleanup, can fail on merge conflicts (no recovery path), and most importantly violates the principle that the reviewer must observe the dev's exact PR content (not a merge-of-it).

### Files touched

**UPDATE:**
- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` — the main change. New behaviour:
  - `runReviewerSession` (main entry): after Read 1 (source story) and Read 3 (standards doc), but BEFORE the AC-walk (line 419-456 in the current file), call a new helper `materialisePrBranchWorktree({ targetRepoRoot, sessionUlid, prNumber, execaImpl })` which returns `{ worktreePath, headRefName, headRefOid, cleanup: () => Promise<void> }`.
  - Wrap the AC-walk + risk-tier classification + persist-result-file phase in `try { ... } finally { await cleanup(); }`.
  - Pass `worktreePath` as the new `checkRoot` parameter to `runArtifactCheck` and `runVitestCheck`.
  - `runArtifactCheck` signature change: replace `targetRepoRoot: string` with `checkRoot: string` (the function only used `targetRepoRoot` for the `path.resolve(targetRepoRoot, artifactPath)` call).
  - `runVitestCheck` signature change: same — replace `targetRepoRoot: string` with `checkRoot: string` (the function only used `targetRepoRoot` for the `cwd:` argument). NOTE: 5.26 will further refine `runVitestCheck` to be workspace-aware within `checkRoot`; this story leaves the cwd as `checkRoot` directly, which is correct for repos where `checkRoot` is the package root.

**NEW:**
- `plugins/crew/mcp-server/src/lib/materialise-pr-branch-worktree.ts` — the helper. Exports `materialisePrBranchWorktree({ targetRepoRoot, sessionUlid, prNumber, execaImpl?, ghImpl? })` and the typed `ReviewerPrBranchFetchError`. Internally:
  1. `gh pr view <prNumber> --json headRefName,headRefOid` via the existing `gh` wrapper at `plugins/crew/mcp-server/src/lib/gh.ts` (don't reinvent — reuse permissions/allowlisting).
  2. `git fetch origin <headRefName>` to ensure the sha is in the local object DB.
  3. Compute `worktreePath = path.join(targetRepoRoot, ".crew", "state", "sessions", sessionUlid, "review-worktree")`.
  4. Stale-worktree detection: if `worktreePath` exists, call `git worktree remove <worktreePath> --force` first (handles the interrupted-prior-run case from AC3e). Log to a returned `setupLog: string[]` so the caller can surface it.
  5. `git worktree add <worktreePath> <headRefOid>` (use the sha, not the branch name — sha is immutable, branch name could be moved out from under us mid-check).
  6. Return `{ worktreePath, headRefName, headRefOid, cleanup }` where `cleanup` does `git worktree remove <worktreePath> --force`, catches errors, returns them as warnings (per AC5).

- `plugins/crew/mcp-server/src/tools/__tests__/reviewer-pr-branch-check.test.ts` — vitest per AC3.

- `plugins/crew/mcp-server/src/errors.ts` — add `ReviewerPrBranchFetchError` with `{ prNumber, ghSubcommand, underlyingMessage }` shape. Mirrors existing `ReviewerFirstCallSkippedError`'s typed-error pattern.

### Reviewer permission allowlist update

`plugins/crew/permissions/generalist-reviewer.yaml` already has `gh_allow: [pr-diff, pr-view, api, repo-view]` — `pr-view` covers AC1's `gh pr view --json headRefName,headRefOid` call. No allowlist additions required. `git worktree` and `git fetch` invocations are git subcommands, not gh — they're handled by node's `execa` directly without going through the gh wrapper, so no `gh_allow` change is needed.

Verify in dev: the existing `gh` wrapper at `plugins/crew/mcp-server/src/lib/gh.ts` may not yet pass `headRefName,headRefOid` via the `--json` arg shape. If not, check the existing `gh` call sites in `runReviewerSession` (line 387-393 for `pr-diff`, line 478-485 for `pr-view --json commits`) for the patterns — `pr-view` with `--json <fields>` is already supported.

### Behavioural contract

```ts
// Before (current):
const acResults: Record<number, AcResult> = {};
for (const ac of acEntries) {
  const classification = classifyAc(ac.body);
  if (classification.applicability === "runnable-artifact-check") {
    acResults[ac.index] = await runArtifactCheck(
      ac.index, ac.tag, classification.artifactPath!, targetRepoRoot,
    );
  } else if (classification.applicability === "runnable-vitest") {
    acResults[ac.index] = await runVitestCheck(
      ac.index, ac.tag, classification.testNameFilter!, targetRepoRoot, execaImpl,
    );
  } else {
    acResults[ac.index] = { /* manual-check-required */ };
  }
}

// After (5.26):
const { worktreePath, headRefName, headRefOid, cleanup, setupLog } =
  await materialisePrBranchWorktree({ targetRepoRoot, sessionUlid, prNumber, execaImpl });

let acResults: Record<number, AcResult>;
let riskTierBlock: RiskTierBlock | undefined;
try {
  acResults = {};
  for (const ac of acEntries) {
    const classification = classifyAc(ac.body);
    if (classification.applicability === "runnable-artifact-check") {
      acResults[ac.index] = await runArtifactCheck(
        ac.index, ac.tag, classification.artifactPath!, worktreePath,  // <-- checkRoot, not targetRepoRoot
      );
    } else if (classification.applicability === "runnable-vitest") {
      acResults[ac.index] = await runVitestCheck(
        ac.index, ac.tag, classification.testNameFilter!, worktreePath, execaImpl,  // <-- checkRoot
      );
    } else {
      acResults[ac.index] = { /* manual-check-required */ };
    }
  }
  // risk-tier classification still runs against targetRepoRoot for spec lookups — those files
  // live in planning-artifacts/, NOT in the PR branch's plugin source. Confirm in dev.
  riskTierBlock = await classifyRiskTierWrapper(...);
} finally {
  await cleanup();  // unconditional cleanup per AC5
}

// Then persist reviewer-result.json (unchanged from current flow).
```

The `prDiff` read (line 387-393, `gh pr diff`) is unchanged — it produces the unified diff text used by the risk-tier classifier and reviewer summary; it doesn't need the worktree.

The `standards` read (line 399, `lookupStandards(targetRepoRoot)`) is unchanged — `docs/standards.md` lives on `dev` (the orchestrator's branch), not on the PR branch.

### Dependencies on other in-flight work

- **Hard dep:** none. 5.26 ships independently.
- **Soft dep:** Story 5.27 (`runVitestCheck` workspace-aware cwd) sits on top of 5.26 — 5.27 refines `runVitestCheck` to walk for the nearest `package.json` from the test path within `checkRoot`. 5.27 can be authored and merged independently, but its tests are easier to write against the post-5.26 signature (one parameter, `checkRoot`).
- **No blocker on 6.1/6.2/6.3:** those Epic 6 specs are ready-for-dev but the drain is paused until 5.26 + 5.27 ship (see memory `project_reviewer_toolchain_gaps`).

### Build artefacts

After any change in `plugins/crew/mcp-server/src/`, run `pnpm --dir plugins/crew/mcp-server build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git". Post-5.24, the `pnpm build` chain includes the post-build normaliser — verify zero unexpected dist drift before staging.

### Edge cases worth surfacing in dev/review

- **Concurrent reviewer sessions for the same target repo.** v1 has no expectation of concurrent /crew:start sessions, so the per-session worktree path is collision-free by design (each session gets its own ULID). If concurrency lands later, this design needs revisiting.
- **PR branch has been force-pushed mid-review.** The `headRefOid` captured at AC1 fetch time is what gets materialised. If the branch is force-pushed between fetch and worktree-add, the sha may not be reachable; `git worktree add <sha>` fails with a clear error. Surface verbatim, halt — this is correct fail-fast behaviour, not a defect.
- **Worktree-add fails due to nested git repo or path conflict.** The session dir lives under `.crew/state/sessions/<ulid>/` which is gitignored — no nested-repo concern. Path conflicts only happen if a prior session crashed without cleanup; AC3e covers this via the stale-detection branch.
- **The `git fetch` step.** Required because the PR's head ref may not be in the local object DB yet (CI just pushed it). `git fetch origin <headRefName>` is cheap and idempotent. Don't fetch all refs — that's slow and noisy.
- **Worktree removal on cleanup fails.** AC5 specifies: log warning, continue. Don't fail the verdict on a cleanup hiccup. Operator can `git worktree prune` manually if cruft accumulates.
- **Spec file paths in artifact: markers.** Some ACs reference files OUTSIDE the plugin source tree — e.g. `artifact: _bmad-output/implementation-artifacts/...` for Dev Notes-style ACs. These files exist on `dev` (committed there by the chore-commit flow), NOT on the PR branch. After 5.26, those checks would fail because the PR branch's worktree doesn't include the orchestrator's chore commits. **Decision for v1:** that's correct behaviour — if a spec author marks an artifact in `_bmad-output/`, they should arrange for that file to land on the PR branch too (e.g. dev commits the Dev Notes addition to the spec). For Story 5.24, the dev DID commit the Dev Notes addition to `5-24-zod-determinism-dts-fix.md` as part of its PR — that's the right pattern. Document this in the spec-authoring guidelines as a follow-up if it bites again.

### Architectural fit / references

- **Source code** — `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`. The full file is 558 lines as of 2026-05-28; the critical sections are `runArtifactCheck` (183-215), `runVitestCheck` (226-279), and the main `runReviewerSession` entry (362-558).
- **gh wrapper** — `plugins/crew/mcp-server/src/lib/gh.ts`. Reuse for the `pr view` call; do NOT directly invoke `execa("gh", ...)` outside the wrapper — that bypasses the permission allowlist enforcement (Story 1.4 substrate).
- **Existing typed errors** — `plugins/crew/mcp-server/src/errors.ts`. Mirror `ReviewerFirstCallSkippedError`'s shape (`{ sessionUlid, ref }` constructor) for `ReviewerPrBranchFetchError`.
- **Deterministic seam principle** — memory `feedback_default_to_deterministic_seams`. The PR-branch fetch + worktree materialisation is exactly this pattern: load-bearing decisions (what filesystem to check against) live in tool-written artefacts (the worktree), not in LLM prose or runtime fallbacks. The failing-loud `ReviewerPrBranchFetchError` (AC4) is the deterministic seam — refuses to silently degrade to the wrong behaviour.
- **Carry-forward source** — `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` entry 13. Authoritative description of the gap and its lineage.
- **Memory `project_reviewer_toolchain_gaps`** — captures the meta-pause: /crew:start drain is held until this story (5.26) and 5.27 ship.

---

## Definition of Done

- [ ] All five ACs met (AC1–AC5).
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; new vitest at `reviewer-pr-branch-check.test.ts` exercises every AC3 clause + AC4 + AC5.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit.
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean — `runReviewerSession` itself is what's being changed, so the reviewer's verdict on this PR depends on the change working. If the reviewer's verdict is BLOCKED or NEEDS CHANGES, inspect the worktree-materialisation step and confirm the temp worktree was created correctly for THIS PR (recursive test in production).
- [ ] No changes to `docs/standards.md`, `discipline-rules.yaml`, persona files, or any state directory.
- [ ] `ReviewerPrBranchFetchError` added to `errors.ts`; carries `{ prNumber, ghSubcommand, underlyingMessage }`.
- [ ] Carry-forward entry 13 updated to "Folded into 5.26" once shipped.

---

## Dev Notes

*(Dev fills this in during implementation — any deviation from the binding tool shapes above, gh wrapper quirks encountered, worktree-cleanup edge cases worth recording for the next person.)*
