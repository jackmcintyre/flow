# Story 10.1: Enrich the native AC with a structured `verification` block

story_shape: substrate
Status: ready-for-dev

## Story

As the crew planning cockpit (the author seam that drafts stories, the judge panel that grades them, and the Tier-0 validator that vetoes malformed drafts),
I want every **native** acceptance criterion to carry a structured, machine-readable `verification: { type, target }` field,
so that "how this AC is checked" is a parsed, schema-enforced property — not a `vitest:`/`artifact:` marker buried in free prose that can drift, be omitted, or lie. This is the spine of the native re-foundation: it is the per-AC marker that turns rubric checks **T0-2** ("every AC carries a verification marker") and **T0-6** ("every named check is runnable") from prose-grep into a schema fact. Story 10.1 lands the **field + fail-closed write/parse**; the validator + scan-time enforcement of T0-2/T0-6 is Story 10.3.

## Dependencies

- **No hard story dependency.** Builds directly on the existing native adapter (parser/writer/manifest shipped pre-Epic-10). First story of Epic 10.
- **Is a prerequisite for** 10.2 (adds `tasks[]`/`cited_sources[]`/structured narrative to the same format), 10.3 (Tier-0 validator reads the `verification` field), 10.4, and 10.5 (ingest enriches BMad ACs into this field).
- **Touches the shared `AC` type** (`adapters/adapter.ts`) used by both the native and BMad parsers — the change is additive and BMad-safe (see Scope discipline). Does **not** touch the discipline validator (`validate-against-discipline`) — that surface is 10.3's, and is also where the live Epic 6 calibration drain (6.5–6.8) works.

## Acceptance Criteria

**AC1 — a native AC round-trips its verification block, and a missing one is rejected at write (integration):**

Drive the real `writeNativeStory` tool against a temp native workspace (the canonical tmpdir + `config.yaml` + atomic-write fixture in the existing test). (a) Writing a story whose every AC includes a `verification` block succeeds, and re-reading the written file through `parseNativeStory` returns each AC with `verification: { type: "vitest" | "artifact", target: "<path>" }` intact (round-trip stable). (b) Writing a story whose any AC omits the `verification` block is rejected before any file is written — the error names the offending AC. This is the observable spine: the verification field survives write→parse, and the write fails closed when it is absent.

vitest: plugins/crew/mcp-server/src/tools/__tests__/write-native-story.test.ts

**AC2 — the native parser extracts and requires the verification line per AC (unit):**

`parseNativeStory` extracts the per-AC verification directive from the stored marker line (`vitest: <path>` or `artifact: <path>` immediately following the AC's Given/When/Then body) into `verification: { type, target }`, requiring exactly one such line per AC. It throws `MalformedNativeStoryError` (carrying `{ path, section, reason }`) when the line is absent, when `type` is neither `vitest` nor `artifact`, or when `target` is empty. (Note: this story checks *presence and shape* of the line — checking that `target` *resolves to a real file* is Tier-0 check T0-6, added in 10.3.)

vitest: plugins/crew/mcp-server/src/adapters/native/__tests__/parse-native-story.test.ts

**AC3 — the manifest AC schema gains an optional verification field, additively (unit):**

The execution-manifest acceptance-criteria schema (`execution-manifest.ts`, currently `{ text, kind }`) gains an optional `verification: { type: "vitest" | "artifact", target: string }`. A native-scanned manifest carries `verification` through from `SourceStory`; a legacy manifest written without it still parses under the schema's strict mode (the field is additive — no regression to already-persisted manifests or to BMad-scanned manifests). `parseExecutionManifest` round-trips a manifest with and without the field.

vitest: plugins/crew/mcp-server/src/schemas/__tests__/execution-manifest.test.ts

**AC4 — the shared AC type carries verification as optional; BMad parsing is unchanged (unit):**

The shared `AC` type (`adapters/adapter.ts`) gains `verification?: { type: "vitest" | "artifact"; target: string }` (optional at the type level so only the native write/parse path enforces presence). The BMad parser compiles against the updated type and its existing AC extraction is unchanged — BMad ACs parse with `verification` left `undefined`. (Extracting `verification` from BMad prose markers is deliberately deferred to the 10.5 ingest seam.)

vitest: plugins/crew/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story-ac-headings.test.ts

## Definition of Done

- [ ] All four ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green — the **full** suite, not just the new tests (the AC type is shared; nothing downstream regresses).
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt.
- [ ] `pnpm knip` green — no dead exports/files introduced (CI bloat-gate).
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean.
- [ ] Change is additive and BMad-safe: `verification` is required only on the native write/parse path; optional on the shared `AC` type and the manifest schema; no existing native fixture, BMad fixture, or persisted manifest needs `verification` to keep parsing **except** newly-written native stories.

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:**
- A structured `verification: { type, target }` field on the native AC, fail-closed at the native write/parse boundary.
- The parse, render, write-input-schema, and manifest-schema changes needed for that field to round-trip.

**Does NOT build (deferred, named here so a reviewer doesn't flag the absence as a gap):**
- The Tier-0 validator checks T0-2 (every AC has verification) and T0-6 (target resolves to a real file / reject invented flags) — **Story 10.3**. 10.1 enforces *presence and shape* at the native write path; 10.3 adds the validator + `/crew:scan` enforcement and the *resolvability* check.
- `tasks[]`, `cited_sources[]`, structured `narrative` — **Story 10.2**.
- Extraction of `verification` from BMad prose markers — **Story 10.5** (ingest). 10.1 only makes the shared type able to carry it.

### Mirror the existing native format — do not reinvent

The native AC marker convention already exists in prose: each AC block is `**AC<n> (<kind>):**` then a Given/When/Then body. This story **promotes the already-conventional `vitest:`/`artifact:` line** (used today in BMad specs and gold-standard native stories) to a parsed field. Emit and parse it as a single line directly under the AC body — do not invent a new syntax (e.g. no YAML sub-block). The round-trip contract is the test: `renderNativeStoryBody` emits exactly what `parseNativeStory` consumes.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/adapters/native/__tests__/parse-native-story.test.ts` — dedicated parser tests for the verification field (AC2). (If a parse-native-story test already exists under a different name, extend it instead of duplicating.)

**UPDATE:**
- `plugins/crew/mcp-server/src/adapters/adapter.ts` (~line 48) — add `verification?: { type: "vitest" | "artifact"; target: string }` to the `AC` type. (Optional at type level — see AC4.)
- `plugins/crew/mcp-server/src/adapters/native/parse-native-story.ts` (~lines 137–175) — parse the verification line into `verification`; throw `MalformedNativeStoryError` on absence/invalid type/empty target. Fail-closed.
- `plugins/crew/mcp-server/src/tools/write-native-story.ts` — add required `verification: z.object({ type: z.enum(["vitest","artifact"]), target: z.string().min(1) })` to each AC in `WriteNativeStoryInputSchema` (~lines 17–38); emit the verification line in `renderNativeStoryBody` (~lines 56–95). The existing pre-write round-trip through `parseNativeStory` (~line 160) then enforces the field for free.
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` (~lines 91–95) — add **optional** `verification` to the manifest AC object (additive; the schema is `strict`, so add the key rather than relying on passthrough).
- Any native story **fixtures** used by the writer/parser/scan tests — add a `verification` line to their ACs so they keep round-tripping (the writer now requires it). Grep the test tree for native-story fixtures before running the suite.

### Existing seams to wire into (do not reinvent)

- **Failure type:** reuse `MalformedNativeStoryError` from `plugins/crew/mcp-server/src/errors.ts` (`{ path, section, reason }`) — the parser already throws it; add the new reasons, don't invent a new error.
- **Round-trip enforcement:** `writeNativeStory` already re-parses the rendered body via `parseNativeStory` before persisting (~line 160). Once the parser requires `verification`, the writer is fail-closed automatically — no separate write-side check needed.
- **AC flow to manifest:** ACs are carried verbatim from `SourceStory.acceptance_criteria` into the manifest by `scan-sources.ts` (no transform). Confirm the new field flows through unchanged; add no mapping logic.
- **Kind enum precedent:** `kind` is already a strict `"integration" | "unit"` union enforced in the parser, the writer's Zod schema, and the manifest schema — mirror that exact three-site pattern for `verification.type`.

### Edge cases worth surfacing in dev/review

- **BMad regression is the top risk.** The `AC` type is shared. If `verification` were made *required* on the type (or on the manifest), every BMad-scanned story and persisted manifest would fail to parse — a system-wide break. The mitigation (and an AC): required only on the native write/parse path; optional on the shared type and manifest. The full suite (not just new tests) must stay green to prove this — that is the per-story ship gate.
- **Existing native fixtures** will now fail the writer's round-trip unless they gain a `verification` line. Updating them is in-scope (listed under Files touched), not a separate story.
- **Two markers on one AC** (both `vitest:` and `artifact:`): decide and pin in the parser test — recommend rejecting >1 verification line per AC in 10.1 (one AC, one check) and revisiting only if a real need appears. Keep it strict.
- **Target resolvability is NOT checked here.** A `vitest:` path that doesn't exist still parses in 10.1 (shape only). That is correct — resolvability is T0-6, Story 10.3. A reviewer might flag "the path isn't checked" — that is deliberate and scoped out.

### Risk + build notes (drain context)

- **Risk tier: medium.** Additive schema change to a core, shared, load-bearing format (parser/writer/manifest). Default-closed and additive, but the shared-`AC`-type blast radius is real — the medium bar (cold-dev sufficiency + the full-suite-green ship gate) applies.
- **Build/verify:** `pnpm --dir plugins/crew/mcp-server test` and `pnpm --dir plugins/crew/mcp-server build`, both green, plus `pnpm knip`. Deterministic; no network, no new deps.
- **Build-safety vs the live Epic 6 drain:** 10.1 does not touch `validate-against-discipline` or the standards surface, so it does not collide with the calibration drain (6.5–6.8). (10.3 does — gate that one behind the drain landing.)

### References

- [Source: _bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md §2–§4] — the schema-is-thinner-than-rubric gap; the enriched §3 schema (this story is the per-AC `verification` slice); T0-2/T0-6 ownership split (field+write here, validator in 10.3).
- [Source: _bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md §2] — Tier-0 T0-2 (verification marker per AC) and T0-6 (named check is runnable); the bug-class this kills.
- [Source: plugins/crew/mcp-server/src/adapters/adapter.ts §AC type ~L48, SourceStory ~L78-88] — the shared types to extend.
- [Source: plugins/crew/mcp-server/src/adapters/native/parse-native-story.ts ~L137-175] — AC parsing + `MalformedNativeStoryError` fail-closed.
- [Source: plugins/crew/mcp-server/src/tools/write-native-story.ts §WriteNativeStoryInputSchema ~L17-38, renderNativeStoryBody ~L56-95, round-trip ~L160] — write-side schema, serialization, and the existing round-trip guard.
- [Source: plugins/crew/mcp-server/src/schemas/execution-manifest.ts ~L91-95] — manifest AC schema (strict mode) to extend additively.
- [Source: plugins/crew/mcp-server/src/adapters/bmad/parse-bmad-story.ts ~L212-250] — BMad AC extraction (must keep compiling; verification stays undefined until 10.5).
- [Source: _bmad-output/implementation-artifacts/9-1-readiness-brake-and-minimal-intake-cockpit.md] — gold-standard story-spec format, AC-marker shape, and the additive/default-closed ship-gate discipline mirrored here.
