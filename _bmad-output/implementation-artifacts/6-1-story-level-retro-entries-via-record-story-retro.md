# Story 6.1: Story-level retro entries via `record-story-retro`

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin maintainer**,
I want **a typed MCP tool that attaches structured retro entries to a story's `done/` manifest**,
So that **the cycle-level retro (Story 6.2) and outcome stats (Story 6.11) have parseable per-story data to roll up**.

This is Epic 6's foundation story. It ships the **schema and tool** only — no proposal generation, no LLM-side authoring discipline, no call-site wiring into the reviewer's flow. Those concerns ride on Story 6.2 (`/retro` skill + retro-analyst subagent) and Story 6.3 (proposal markdown emission). Phasing rationale: per the 2026-05-27 reframe, Epic 6a (6.1–6.3) delivers retro capture + inert proposal output; **no canonical-state mutation surface in 6a** — see `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-27-reframe.md` and memory `project_epic_6_phased`.

## Acceptance Criteria

**AC1:**

`record-story-retro` tool exists and writes `lessons[]`, `failure_class`, `duration_seconds` (and preserves existing `rework_count`) onto the `done/<ref>.yaml` manifest. The tool reads the existing manifest, merges the retro payload, validates the merged document via the existing `parseExecutionManifest` helper, and rewrites the file atomically via `writeManagedFile`. Refuses with a typed `DomainError` when the manifest is not in `done/` (state guard — retro is a post-completion concern). _(FR11, FR55)_
artifact: plugins/crew/mcp-server/src/tools/record-story-retro.ts

**AC2:**

The Zod schema for the retro payload constrains `lessons[].kind` to exactly `pitfall | pattern | tool-quirk | discipline` (closed enum, no `z.string()` fallback per memory `feedback_default_to_deterministic_seams`). `text` is required and non-empty on every lesson. `failure_class` on a lesson is **required when `kind === "pitfall"`** and optional otherwise. `routed_to` is optional on every lesson. The story-level `failure_class` and `duration_seconds` (non-negative integer) are optional. Unknown keys on lessons or the retro payload are rejected (`.strict()`). _(FR11)_
artifact: plugins/crew/mcp-server/src/schemas/story-retro.ts

**AC3 (integration):**

Vitest covers: (a) happy-path write — a valid retro payload lands on a `done/` manifest and the file re-parses cleanly through `parseExecutionManifest`; (b) one assertion per `kind` value (four tests) demonstrating the closed enum accepts all four members; (c) `kind: "pitfall"` without `failure_class` is rejected at the Zod boundary; (d) the tool refuses with a typed error when invoked against a ref that lives in `to-do/`, `blocked/`, or `in-progress/` (not `done/`); (e) re-running `record-story-retro` on the same manifest is idempotent — second call with identical payload produces a byte-identical file. _(FR11, FR55)_
vitest: plugins/crew/mcp-server/src/tools/__tests__/record-story-retro.test.ts

**AC4:**

`ExecutionManifestSchema` (`plugins/crew/mcp-server/src/schemas/execution-manifest.ts`) is extended to accept the three new optional fields (`lessons`, `failure_class`, `duration_seconds`). Existing manifests (any state directory, any prior shape) MUST parse unchanged — additive only. The schema's `.strict()` posture is preserved; the new fields are declared on the manifest object directly so unknown-key rejection still holds.
vitest: plugins/crew/mcp-server/src/schemas/__tests__/execution-manifest.test.ts

New test block: `describe("retro fields (Story 6.1)")` covering omitted-default round-trip, lessons array round-trip, story-level failure_class round-trip, duration_seconds non-negative-integer enforcement.

**AC5:**

`record-story-retro` is registered in `plugins/crew/mcp-server/src/tools/register.ts` following the existing pattern (typed `DomainError` → `{ isError: true }` envelope; otherwise `{ content: [{ type: "text", text: JSON.stringify(result) }] }`). The `generalist-reviewer` permission allowlist at `plugins/crew/permissions/generalist-reviewer.yaml` is extended to include `recordStoryRetro` so the reviewer subagent can call it from its session. No other persona's allowlist changes in this story.
artifact: plugins/crew/mcp-server/src/tools/register.ts

(Also touches `plugins/crew/permissions/generalist-reviewer.yaml` — see Files touched.)

## Implementation Notes

### Out of scope for 6.1 (deliberate)

- **No call-site wiring into the reviewer flow.** The reviewer SKILL.md / PERSONA.md is NOT modified to mandate calling `recordStoryRetro`. The tool exists and is permitted; **when and how** it's invoked is Story 6.2's concern, where the `/retro` skill and the retro-analyst subagent define the call discipline. Memory `feedback_prose_mut_steps_need_seam` and `project_reviewer_first_call_enforcement_needed` say a prose-level mandate to "the reviewer MUST call recordStoryRetro" will be skipped under load; deferring lets 6.2 design the right deterministic seam (likely: SKILL.md prose asks the LLM for the retro payload, then the tool layer makes the call from a deterministic code path).
- **No proposal generation.** Stories 6.2 and 6.3 own `/retro` and the proposal markdown.
- **No mutation of `docs/standards.md`, the rule registry, persona files, or any other canonical state.** 6a phase per `project_epic_6_phased`.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/schemas/story-retro.ts` — Zod schema for the retro payload (lessons + story-level fields). Export `LessonSchema`, `StoryRetroPayloadSchema`, and a `parseStoryRetroPayload` helper that throws a typed `MalformedStoryRetroPayloadError` on failure (parallel to `parseExecutionManifest`'s shape).
- `plugins/crew/mcp-server/src/tools/record-story-retro.ts` — the MCP tool implementation.
- `plugins/crew/mcp-server/src/tools/__tests__/record-story-retro.test.ts` — tests per AC3.

**UPDATE:**
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — add three optional fields (`lessons`, `failure_class`, `duration_seconds`). Preserve `.strict()`. Preserve field-order convention (these new fields are retro-time additions; conventional position is **after** `risk_tier_evidence` at the end of the object, so YAML round-trip puts them last on disk).
- `plugins/crew/mcp-server/src/schemas/__tests__/execution-manifest.test.ts` — new `describe("retro fields (Story 6.1)")` block per AC4.
- `plugins/crew/mcp-server/src/tools/register.ts` — register `recordStoryRetro` with the existing typed-error envelope pattern. Place the registration near the other write-path tools (e.g. after `completeStory` registration at line ~503 — the order is loosely grouped by epic in the existing file, follow that).
- `plugins/crew/mcp-server/src/errors.ts` — add two new typed errors:
  - `MalformedStoryRetroPayloadError` (Zod-failure carrier; mirrors `MalformedExecutionManifestError`).
  - `StoryNotInDoneStateError` (refusal carrier for AC1 state guard; mirrors `ManifestNotFoundError`'s shape).
- `plugins/crew/permissions/generalist-reviewer.yaml` — add `recordStoryRetro` to `tools_allow`.

### Schema shape (binding)

```ts
// plugins/crew/mcp-server/src/schemas/story-retro.ts

export const LESSON_KINDS = ["pitfall", "pattern", "tool-quirk", "discipline"] as const;

export const LessonSchema = z
  .object({
    kind: z.enum(LESSON_KINDS),
    text: z.string().min(1),
    failure_class: z.string().min(1).optional(),
    routed_to: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((lesson, ctx) => {
    if (lesson.kind === "pitfall" && lesson.failure_class === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure_class"],
        message: "failure_class is required when kind is 'pitfall'",
      });
    }
  });

export const StoryRetroPayloadSchema = z
  .object({
    lessons: z.array(LessonSchema).default([]),
    failure_class: z.string().min(1).optional(),
    duration_seconds: z.number().int().nonnegative().optional(),
  })
  .strict();
```

The closed-enum + `superRefine` pattern is the deterministic seam (memory `feedback_default_to_deterministic_seams`): unknown kinds are caught at the Zod boundary, not by hopeful prose elsewhere. Do not add a `z.string()` fallback for `kind` — that would silently accept future kinds and erode the routing contract (FR11's `kind` → proposal-type mapping in §Skill calibration loop of architecture).

### Manifest extension (binding)

In `execution-manifest.ts`, add three optional fields at the end of the object literal (immediately after `risk_tier_evidence`), preserving field-order convention:

```ts
lessons: z.array(LessonSchema).optional(),
failure_class: z.string().min(1).optional(),
duration_seconds: z.number().int().nonnegative().optional(),
```

`LessonSchema` is imported from `./story-retro.js` (not duplicated). The existing `rework_count` field is unchanged — it already lives on the manifest (Story 4.3) and `record-story-retro` only *reads* it through the round-trip; the dev/reviewer cycle continues to be the writer.

### Tool behaviour (binding)

```ts
// plugins/crew/mcp-server/src/tools/record-story-retro.ts

export interface RecordStoryRetroOptions {
  targetRepoRoot: string;
  ref: string;
  payload: unknown;          // validated inside via parseStoryRetroPayload
  role?: string;             // defaults to "generalist-reviewer"
}

export async function recordStoryRetro(opts: RecordStoryRetroOptions): Promise<{
  ref: string;
  absPath: string;
}>;
```

Steps:
1. Validate `payload` via `parseStoryRetroPayload` (throws `MalformedStoryRetroPayloadError`).
2. Resolve `done/<ref>.yaml` absolute path. If absent at that location, check other state dirs (`in-progress/`, `to-do/`, `blocked/`) — if found there, throw `StoryNotInDoneStateError({ ref, foundIn: <state> })`. If absent everywhere, throw `ManifestNotFoundError` (existing).
3. Read the done manifest via `readManifest` (`lib/manifest-io.ts`).
4. Merge: shallow-overwrite `lessons`, `failure_class`, `duration_seconds` on the manifest. Do not touch any other field. Do not touch `rework_count` (it's owned by the dev/reviewer cycle).
5. Re-parse the merged document through `parseExecutionManifest` — this is the deterministic seam: even after the AC4 schema extension, every write goes back through the validator before hitting disk. Failures propagate as `MalformedExecutionManifestError`.
6. Write via `writeManagedFile` with `mcpToolContext: { toolName: "recordStoryRetro", role }`.

**Idempotency:** the merge is a deterministic shallow overwrite, the validator is pure, and YAML stringification with `lineWidth: 0` + `stripUndefined` is byte-stable. Re-running with an identical payload produces a byte-identical file (AC3e covers this).

**No hand-edit guard.** Unlike `completeStory`, this tool operates on `done/` manifests, which are not subject to the in-progress hand-edit guard (`detectInProgressHandEdit` is keyed to the in-progress layer). Hand-edits to `done/` manifests are operator territory; retro overwrites are the documented intent.

### Register.ts wiring (binding)

```ts
import { recordStoryRetro } from "./record-story-retro.js";
// ...
server.registerTool({
  name: "recordStoryRetro",
  description:
    "Attach structured retro entries (lessons[], failure_class, duration_seconds) " +
    "to a done/ manifest after story completion. Reviewer-side tool (Story 6.1, FR11, FR55).",
  inputSchema: {
    type: "object",
    properties: {
      targetRepoRoot: { type: "string" },
      ref: { type: "string" },
      payload: { type: "object" },
      role: { type: "string" },
    },
    required: ["targetRepoRoot", "ref", "payload"],
  },
  handler: async (args) => {
    try {
      const parsed = z
        .object({
          targetRepoRoot: z.string().min(1),
          ref: z.string().min(1),
          payload: z.unknown(),
          role: z.string().optional(),
        })
        .parse(args);
      const result = await recordStoryRetro(parsed);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      if (err instanceof DomainError) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: err.name, message: err.message }) },
          ],
          isError: true,
        };
      }
      throw err;
    }
  },
});
```

### Test plan (per AC3 / AC4)

**`record-story-retro.test.ts`** (AC3):
- Fixture: a `done/<ref>.yaml` manifest seeded via `completeStory` in a tmp dir (use the existing test harness in `claim-complete-loop.integration.test.ts` as a reference for how to set up the state-dir scaffold).
- (a) Happy path: write `{ lessons: [{ kind: "pattern", text: "..." }], failure_class: "ac-marker-gap", duration_seconds: 1800 }`. Re-read; assert all three fields present; assert `parseExecutionManifest` accepts the file from disk.
- (b) Four `kind` tests: one per `pitfall | pattern | tool-quirk | discipline` — assert each accepted.
- (c) `kind: "pitfall"` without `failure_class` → expect `MalformedStoryRetroPayloadError`.
- (d) State-guard refusal: seed a manifest in `in-progress/` (not `done/`); call the tool; assert `StoryNotInDoneStateError` with `foundIn: "in-progress"`. Repeat for `to-do/` and `blocked/`. Also assert `ManifestNotFoundError` for a ref that doesn't exist anywhere.
- (e) Idempotency: call the tool twice with identical payload; read both files' byte content; assert equal.

**`execution-manifest.test.ts`** (AC4) — new `describe("retro fields (Story 6.1)")`:
- Omitted defaults: a manifest without retro fields parses, all three resolve to `undefined`.
- `lessons` round-trip: a manifest with a populated `lessons` array round-trips through `parseExecutionManifest` unchanged.
- Story-level `failure_class` round-trip: a manifest with `failure_class: "ac-marker-gap"` parses.
- `duration_seconds` non-negative-integer: `-1` and `1.5` both throw `MalformedExecutionManifestError`; `0` and `3600` parse.

Do not seed `lessons` with an out-of-enum `kind` value in `execution-manifest.test.ts` — those cases belong in a separate `story-retro.test.ts` (or co-locate them in `record-story-retro.test.ts` per AC3c). The manifest-level test covers manifest-shape concerns only.

### Dependencies

None on other in-flight Epic 6 stories — 6.1 is the leaf of the 6a tranche. Touches `errors.ts`, `execution-manifest.ts`, `register.ts`, and one permission file; all are well-trafficked modules with stable shapes. No spec or code dependencies on Epic 5 in-flight work.

### Build artefacts

After any change in `plugins/crew/mcp-server/src/`, run `pnpm --dir plugins/crew/mcp-server build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git". Story 5.24 just fixed `.d.ts` determinism; verify a clean rebuild produces zero `dist/` drift before staging — if drift recurs, that's a 5.24 regression, not a 6.1 problem (flag it and stop).

### Edge cases worth surfacing in dev/review

- **`lessons: []` semantics.** An empty `lessons` array is a valid payload — the story completed with no extracted lessons. The merged manifest carries `lessons: []` explicitly, not `undefined`. AC2's `.default([])` on the payload schema makes this round-trip cleanly. Confirm `stripUndefined`-style helpers in `writeManagedFile` or the YAML stringifier don't drop the empty array (they shouldn't — empty arrays are not undefined).
- **`routed_to` semantics.** Optional free-text label naming a downstream proposal kind (rule, skill-create, etc.) when the retro-analyst has already decided. For 6.1, accept any non-empty string — 6.2 will close the enum when the proposal-type taxonomy lands. This is the explicit forward-compat hole; future 6.x stories will tighten it.
- **`failure_class` taxonomy.** Free-text in 6.1 by design — 6.2 / 6.3 will narrow it after the retro-analyst defines the closed set. Don't introduce a closed enum prematurely; the AC-marker-gap memory shows the cost of mistuned vocabularies (`project_ac_marker_gap`).
- **Concurrent writes.** Two `recordStoryRetro` calls on the same ref are not guarded — they race on the file. v1 assumes single-writer (the reviewer subagent). If this assumption changes in 6.2, the contract is "last writer wins"; document it then, don't pre-empt now.
- **Manifest grew big.** Lessons text is operator-readable but unbounded. v1 enforces no length cap. If retros routinely exceed ~10KB per manifest, consider a cap in 6.2.

### Architectural fit / references

- **Retro lesson kinds + downstream routing** — `_bmad-output/planning-artifacts/architecture/skill-calibration-loop.md § Vocabulary`. `kind` here is the routing pivot for 6.3's proposal-type discriminator.
- **FR11 (story frontmatter retro fields)** — `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` line 20.
- **FR55 (reviewer records story-level retros)** — same file, line 84.
- **Phasing context** — `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-27-reframe.md` and epic-file phasing note (6a vs 6b).
- **Existing schema/tool pattern to mirror** — `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` (closed-enum + `parseExecutionManifest` helper); `plugins/crew/mcp-server/src/tools/complete-story.ts` (atomic-manifest-rewrite shape). Match these patterns exactly; don't invent new conventions.
- **Deterministic-seam principle** — memory `feedback_default_to_deterministic_seams`. The `.strict()` + closed `kind` enum + `parseStoryRetroPayload` helper is the load-bearing seam here; resist any future PR that adds `z.string()` fallbacks.

## Definition of Done

- [ ] All five ACs met (AC1–AC5).
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; new vitest files exercise every AC clause listed in AC3 / AC4.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit; `git diff plugins/crew/mcp-server/dist/` shows only the genuine additions for this story.
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean — no rubber-stamp guard fires; AC4 and AC5 both have machine-checkable artifacts so the reviewer's runnable-AC pass should be all-green.
- [ ] No changes to reviewer SKILL.md or PERSONA.md (call-site wiring is explicitly deferred to 6.2 per Implementation Notes § Out of scope).
- [ ] No changes to `docs/standards.md`, `discipline-rules.yaml`, persona files, or any other canonical-state surface (6a phase).

## Dev Notes

Implementation followed the binding spec verbatim. Key choices inside the AC envelope:

- **`LessonSchema` lives in `story-retro.ts` and is imported by `execution-manifest.ts`.** This keeps the closed `kind` enum + `pitfall` superRefine as a single source of truth. The dependency direction (`execution-manifest.ts` → `story-retro.ts` → `errors.ts`) is acyclic.
- **`stripUndefined` mirrors `complete-story.ts`.** Same shallow `Object.fromEntries(Object.entries(...).filter(v !== undefined))` pattern, so YAML round-trip drops optional unset fields rather than emitting `key: null`. Empty arrays (`lessons: []`) are preserved because they are not `undefined`.
- **State-guard probes in `in-progress → to-do → blocked` order.** Returns the first hit. Operators most often hit this guard mid-cycle, hence `in-progress/` first.
- **Default `role`: `"generalist-reviewer"`** — matches the v1 caller documented in FR55 and the permissions allowlist update.
- **Tool-count assertions across six existing tests bumped 35 → 36.** Each existing assertion already carried a story-history comment; appended `"; Story 6.1 added recordStoryRetro (36)"` to each. No semantic change to those tests beyond the new sentinel.
- **`dist/` rebuild was deterministic** — second `pnpm build` produced byte-identical output; build-determinism vitest stayed green.
