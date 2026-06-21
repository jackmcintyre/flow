# Story 5.22: `renderScanResult` leading-whitespace test assertion

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **a regression assertion that `renderScanResult`'s output has no leading whitespace on any non-empty line**,
So that **terminal-rendered scan results stay cosmetically clean and a future refactor can't quietly introduce indentation drift**.

This story is independent — no spec or code dependencies on other in-flight Epic 5 stories.

## Acceptance Criteria

**AC1:**

Add a test case in scan-sources test coverage that runs `scanSources` on a fixture, calls `renderScanResult` on the output, splits the rendered string by `\n`, and asserts each non-empty line passes `!/^\s/.test(line)` (no leading whitespace). Use or extend an existing fixture from `plugins/crew/mcp-server/tests/scan-sources.test.ts` so the rendered output has at least 5 non-empty lines (counts + skippedRefs + blockedRefs sections, typical).
`vitest: plugins/crew/mcp-server/tests/scan-sources.test.ts`

**AC2:**

The new test MUST pass on current `dev` HEAD without modifying `renderScanResult` first — this story is a forward-looking guard, not a fix. If the test fails on current `dev`, that's signal of an existing drift; the right resolution is to fix `renderScanResult` to match (single-line entries, no indent), not weaken the assertion. Document any such finding in the PR body.
`artifact: plugins/crew/mcp-server/src/tools/scan-sources.ts (renderScanResult — only modified if AC2 reveals current drift)`

## Implementation Notes

### Files touched

**MODIFY:**

- `plugins/crew/mcp-server/tests/scan-sources.test.ts` — add a new `describe` block (e.g., "renderScanResult cosmetic guarantees") with one `it` that asserts the no-leading-whitespace invariant per AC1.

**LIKELY UNCHANGED:**

- `plugins/crew/mcp-server/src/tools/scan-sources.ts` — `renderScanResult` itself (defined at line 61, consumed by register.ts:682). Only modified if AC2 reveals current drift.

### Build artefacts

If only the test file changes, no `dist/` rebuild needed (vitest tests aren't shipped to `dist/`). If `renderScanResult` is modified, run `pnpm --dir plugins/crew/mcp-server build` and stage `dist/` in the same commit per project CLAUDE.md § "Plugin build output is tracked in git".

### Dependencies

None. Leaf story.

### Context (for grounding, not implementation)

- Carry-forward entry 2 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` is the source — surfaced from Story 5.13 review feedback as Info-level cosmetic guarantee.
- `renderScanResult` is defined at `plugins/crew/mcp-server/src/tools/scan-sources.ts:61` and consumed by the `crew:scan` tool handler at `register.ts:682`.
- This story doubles as canary-2 for the self-bootstrap loop (`/crew:start`), validating that the substrate fixes shipped in 5.20 + 5.21 hold under a clean cycle. Story content is intentionally tiny so any cycle defects are clearly substrate-level, not story-design.

### Edge cases worth surfacing in dev/review

- **Empty / blank lines:** rendered output may have intentional blank lines between sections. The assertion treats empty strings as exceptions (`line !== ""`).
- **Multi-line continuation indent:** if `renderScanResult` formats anything across multiple lines with continuation indentation, the assertion catches it. If it does, the dev decides: relax the assertion to allow continuation-line indent, OR reshape the render to single-line entries. Default expectation: single-line entries, no indent.

## Definition of Done

- [ ] AC1 vitest case green.
- [ ] AC2 verified — test passed on current `dev` HEAD pre-change (or current behaviour fixed if test exposed drift, with PR body documenting the finding).
- [ ] If `renderScanResult` modified: `pnpm --dir plugins/crew/mcp-server build` + `dist/` staged.
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean (no rubber-stamp guard fires — canary-2 substrate-validation goal).
- [ ] `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` entry 2 marked "Folded into 5.22."
