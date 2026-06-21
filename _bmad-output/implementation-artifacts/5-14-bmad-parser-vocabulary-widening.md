# Story 5.14: BMad-parser vocabulary widening (`draft`, `approved`, `review`)

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **`/crew:scan` to recognise the BMad lifecycle states `draft`, `approved`, and `review` instead of throwing `MalformedBmadStoryError`**,
so that **the existing 60-spec corpus in `_bmad-output/implementation-artifacts/` scans clean and Phase 2 of the dogfood plan can start**.

### What this story is, in one sentence

Widen the BMad parser's recognised lifecycle vocabulary from six values to nine by adding `draft`, `approved`, and `review`, mapping each to the plugin's execution-state vocabulary (`draft → to-do`, `approved → to-do`, `review → in-progress`), and proving the widening against the live 60-spec corpus via an integration test.

### Why this is independent

This is a mechanical enum widening at three locations (the `BmadStatus` type, two mirrored `isKnownBmadStatus` guards, and one `switch` in `mapBmadStatusToExecution`), plus an integration test and a one-line cleanup of a malformed spec file. It introduces no schema migrations, no new parser shapes, no skill changes, no orchestrator changes. `reconcileStatus` is unaffected — its default branch routes via whatever mapping `mapBmadStatusToExecution` returns, so widening the source enum automatically widens its reconciliation behaviour without code change.

### What this story does NOT

- (a) Solve the deeper "`sprint-status.yaml` is the canonical source of truth for execution state" question. That is structural-parser-shaped and stays in Story 5.18.
- (b) Accept free-text Status variants. The grammar stays strict: `revised — re-implement per new architectural direction (tool-layer seam)` and similar prose forms remain `MalformedBmadStoryError` by design. Only the three new bare keywords are added.
- (c) Touch `reconcileStatus` directly. Its default branch already routes via `mapBmadStatusToExecution`, so the new mappings flow through for free.
- (d) Touch the `optional` semantics. The skip path stays unique to `optional`.
- (e) Change the `ship-gate` detection, `raw_frontmatter` shape, or any downstream consumer of `parseBmadStory`'s return value (other than adding the three new strings to the set of values that pass validation).
- (f) Add a permissive/structural parser. The story-parser brittleness item is a separate workstream; this story is the minimal targeted unblock.

---

## Acceptance Criteria

**AC1:**

`BmadStatus` (in `plugins/crew/mcp-server/src/adapters/bmad/map-bmad-status.ts`) and the mirror `isKnownBmadStatus` (in `plugins/crew/mcp-server/src/adapters/bmad/parse-bmad-story.ts:165-174`) both accept `draft`, `approved`, `review` in addition to today's six values. `mapBmadStatusToExecution` maps `draft → "to-do"`, `approved → "to-do"`, `review → "in-progress"`. The lifecycle table in `plugins/crew/docs/spikes/bmad-format.md` is updated to match. Unit tests cover the new values in both directions (parser accepts; `mapBmadStatusToExecution` returns the expected execution state). `reconcileStatus` is unaffected (its default branch already routes via the mapping it just received).
`artifact: plugins/crew/mcp-server/src/adapters/bmad/map-bmad-status.ts`

**AC2 (integration):**

vitest runs `parseBmadStory` over every `.md` file in `_bmad-output/implementation-artifacts/` (using the real repo path as the fixture root via a `path.resolve(__dirname, ...)` walk), asserts zero `MalformedBmadStoryError` throws, and asserts every result's `raw_frontmatter.status` round-trips the on-disk literal. **Precondition baked into the same commit:** `4-3c-call-completestory-after-ready-for-merge.md`'s `Status: revised — re-implement per new architectural direction (tool-layer seam)` is normalised to `Status: done` (the spec is marked `done` in `sprint-status.yaml`). The free-text grammar is explicitly NOT accepted — `revised — ...` remains a `MalformedBmadStoryError` by design.
`vitest: plugins/crew/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story-corpus.integration.test.ts`

---

## Implementation Strategy

### Files touched

**MODIFY:**

- `plugins/crew/mcp-server/src/adapters/bmad/map-bmad-status.ts` — widen the `BmadStatus` union type (lines 5-11), widen the `isKnownBmadStatus` guard (lines 94-103), add three new `case` arms to `mapBmadStatusToExecution`'s `switch` (lines 19-34).
- `plugins/crew/mcp-server/src/adapters/bmad/parse-bmad-story.ts` — widen the mirror `isKnownBmadStatus` guard (lines 165-174). This is a duplicate of the guard in `map-bmad-status.ts` and MUST be kept in sync (Dev Notes § "Two-mirror invariant" below covers why).
- `plugins/crew/docs/spikes/bmad-format.md` — add three rows to the "Lifecycle vocabulary" table (lines 57-65) for `draft`, `approved`, `review`.
- `_bmad-output/implementation-artifacts/4-3c-call-completestory-after-ready-for-merge.md` — line 4: replace `Status: revised — re-implement per new architectural direction (tool-layer seam)` with `Status: done`. This is a one-line spec-file cleanup, NOT a behaviour change; `sprint-status.yaml` already records the story as `done`. This edit is the precondition that lets AC2's corpus test pass.

**NEW:**

- `plugins/crew/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story-corpus.integration.test.ts` — the integration test required by AC2. Walks the live repo corpus via `path.resolve(__dirname, '../../../../../../../_bmad-output/implementation-artifacts')`. See Dev Notes § "AC2 fixture layout" for the exact path-arithmetic and assertion shape.
- `plugins/crew/mcp-server/src/adapters/bmad/__tests__/map-bmad-status.test.ts` OR additions to an existing co-located unit test file — unit coverage required by AC1. There is currently no unit-test file for `map-bmad-status.ts`; the existing `__tests__/` directory contains only `parse-bmad-story.ship-gate.test.ts`. Recommended: create a new `map-bmad-status.test.ts` file co-located with the other adapter tests, since the assertions cover a distinct module. Cases:
  - `mapBmadStatusToExecution("draft")` returns `"to-do"`
  - `mapBmadStatusToExecution("approved")` returns `"to-do"`
  - `mapBmadStatusToExecution("review")` returns `"in-progress"`
  - The full mapping matrix for the six existing values still holds (regression coverage so the widening doesn't silently break `case "contexted"` etc.).
  - `parseBmadStory` accepts a minimal fixture file with `Status: draft`, `Status: approved`, `Status: review` (one test per status) and returns `raw_frontmatter.status` equal to the on-disk literal.

### Where the new code lands (verbatim line refs)

- `map-bmad-status.ts`:
  - Type union at lines 5-11 widens from six to nine members.
  - `mapBmadStatusToExecution`'s `switch` body at lines 20-33 adds three new `case` arms. Recommended placement: keep alphabetical-ish or group the new keywords together; either is fine — exhaustiveness checking is what matters.
  - Inner `isKnownBmadStatus` at lines 94-103 adds three new `s ===` clauses.
- `parse-bmad-story.ts`:
  - Outer `isKnownBmadStatus` mirror at lines 165-174 adds three new `s ===` clauses, kept identical to the guard in `map-bmad-status.ts`.
  - The throw site at lines 88-94 (which produces the `MalformedBmadStoryError` with `reason: \`unknown Status value '${statusValue}'\``) is NOT modified — once the guard widens, the throw path simply stops firing for the three new values.
- `bmad-format.md`:
  - Insert the three new rows into the lifecycle table at lines 57-65. Suggested placement preserves logical lifecycle order: `draft` and `approved` before `ready-for-dev`; `review` between `in-progress` and `done`. Notes column should record the execution mapping rationale (e.g. `approved` is "PM has approved spec for dev pickup, semantically equivalent to `ready-for-dev`"; `review` is "dev work complete, awaiting human review — semantically equivalent to `in-progress` from the orchestrator's POV").

### Compile-time exhaustiveness check (recommended, not required)

TypeScript's `switch`-over-discriminated-union exhaustiveness check on `mapBmadStatusToExecution` will catch a missing `case` arm IF the function's return type is explicit (`ExecutionState | null`) and the compiler is in strict mode. The current code already has both, so adding a new union member without adding a `case` arm should produce a TS error at build time. Dev SHOULD verify this by running `pnpm typecheck` after widening only the union (without adding the `case` arms) to confirm the safety net; then add the `case` arms.

---

## Dev Notes

### Two-mirror invariant

`isKnownBmadStatus` is duplicated in two files: `map-bmad-status.ts` (lines 94-103, the inner module-private helper) and `parse-bmad-story.ts` (lines 165-174, the outer mirror used by the throw site at lines 88-94). The duplication is intentional in the current architecture (each module owns its own validation surface), but it means any vocabulary change MUST touch both. Forgetting one yields a silent drift: the parser will accept a value the mapper rejects (or vice versa) and the failure mode is a runtime exception deep in `scan-sources`. **Always edit both guards in the same change, with identical clause lists.** A future hardening would extract the guard to a shared helper; that is out of scope for 5.14.

### Locked mapping decisions (do NOT renegotiate)

These were locked at planning time. The dev agent must NOT propose alternatives:

| New BMad status | Execution state | Rationale |
|---|---|---|
| `draft` | `to-do` | Spec exists but PM hasn't approved it for dev pickup. From the orchestrator's POV, it's not claimable yet — semantically equivalent to `backlog`. Mapping to `to-do` preserves the existing "appears in the scan but isn't claimable until approved" behaviour without inventing a new execution state. |
| `approved` | `to-do` | Spec is approved for dev pickup. Semantically equivalent to `ready-for-dev`. The fact that BMad emits both `approved` and `ready-for-dev` is a vocabulary quirk of the upstream skill; both collapse to the same execution state for the plugin's purposes. |
| `review` | `in-progress` | Dev work complete, awaiting human review. From the orchestrator's POV, the story is mid-flight (it's been claimed, work has happened, it's not yet `done`). Mapping to `in-progress` keeps the existing "claimed and active" semantics consistent. |

**Explicitly rejected mapping decisions:**

- Free-text Status variants like `revised — re-implement per new architectural direction (tool-layer seam)` are NOT accepted. They remain `MalformedBmadStoryError`. The grammar stays strict; only bare known keywords pass. Adding a permissive/structural parser is a separate workstream (see CLAUDE.md § "Top blocker: story-parser brittleness").
- Mapping `review` to `done` is rejected — a story in `review` is not done; it might be rejected and re-opened.
- Mapping `draft` or `approved` to anything other than `to-do` is rejected — both states represent "not yet claimed" and the existing `to-do` execution state already captures that semantics without adding new vocabulary downstream.

### AC2 fixture layout (path arithmetic)

The integration test file lives at:

```
plugins/crew/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story-corpus.integration.test.ts
```

The corpus it walks lives at:

```
_bmad-output/implementation-artifacts/
```

Both paths are relative to the repo root. From the test file's `__dirname`, the corpus root is seven `..` segments up:

```ts
import path from "node:path";

const CORPUS_ROOT = path.resolve(
  __dirname,
  "../../../../../../../_bmad-output/implementation-artifacts",
);
```

Count check: `__tests__/` → `bmad/` → `adapters/` → `src/` → `mcp-server/` → `crew/` → `plugins/` → repo root → `_bmad-output/implementation-artifacts/`. That's seven `..` from `__dirname` (which is `__tests__/`) to the repo root, then descend into `_bmad-output/implementation-artifacts/`. Verify by `fs.existsSync(CORPUS_ROOT)` in a `beforeAll` and fail fast with a clear error message if the path arithmetic is wrong (this protects the test against future repo-layout changes).

Walk shape (`fs.readdirSync(CORPUS_ROOT)` filtered to `.md` files, then `parseBmadStory` on each). For each entry, assert:

1. `parseBmadStory(absPath)` does NOT throw a `MalformedBmadStoryError`.
2. The returned `raw_frontmatter.status` is a string equal to the literal `Status:` value on disk (read separately via a minimal in-test regex on the first ~20 lines of the file — do NOT re-use the parser's own extraction logic, that would be circular).

The test SHOULD use `describe.each` or a `test.each` parametrised over the file list so vitest reports per-file failures (much easier to triage than a single aggregate failure when one of 60 files trips).

### AC2 precondition: the 4.3c spec-file cleanup

The corpus today contains one file that the strict grammar will (correctly) reject even after widening: `_bmad-output/implementation-artifacts/4-3c-call-completestory-after-ready-for-merge.md` line 4 reads `Status: revised — re-implement per new architectural direction (tool-layer seam)`. The spec is recorded as `done` in `sprint-status.yaml`. The cleanup is a one-line edit in the same commit as the parser widening:

```
- Status: revised — re-implement per new architectural direction (tool-layer seam)
+ Status: done
```

This MUST be in the same commit as the parser change (so AC2's corpus test passes in the commit that introduces it). Do not stage the cleanup separately.

### Why the planner template was the wrong file to clamp

The reframe doc proposed clamping the planner template's allowed Status values. That's the wrong file: the failing specs in the corpus weren't authored from our planner template — they were authored from the installed `bmad-create-story` skill's template, which emits `draft`/`approved`/`review` as part of the BMad lifecycle. The fix has to live in the parser, not in our authoring template. (Captured here so the dev agent doesn't re-litigate.)

### Out of scope (do not let scope creep in)

- Sprint-status.yaml authority work (Story 5.18).
- Permissive/structural AST parser (separate workstream).
- Auto-cleanup of malformed Status lines in the corpus beyond the one targeted 4.3c edit. If the dev agent encounters another spec file with a malformed Status during AC2 test development, STOP and ask — do not silently rewrite specs.
- `reconcileStatus` matrix updates. The default branch already covers the new vocabulary via the mapping; explicit matrix rows for the new statuses are not part of this story.
- Extracting the duplicated `isKnownBmadStatus` guard into a shared helper. Tempting but separate.

### Test strategy summary

- **AC1 unit coverage** lands in `plugins/crew/mcp-server/src/adapters/bmad/__tests__/map-bmad-status.test.ts` (new file). Covers the full `mapBmadStatusToExecution` matrix (nine values + the `optional` null skip) and parser acceptance of the three new Status literals via minimal fixture files.
- **AC2 integration coverage** lands in `plugins/crew/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story-corpus.integration.test.ts` (new file). Walks the live corpus.
- The existing `parse-bmad-story.ship-gate.test.ts` is unaffected and MUST continue to pass.

Run order during dev: `pnpm typecheck` → `pnpm test` from the repo root. Both must pass before opening the PR.

### Build artefact reminder

`plugins/crew/mcp-server/dist/` is checked into git (`/plugin install` copies the tree as-is and does not run a build step). After changing `src/`, run `pnpm build` and commit `dist/` in the same change. CI fails on drift. See `plugins/crew/docs/README-install.md` § Build artefacts.

---

## Dependencies

None. Leaf story.

---

## References

- Stub: `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md` § Story 5.14 (lines 326-341).
- Diagnosis: `_bmad-output/postmortems/2026-05-27-parser-brittleness-diagnosis.md` (local-only, not in git).
- Plan context: Phase 0 of the `cosmic-forging-spark` plan surfaced the scan-failure on `Status: review` as the root cause (20 of 60 specs trip it).
- Related: Story 5.18 will tackle the deeper sprint-status authority question; do NOT pre-empt it here.
- Related: CLAUDE.md § "Top blocker: story-parser brittleness" — the permissive-parser workstream is downstream of this minimal unblock.

---

## Out of Scope (explicit)

- Schema migration for `BmadStatus` consumers (none required — the type widening is additive).
- Backfilling the BMad authoring template (the upstream skill already emits the new values; the parser is the one that was behind).
- Any change to `/crew:scan` skill prose or surface (substrate-only).
- Any change to `sprint-status.yaml` (state file — the orchestrator owns transitions).
