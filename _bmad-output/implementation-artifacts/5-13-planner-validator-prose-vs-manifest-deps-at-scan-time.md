# Story 5.13: Planner-validator — prose vs manifest deps at scan time (+ typed `blocked_by`)

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **`/crew:scan` to refuse to write a `to-do/` manifest when the `depends_on` set drifts from the dependencies declared in the spec's prose, AND I want `blocked_by` to be a typed Zod enum rather than a free string**,
so that **planner-author mistakes are caught at scan time (before claim time, when they are cheap to fix), and `blocked/` manifests can be programmatically routed — each typed reason carries an operator hint instead of being re-surfaced as the inscrutable generic "clear blocked_by and re-run" prose**.

### What this story is, in one sentence

Close the last functional pre-dogfood gap from the pre-Epic-5 enhancement plan: (1) extract dep references from the spec body using a small, conservative set of patterns and refuse the scan write when those references drift from the manifest's `depends_on`; (2) turn `blocked_by` from a `union(literals, z.string())` fallback into a closed `z.enum([...])` of thirteen typed members; (3) update `/crew:start`'s blocked-recovery surface to render a per-case operator hint keyed off the typed value.

### Why this is independent of 5.10 / 5.11 / 5.12

5.10 / 5.11 / 5.12 address mid-cycle resilience (transcript persistence, orphan recovery, MCP reap). 5.13 addresses planner-time correctness and the blocked-state recovery UX. The four ship in any order; 5.13 happens to depend on 5.11's `blockOrphanNoTranscript` only in that the migration table includes the `orphan-no-transcript` literal that path already writes — the enum just adopts it. No code in 5.13 calls into 5.10 / 5.11 / 5.12 paths.

### What this story does NOT

- (a) Add a generic prose-vs-manifest validator for every field. The validator is scoped to `depends_on` only.
- (b) Re-author or re-format any spec body to make dep extraction easier. The patterns are chosen to match what authors already write in 5.10 / 5.11 / 5.12.
- (c) Add new `blocked_by` reasons beyond the thirteen members listed in AC2. Every existing writer must map cleanly; if one does not, the spec author flagged that for promotion to AC discussion (see Migration table below — all current writers map).
- (d) Migrate `/crew:scan`'s rendered output away from its current structured-text shape (see `renderScanResult` in `scan-sources.ts`). A new `blocked:` summary line line for `deps-drift` is added; the existing block/skipped/created/updated lines stay.
- (e) Change the runtime semantics of any existing `blocked_by` writer beyond replacing the string literal with the typed value (the Zod boundary catches future drift; the call sites do not change).

---

## Acceptance Criteria

<!--
AC1 (user-surface) judgement: `/crew:scan` is an operator-invoked slash command and its rendered output is the natural verification path. A `[deps-drift]` line printed to the operator's chat (via `renderScanResult`) is the observable surface. Tagging.

AC2 not user-surface: schema-only change; no operator surface beyond AC3.

AC3 (user-surface) judgement: explicitly touches `/crew:start`'s blocked-recovery output (operator-observable TUI text per memory `project_blocked_recovery_prose_lies`). Tagging.

AC4 / AC5: vitest only, do not tag.
-->

**AC1 (user-surface):**
**Given** an operator running `/crew:scan` against a target repo containing a source spec whose prose declares a dep that the manifest's `depends_on` omits (or vice versa — manifest declares a dep that prose does not),
**When** the scan runs and `scanSources` extracts dep references from the spec body using **exactly two** patterns: (i) lines matching `/^Depends on:\s*(.+)$/m` in the spec body (comma- or space-separated ref list following the colon), and (ii) blockquote lines matching `/^>\s*Depends on (?:Story\s+)?(.+)$/m` (the `> Depends on Story X.Y` convention used in 5.10 / 5.11 / 5.12),
**Then** the scan refuses to write the `to-do/` manifest for that ref, writes a `blocked/` manifest with `blocked_by: "deps-drift"` and a `discipline_violations` entry whose `code` is `deps-drift-prose-vs-manifest` carrying the symmetric-difference detail, the rendered result string carries a new line `[deps-drift] <ref> — prose: {refA, refB}, manifest: {refA}` (one line per drifted ref), and that line appears in the operator's terminal output verbatim. _(Closes pre-Epic-5 enhancement plan item.)_

<!--
Rationale for choosing patterns (i) + (ii) only:

- `Depends on:` (pattern i) — explicit, unambiguous; matches what BMad-style and native specs already use for declared dependencies.
- `> Depends on Story X.Y` (pattern ii) — verbatim convention from Stories 5.10/5.11/5.12 epic-block source notes. Author-stable.

Rejected candidates and reasoning:

- `[[story-key]]` cross-refs — too noisy. Memory linking (see plugin memory conventions) uses these for navigation, not dependency declaration. Would generate false positives on every linked memory.
- `## Dependencies` H2 headers — the native adapter's `parseDependencies` already reads this section for `depends_on` (see `parse-native-story.ts:84` and `parseDependencies` at line 181). Re-extracting it would just re-read the same source the manifest was built from, producing no drift signal. The whole point of AC1 is to catch drift between the *spec body's prose* (what a human author wrote) and the *manifest's depends_on* (what the adapter parsed) — extracting from the same source defeats this.
- AC-text story-key regex (`\d+-\d+[a-z]?-[a-z0-9-]+`) — too lossy. Story keys are mentioned in AC text for context ("see Story 5.10 for transcript shape") without implying a build-time dep. False positives would dominate.

Ref-token grammar inside (i) and (ii): a ref token is matched by either `^native:[0-9A-HJKMNP-TV-Z]{26}$` (native ULID) or `^bmad:\d+\.\d+$` (BMad story id) — same as `NATIVE_REF_RE` / `BMAD_REF_RE` in `parse-native-story.ts:178-179`. Tokens that fail both regexes are silently dropped in v1; a v2 may add a stderr warning (see Implementation Strategy § Edge cases). Malformed tokens do NOT trigger drift on their own.
-->

**AC2:**
**Given** the `ExecutionManifestSchema` in `plugins/crew/mcp-server/src/schemas/execution-manifest.ts`,
**When** the schema is parsed,
**Then** `blocked_by` is a closed `z.enum([...])` with exactly these thirteen members and no `z.string()` fallback (the closed enum required by this story, audit-derived from live writers + one reserved schema member; `deps-drift` is the new member this story introduces): `handoff-grammar`, `gh-defer`, `gh-retry`, `gh-needs-human`, `reviewer-no-session-result`, `reviewer-verdict-needs-changes`, `reviewer-verdict-blocked`, `routing-failure`, `routing-self-yield`, `planning-discipline`, `orphan-no-transcript`, `reviewer-grammar`, `deps-drift`. Any manifest write attempting a value outside this set fails the Zod parse at the schema boundary with the canonical Zod enum error.

<!--
Migration table — every current writer maps cleanly to one of the thirteen members.

Note on enum count: the epic block at Story 5.1 lists nine members. The spec author's codebase audit found ten live writers + one reserved schema member (`reviewer-grammar`, retained from Story 4.3), and this story adds one new writer (`deps-drift`) — totalling thirteen members. The spec's enum count diverges from the epic by intent (audit-driven): `source-drift` is dropped (no live writer), and `gh-retry`, `routing-failure`, `routing-self-yield`, `planning-discipline`, and `reviewer-grammar` are added based on live or schema-reserved writers.

| File | Line | Current value | Target enum member | Notes |
|------|------|---------------|---------------------|-------|
| `tools/process-dev-transcript.ts` | 122 | `gh-${errorClass}` (defer/retry/needs-human) | `gh-defer`, `gh-retry`, `gh-needs-human` | All three `errorClass` members are in the v1 enum. |
| `tools/process-dev-transcript.ts` | 152 | `handoff-grammar` | `handoff-grammar` | exact match. |
| `tools/process-reviewer-transcript.ts` | 142 | `reviewer-no-session-result` | `reviewer-no-session-result` | exact match. |
| `tools/process-reviewer-transcript.ts` | 171 | `reviewer-verdict-needs-changes` | `reviewer-verdict-needs-changes` | exact match. |
| `tools/process-reviewer-transcript.ts` | 187 | `reviewer-verdict-blocked` | `reviewer-verdict-blocked` | exact match. |
| `tools/process-reviewer-yield.ts` | 131 | `routing-failure` | `routing-failure` | added to the v1 enum based on the live writer. |
| `tools/process-reviewer-yield.ts` | 154 | `routing-self-yield` | `routing-self-yield` | added to the v1 enum based on the live writer. |
| `tools/scan-sources.ts` | 331, 385 | `planning-discipline` | `planning-discipline` | added to the v1 enum based on the live writer. |
| `tools/block-orphan-no-transcript.ts` | 81 | `orphan-no-transcript` | `orphan-no-transcript` | exact match (Story 5.11's existing path; the epic block's AC2 text explicitly says this entry "rides on 5.11's existing `blockOrphanNoTranscript` path"). |
| (Story 5.13 NEW) | new line in `scan-sources.ts` | `deps-drift` | `deps-drift` | new writer added by this story. |

§ Notes on the enum membership decision:

The v1 enum has **thirteen members**, derived from a codebase audit: ten live writers + one reserved schema literal (`reviewer-grammar`, retained from Story 4.3) + one new writer added by this story (`deps-drift`) + the `gh-retry` member (the third `errorClass` value at `process-dev-transcript.ts:122`). The literal `source-drift` is removed (no live writer; no test). The dev agent MUST NOT drop any existing writer's literal; the dev agent MUST NOT add members beyond the thirteen listed.

**Document the reasoning verbatim in the schema's JSDoc** so the next planner knows the v1 enum is closed and any new reason needs a deliberate schema-change story, not a free-string sneak-in. (This is the load-bearing change — see project memory `feedback_default_to_deterministic_seams`: load-bearing decisions live in tool-written artefacts, not LLM prose. The closed enum is the deterministic seam.)

Existing test fixtures that reference `blocked_by` — every match found by grep `-rn "blocked_by"` under `__tests__/`:

| File | Lines | Current value(s) | Target enum member(s) |
|------|------|------|------|
| `schemas/__tests__/execution-manifest.test.ts` | 90, 98, 106, 114, 122, 130 | `handoff-grammar`, `reviewer-grammar`, `planning-discipline`, `source-drift`, `some-future-value`, undefined | `handoff-grammar`, `reviewer-grammar` (retained in the v1 enum — see Note below), `planning-discipline`, **`source-drift` removed** (drop this fixture line entirely), `some-future-value` will now fail Zod (this is the test of the enum's closedness; flip the assertion to `.toThrow`), undefined |
| `tools/__tests__/gh-recoverable.integration.test.ts` | 283, 329, 373, 410, 529, 530, 554 | `gh-defer`, `gh-needs-human`, `gh-retry`, undefined, `handoff-grammar`, n/a (regex), `gh-defer` | exact matches; all already in enum. |
| `tools/__tests__/process-dev-transcript.test.ts` | 213, 237, 261, 280, 331, 353, 375, 396, 397, 417, 422, 429, 443 | undefined, `handoff-grammar` (multi), `gh-defer`, `gh-retry`, `gh-needs-human`, regex match | exact matches; all already in enum. |
| `tools/__tests__/block-orphan-no-transcript.test.ts` | 5, 77, 81 | `orphan-no-transcript` (comments + assertions) | exact match. |
| `tools/__tests__/process-reviewer-transcript.test.ts` | (search needed) | `reviewer-verdict-needs-changes`, `reviewer-verdict-blocked`, `reviewer-no-session-result` | exact matches (verify in dev). |
| `tools/__tests__/process-reviewer-yield.test.ts` | (search needed) | `routing-failure`, `routing-self-yield` | exact matches (verify in dev). |
| `tools/__tests__/hand-edit-allowance.integration.test.ts` | (search needed) | various | verify; default-map to known members. |
| `tools/__tests__/inner-cycle.integration.test.ts` | (search needed) | various | verify; default-map to known members. |
| `__tests__/orphan-recovery.test.ts` | 281, 297 | `orphan-no-transcript` (assertions) | exact match. |
| `__tests__/operator-smoke-helpers/ac5-rubber-stamp.smoke.test.ts` | 377 | `reviewer-verdict-needs-changes` (comment) | exact match. |
| `__tests__/operator-smoke-helpers/ac5-4-8-apply-reviewer-labels.smoke.test.ts` | 398, 400 | `reviewer-verdict-needs-changes` | exact match. |
| `__tests__/operator-smoke-helpers/ac5-4-6b-post-reviewer-comments.smoke.test.ts` | 504, 518, 520 | `reviewer-verdict-needs-changes` | exact match. |
| `skills/__tests__/start-skill-content.test.ts` | 165 | `handoff-grammar` (asserts skill text contains this) | exact match. |

Note: `reviewer-grammar` appears in the existing schema literal-union (line 135) and in one test (`execution-manifest.test.ts:96-101`) but has NO live writer. **Decision:** keep `reviewer-grammar` in the enum as a reserved member — it was deliberately added in Story 4.3 as part of the handoff/reviewer grammar pair. Removing it would mean re-removing a literal the planner of 4.3 already justified, and the test for it stays valid as a forward-compat reservation. The final v1 enum is **thirteen members**: `handoff-grammar`, `gh-defer`, `gh-retry`, `gh-needs-human`, `reviewer-no-session-result`, `reviewer-verdict-needs-changes`, `reviewer-verdict-blocked`, `routing-failure`, `routing-self-yield`, `planning-discipline`, `orphan-no-transcript`, `reviewer-grammar` (reserved), `deps-drift` (new).

Summary: **10 live writers** identified (process-dev-transcript ×2, process-reviewer-transcript ×3, process-reviewer-yield ×2, scan-sources `planning-discipline` ×1 site, block-orphan-no-transcript ×1) + **1 reserved schema member** (`reviewer-grammar`) + **1 NEW writer** added by this story (scan-sources `deps-drift`) = **13 enum members** total. **12 test files** carry `blocked_by` literals to migrate (per the grep audit above); the dev agent re-greps to confirm zero free-string survivors before merging.
-->

**AC3 (user-surface):**
**Given** `/crew:start` encountering a `blocked/` manifest in its outer-loop blocked-recovery surface (per project memory `project_blocked_recovery_prose_lies`),
**When** the start skill renders the per-case operator hint for that manifest,
**Then** the rendered hint is keyed off the typed `blocked_by` value (case-of-thirteen) — no generic `clear blocked_by and re-run` fallback for known reasons — and each enum member resolves to a verbatim hint of the form `[<enum-member>] <ref> — <operator action>` (e.g. `[deps-drift] <ref> — fix the spec's "Depends on:" prose or the source story's ## Dependencies section, then re-run /crew:scan`). The thirteen hints are written into a single exported `BLOCKED_BY_HINTS: Readonly<Record<BlockedBy, string>>` in `mcp-server/src/lib/blocked-by-hints.ts`. The `/crew:start` SKILL.md is updated only to reference this seam via tool return; the hint text itself lives in the tool-written artefact (deterministic seam — per memory `feedback_default_to_deterministic_seams`).

<!--
Rationale for AC3 user-surface tag: the rendered hint appears in the operator's chat output (TUI) when /crew:start hits a blocked manifest. The text is directly observable per project memory `project_blocked_recovery_prose_lies` — the whole point of this AC is that the OLD generic prose was a paper-only fix; the NEW typed hints are the load-bearing one. Tagging.
-->

**AC4 (integration):**
**Given** the vitest harness for `scan-sources` and `execution-manifest`,
**When** the suite runs,
**Then** vitest covers: (a) a synthetic spec whose prose declares one dep ref the manifest omits → `scanSources` writes the manifest to `blocked/` with `blocked_by: "deps-drift"` AND the rendered result string contains `[deps-drift] <ref> — prose: {...}, manifest: {...}`; (b) a `blocked_by` write with a value outside the enum (e.g. the literal string `"some-future-value"`) → Zod parse throws; (c) for every one of the thirteen enum members, `BLOCKED_BY_HINTS[member]` returns a non-empty string starting with `[<member>] ` and not equal to the generic legacy phrase `clear blocked_by and re-run`. _(integration)_

**AC5 (integration):**
**Given** the codebase post-migration,
**When** the dev agent runs `pnpm -r test` AND a separate `grep -rn 'blocked_by:' plugins/crew/mcp-server/src/` ignoring `.d.ts` and JSDoc-comment lines,
**Then** every test passes AND every `blocked_by` string literal in non-test source maps to one of the thirteen enum members. Tests that previously asserted free-string fallback behaviour (the `"some-future-value"` test at `execution-manifest.test.ts:120-126`) are flipped to assert the Zod throw. No test references a `blocked_by` value not in the enum. _(integration)_

---

## Implementation Strategy

### Files touched

**NEW:**

- `plugins/crew/mcp-server/src/lib/extract-dep-refs.ts` — pure function `extractDepRefsFromSpecBody(body: string): Set<string>`. Reads patterns (i) `^Depends on:\s*(.+)$/gm` and (ii) `^>\s*Depends on (?:Story\s+)?(.+)$/gm`. Splits each capture by comma or whitespace; trims; filters tokens against `NATIVE_REF_RE` / `BMAD_REF_RE` (re-exported or duplicated from `parse-native-story.ts`); returns the union as a `Set`. Tokens that fail both ref regexes are silently dropped (NOT warned to stderr in v1; see Edge cases). No I/O.
- `plugins/crew/mcp-server/src/lib/blocked-by-hints.ts` — exports `BlockedBy` (the union type derived from the Zod enum) and `BLOCKED_BY_HINTS: Readonly<Record<BlockedBy, string>>`. Each hint is a single-line string of the form `[<member>] {ref} — {operator-action}` where `{ref}` is a literal placeholder the caller substitutes at render time.

**MODIFY:**

- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — replace the `blocked_by` union (lines 130-138) with `z.enum([...])` of thirteen members; export the inferred type `BlockedBy = z.infer<...>`. Update JSDoc to enumerate the thirteen members and link to `_bmad-output/implementation-artifacts/5-13-*.md § AC2` for the closed-enum rationale.
- `plugins/crew/mcp-server/src/tools/scan-sources.ts` — within the `currentState === null` branch (today's discipline-violation path lives at line 362-404), insert a new prior gate: extract prose refs from `story.raw_path`'s contents (re-read the source file's bytes; the parsed `SourceStory` does not retain the raw body — see § Edge cases for the no-double-read decision). Compute symmetric difference vs `story.depends_on`. If non-empty: write a `blocked/` manifest with `blocked_by: "deps-drift"` and `discipline_violations: [{ code: "deps-drift-prose-vs-manifest", field: "depends_on", detail: <human description of the drift set> }]`. Append the ref to `result.blockedRefs`. Add a new field `depsDriftRefs: Array<{ ref: string; proseRefs: string[]; manifestRefs: string[] }>` to `ScanResult` (a typed addition next to `blockedRefs`). Update `renderScanResult` to emit one `[deps-drift] <ref> — prose: {...}, manifest: {...}` line per entry, immediately above the existing `blocked:` summary line. Also runs in the existing `currentState === "blocked"` re-evaluation branch (line 284-355) symmetrically — if the source's drift changes from `planning-discipline` to `deps-drift` or vice versa, the blocked manifest is rewritten with the new typed reason. The `deps-drift` gate runs **before** `validateAgainstDiscipline` (a drift is a planner-author mistake; surfacing it before discipline gives the operator the more actionable signal first).
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (lines 122, 152) — no semantic change; the literal strings already match enum members. Verify post-Zod that the existing `blocked_by: \`gh-${errorClass}\`` template expression produces only `gh-defer | gh-retry | gh-needs-human` (the only three `errorClass` values) — if a future `errorClass` value were added, Zod would catch it at write time.
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (lines 142, 171, 187) — no semantic change.
- `plugins/crew/mcp-server/src/tools/process-reviewer-yield.ts` (lines 131, 154) — no semantic change.
- `plugins/crew/mcp-server/src/tools/block-orphan-no-transcript.ts` (line 81) — no semantic change.
- `plugins/crew/skills/start/SKILL.md` — the failure-mode bullets at lines 185-191, 167 currently include the legacy free-text `clear blocked_by and re-run` phrases. Replace each with a one-line cross-reference to `BLOCKED_BY_HINTS[<member>]` (e.g. "Recovery hint: see `BLOCKED_BY_HINTS["reviewer-verdict-needs-changes"]`."). The hint text itself stays in the tool artefact, not in the SKILL.md (deterministic seam).
- All `__tests__/**` files in the Migration table (twelve files) — replace any free-string `blocked_by:` literal with a typed enum member or convert the existing "string fallback" assertion to a Zod-throw assertion.

### Sequencing

1. **Add the enum + new lib first** (no behaviour change yet):
   - `extract-dep-refs.ts` + its unit tests (table-driven over the patterns + ref grammar).
   - `blocked-by-hints.ts` + a unit test asserting every enum member has a hint.
2. **Migrate the schema:** `execution-manifest.ts` enum change. Run `pnpm -r test`; identify and update every test that fails because of the closed-enum change. This batch is mechanical — most diffs are zero-semantic-shift literal swaps; the only behavioural-shift is the `some-future-value` test which flips from "string fallback passes" to "Zod throws".
3. **Wire the scan-sources gate:** add the `extractDepRefsFromSpecBody` call + drift comparison + `blocked/` write + `[deps-drift]` render. Integration test in `tools/__tests__/scan-sources.integration.test.ts` (or `tools/__tests__/scan-sources.test.ts` — whichever already exists; dev agent reads the existing test file conventions before writing).
4. **Surface `BLOCKED_BY_HINTS` in `/crew:start`:** thread the lookup through whatever prose path the SKILL.md uses today to render the blocked-recovery line; if no current TS seam exists, add a `renderBlockedRecoveryHint(manifest: ExecutionManifest): string` helper alongside `BLOCKED_BY_HINTS` and have the skill prose reference its return shape verbatim.

### Edge cases

- **No-double-read decision (deps extraction):** `scan-sources` already reads `story.raw_path` indirectly via the adapter's `readSourceStory`. The adapter returns a `SourceStory` with parsed fields but does NOT retain the raw body. To extract prose refs, `scan-sources.ts` re-reads `story.raw_path` once with `fs.readFile(story.raw_path, "utf8")` inside the new drift-gate. This is the simplest seam — extending the adapter's return shape to include the raw body would couple every adapter to a v1-specific need. The double-read costs are negligible (specs are <100KB; scan is operator-triggered).
- **Manifest declares MORE than prose (prose is the subset):** still a drift. The AC1 surface text is "symmetric-difference" — both directions are violations. Example: prose says `Depends on: native:01HZABC...`, manifest's parsed `depends_on` is `[native:01HZABC..., native:01HZDEF...]` (the extra ref came from a `## Dependencies` H2 the prose did not mirror). Rendered line: `[deps-drift] <ref> — prose: {native:01HZABC...}, manifest: {native:01HZABC..., native:01HZDEF...}`.
- **No prose lines and no manifest deps:** both sets empty → no drift → scan proceeds normally (writes to `to-do/`).
- **Prose declares a malformed ref (matches the `Depends on:` line but not `NATIVE_REF_RE`/`BMAD_REF_RE`):** the token is silently dropped from the extracted set; if the dropped token was the only thing in the prose, the prose set is empty for this comparison purpose. The dev agent MAY add a stderr warning in v2; v1 prioritises false-positive avoidance over warning chatter.
- **Same ref appears in both pattern (i) and (ii):** deduplicate via `Set`.
- **Mixed adapter source spec (BMad spec referencing a `native:` ref or vice versa):** the ref grammar allows both prefixes regardless of the active adapter. The drift gate does NOT validate that prose-cited deps point to refs from the same adapter; that's a separate question, deferred.
- **Re-scan of an already-`deps-drift`-blocked story (already-in-blocked branch):** `scan-sources.ts:284-355` already re-evaluates the source hash; the new code path re-evaluates the drift after the hash check. If the operator fixed the drift (prose + manifest now agree), promote from `blocked/` to `to-do/` (the existing `disciplineResult` promotion path generalises to "any-prior-block-reason"). If the drift remains, rewrite the `blocked/` manifest with the updated source hash (current behaviour).
- **Re-scan of a `planning-discipline`-blocked story where the operator also introduced a drift:** the discipline violation takes precedence in v1 (it runs first today). The dev agent SHOULD reverse the order so `deps-drift` runs first (a drift is a more actionable signal) — see Sequencing § 3.

### What MUST NOT be touched

- The `/crew:scan` SKILL.md does NOT learn the new render shape; `renderScanResult` does all the work and the skill prose continues to call it verbatim. (Per memory `feedback_prose_mut_steps_need_seam` — prose-level mutating steps need a tool seam; AC1's render is the seam.)
- The runtime semantics of `process-dev-transcript`, `process-reviewer-transcript`, `process-reviewer-yield`, and `block-orphan-no-transcript` do not change. Only the schema does.
- No new MCP tool is registered. The drift-gate is internal to `scan-sources`.
- `plugins/crew/mcp-server/dist/` is the committed build output. Per project CLAUDE.md, the dev agent rebuilds and commits `dist/` in the same change.

### Build artefacts (`dist/` discipline)

After any change in `plugins/crew/mcp-server/src/`, the dev agent MUST run `pnpm -r build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git".

---

## Test Plan

### Unit tests

- `lib/__tests__/extract-dep-refs.test.ts` — table-driven, covering:
  - empty body → empty set
  - single `Depends on: native:<ULID>` line → set with one element
  - `> Depends on Story 5.10` blockquote → set containing `bmad:5.10` (per the § Edge case → blockquote ref tokens section below: `5.10` matching `^\d+\.\d+$` is normalised to `bmad:5.10`; native ULIDs would have to be cited verbatim as `> Depends on native:01HZ...`).
  - multiple lines, mixed patterns, with dedupe
  - malformed refs silently dropped
  - case sensitivity preserved (the regex is anchored on `Depends on:` exactly)
- `lib/__tests__/blocked-by-hints.test.ts` — asserts every enum member has a hint; every hint starts with `[<member>]`; no hint equals the legacy `clear blocked_by and re-run` text.
- `schemas/__tests__/execution-manifest.test.ts` — extend with: every enum member parses successfully; out-of-enum value throws ZodError with the canonical `invalid_enum_value` shape.

### Integration tests

- `tools/__tests__/scan-sources.deps-drift.test.ts` (NEW):
  - (a) prose declares `native:01HZ...A` + manifest `depends_on: []` → scan writes `blocked/` with `blocked_by: "deps-drift"` + render contains `[deps-drift] <ref> — prose: {native:01HZ...A}, manifest: {}`.
  - (b) prose declares `native:01HZ...A` + manifest `depends_on: [native:01HZ...A]` → scan writes `to-do/` (no drift).
  - (c) prose declares `native:01HZ...A` + manifest `depends_on: [native:01HZ...A, native:01HZ...B]` → scan writes `blocked/` (symmetric drift).
  - (d) operator fixes the spec body so prose + manifest agree → re-scan promotes from `blocked/` to `to-do/`.
- AC4(c): `lib/__tests__/blocked-by-hints.test.ts` covers the "no generic phrase" assertion across all thirteen members.

### Edge case → blockquote ref tokens

The `> Depends on Story 5.10` convention used in 5.10/5.11/5.12 source-note blockquotes cites the **story key in human-readable form** (e.g. `5.10`, `5.11`), NOT the manifest ref form (`native:<ULID>` or `bmad:5.10`). For 5.13's v1 drift gate, the author's reasonable call: pattern (ii)'s captures are first parsed as `bmad:<id>` if they match `^\d+\.\d+$` (so `5.10` → `bmad:5.10`); native ULIDs would have to be cited verbatim (`> Depends on native:01HZ...`). This keeps the gate useful for the BMad-style refs the convention was designed for, and avoids an unwinnable disambiguation problem (5.10 the story key vs `native:01HZ...` the ref).

### Smoke test (operator-driven)

- AC1 user-surface verification: a `/crew:scan` invocation in `tools/__tests__/scan-sources.deps-drift.test.ts` exercises the rendered output (the integration test drives the same code path the operator would). This is `automated_e2e_verified` evidence per `plugins/crew/docs/user-surface-acs.md § How the gate uses this`.
- AC3 user-surface verification: a `/crew:start` invocation against a fixture containing a `blocked/` manifest for each enum member, asserting the rendered hint text. Driven by an integration test in `__tests__/start-skill-blocked-recovery.test.ts` (or the existing `start-skill-content.test.ts`).

---

## Developer Context

### Why this story exists (and why now)

Per the epic block: "Added 2026-05-27 from the pre-Epic-5 enhancement plan. Source: postmortem § L4 + Epic 4 retro § Carry-forward remediation (typed `blocked_by`). Independent of 5.10 / 5.11 / 5.12. Closes the last functional pre-dogfood gap."

The story is one of three remaining items before dogfooding (`/crew:start`) can resume per CLAUDE.md § "Dogfood paused until L1 defects fixed". The other two (5.10 transcript persistence, 5.11 orphan recovery) are already in `review`/`done` status per the sprint-status file; 5.13 is the third.

Two memory entries are directly load-bearing:

- `feedback_planner_prose_must_match_manifest` — "prose declarations don't gate behaviour; only manifest fields do. Validate at scan time." This story IS the validation seam that memory describes.
- `project_blocked_recovery_prose_lies` — "/crew:start tells operators to clear blocked_by and re-run, but the claim loop only scans to-do/; real fix needs file move + status flip + claimed_by removal." AC3 is the recovery-text fix; the orchestrator-side claim-loop fix is a separate concern (the blocked → to-do file move on `blocked_by` clear is already in `scan-sources.ts:300-316` and is correct).

### Previous-story intelligence

- **Story 5.11** (`5-11-orphan-recovery-branch-in-crew-start.md`) added the `block-orphan-no-transcript.ts` tool that writes `blocked_by: "orphan-no-transcript"`. AC2 of this story preserves that literal verbatim. Re-read `block-orphan-no-transcript.ts:81` to confirm before writing the enum.
- **Story 4.3** (handoff-grammar + reviewer-grammar) added the `handoff-grammar` and `reviewer-grammar` literals to the schema. Both are in the v1 enum.
- **Story 4.5** (`gh-error-map`) defined the `gh-defer | gh-retry | gh-needs-human` triad. All three are in the v1 enum (the Migration table § Notes above explains why the v1 enum has thirteen members rather than the nine listed in the epic block — the codebase audit found extra live writers + `reviewer-grammar` as a reserved member).

### Project memories cited

- `feedback_default_to_deterministic_seams` — load-bearing decisions live in tool-written artefacts, not LLM prose. The closed Zod enum + `BLOCKED_BY_HINTS` table are both deterministic seams. AC3's hint text deliberately lives in the TS file, not in `SKILL.md`.
- `feedback_prose_mut_steps_need_seam` — prose-level mutating steps need a tool seam. The `renderScanResult` extension (new `[deps-drift]` line) is the seam; the `/crew:scan` skill continues to print its return value verbatim.
- `feedback_planner_prose_must_match_manifest` — the gate AC1 codifies.
- `project_blocked_recovery_prose_lies` — AC3 addresses the recovery-text side.

### Recent commit context (last 5)

- `25926a3 feat(5): orphan-recovery branch in /crew:start (#157)` — 5.11; introduced `blockOrphanNoTranscript` writer + `orphan-no-transcript` literal.
- `1699de3 feat(1): /crew:smoke harness wrapper skill (#156)` — unrelated to 5.13.
- `537a2a8 feat(1): ship-story base-branch override and worktree-spec fallback (#155)` — unrelated.
- `9cee1f6 chore(1.12): add story block + reopen epic-1 for substrate follow-up` — unrelated.
- `761b9ef docs(epic-4): add retrospective + mark sprint-status done` — referenced in source notes (Epic 4 retro § Carry-forward remediation cites typed `blocked_by`).

---

## Definition of Done

- [ ] `extract-dep-refs.ts` + tests land; unit-test coverage for all six edge cases in § Test Plan.
- [ ] `blocked-by-hints.ts` + test land; every enum member has a non-generic hint.
- [ ] `execution-manifest.ts` `blocked_by` is `z.enum([...])` of thirteen members; JSDoc updated; type `BlockedBy` exported.
- [ ] `scan-sources.ts` writes `blocked/` with `blocked_by: "deps-drift"` on prose/manifest drift; `renderScanResult` emits `[deps-drift]` lines; integration test covers (a)/(b)/(c)/(d) above.
- [ ] All twelve test files in the Migration table audited; no free-string `blocked_by` literal survives in `__tests__/**`; the `some-future-value` test flips to assert Zod throw.
- [ ] `/crew:start` SKILL.md blocked-recovery surface references `BLOCKED_BY_HINTS` (or its rendered output) rather than inlining the legacy `clear blocked_by and re-run` text.
- [ ] `pnpm -r build` clean; `plugins/crew/mcp-server/dist/` committed in the same change.
- [ ] `pnpm -r test` passes (including the renumbered `blocked_by` assertions).
- [ ] AC1's user-surface verification: integration test for `scan-sources.deps-drift` exercises the rendered `[deps-drift]` line.
- [ ] AC3's user-surface verification: integration test for `/crew:start` blocked-recovery against fixtures for each enum member.

### Completion note

Ultimate context engine analysis completed — comprehensive developer guide created.
