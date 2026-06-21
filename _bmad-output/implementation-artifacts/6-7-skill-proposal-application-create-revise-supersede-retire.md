# Story 6.7: Skill proposal application — create, revise, supersede, retire

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **every skill-shaped retro proposal — create, revise, supersede, retire — to apply through the same diff-then-confirm gate as rules, writing version-controlled skill files with audit-trail frontmatter**,
So that **"what should always happen" gets codified, revised, superseded, and retired with the same discipline as "what shouldn't" — and I can see, approve, and later `git revert` every change to my team's skills**.

This is the **constructive twin** of the rule work (Stories 6.5/6.5b). Where rules codify failures, skills codify repeatable successes (architecture: "Skills are the constructive twin of rules"). Story 6.4 shipped the gate with an empty registry; Story 6.5 registered the first handler (`rule`). This story registers the four `skill-*` handlers — `skill-create`, `skill-revise`, `skill-supersede`, `skill-retire` — so accepting a skill proposal actually writes, replaces, supersedes, or archives a project-scope skill file under `<target-repo>/.crew/skills/`. It builds the skill-frontmatter schema these files carry, makes `.crew/skills/**` canonical (gated like personas and the rule registry), and proves all four paths end-to-end through the production gate. It does **not** build the `skill.invoke` telemetry or effectiveness measurement (Story 6.8) — this story is purely the apply surface.

## Dependencies

- **Consumes the Story 6.4 gate seam (shipped):** `ProposalApplyHandler` / `HandlerContext` / `ProposalApplyResult` / `createProductionRegistry()` / `KIND_TO_STORY` (all four `skill-*` kinds already map to `"Story 6.7"`). This story registers the four handlers into the production registry; the gate's preview/confirm/commit/stamp/idempotency machinery is reused unchanged.
- **Consumes the skill proposal variants from Story 6.3 (shipped):** the `skill-create` / `skill-revise` / `skill-supersede` / `skill-retire` Zod variants in `retro-proposal.ts` (field shapes below) and `parseRetroProposalFile`. Handlers read already-parsed proposals; they never re-parse the markdown body.
- **Mirrors the Story 6.5 pattern:** the comment-preserving write seam and the managed-fs canonical-path posture established for the rule registry. Skill files are markdown-with-frontmatter; the same managed-fs + git-wrapper discipline applies.
- **Is independent of** the rule side (6.5/6.5b/6.6) and the persona/team side (6.9/6.10) — the four handlers register into the gate without touching those surfaces.
- **Pairs with Story 6.8**, which adds invocation telemetry + effectiveness measurement over the skill files this story produces.

## Acceptance Criteria

**AC1 — `skill-create` writes a new project-scope skill with valid audit frontmatter and refuses to overwrite (integration):**

The `skill-create` apply handler reads an accepted `skill-create` proposal (`proposed_path`, `frontmatter_description`, `body`) and writes a new skill file at `<target-repo>/.crew/skills/<name>.md` whose frontmatter carries `name`, `description` (from the proposal), `allowed_tools`, `version: "0.1.0"`, `introduced_at` (now, ISO-8601 UTC), and `source_lesson_refs` (from the proposal's lesson provenance). It writes through the managed-fs guard with the MCP tool context and returns the single repo-relative path it changed; it makes no commit. If a file already exists at the proposed path, the handler raises a typed `SkillAlreadyExistsError` before any write (no overwrite). A vitest drives the handler against a fresh proposal and asserts the file exists with all frontmatter fields, validates against the skill-frontmatter schema, and asserts a second create at the same path raises `SkillAlreadyExistsError` with no mutation.
vitest: plugins/crew/mcp-server/src/tools/__tests__/apply-skill-proposal.test.ts

**AC2 — `skill-revise` archives the prior body, bumps the version, and replaces the body (integration):**

The `skill-revise` apply handler reads an accepted `skill-revise` proposal (`target_skill_path`, `revised_body`, `version_bump: patch | minor`), archives the prior skill file to `<skill>.history/<prior-version>.md`, bumps the frontmatter `version` per `version_bump`, and writes the revised body back to the skill file (frontmatter preserved except the bumped version). A revise targeting a non-existent skill raises a typed `SkillNotFoundError` before any write. The handler returns both changed paths (the skill file and the history file). A vitest drives a revise against a seeded `0.1.0` skill and asserts the prior body is archived at `<skill>.history/0.1.0.md`, the new version matches the bump rule, the body is replaced, and an unknown target raises `SkillNotFoundError` with no mutation.
vitest: plugins/crew/mcp-server/src/tools/__tests__/apply-skill-proposal.test.ts

**AC3 — `skill-supersede` atomically writes the replacement and archives the superseded skill (integration):**

The `skill-supersede` apply handler reads an accepted `skill-supersede` proposal (`superseded_skill_path`, `replacement: { proposed_path, frontmatter_description, body }`) and, in one apply, writes the replacement skill (as in `skill-create`, with a `supersedes:` frontmatter field naming the superseded skill) and archives the superseded skill to `_archived/<name>.md` with `retired_at` stamped. Both effects happen together (one atomic apply per the shipped single-proposal schema — see Implementation Notes); the handler returns both changed paths. A vitest drives a supersede and asserts the replacement exists with `supersedes:` set, the superseded skill is archived with `retired_at`, and both are reflected in the handler's `changedPaths`.
vitest: plugins/crew/mcp-server/src/tools/__tests__/apply-skill-proposal.test.ts

**AC4 — `skill-retire` archives the skill with `retired_at` and preserves history (integration):**

The `skill-retire` apply handler reads an accepted `skill-retire` proposal (`target_skill_path`, `last_invoked_at`) and moves the skill file to `<target-repo>/.crew/skills/_archived/<name>.md` with `retired_at` stamped in its frontmatter; any `<skill>.history/` is preserved (not deleted). The active skill path no longer resolves a live skill after retirement. A retire targeting a non-existent skill raises `SkillNotFoundError`. A vitest drives a retire and asserts the file is gone from the live path, present under `_archived/` with `retired_at`, history preserved, and an unknown target raises `SkillNotFoundError` with no mutation.
vitest: plugins/crew/mcp-server/src/tools/__tests__/apply-skill-proposal.test.ts

**AC5 — all four handlers register into the production gate and apply end-to-end, idempotently (integration):**

`createProductionRegistry()` registers all four `skill-*` handlers. Driving the real `acceptProposal` gate (no injected handlers) through preview + confirm for each kind renders a diff on preview (mutating nothing), and on confirm applies the change, commits the handler's changed paths together with the proposal stamp in one commit through the git wrapper, stamps the proposal `applied`, and emits one `retro.proposal.applied` event. Re-accepting an already-applied skill proposal reads the persisted `applied` block and no-ops (no second file write, commit, or telemetry). A vitest drives at least `skill-create` and `skill-revise` through the production gate (injecting only the git seam) and asserts the preview-no-op, the single combined commit, the stamp, one telemetry event, and the idempotent re-accept.
vitest: plugins/crew/mcp-server/src/tools/__tests__/apply-skill-proposal.test.ts

**AC6 — skill files are canonical, the frontmatter schema and typed errors are wired, and all four kinds resolve to registered handlers (artifact):**

`.crew/skills/**` is added to `CANONICAL_PATH_GLOBS` so skill writes are gated like personas and the rule registry. A skill-frontmatter Zod schema (`name`, `description`, `allowed_tools`, `version` semver, `introduced_at`, `source_lesson_refs`, optional `supersedes`, optional `retired_at`), `.strict()`, is defined and exported. `SkillAlreadyExistsError` and `SkillNotFoundError` are defined extending `DomainError`. After registration, none of the four `skill-*` kinds fails closed — `KIND_TO_STORY`'s `"Story 6.7"` pointers all resolve to real handlers.
artifact: plugins/crew/mcp-server/src/lib/proposal-apply-registry.ts

## Definition of Done

- [ ] All six ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the new test file covers every integration AC clause across all four kinds.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit (CI fails on `src`/`dist` drift).
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC1–AC5 are runnable vitest, AC6 is file-presence/registration; the reviewer's runnable-AC pass should be all-green.
- [ ] Skill writes go through the managed-fs guard (canonical) and the gate's single commit — no handler commits on its own, no raw `fs.write` to `.crew/skills/`.
- [ ] Scope held: no `skill.invoke` telemetry, no effectiveness measurement (Story 6.8); no change to the gate machinery (6.4) or the rule side (6.5/6.5b/6.6).

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** the skill-frontmatter Zod schema; the `.crew/skills/**` canonical glob; the four `skill-*` apply handlers (`previewDiff` + `apply` each); their registration into `createProductionRegistry()`; `SkillAlreadyExistsError` + `SkillNotFoundError`; the history/archive write conventions.

**Does NOT build (deferred):** `skill.invoke` telemetry, `recordSkillInvoke`, `computeSkillEffectiveness` (all Story 6.8); any rule, persona-append, or team-change handler. The skill files this story writes are inert until 6.8 measures their use.

### The shipped proposal variants (read, do not redefine)

From `schemas/retro-proposal.ts` (Story 6.3, shipped):

- `skill-create`: `{ proposed_path, frontmatter_description, body }`
- `skill-revise`: `{ target_skill_path, revised_body, version_bump: "patch" | "minor" }`
- `skill-supersede`: `{ superseded_skill_path, replacement: { proposed_path, frontmatter_description, body } }`
- `skill-retire`: `{ target_skill_path, last_invoked_at }`

All carry `ProposalBase` (`id`, `created_at`, `rationale`, optional `applied`).

### `skill-supersede` is one atomic proposal (divergence from the epic wording)

The epic describes supersede as a "pair" where "either half can be accepted independently." The **shipped 6.3 schema** models it as a **single** `skill-supersede` proposal carrying an embedded `replacement`. Honour the shipped schema: one accept applies both halves atomically (write the replacement, archive the superseded skill). This matches the gate's one-proposal-one-accept contract and avoids a schema change. If independent acceptance is wanted later, it would be modelled as two linked proposals (a future schema-change story) — note this in the completion notes so the reviewer reads AC3 against the atomic model, not the "either half" wording.

### Make `.crew/skills/**` canonical (the gating decision)

Skill files are version-controlled team state the operator reads and diffs — symmetric with `team/**` (personas) and `docs/discipline-rules.yaml` (rules), all of which are canonical. Add `.crew/skills/**` to `CANONICAL_PATH_GLOBS` in `lib/managed-fs.ts` so every skill write must go through `writeManagedFile` with an `mcpToolContext` — closing the same "no raw fs.write to canonical state" hole the standards criterion `no-canonical-fs-writes-outside-mcp` guards. Handlers pass `mcpToolContext: { toolName: "acceptProposal", role: ctx.role }`.

### The skill-frontmatter schema

```ts
// plugins/crew/mcp-server/src/schemas/skill-frontmatter.ts
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),                                  // "<plugin>:<command>"
  description: z.string().min(1),
  allowed_tools: z.array(z.string()),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  introduced_at: z.string().min(1),                         // ISO-8601 UTC
  source_lesson_refs: z.array(z.string()),                  // audit trail (story-ref#lesson)
  supersedes: z.string().optional(),                        // set on supersede
  retired_at: z.string().optional(),                        // set on retire; only in _archived/
}).strict();
```

`version_bump` semantics: `patch` → `x.y.(z+1)`; `minor` → `x.(y+1).0`. `version` starts at `0.1.0` on create. Keep the bump in a tiny pure helper so AC2 can assert it deterministically.

### The four handlers (register into the 6.4 gate)

Each implements `ProposalApplyHandler` for its `type`:

- `previewDiff` — render a human-readable before/after (new file, body replacement, supersede pair, or archive move); **no write/commit**.
- `apply` — perform the file effect(s) via `writeManagedFile` (and, for revise/retire/supersede, the archive write/move), return the repo-relative `changedPaths`; **no commit** (the gate commits).

Register by extending `createProductionRegistry()` to `.set(...)` all four handlers. Keep a clock seam (`introduced_at` / `retired_at`) injectable for deterministic tests.

### Archive + history conventions (reuse the atomic write pattern)

- **Revise history:** copy the prior file to `<skill>.history/<prior-version>.md` before replacing (so a reviewer can see every prior body). Use `writeManagedFile` (history lives under `.crew/skills/**`, now canonical).
- **Retire / supersede archive:** move the superseded/retired file to `.crew/skills/_archived/<name>.md` with `retired_at` stamped. Preserve any `<skill>.history/`. There is no dedicated move helper; do read-then-write-then-(remove via the managed-fs guard or rename) following the atomic `.tmp` rename pattern already in `managed-fs.ts`.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/schemas/skill-frontmatter.ts` — the frontmatter schema.
- `plugins/crew/mcp-server/src/lib/apply-skill-proposal.ts` — the four `skill-*` handlers (or one module per kind if cleaner).
- `plugins/crew/mcp-server/src/tools/__tests__/apply-skill-proposal.test.ts` — AC1–AC5.

**UPDATE:**
- `plugins/crew/mcp-server/src/lib/managed-fs.ts` — add `.crew/skills/**` to `CANONICAL_PATH_GLOBS`.
- `plugins/crew/mcp-server/src/lib/proposal-apply-registry.ts` — register the four handlers in `createProductionRegistry()`.
- `plugins/crew/mcp-server/src/errors.ts` — add `SkillAlreadyExistsError`, `SkillNotFoundError` extending `DomainError`.

### Existing seams to wire into (do not reinvent)

- **Gate seam:** `proposal-apply-registry.ts` + `tools/accept-proposal.ts` (gate owns commit/stamp/telemetry).
- **Managed-fs:** `writeManagedFile` + `CANONICAL_PATH_GLOBS` + the atomic `.tmp` rename pattern in `lib/managed-fs.ts`.
- **Proposal types + parser:** `retro-proposal.ts` (`parseRetroProposalFile`, the four `skill-*` variants).
- **Frontmatter split:** `splitFrontmatter` in `lib/markdown-frontmatter.ts`; `yaml.parse`/`yaml.stringify({ lineWidth: 0 })` (skill files are derived/managed; comment preservation is not required, unlike the hand-annotated rule registry).
- **Errors:** `DomainError` base + an existing typed-error constructor in `errors.ts`.
- **Test conventions:** mirror `tools/__tests__/accept-proposal.test.ts` — tmpRoot, seed proposals via `writeRetroProposal`, inject the git seam, assert telemetry by reading `.crew/telemetry/*.jsonl`.

### Edge cases worth surfacing in dev/review

- **Create over an existing path** → `SkillAlreadyExistsError`, no overwrite (AC1).
- **Revise/retire/supersede a missing skill** → `SkillNotFoundError`, no mutation.
- **Path containment.** `proposed_path` / `target_skill_path` use the proposal's `PathInsideRepoSchema`; reject any path escaping `.crew/skills/` before writing.
- **Atomicity of supersede.** If the archive half fails after the replacement write (or vice-versa), leave the tree clean (the gate commits nothing on a throw — reuse the 6.4 partial-failure posture). Order the effects so a throw leaves no half-applied state, and note the ordering.
- **History collision.** Revising twice at the same version must not clobber an existing `<skill>.history/<version>.md`; the version bump makes this unlikely, but assert the archive name derives from the *prior* version.

### Risk + build notes (drain context)

- This is a `medium`-risk change: it registers four canonical-state mutation handlers and makes `.crew/skills/**` gated. Expect the auto-merge gate to **pause for a human merge**.
- Code change touching schema + lib + managed-fs + errors + registry: rebuild and commit `dist/` in the same change; full `pnpm build` + `pnpm test` green from `plugins/crew/mcp-server` before the PR.
- Do not write any `.crew/state` manifest. Canonical surfaces written: `.crew/skills/**` (skills, history, archive) via the handlers.

### References

- Epic 6 file, Story 6.7 block.
- Story 6.4 (the gate): `_bmad-output/implementation-artifacts/6-4-accept-proposal-id-skill-diff-then-confirm-gate.md`.
- Story 6.5 (the rule handler — the pattern this mirrors): `_bmad-output/implementation-artifacts/6-5-rule-registry-parser-and-apply-rule-proposal.md`.
- Architecture: `_bmad-output/planning-artifacts/architecture/skill-calibration-loop.md` (skill proposal types, scopes, frontmatter, archive conventions).
- PRD: FR63 (skill-create apply); the revise/supersede/retire paths the architecture adds alongside it.
