# Story 5.1: `block-story` MCP tool and `blocked_by` taxonomy

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a generalised `block-story` MCP tool that atomically moves any `in-progress/` manifest to `blocked/` with a typed `blocked_by` reason, AND a reconciled closed `blocked_by` enum that covers both Story 5.13's existing thirteen members and the three new reasons named in this epic block**,
so that **downstream surfaces (orchestration, retros, blocked-recovery hints) can route every block reason by a single typed enum, and so that all current and future block writers (dev cycle, reviewer cycle, scan, orphan-recovery, and the new `user` and `dep-not-built` paths) go through one canonical tool seam instead of accreting per-reason variants**.

### What this story is, in one sentence

Generalise Story 5.11's specialised `blockOrphanNoTranscript` into a single `blockStory` MCP tool that takes `{ targetRepoRoot, ref, blocked_by, detail? }`, atomically moves the manifest from `in-progress/` to `blocked/`, stamps the typed `blocked_by`, and returns the verbatim chat log line — AND extend Story 5.13's thirteen-member closed `blocked_by` enum with the three additional members named in this epic block (`source-drift`, `dep-not-built`, `user`), bringing the v2 enum to **sixteen members** with corresponding hints in `BLOCKED_BY_HINTS`.

### Why this story exists (and how it relates to 5.13)

Story 5.13 has **already shipped** the closed `blocked_by` Zod enum, the `BLOCKED_BY_HINTS` table, and the `/crew:start` blocked-recovery surface. This story does NOT greenfield those artefacts — it **reshapes** them:

1. The Zod enum (`plugins/crew/mcp-server/src/schemas/execution-manifest.ts:153-169`) currently has thirteen members. This story adds three (`source-drift`, `dep-not-built`, `user`) → **sixteen total**.
2. `BLOCKED_BY_HINTS` (`plugins/crew/mcp-server/src/lib/blocked-by-hints.ts:27-66`) currently has thirteen entries. This story adds three matching hints.
3. The epic block at Story 5.1 lists nine members. The reconciled enum is the **union** of (5.13's 13) ∪ (5.1's 9 mapped) — see § 5.13 ↔ 5.1 reconciliation table below.
4. Currently, the only "block-this-manifest" MCP tool is `blockOrphanNoTranscript` (Story 5.11) — specialised to the no-transcript orphan path. This story extracts the move-and-stamp pattern into a generalised `blockStory` tool. `blockOrphanNoTranscript` remains as a thin wrapper that calls `blockStory({ blocked_by: "orphan-no-transcript", … })` so 5.11's call sites and tests do not break.

### 5.13 ↔ 5.1 reconciliation table

| Epic 5.1 epic-block name | Story 5.13 existing enum member | Decision |
|--------------------------|----------------------------------|----------|
| `planning-discipline`    | `planning-discipline`            | exact match — keep |
| `routing-failure`        | `routing-failure`                | exact match — keep |
| `gh-defer`               | `gh-defer`                       | exact match — keep |
| `gh-retry`               | `gh-retry`                       | exact match — keep |
| `gh-needs-human`         | `gh-needs-human`                 | exact match — keep |
| `reviewer-grammar-error` | `reviewer-grammar`               | **rename: adopt 5.13's `reviewer-grammar`** — no semantic difference; avoiding churn on the already-reserved literal that 5.13's audit kept |
| `source-drift`           | (none — 5.13 explicitly dropped) | **NEW member**: re-add. Reason: future writers in this epic (5.4 stuck-story / 5.16 drift-on-refresh evolution) may need to block-on-drift after claim; 5.1 reserves the literal even though there is no live writer in this story |
| `dep-not-built`          | (none)                           | **NEW member**: a manifest cannot proceed because at least one `depends_on` ref is not in `done/`. No live writer in this story — reserved for the orchestration loop (Story 5.3 / 5.4 evolution) and for operator-invoked `block-story(ref, "dep-not-built")` calls |
| `user`                   | (none)                           | **NEW member**: operator-invoked block via `block-story(ref, "user")` — covers any human reason that does not fit a typed category. Replaces the legacy "I'll just edit the file" path with a tool call |

The 9 names reconciled in this table join Story 5.13's existing 13 members; 6 of the 9 already exist in 5.13's set (deduped), netting +3 new members → 16 total.

**Resulting v2 enum — sixteen members:**

```
handoff-grammar
gh-defer
gh-retry
gh-needs-human
reviewer-no-session-result
reviewer-verdict-needs-changes
reviewer-verdict-blocked
routing-failure
routing-self-yield
planning-discipline
orphan-no-transcript
reviewer-grammar
deps-drift
source-drift     (NEW — Story 5.1)
dep-not-built    (NEW — Story 5.1)
user             (NEW — Story 5.1)
```

The dev agent MUST NOT drop any existing member; the dev agent MUST NOT add members beyond the sixteen listed.

### Why this is independent of 5.2 / 5.3 / 5.4

5.1 lays the seam (the tool + the enum). 5.2 adds heartbeats; 5.3 adds the orchestration polling loop; 5.4 adds stuck-story detection. Each of those later stories writes through `blockStory(…)` with a typed reason — but none of them are blockers for 5.1's substrate ship. Order can flex.

### What this story does NOT

- (a) Add live writers for `source-drift`, `dep-not-built`, or `user` beyond the enum + hint. The members are **reserved** for orchestration paths in later Epic 5 stories and for operator-invoked `block-story(ref, reason)` calls. No new auto-block logic is added by 5.1.
- (b) Migrate `blockOrphanNoTranscript` callers off the specialised tool. The specialised tool is refactored to delegate to `blockStory` internally, but its public signature, name, and AC3-mandated chat line text remain identical. All Story 5.11 tests pass unchanged.
- (c) Touch `scan-sources.ts`, `process-dev-transcript.ts`, `process-reviewer-transcript.ts`, or `process-reviewer-yield.ts`. Those tools have their own canonical block paths (Story 5.13's typed writers) and continue to write `blocked/` manifests via `writeManagedFile` directly. A v3 refactor MAY route them through `blockStory` too, but that is out of scope here — touching them risks regressing the 12-test-file migration that 5.13 just shipped.
- (d) Change the runtime semantics of `BLOCKED_BY_HINTS[orphan-no-transcript]` or any other existing entry. Only three NEW hints are added.
- (e) Add a `/crew:block` slash command, a planner-facing UI, or any user-observable surface. `blockStory` is internal MCP — operators invoke it indirectly (via `/crew:start`'s orphan path today, via future skills tomorrow). This is `substrate`.

---

## Acceptance Criteria

<!--
All three ACs name internal MCP tools, typed enums, and integration tests. Per task instructions: no `(user-surface)` parenthetical. Plain `**ACn:**` tagging.

Per project memory `project_ac_marker_gap`: every AC MUST carry an `artifact:` or `vitest:` marker. Markers below.
-->

**AC1:**
**Given** a story manifest in `in-progress/<ref>.yaml` (any adapter, any prior state),
**When** an MCP caller invokes `blockStory({ targetRepoRoot, ref, blocked_by, detail? })` with `blocked_by` set to one of the sixteen enum members from § 5.13 ↔ 5.1 reconciliation,
**Then** (a) the manifest is atomically moved from `in-progress/` to `blocked/` via the canonical `moveBetweenStates` primitive (same primitive `blockOrphanNoTranscript` uses today at `block-orphan-no-transcript.ts:61-66`); (b) the now-blocked manifest is rewritten with `blocked_by` set to the typed value and the `claimed_by` field removed (the manifest no longer belongs to the prior session); (c) if `detail` is provided, it is appended to the rendered chat line as `: <detail>` (e.g. `[user] <ref> — manual block: schema migration pending`); (d) the tool returns `{ chatLog: string[] }` with exactly one entry — the rendered hint from `BLOCKED_BY_HINTS[blocked_by]` (with `{ref}` substituted) optionally suffixed with the `detail` text. The move and the stamp run in order; if the move succeeds but the stamp fails, the manifest lands in `blocked/` without `blocked_by` — recoverable by the operator (matches the existing `blockOrphanNoTranscript` pattern explicitly, per `block-orphan-no-transcript.ts:14-17`). `artifact: plugins/crew/mcp-server/src/tools/block-story.ts, plugins/crew/mcp-server/src/tools/register.ts, plugins/crew/mcp-server/src/tools/block-orphan-no-transcript.ts` _(FR20)_

**AC2:**
**Given** the `ExecutionManifestSchema.blocked_by` field in `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` and the `BLOCKED_BY_HINTS` table in `plugins/crew/mcp-server/src/lib/blocked-by-hints.ts`,
**When** the schema and the hints table are parsed/imported,
**Then** (a) `blocked_by` is a closed `z.enum([...])` with exactly the **sixteen** members listed in § Resulting v2 enum (the existing thirteen from Story 5.13, plus the three new members `source-drift`, `dep-not-built`, `user`); (b) any write attempting a value outside this set fails the Zod parse at the schema boundary with the canonical `invalid_enum_value` error; (c) `BLOCKED_BY_HINTS` has exactly sixteen entries — every enum member maps to a non-empty hint of the form `[<member>] {ref} — <operator action>` (matching the convention at `blocked-by-hints.ts:27-66`); (d) the schema's JSDoc comment block (currently at `execution-manifest.ts:125-150`) is updated to enumerate the sixteen members with a one-line provenance note per member (which story added it); (e) `BlockedBy` (the inferred TS union type exported from `execution-manifest.ts:241`) widens automatically — no manual type-list maintenance. `artifact: plugins/crew/mcp-server/src/schemas/execution-manifest.ts, plugins/crew/mcp-server/src/lib/blocked-by-hints.ts` _(FR20)_

**AC3:**
**Given** the vitest harness for the new `blockStory` tool,
**When** the suite runs,
**Then** vitest covers **all sixteen** `blocked_by` enum members in a table-driven test that, for each member: (a) seeds an `in-progress/<ref>.yaml` fixture; (b) invokes `blockStory({ … blocked_by: <member> })`; (c) asserts the manifest is gone from `in-progress/`; (d) asserts the manifest exists at `blocked/<ref>.yaml` with `blocked_by === <member>` and `claimed_by` absent; (e) asserts the returned `chatLog[0]` starts with `[<member>] ` and is the substituted `BLOCKED_BY_HINTS[<member>]` text. AND **separately** the suite covers the "dev keeps picking" invariant: (f) seed three `in-progress/` manifests and three `to-do/` manifests; call `blockStory` on all three in-progress refs (one with `user`, one with `dep-not-built`, one with `source-drift`); assert that a subsequent `listClaimableTodos` call returns exactly the three `to-do/` refs and that no blocked ref appears in the claimable list (the dev session keeps picking from `to-do/` without waiting). The fixture pattern follows `block-orphan-no-transcript.test.ts:48-58` (`seedInProgressManifest`). `vitest: plugins/crew/mcp-server/src/tools/__tests__/block-story.test.ts` _(FR21)_

---

## Implementation Strategy

### Files touched

**NEW:**

- `plugins/crew/mcp-server/src/tools/block-story.ts` — the generalised tool. Exports `blockStory(opts: BlockStoryOptions): Promise<BlockStoryResult>`. Signature:
  ```ts
  export interface BlockStoryOptions {
    targetRepoRoot: string;
    ref: string;
    blocked_by: BlockedBy;          // typed import from schemas/execution-manifest.js
    detail?: string;                 // optional free-text appended to the chat line
  }
  export interface BlockStoryResult {
    chatLog: string[];               // one entry — the rendered hint
  }
  ```
  Implementation mirrors `block-orphan-no-transcript.ts` step-for-step:
  1. `moveBetweenStates({ targetRepoRoot, ref, from: "in-progress", to: "blocked" })`.
  2. `readManifest(<blocked-path>)`.
  3. Stamp `blocked_by` (typed) and **delete** `claimed_by` (the manifest no longer belongs to the prior session — this is the new bit; `blockOrphanNoTranscript` does not currently delete it because Story 5.11 did not call it out, but 5.1 makes it explicit).
  4. `writeManifest(<blocked-path>, updated)`.
  5. Render the chat line via `renderBlockedRecoveryHint(blocked_by, ref)` (from `blocked-by-hints.ts:75`) and optionally append `: ${detail}`.
- `plugins/crew/mcp-server/src/tools/__tests__/block-story.test.ts` — table-driven over all sixteen enum members + the "dev keeps picking" invariant test.

**MODIFY:**

- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — extend the `z.enum([...])` at lines 154-168 with the three new members (`source-drift`, `dep-not-built`, `user`). Update the JSDoc block at lines 125-150 to list sixteen members with provenance.
- `plugins/crew/mcp-server/src/lib/blocked-by-hints.ts` — add three new entries to `BLOCKED_BY_HINTS` (the inferred `Record<BlockedBy, string>` type will force this once the enum widens — TypeScript will fail to compile until all three are added; the dev agent leverages this as a guard).
- `plugins/crew/mcp-server/src/tools/register.ts` — register the new `blockStory` MCP tool. Follow the exact pattern at lines 1485-1524 (`blockOrphanNoTranscript` registration). The `inputSchema` adds `blocked_by` and optional `detail` to the existing `{ targetRepoRoot, ref }` shape.
- `plugins/crew/mcp-server/src/tools/block-orphan-no-transcript.ts` — refactor to call `blockStory({ targetRepoRoot, ref, blocked_by: "orphan-no-transcript", detail: \`no persisted transcript for session ${staleUlid}; manual recovery required\` })` internally. The AC3 chat line from Story 5.11 (`block-orphan-no-transcript.ts:86-88`) must remain byte-identical — the new `detail` parameter is the seam that preserves the exact string. The existing exports (`blockOrphanNoTranscript`, `BlockOrphanNoTranscriptOptions`, `BlockOrphanNoTranscriptResult`) and their signatures stay; only the body changes. **All four existing tests in `block-orphan-no-transcript.test.ts` MUST pass unchanged.**
- `plugins/crew/mcp-server/src/schemas/__tests__/execution-manifest.test.ts` — extend the enum-member parse tests to cover the three new values (`source-drift`, `dep-not-built`, `user`); flip nothing else.

### Sequencing

1. **Enum + hints first** (compile-only — no behaviour change):
   - Add the three members to the Zod enum in `execution-manifest.ts`.
   - Add the three new entries to `BLOCKED_BY_HINTS`. TypeScript will refuse to compile until all three are present (the `Record<BlockedBy, string>` type forces exhaustiveness).
   - Update `execution-manifest.test.ts` to assert the three new members parse.
2. **Generalised tool:**
   - Write `block-story.ts` following the `block-orphan-no-transcript.ts` shape.
   - Register it in `register.ts`.
   - Write the table-driven test in `block-story.test.ts` (all sixteen members + the dev-keeps-picking invariant).
3. **Refactor the specialised tool:**
   - Rewrite `block-orphan-no-transcript.ts`'s body to call `blockStory(…)`. Keep the AC3 chat line byte-identical via the `detail` parameter.
   - Run the existing four tests in `block-orphan-no-transcript.test.ts` — all four must pass unchanged.

### Edge cases

- **`claimed_by` removal:** the new `blockStory` tool deletes `claimed_by` from the stamped manifest (AC1.b). This is a small behavioural change from `blockOrphanNoTranscript` (which today preserves `claimed_by`). The change is correct: once a story is blocked, the prior session's claim is no longer relevant; the next operator action (clear `blocked_by` and re-run `/crew:start`) will let a fresh session claim. The Story 5.11 test (`block-orphan-no-transcript.test.ts:80-99`) does not assert on `claimed_by` presence after the call, so it continues to pass.
- **`detail` parameter for hints with no operator-action variability:** every hint in `BLOCKED_BY_HINTS` has a self-contained operator action; `detail` is purely additive context (e.g. `[user] <ref> — manual block: schema migration pending`). When `detail` is omitted, the hint string is rendered verbatim.
- **`blockStory` called on a manifest that is NOT in `in-progress/`:** `moveBetweenStates` already throws `ManifestNotFoundError` on ENOENT (`block-orphan-no-transcript.ts:51-52` documents this). The new tool inherits that contract — no extra guard needed.
- **Idempotency / double-block:** calling `blockStory` twice on the same ref will fail on the second call because `in-progress/<ref>.yaml` no longer exists. This is correct — the caller should check `listClaimableTodos` or similar before re-blocking. NOT a new failure mode (Story 5.11's tool has the same shape).
- **Concurrent block + claim:** `moveBetweenStates` uses `fs.rename` (atomic per `managed-fs.ts:115-120`). If two callers race a `blockStory` + `claimStory` on the same ref, exactly one wins; the loser sees `ManifestNotFoundError`. Already guaranteed by Story 1.6's primitive.
- **Adding members beyond the sixteen:** any future block reason requires a deliberate schema-change story (deterministic seam per memory `feedback_default_to_deterministic_seams`). The Zod boundary catches free-string attempts at write time; the `Record<BlockedBy, string>` type catches hint-table omissions at compile time.

### What MUST NOT be touched

- `process-dev-transcript.ts`, `process-reviewer-transcript.ts`, `process-reviewer-yield.ts`, `scan-sources.ts` — Story 5.13 just migrated these to the typed enum and their direct `writeManagedFile` paths are correct. Routing them through `blockStory` is out of scope (would re-touch the 12 test files 5.13 just stabilised).
- The four existing tests in `block-orphan-no-transcript.test.ts` — their assertions must continue to pass byte-for-byte. The AC3 chat line is the canary.
- `plugins/crew/skills/start/SKILL.md` — Story 5.13 already wired the blocked-recovery surface to `BLOCKED_BY_HINTS`. No skill text changes needed for 5.1 (the three new hints flow through the same render path automatically).
- `plugins/crew/mcp-server/dist/` is the committed build output. Per project CLAUDE.md, the dev agent rebuilds and commits `dist/` in the same change.

### Build artefacts (`dist/` discipline)

After any change in `plugins/crew/mcp-server/src/`, the dev agent MUST run `pnpm -r build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git".

---

## Test Plan

### Unit tests

- `schemas/__tests__/execution-manifest.test.ts` (EXTEND): assert `source-drift`, `dep-not-built`, `user` parse successfully; assert an out-of-enum value (e.g. `"freeform-string"`) throws Zod `invalid_enum_value`.
- `lib/__tests__/blocked-by-hints.test.ts` (EXTEND): the existing test asserts every enum member has a hint — once the enum widens to sixteen, the test must continue to pass with no manual edits beyond updating any explicit member count.

### Integration tests

- `tools/__tests__/block-story.test.ts` (NEW):
  - **Per-member sweep (sixteen cases):** for each enum member, seed `in-progress/<ref>.yaml`, call `blockStory({ … blocked_by: <member> })`, assert (a) `in-progress/<ref>.yaml` is gone, (b) `blocked/<ref>.yaml` exists with `blocked_by === <member>` and no `claimed_by`, (c) `chatLog[0]` starts with `[<member>] ` and equals `renderBlockedRecoveryHint(<member>, ref)`.
  - **`detail` parameter:** seed a fixture; call with `detail: "schema migration pending"` and `blocked_by: "user"`; assert `chatLog[0]` ends with `: schema migration pending`.
  - **Dev-keeps-picking invariant (AC3 second half):** seed three `in-progress/` manifests (refs A, B, C) and three `to-do/` manifests (refs D, E, F). Call `blockStory` on A (with `user`), B (with `dep-not-built`), C (with `source-drift`). Then call `listClaimableTodos({ targetRepoRoot })` (the existing tool at `plugins/crew/mcp-server/src/tools/list-claimable-todos.ts`) and assert the returned refs are exactly `{D, E, F}` — no blocked ref leaks into the claimable list.
  - **`ManifestNotFoundError` propagation:** call `blockStory` on a ref that does not exist in `in-progress/`; assert `ManifestNotFoundError` is thrown.

- `tools/__tests__/block-orphan-no-transcript.test.ts` (UNCHANGED): all four existing tests continue to pass against the refactored body.

### Smoke test (operator-driven)

None required — `substrate` story with no user-observable surface. The dev-keeps-picking invariant is covered by the integration test above.

---

## Developer Context

### Why this story exists (and why now)

Per the epic block: Story 5.1 lays the substrate for Epic 5's orchestration / recovery / visibility surfaces. Every later Epic 5 story (5.2 heartbeats, 5.3 `/watch`, 5.4 stuck-story detection, 5.4b paused-for-human, 5.5 one-line surface + move-back) writes through a typed `blocked_by` reason; this story is the seam they all share. It also extracts the move-and-stamp pattern from Story 5.11's specialised `blockOrphanNoTranscript` so future block paths don't accrete as per-reason variants.

### Why this story is NOT the carrier for the Epic 5 carry-forward entries

Reviewed `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` entries 1 and 2:

- **Entry 1** (`readFile` warn-instead-of-throw in `scan-sources.ts:579-590`) — Story 5.1 does NOT touch `scan-sources.ts`. **Not carried.**
- **Entry 2** (`renderScanResult` leading-whitespace assertion in `scan-sources.ts`) — Story 5.1 does NOT touch `scan-sources.ts` or `renderScanResult`. **Not carried.**

Both entries remain parked for the next Epic 5 story that touches `scan-sources.ts` outside the drift surface.

### Previous-story intelligence

- **Story 5.11** (`5-11-orphan-recovery-branch-in-crew-start.md`) — added `blockOrphanNoTranscript` as the first "block-this-manifest" MCP tool. 5.1 generalises it. The AC3 chat line at `block-orphan-no-transcript.ts:86-88` is the canary string the refactor must preserve verbatim.
- **Story 5.13** (`5-13-planner-validator-prose-vs-manifest-deps-at-scan-time.md`) — shipped the closed `blocked_by` Zod enum (13 members), `BLOCKED_BY_HINTS`, and the `/crew:start` blocked-recovery surface. 5.1 widens the enum to 16 members and adds three hints; everything else 5.13 built stays.
- **Story 1.6** (managed-fs / atomic-write) — `atomicWriteFile` and `moveBetweenStates` are the two primitives 5.1's tool composes. No new primitive is needed.

### Project memories cited

- `feedback_default_to_deterministic_seams` — the closed Zod enum + `BLOCKED_BY_HINTS` table are deterministic seams; the hint text lives in TypeScript, not SKILL.md prose. Adding new members to either is a deliberate schema-change story (this one).
- `project_blocked_recovery_prose_lies` — 5.13 fixed the recovery-text side. 5.1 extends the same fix to the three new reasons.
- `project_ac_marker_gap` — every AC carries an `artifact:` or `vitest:` marker.

### Recent commit context (last 5)

- `65d1a51 feat(5): fix gh pr view --json baseRepository non-field (#5.15) (#160)` — 5.15; unrelated.
- `38e1966 chore(5): stub Story 5.15 — fix gh pr view --json baseRepository non-field` — 5.15 stub.
- `c403075 docs: pre-dogfood hygiene checklist + promotion procedure` — docs.
- `c6ffe50 feat(5): planner-validator + typed blocked_by enum (#159)` — **5.13; introduced the closed enum 5.1 widens.**
- `49a836b feat(5): MCP child resilient to parent stdin-close (#158)` — 5.12; unrelated.

---

## Definition of Done

- [ ] `block-story.ts` lands with the `blockStory(opts)` signature; registered in `register.ts`.
- [ ] `execution-manifest.ts` `blocked_by` is `z.enum([...])` of sixteen members; JSDoc updated; `BlockedBy` widens automatically.
- [ ] `blocked-by-hints.ts` `BLOCKED_BY_HINTS` has sixteen entries; the three new entries follow the `[<member>] {ref} — <operator action>` format.
- [ ] `block-orphan-no-transcript.ts` refactored to delegate to `blockStory`; all four existing tests pass unchanged (AC3 chat line preserved byte-for-byte).
- [ ] `block-story.test.ts` covers all sixteen enum members in the per-member sweep + the `detail`-parameter case + the dev-keeps-picking invariant + the `ManifestNotFoundError` propagation.
- [ ] `execution-manifest.test.ts` extended to assert the three new members parse and an out-of-enum value throws.
- [ ] `pnpm -r build` clean; `plugins/crew/mcp-server/dist/` committed in the same change.
- [ ] `pnpm -r test` passes (including the existing 5.11 and 5.13 suites).

### Completion note

Ultimate context engine analysis completed — comprehensive developer guide created.
