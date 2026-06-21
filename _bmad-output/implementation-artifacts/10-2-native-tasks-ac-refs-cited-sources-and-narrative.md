# Story 10.2: Add `tasks[] → ac_refs`, `cited_sources[]`, and a structured narrative

story_shape: substrate
Status: ready-for-dev

## Story

As the crew planning cockpit (author seam, judge panel, Tier-0 validator),
I want the **native** story format to carry a structured `tasks[]` (each task mapped to ≥1 AC), a `cited_sources[]` list, and a structured `narrative { role, want, so_that }`,
so that the remaining rubric-graded properties — **T0-1** ("required sections present; every task mapped to an AC") and **T0-5** ("every technical claim cites a source path") — become parsed, schema-enforced fields rather than free prose. With 10.1 (`verification`) this completes the §3 enriched native schema. As in 10.1, 10.2 lands the **fields + fail-closed write/parse**; the validator + scan-time T0-1/T0-5 enforcement is Story 10.3.

## Dependencies

- **Depends on 10.1** (`native:`/Epic-10 — the enriched-format work and the additive/BMad-safe pattern this story mirrors). Both touch the same parser/writer/manifest/type seams.
- **Is a prerequisite for** 10.3 (validator reads `tasks[].ac_refs` and `cited_sources` for T0-1/T0-5), 10.5 (ingest must enrich BMad stories into tasks/cited_sources too).
- **Touches the shared `AC`/`SourceStory` types** (`adapters/adapter.ts`) used by both parsers — additive and BMad-safe (see Scope discipline). Does **not** touch the discipline validator (10.3's surface, shared with the live Epic 6 drain).

## Acceptance Criteria

**AC1 — a native story round-trips tasks, cited sources, and a structured narrative, and violations are rejected at write (integration):**

Drive the real `writeNativeStory` tool against a temp native workspace. (a) Writing a story with a structured narrative, ≥1 task each mapping to a real AC id, and ≥1 cited source succeeds, and re-reading via `parseNativeStory` returns `narrative_struct: { role, want, so_that }`, `tasks: [{ text, ac_refs }]`, and `cited_sources: [...]` intact. (b) Writing a story that omits tasks, includes a task whose `ac_refs` names a non-existent AC, omits cited sources, or whose narrative is not in role/want/so_that shape is rejected before any file is written — the error names the specific violation. Observable spine: the three new fields survive write→parse, and the write fails closed on each violation.

vitest: plugins/crew/mcp-server/src/tools/__tests__/write-native-story.test.ts

**AC2 — the parser extracts tasks with AC refs and rejects dangling/empty refs (unit):**

`parseNativeStory` parses a new `## Tasks` section: each bullet `- <text> (AC: 1, 3)` becomes `{ text, ac_refs: ["AC1", "AC3"] }`. It throws `MalformedNativeStoryError { path, section, reason }` when a task carries no AC ref, or when an `ac_ref` does not resolve to a parsed AC id in the same story. (Whole-story T0-1 enforcement at scan time is 10.3; this is the parse-level shape + intra-story ref integrity.)

vitest: plugins/crew/mcp-server/src/adapters/native/__tests__/parse-native-story.test.ts

**AC3 — the parser extracts cited sources and a structured narrative (unit):**

`parseNativeStory` parses a new `## Cited Sources` section (bullet list of repo-relative paths) into `cited_sources: string[]`, throwing when the section is empty; and parses the `## Narrative` "As a {role}, I want {want}, so that {so_that}." prose into `narrative_struct: { role, want, so_that }` (retaining the raw `narrative` string), throwing when the prose does not match that shape. (Checking that each cited path *resolves on disk* is T0-5, Story 10.3 — this checks presence and shape.)

vitest: plugins/crew/mcp-server/src/adapters/native/__tests__/parse-native-story.test.ts

**AC4 — the manifest schema and shared types gain the new fields, additively (unit):**

The execution-manifest schema and the shared `SourceStory` type gain optional `tasks?`, `cited_sources?`, and `narrative_struct?`. A native-scanned manifest carries them through from `SourceStory`; a legacy manifest or a BMad-scanned manifest without them still parses under strict mode (additive — no regression). The BMad parser compiles unchanged and leaves all three `undefined` (BMad enrichment is the 10.5 ingest's job).

vitest: plugins/crew/mcp-server/src/schemas/__tests__/execution-manifest.test.ts

## Definition of Done

- [ ] All four ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green — the **full** suite (shared types changed; nothing downstream regresses).
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt.
- [ ] `pnpm knip` green.
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean.
- [ ] Additive and BMad-safe: the three fields are required only on the native write/parse path; optional on the shared types and the manifest schema; no existing native fixture (beyond newly-written stories), BMad fixture, or persisted manifest must carry them to keep parsing.

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** `tasks[]` (with `ac_refs`), `cited_sources[]`, and `narrative_struct { role, want, so_that }` on the native format — parser (new `## Tasks` / `## Cited Sources` sections + structured narrative), writer (input schema + render), manifest schema, shared types — fail-closed at the native write/parse boundary.

**Does NOT build (deferred — named so a reviewer doesn't flag the absence):**
- Tier-0 validator checks **T0-1** (every task maps to an AC — scan-time, across the whole story) and **T0-5** (every cited path *resolves on disk*) — **Story 10.3**. 10.2 enforces shape + intra-story ref integrity at the native write path; 10.3 adds the validator + `/crew:scan` enforcement and the on-disk resolvability check.
- BMad extraction of these fields — **Story 10.5** (ingest).

### Mirror 10.1 exactly — do not invent a parallel pattern

10.1 established the pattern: required on the native write/parse path, optional on the shared type + manifest, fail-closed via the writer's existing pre-write round-trip through `parseNativeStory`. Reuse it verbatim for all three new fields. Add new `## Tasks` and `## Cited Sources` sections via the existing `splitTopLevelSections` map (the parser already splits generic `## <name>` sections — read the two new section names from that map; do not write a bespoke scanner).

### Files touched

**UPDATE:**
- `plugins/crew/mcp-server/src/adapters/adapter.ts` — extend `SourceStory` with optional `tasks?: { text: string; ac_refs: string[] }[]`, `cited_sources?: string[]`, `narrative_struct?: { role: string; want: string; so_that: string }`.
- `plugins/crew/mcp-server/src/adapters/native/parse-native-story.ts` — parse `## Tasks` (bullets with `(AC: …)` → `ac_refs`), `## Cited Sources` (bullet paths), and the structured narrative from `## Narrative`; fail-closed via `MalformedNativeStoryError`. Reuse `splitTopLevelSections` and mirror the bullet-parsing style of the existing `parseDependencies`.
- `plugins/crew/mcp-server/src/tools/write-native-story.ts` — add `tasks` (≥1, each `{ text, ac_refs: string[] (≥1) }`), `cited_sources` (≥1), and structured `narrative` to `WriteNativeStoryInputSchema`; render `## Tasks` / `## Cited Sources` sections and the "As a … I want … so that …" narrative in `renderNativeStoryBody`. The existing pre-write round-trip enforces them.
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — add optional `tasks`, `cited_sources`, `narrative_struct` (additive; strict mode).
- Native story **fixtures** in the writer/parser/scan tests — add `## Tasks`, `## Cited Sources`, and role/want/so_that narrative so they keep round-tripping. Grep the test tree first.

### Existing seams to wire into (do not reinvent)

- **Section splitting:** `splitTopLevelSections` (parse-native-story.ts L110-125) already yields a `Map<name, Section>` — read `"Tasks"` and `"Cited Sources"` from it.
- **Bullet parsing + ref validation:** mirror `parseDependencies` (L181-197) for the `## Cited Sources` and `## Tasks` bullet shapes and their `MalformedNativeStoryError` reasons.
- **Narrative source:** today `narrative` is `narrativeSection.bodyLines.join("\n").trim()` (L56). Keep that raw string; add `narrative_struct` by parsing the role/want/so_that prose from it.
- **Failure type:** reuse `MalformedNativeStoryError` (`errors.ts`) with new `section`/`reason` values.

### Edge cases worth surfacing in dev/review

- **Narrative round-trip fragility.** Rendering `narrative_struct` to "As a {role}, I want {want}, so that {so_that}." and parsing it back must be stable. Pin the round-trip in a test; keep the render/parse grammar strict and symmetric. If the prose form proves brittle, prefer rendering the canonical sentence from the struct and parsing only that exact grammar.
- **Dangling `ac_refs` is the top risk.** A task referencing `AC9` when only AC1–AC4 exist must be rejected at parse (AC2), not silently dropped — that is the integrity the T0-1 validator (10.3) later enforces across scan.
- **AC-ref grammar:** pin one grammar — `(AC: 1, 3)` mapping to `["AC1","AC3"]`. Reject empty `(AC: )` and non-numeric refs. One grammar, tested.
- **Story size:** this story carries three related additions. The narrative-struct slice could split out if the dev finds the integration AC needs more than one orthogonal assertion — but all three share one spine (the native format carries the §3 fields fail-closed) and one write path, so they ship together by default to avoid per-story orchestration tax.
- **On-disk resolvability of cited paths is NOT checked here** (that's T0-5 / 10.3). A `cited_sources` entry pointing at a non-existent path still parses in 10.2 — deliberate, scoped out.

### Risk + build notes (drain context)

- **Risk tier: medium.** Additive schema change to the shared, load-bearing native format; default-closed and additive, but the shared-type blast radius is real (same as 10.1). Full-suite-green is the per-story ship gate.
- **Build/verify:** `pnpm --dir plugins/crew/mcp-server test` + `build`, both green, plus `pnpm knip`. Deterministic; no network, no new deps.
- **Build-safety vs the live Epic 6 drain:** like 10.1, 10.2 does not touch `validate-against-discipline` or the standards surface — no collision with the calibration drain. (10.3 does.)

### References

- [Source: _bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md §3] — the enriched §3 schema: `tasks[]→ac_refs`, `cited_sources[]`, structured narrative (this story's slice); T0-1/T0-5 ownership split (fields here, validator in 10.3).
- [Source: _bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md §2] — T0-1 (required sections; every task mapped to an AC) and T0-5 (every claim cites a source path).
- [Source: plugins/crew/mcp-server/src/adapters/native/parse-native-story.ts §splitTopLevelSections L110-125, parseDependencies L181-197, narrative L56] — the section-split, bullet-parse, and narrative seams to extend.
- [Source: plugins/crew/mcp-server/src/adapters/adapter.ts §SourceStory] — the shared type to extend additively.
- [Source: plugins/crew/mcp-server/src/tools/write-native-story.ts §WriteNativeStoryInputSchema, renderNativeStoryBody, round-trip] — write-side schema, serialization, and the existing round-trip guard.
- [Source: plugins/crew/mcp-server/src/schemas/execution-manifest.ts] — manifest schema (strict mode) to extend additively.
- [Source: _bmad-output/implementation-artifacts/10-1-enrich-native-ac-verification-block.md] — the pattern this story mirrors (required-on-native / optional-on-shared / fail-closed via round-trip).
