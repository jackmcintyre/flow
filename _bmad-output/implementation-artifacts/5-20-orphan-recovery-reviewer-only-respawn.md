# Story 5.20: Orphan-recovery — reviewer-only re-spawn when PR exists and transcript is consumed

story_shape: substrate
Status: done

## Story

As a **plugin operator**,
I want **`/crew:start` to retry only the reviewer when an orphan manifest has no transcript but its PR is already open and green**,
So that **a reviewer-side failure doesn't force me into Path B manual closeout when the dev side already shipped**.

This story is independent — no spec or code dependencies on other in-flight Epic 5 stories.

## Acceptance Criteria

**AC1:**

`scanOrphanedInProgress` returns `hasOpenPR: boolean` per orphan, computed by querying `gh pr list --head <branch>` (or equivalent) where the branch name derives from the manifest's story ref using the same convention `/ship-story` and `/crew:start` use for dev branches.
`artifact: plugins/crew/mcp-server/src/tools/scan-orphaned-in-progress.ts`

**AC2:**

The `/crew:start` orchestration adds a new branch: when an orphan has `hasTranscript: false` AND `hasOpenPR: true`, route to **spawn-reviewer-only** (call `reattachOrphan` to rewrite `claimed_by`, then spawn the reviewer subagent without dev replay). When `hasTranscript: false` AND `hasOpenPR: false`, preserve the current behaviour (call `blockOrphanNoTranscript` → stamp `blocked_by: orphan-no-transcript`).
`artifact: plugins/crew/skills/crew-start/SKILL.md (or the orchestration tool that consumes scanOrphanedInProgress output)`

**AC3 (integration):**

Seed a fixture with (a) an in-progress manifest, (b) a stale `claimed_by` ULID, (c) no transcript on disk, (d) an open PR for the story's ref (mock the `gh` call). Assert `scanOrphanedInProgress` returns `hasOpenPR: true` AND the recovery routing produces a "spawn-reviewer" outcome with no `blocked_by` stamp on the manifest.
`vitest: plugins/crew/mcp-server/src/tools/__tests__/orphan-recovery-reviewer-only.test.ts`

**AC4 (integration):**

Same orphan shape but mock `gh pr list` returning empty. Assert `hasOpenPR: false` AND the current behaviour is preserved: `blockOrphanNoTranscript` is called, manifest stamped `blocked_by: orphan-no-transcript`.
`vitest: plugins/crew/mcp-server/src/tools/__tests__/orphan-recovery-reviewer-only.test.ts`

## Implementation Notes

### Files touched

**MODIFY:**

- `plugins/crew/mcp-server/src/tools/scan-orphaned-in-progress.ts` — add `hasOpenPR: boolean` to the `OrphanedManifest` interface and populate it per orphan via `gh pr list --head <branch>`. The branch name derives from `manifest.ref` using the existing convention (read `/ship-story` skill or sibling tools to find the canonical mapping; do NOT invent new). Use the existing `gh()` wrapper per memory `feedback_gh_is_me_acting_as_jack`. Cache cheaply if multiple orphans share a branch.
- `plugins/crew/skills/crew-start/SKILL.md` (or the orchestration tool it points to) — add the `hasTranscript: false` AND `hasOpenPR: true` branch. Routes through `reattachOrphan` (to rewrite `claimed_by`) → spawn-reviewer-only. Preserves the no-PR branch as-is.

**NEW:**

- `plugins/crew/mcp-server/src/tools/__tests__/orphan-recovery-reviewer-only.test.ts` — vitest fixtures for AC3 (PR-exists routing) and AC4 (no-PR regression). Mock `gh` calls; assert routing outcome by inspecting the manifest state + the tool call sequence.

### Build artefacts

After any change in `plugins/crew/mcp-server/src/`, the dev agent MUST run `pnpm -r build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git".

### Dependencies

None. Leaf story.

### Context (for grounding, not implementation)

- Memory `project_orphan_recovery_no_reviewer_only_branch` carries the full canary-1 (bmad:5.19) failure shape and the Path B closeout recipe — read for the failure-mode receipt that motivated this story.
- Carry-forward entry 8 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` is the prerequisite write — already authored.
- This story does NOT cover the reviewer-first-call deterministic seam — that's Story 5.21 (parallel substrate fix sequenced via cosmic-forging-spark.md Phase 2.5).

### Edge cases worth surfacing in dev/review

- **Branch name derivation:** how `scanOrphanedInProgress` maps `manifest.ref` → branch name. The convention `/ship-story` uses must be read, not invented.
- **PR-detection failure mode:** if `gh pr list` errors (network, auth), default to `hasOpenPR: false` — safe fallback to the current block-no-transcript behaviour. Don't throw.
- **Multiple PRs match:** if more than one open PR shares the branch name (rare), treat as `hasOpenPR: true`; first-match acceptable.

## Definition of Done

- [ ] All ACs met; all vitest cases green.
- [ ] `pnpm -r build` passes; `dist/` rebuilt and staged.
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean (no rubber-stamp guard fires).
- [ ] `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` entry 8 marked "Folded into 5.20."
