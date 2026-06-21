# Story 5.19: `scan-sources` `readFile` resilience — warn-instead-of-throw on malformed manifest read

story_shape: substrate

Status: ready-for-dev

<!-- Authored 2026-05-27 as Phase 2 canary-1 of the cosmic-forging-spark plan. Sourced from epic-5-carry-forward.md entry 1. -->

## Story

As a **plugin operator**,
I want **`/crew:scan` to skip a single malformed/unreadable manifest with a warning rather than abort the whole scan**,
So that **one bad spec file doesn't block scanning the other 59**.

### What this story is, in one sentence

The to-do branch of `scan-sources.ts` currently lets per-file `readFile` errors propagate to the boundary, aborting the whole scan pass on the first bad file. This story wraps that `readFile` in a `try/catch` so the bad file lands in `result.skippedRefs` with reason `"unreadable-manifest"` and detail `"<errno>: <path>"`, and the scan continues with the remaining files.

### Why this story is independent of 5.18

5.18 is the structural-parser refactor — much bigger lift. 5.19 is a single-line resilience fix: catch one error, push to skipped list, continue. The two are independent; the structural parser doesn't subsume this resilience pattern (the structural parser still needs to read files, and `readFile` errors still need a per-file recovery path).

---

## Acceptance Criteria

**AC1:**

The to-do branch's `readFile` call site in `scan-sources.ts` (currently around lines 579-590 per `epic-5-carry-forward.md` entry 1) wraps the read in `try/catch`. On error, push to `result.skippedRefs` with reason `"unreadable-manifest"` and detail `"<errno>: <path>"`, then `continue`. The scan completes; the other manifests are processed normally. Refusal text matches the existing `skippedRefs` convention.
`artifact: plugins/crew/mcp-server/src/tools/scan-sources.ts`

**AC2 (integration):**

vitest seeds a fixture with 3 valid manifests + 1 deliberately-malformed-yaml manifest under `to-do/`, runs `scanSources`, asserts (a) the 3 valid manifests scan clean, (b) the bad one appears in `result.skippedRefs` with reason `"unreadable-manifest"` and a non-empty `detail` field, (c) `scanSources` returns without throwing at the boundary (the per-file error is contained).
`vitest: plugins/crew/mcp-server/src/tools/__tests__/scan-sources-readfile-resilience.test.ts`

---

## Implementation Notes

### Files touched

**MODIFY:**

- `plugins/crew/mcp-server/src/tools/scan-sources.ts` — wrap the `readFile` call site in the to-do branch (around lines 579-590) in `try/catch`. Use the same `skippedRefs` push convention used elsewhere in the file (look at other push sites for the canonical shape).
- `plugins/crew/mcp-server/src/tools/__tests__/scan-sources-readfile-resilience.test.ts` (NEW) — vitest fixture as described in AC2.

### Build artefacts

After any change in `plugins/crew/mcp-server/src/`, the dev agent MUST run `pnpm -r build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git".

### Dependencies

None. Leaf story.

---

## Definition of Done

- [ ] `scan-sources.ts` to-do branch's `readFile` wrapped in `try/catch`; on error, push to `skippedRefs` with reason `"unreadable-manifest"` and detail `"<errno>: <path>"`, then `continue`.
- [ ] `scan-sources-readfile-resilience.test.ts` lands; covers the 4 assertions in AC2.
- [ ] `pnpm -r build` clean; `dist/` committed in the same change.
- [ ] `pnpm -r test` passes (all existing scan-sources tests still green).
