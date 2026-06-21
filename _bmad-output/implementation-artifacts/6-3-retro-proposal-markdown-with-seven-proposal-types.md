# Story 6.3: Retro proposal markdown with seven proposal types

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **every cycle's retro to produce a single proposal markdown file under `<target-repo>/.crew/retro-proposals/<ISO>.md`, carrying any of seven typed proposals**,
So that **the calibration loop covers the full surface — what not to do (rules), what to always do (skills), and how to evolve the team — with each proposal kind validated at the boundary**.

This is the third and final story of Epic 6a (per the 2026-05-27 reframe). 6.1 ships the per-story retro substrate; 6.2 ships the skill + subagent + input-gathering; 6.3 ships the schema + writer that lets the subagent emit a structured artifact. After 6.3, retros run end-to-end and produce inert proposal markdown — Jack reviews by hand, decides what to apply (or not). The `/accept-proposal` mutation gate is Epic 6b (Story 6.4+) and out of scope here.

## Dependencies

- **No code dependency on 6.1 or 6.2.** 6.3 is the leaf: schema + tool + tests. Can be developed and merged independently.
- **Sequencing note.** Story 6.2 hard-depends on 6.3 (the analyst calls `writeRetroProposal`). **6.3 should land first** so 6.2 can wire against a real tool. This story can be claimed and shipped in any cycle where 6.1 has landed or not — 6.3 doesn't read manifests, so 6.1 is orthogonal.

## Acceptance Criteria

**AC1:**

`writeRetroProposal({ targetRepoRoot, isoTimestamp, proposals })` writes exactly one markdown file at `<targetRepoRoot>/.crew/retro-proposals/<isoTimestamp>.md`. The file's structure is: a YAML frontmatter block carrying the validated `proposals` array, followed by an operator-readable rendered Markdown body that lists each proposal as an H2 section with a one-line summary and the structured fields rendered as a definition list. The parent directory is mkdir-p'd if absent. The write goes through `writeManagedFile` (canonical-fs guard). The tool refuses with a typed `RetroProposalAlreadyExistsError` if the target file already exists — proposals are immutable artifacts (idempotency by ISO timestamp; collisions are bugs in the caller, not silent overwrites). _(FR58)_
artifact: plugins/crew/mcp-server/src/tools/write-retro-proposal.ts

**AC2:**

The Zod schema `RetroProposalSchema` is a `z.discriminatedUnion("type", [...])` over **exactly seven** discriminator literals: `rule | rule-retirement | skill-create | skill-revise | skill-supersede | skill-retire | team-change`. Closed enum, no `z.string()` fallback. Each variant carries the fields required by its kind (per AC3–AC7 below). Every proposal additionally carries a stable `id: ULID`, a `created_at: ISO-8601` timestamp, and a `rationale: string.min(1)` (one-paragraph justification). The schema is `.strict()` on every variant. _(FR59, Architecture §Skill calibration loop)_
artifact: plugins/crew/mcp-server/src/schemas/retro-proposal.ts

**AC3:**

A `rule` proposal carries: `text: string.min(1)` (the rule criterion phrased operator-readably), `target_failure_class: string.min(1)`, `recommended_promotion_level: z.enum(["must", "should", "advisory"])`. Validation refuses unknown promotion levels and missing fields. _(FR59)_
vitest: plugins/crew/mcp-server/src/schemas/__tests__/retro-proposal.test.ts

(One test per AC3–AC7 — see AC8.)

**AC4:**

A `skill-create` proposal carries: `proposed_path: string.min(1)` (path relative to target repo, e.g. `.crew/skills/<name>.md`), `frontmatter_description: string.min(1)`, `body: string.min(1)` (the proposed skill body markdown, excluding frontmatter — the apply tool in 6.7 stitches frontmatter and body together). Validation refuses absolute paths starting with `/` outside the target repo, and refuses paths containing `..` segments (path-traversal guard). _(FR59)_
vitest: plugins/crew/mcp-server/src/schemas/__tests__/retro-proposal.test.ts

**AC5:**

A `team-change` proposal carries: `action: z.enum(["hire", "unhire"])`, `target_role: string.regex(/^[a-z0-9-]+$/)` (kebab-cased role name matching the catalogue convention), `justification: string.min(1)`, `predicted_impact: { affected_failure_classes: string[] }` (which failure classes are expected to change as a result). Validation refuses non-kebab-cased role names and empty `affected_failure_classes` arrays (a team change with no predicted impact has no observable signal). _(FR106)_
vitest: plugins/crew/mcp-server/src/schemas/__tests__/retro-proposal.test.ts

**AC6:**

The four remaining proposal types are schema-defined with the minimum fields needed to survive into Epic 6b's apply paths:
- `rule-retirement`: `target_rule_id: ULID`, `fire_count_over_window: z.number().int().nonnegative()`, `recommended_action: z.enum(["retire", "relax"])`. _(FR64a)_
- `skill-revise`: `target_skill_path: string.min(1)`, `revised_body: string.min(1)`, `version_bump: z.enum(["patch", "minor"])`. _(Architecture §Skill calibration loop)_
- `skill-supersede`: `superseded_skill_path: string.min(1)`, `replacement: skill-create variant nested` — i.e. carries an embedded `skill-create` shape (`proposed_path`, `frontmatter_description`, `body`). The "two-half acceptance" semantics from the epic file (either half can be accepted independently) is Epic 6b's apply-time concern; the schema captures both halves in one record. _(Architecture §Skill calibration loop)_
- `skill-retire`: `target_skill_path: string.min(1)`, `last_invoked_at: ISO-8601 | null` (null when the skill never fired).
vitest: plugins/crew/mcp-server/src/schemas/__tests__/retro-proposal.test.ts

**AC7:**

`RetroProposalFileSchema` wraps the file-level shape: `{ iso_timestamp: ISO-8601, cycle_window: { from: ISO-8601, to: ISO-8601 } | null, proposals: RetroProposal[].min(0) }`. The proposals array MAY be empty — a retro that finds nothing worth proposing is a valid retro and produces an empty proposals file (still records that the retro ran). `.strict()` on the wrapper. _(FR58, FR59)_
artifact: plugins/crew/mcp-server/src/schemas/retro-proposal.ts

**AC8 (integration):**

Vitest in `plugins/crew/mcp-server/src/schemas/__tests__/retro-proposal.test.ts` covers, at minimum:
- One happy-path test per proposal type (seven tests) — valid fixture parses cleanly.
- One Zod-rejection test per proposal type (seven tests) — at least one missing or out-of-enum field per variant rejected with `MalformedRetroProposalError`.
- Discriminated-union behaviour: a proposal with `type: "rule"` and `proposed_path` (a `skill-create` field) fails — the discriminator rules out cross-variant field smuggling.
- Path-traversal guard on `skill-create` (AC4): `proposed_path: "../../etc/passwd"` rejected.
- Empty `proposals: []` round-trips through `RetroProposalFileSchema`.

Plus the writer integration: `plugins/crew/mcp-server/src/tools/__tests__/write-retro-proposal.test.ts` covers:
- Happy path: write a file with mixed proposal types; read back; assert frontmatter parses cleanly through `RetroProposalFileSchema`; assert body markdown contains an H2 per proposal.
- Collision refusal: writing twice with the same `isoTimestamp` against the same target throws `RetroProposalAlreadyExistsError`.
- Empty proposals: `proposals: []` produces a valid file with frontmatter `proposals: []` and a body that says "No proposals produced this cycle."
- Path-traversal in `isoTimestamp` (defense in depth): `isoTimestamp: "../escape"` rejected at the writer boundary (the writer validates the timestamp matches an ISO-8601 regex before forming the path).
vitest: plugins/crew/mcp-server/src/tools/__tests__/write-retro-proposal.test.ts

(Also covered by `plugins/crew/mcp-server/src/schemas/__tests__/retro-proposal.test.ts` — see Test plan.)

**AC9:**

`writeRetroProposal` is registered in `plugins/crew/mcp-server/src/tools/register.ts` with the standard `DomainError` envelope. Tool name: `writeRetroProposal` (camelCase per project convention). The retro-analyst's permission allowlist (`plugins/crew/permissions/retro-analyst.yaml`) is **not** modified by this story — that addition belongs to Story 6.2's AC5. (If 6.2 lands first, the allowlist already mentions `writeRetroProposal`, which is fine — the tool registration completes the wiring.)
artifact: plugins/crew/mcp-server/src/tools/register.ts

## Implementation Notes

### Out of scope for 6.3 (deliberate)

- **No `/accept-proposal` skill, no apply tools, no canonical-state mutation.** Those are Epic 6b (Story 6.4 onwards). 6.3 emits inert markdown that humans read; the apply path comes later, gated by diff-then-confirm.
- **No call site.** 6.3 ships the schema + writer. The caller (retro-analyst subagent) ships in Story 6.2. 6.3 alone is testable in isolation via vitest.
- **No proposal-validation-at-apply.** The validators here cover write-time. Apply-time re-validation (`/accept-proposal` reads the markdown, re-parses, applies) is Epic 6b's concern. The Zod schemas here are designed to survive both passes — re-parsing the written file MUST round-trip cleanly.
- **No deduplication.** If the analyst proposes the same `rule` twice in one cycle (or duplicates across cycles), the schema accepts. Dedup logic belongs to the apply path (Story 6.5+).
- **No proposal-ID minting helper exposed to the analyst.** The analyst will mint ULIDs via `mintSessionUlid` (or a thin variant) — that's Story 6.2's wiring choice. The schema just requires the ID is shaped like a ULID.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/schemas/retro-proposal.ts` — the Zod schemas (`LessonSchema` from 6.1 is NOT reused here; retro proposals are a different shape).
- `plugins/crew/mcp-server/src/schemas/__tests__/retro-proposal.test.ts` — AC3–AC8 schema tests.
- `plugins/crew/mcp-server/src/tools/write-retro-proposal.ts` — the writer.
- `plugins/crew/mcp-server/src/tools/__tests__/write-retro-proposal.test.ts` — AC8 writer tests.

**UPDATE:**
- `plugins/crew/mcp-server/src/tools/register.ts` — register `writeRetroProposal` per AC9. Place after the other write-path registrations (group with `writeNativeStory` / `recordStoryRetro` from 6.1).
- `plugins/crew/mcp-server/src/errors.ts` — add two typed errors:
  - `MalformedRetroProposalError` (Zod-failure carrier; mirrors `MalformedExecutionManifestError`'s shape).
  - `RetroProposalAlreadyExistsError` (collision carrier with `{ absPath, isoTimestamp }`).

### Schema shape (binding)

```ts
// plugins/crew/mcp-server/src/schemas/retro-proposal.ts

const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID");
const IsoTimestampSchema = z.string().datetime({ offset: false }).refine((s) => s.endsWith("Z"), "must be UTC");
const RolePathSchema = z.string().regex(/^[a-z0-9-]+$/, "kebab-cased role name");

const ProposalBase = z.object({
  id: UlidSchema,
  created_at: IsoTimestampSchema,
  rationale: z.string().min(1),
});

const PathInsideRepoSchema = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("/"), "must be repo-relative (no leading '/')")
  .refine((s) => !s.split("/").includes(".."), "must not contain '..' segments");

export const RuleProposalSchema = ProposalBase.extend({
  type: z.literal("rule"),
  text: z.string().min(1),
  target_failure_class: z.string().min(1),
  recommended_promotion_level: z.enum(["must", "should", "advisory"]),
}).strict();

export const RuleRetirementProposalSchema = ProposalBase.extend({
  type: z.literal("rule-retirement"),
  target_rule_id: UlidSchema,
  fire_count_over_window: z.number().int().nonnegative(),
  recommended_action: z.enum(["retire", "relax"]),
}).strict();

const SkillCreateBody = {
  proposed_path: PathInsideRepoSchema,
  frontmatter_description: z.string().min(1),
  body: z.string().min(1),
};

export const SkillCreateProposalSchema = ProposalBase.extend({
  type: z.literal("skill-create"),
  ...SkillCreateBody,
}).strict();

export const SkillReviseProposalSchema = ProposalBase.extend({
  type: z.literal("skill-revise"),
  target_skill_path: PathInsideRepoSchema,
  revised_body: z.string().min(1),
  version_bump: z.enum(["patch", "minor"]),
}).strict();

export const SkillSupersedeProposalSchema = ProposalBase.extend({
  type: z.literal("skill-supersede"),
  superseded_skill_path: PathInsideRepoSchema,
  replacement: z.object(SkillCreateBody).strict(),
}).strict();

export const SkillRetireProposalSchema = ProposalBase.extend({
  type: z.literal("skill-retire"),
  target_skill_path: PathInsideRepoSchema,
  last_invoked_at: IsoTimestampSchema.nullable(),
}).strict();

export const TeamChangeProposalSchema = ProposalBase.extend({
  type: z.literal("team-change"),
  action: z.enum(["hire", "unhire"]),
  target_role: RolePathSchema,
  justification: z.string().min(1),
  predicted_impact: z.object({
    affected_failure_classes: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict();

export const RetroProposalSchema = z.discriminatedUnion("type", [
  RuleProposalSchema,
  RuleRetirementProposalSchema,
  SkillCreateProposalSchema,
  SkillReviseProposalSchema,
  SkillSupersedeProposalSchema,
  SkillRetireProposalSchema,
  TeamChangeProposalSchema,
]);

export const RetroProposalFileSchema = z.object({
  iso_timestamp: IsoTimestampSchema,
  cycle_window: z.object({ from: IsoTimestampSchema, to: IsoTimestampSchema }).strict().nullable(),
  proposals: z.array(RetroProposalSchema),
}).strict();

export type RetroProposal = z.infer<typeof RetroProposalSchema>;
export type RetroProposalFile = z.infer<typeof RetroProposalFileSchema>;

export function parseRetroProposalFile(input: unknown, opts: { absPath: string }): RetroProposalFile {
  // mirrors parseExecutionManifest — throws MalformedRetroProposalError on failure
}
```

The `.strict()` posture is non-negotiable on every variant — memory `feedback_default_to_deterministic_seams`. No new variants without a coordinated schema bump.

### Writer shape (binding)

```ts
// plugins/crew/mcp-server/src/tools/write-retro-proposal.ts

export interface WriteRetroProposalOptions {
  targetRepoRoot: string;
  isoTimestamp: string;         // ISO-8601 UTC; validated against IsoTimestampSchema before path-forming
  proposals: unknown[];         // each validated via RetroProposalSchema before write
  cycleWindow?: { from: string; to: string } | null;
  role?: string;                // for managed-fs context; defaults to "retro-analyst"
}

export async function writeRetroProposal(opts: WriteRetroProposalOptions): Promise<{
  absPath: string;
  proposalCount: number;
}>;
```

Steps:
1. Validate `isoTimestamp` via `IsoTimestampSchema.parse` — defends against path-traversal in the filename component.
2. Validate the file shape via `RetroProposalFileSchema.parse({ iso_timestamp: opts.isoTimestamp, cycle_window: opts.cycleWindow ?? null, proposals: opts.proposals })`. Failures throw `MalformedRetroProposalError`.
3. Form the absolute path: `path.join(targetRepoRoot, ".crew", "retro-proposals", `${isoTimestamp}.md`)`.
4. `fs.mkdir(parentDir, { recursive: true })` — first-ever retro creates the dir.
5. Check for collision via `fs.access` — if file exists, throw `RetroProposalAlreadyExistsError({ absPath, isoTimestamp })`. **Do not overwrite.** Proposals are immutable.
6. Render the file: YAML frontmatter via `yaml.stringify` (lineWidth 0) wrapped in `---\n...\n---\n`, followed by a rendered Markdown body. The body shape:
   ```
   # Retro proposals — <isoTimestamp>

   Cycle window: <from> → <to>   (or "Not specified" when null)
   Proposals: <N>

   ## Proposal 1 — <type> — <id>

   **Rationale.** <rationale>

   <type-specific rendered fields as a definition list>

   ## Proposal 2 — ...
   ```
   When `proposals: []`, the body is just the header lines plus a single paragraph: "No proposals produced this cycle."
7. Write via `writeManagedFile({ absPath, contents, targetRepoRoot, mcpToolContext: { toolName: "writeRetroProposal", role } })`.

The frontmatter is the source of truth — the rendered body is operator-readable scaffolding. Epic 6b's `/accept-proposal` parses the frontmatter, not the body, when applying.

### Test plan (per AC8)

**`retro-proposal.test.ts`** (schemas):
- One happy-path fixture per type (seven `it()` tests).
- One rejection fixture per type — vary the missing/invalid field per variant.
- Discriminated-union smuggle test: `{ type: "rule", proposed_path: "..." }` rejected (Zod's `discriminatedUnion` already enforces; assertion documents the guarantee).
- Path-traversal: `{ type: "skill-create", proposed_path: "../../etc/passwd" }` rejected via `PathInsideRepoSchema`.
- Promotion-level closed enum: `recommended_promotion_level: "maybe"` rejected.
- ULID guard: malformed `id` (wrong length, lowercase) rejected.
- Empty `proposals: []` round-trips through `RetroProposalFileSchema` cleanly.

**`write-retro-proposal.test.ts`** (writer):
- Happy path: write a file with mixed proposal types into a tmp dir; read back; `parseRetroProposalFile(yaml.parse(frontmatter))` round-trips.
- Body sanity: H2 count equals proposal count; the header carries the right `iso_timestamp`.
- Collision: second call with same `isoTimestamp` throws `RetroProposalAlreadyExistsError`; first file is unchanged.
- Empty `proposals: []`: file written; body contains the "No proposals" sentence; frontmatter `proposals: []`.
- Path-traversal in `isoTimestamp`: `"../escape"` rejected at AC1's validate-before-path-form step. (Defense in depth — the schema rejects, but the test pins the behaviour at the writer's boundary too.)

### Dependencies

None. Schema + tool + tests. The retro-analyst's allowlist update is Story 6.2's AC5; this story does not touch permissions.

### Build artefacts

Standard: rebuild and stage `dist/` in the same commit. Verify deterministic dist post-5.24.

### Edge cases worth surfacing in dev/review

- **ISO timestamp granularity.** ms-precision (`2026-05-28T14:32:11.123Z`) is the convention from `TelemetryEventBase`. Two retros within the same millisecond would collide; the analyst should treat collision as a bug and surface it (the typed error suffices). Operators running `/crew:retro` twice in one second is a corner case worth noting but not engineering against.
- **Frontmatter size.** Skill-create proposals carry a `body` field that could be hundreds of lines. The frontmatter YAML will get large; that's fine — operator-readable rendering is in the body, frontmatter is structured. Don't truncate or summarise.
- **`skill-supersede` nested validation.** The `replacement` field embeds a `skill-create`-shaped object. The current schema uses `z.object(SkillCreateBody).strict()` rather than `SkillCreateProposalSchema` to avoid double-discriminator confusion (the outer `type: "skill-supersede"` is the discriminator; the inner replacement doesn't need its own `type` literal). Confirm this in dev — if it makes the schema harder to maintain, factor SkillCreateBody differently.
- **`last_invoked_at: null` vs absent.** AC6 says `null` when the skill never fired. Use `z.nullable()` not `z.optional()` — null is the explicit "no data" value; absent would mean "didn't measure," which is a different statement. Operators reading the proposal should see `last_invoked_at: null`, not the field missing.
- **`writeManagedFile` context.** Use `role: "retro-analyst"` so the canonical-fs guard's role-trace is meaningful. Don't default to `"orchestrator"` — that misattributes the write.

### Architectural fit / references

- **FR58** (single proposal markdown file under `<target-repo>/.crew/retro-proposals/<ISO>.md`) — `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` line 87. The PRD originally named `_bmad-output/retro-proposals/...`; the epic file (more recent) corrects this to `<target-repo>/.crew/retro-proposals/...`. The epic location is binding.
- **FR59** (the seven proposal types and per-type field shapes) — same file, line 88. The PRD lists three types; the epic file + architecture extend to seven. The epic + architecture are binding.
- **FR106** (team-change predicted-impact field) — same file (search for FR106; defined later in the FR list around team-fitness).
- **Architecture §Skill calibration loop** — `_bmad-output/planning-artifacts/architecture/skill-calibration-loop.md`. The seven types and the inter-relationships (skill-supersede pairs, skill-retire ↔ rule-retirement symmetry) all live here.
- **Existing schema patterns to mirror** — `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` (closed-enum, `.strict()`, typed-error parse helper) and `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` (discriminated union over `type`). The retro-proposal schema sits at the intersection of those two patterns.
- **Deterministic seam principle** — memory `feedback_default_to_deterministic_seams`. Every variant `.strict()`, no `z.string()` fallbacks, validation at write-time AND apply-time (6.4 re-reads through `parseRetroProposalFile`).

## Definition of Done

- [ ] All nine ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; both new test files cover every AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit.
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean — AC1, AC7, AC9 are file-presence; AC3–AC8 are runnable vitest; reviewer's runnable-AC pass should be all-green.
- [ ] No canonical-state mutation outside `<target-repo>/.crew/retro-proposals/` (the new dir is itself a write surface, but it's not yet inputs to any mutation tool until Epic 6b lands).
- [ ] Schema additions are additive only — no existing schema in `src/schemas/` is rewritten or weakened.

## Dev Notes

Shipped as specified — schema shape, writer shape, and test plan match the binding shape in this story. Implementation choices worth noting for Epic 6b apply-path implementers:

- **`skill-supersede.replacement` shape.** Kept as `z.object(SkillCreateBody).strict()` (no inner `type` discriminator). The outer `type: "skill-supersede"` is the only discriminator on the record; the nested `replacement` is just the field-set of a skill-create payload. Apply tools (6.5/6.7) read `proposal.replacement.proposed_path / .frontmatter_description / .body` directly — no `proposal.replacement.type` field exists.
- **`PathInsideRepoSchema` is shared.** `proposed_path`, `target_skill_path`, `superseded_skill_path`, and `replacement.proposed_path` all run through the same refine: rejects leading `/` (absolute) and any `..` segment (traversal). When Epic 6b's apply tools form an absolute path, they MUST still re-resolve and re-validate the join is inside `targetRepoRoot` — defense in depth.
- **`last_invoked_at: null` vs absent.** Schema is `z.nullable()` not `z.optional()`. Apply tools comparing two skill-retire proposals can rely on the field always being present (null or an ISO timestamp).
- **ULID regex on `id` and `target_rule_id`.** Crockford base32 minus I L O U; 26 chars. Identical to the regex used by the `ulid` package.
- **`RETRO_PROPOSAL_TYPES` tuple exported.** Apply-tool handlers can `switch(proposal.type)` with an exhaustiveness check against this tuple — adding an eighth variant will be a TS error at every switch-site.
- **File-level wrapper round-trips.** `parseRetroProposalFile(yaml.parse(<frontmatter>))` is the canonical apply-time re-read. The writer renders frontmatter with `lineWidth: 0` for byte-stable output (idempotency test included).
- **Renderer body shape.** The body is operator-readable scaffolding only — apply tools MUST read the frontmatter (the structured source of truth), never the body. Long fields (`skill-create.body`, `skill-revise.revised_body`, `skill-supersede.replacement.body`) are summarised as a line-count in the body to keep operator reading tractable; the full text remains in the frontmatter.
