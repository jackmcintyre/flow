# Story 6.5: Rule registry parser and `apply-rule-proposal`

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin maintainer**,
I want **the discipline-rule registry given a real schema and a comment-preserving parser, and the first production apply handler wired into the Story 6.4 gate so that accepting a `rule` proposal actually appends a rule to the registry**,
So that **the calibration loop's "what shouldn't happen again" half stops being inert markdown — an accepted rule proposal mutates one source-of-truth registry, with a stable id and an introduction timestamp, without ever losing the human-authored comments that explain why each rule earns its slot**.

This is the **first real handler to register into the Story 6.4 `/accept-proposal` gate**. Story 6.4 shipped the gate as pure machinery with an empty production registry — every proposal kind fails closed today with a "ships in Story 6.X" error. This story registers exactly one kind: `rule`. It builds two things and deliberately nothing more: (1) the `discipline-rules.yaml` Zod schema plus a **comment-preserving** parse/serialize seam, and (2) the `rule`-kind apply handler that appends (or edits) a rule and registers itself into the gate's production registry. It does **not** regenerate `docs/standards.md` (Story 6.5b owns that, including the ≤10-criteria cap and the version bump) and does **not** handle rule-retirement (Story 6.6 owns retirement generation + the retirement apply path). After this story, accepting a `rule` proposal appends to the registry and commits through the gate; the standards doc stays untouched until 6.5b wires regeneration into the same apply path.

## Dependencies

- **Consumes the Story 6.4 gate seam (shipped):** the `ProposalApplyHandler` interface, `HandlerContext`, `ProposalApplyResult`, the production registry created by `createProductionRegistry()`, and the `KIND_TO_STORY` fail-closed map. This story registers a handler for the `rule` kind into that registry; it does not touch the gate's preview/confirm/commit/stamp/idempotency machinery — that is already proven.
- **Consumes the rule proposal shape from Story 6.3 (shipped):** the `RuleProposalSchema` (`text`, `target_failure_class`, `recommended_promotion_level`) and `parseRetroProposalFile`. The apply handler reads an already-parsed `rule` proposal off a located file; it never re-parses the markdown body.
- **Consumes the existing registry read seam:** `gatherRuleRegistry()` in `gather-retro-inputs.ts` already reads `docs/discipline-rules.yaml` and returns `null` when absent. This story gives that raw read a schema and a writer; the read seam should switch to the new parser so the retro analyst sees a validated registry.
- **Is a prerequisite for** Story 6.5b (regenerate `docs/standards.md` from the registry) and Story 6.6 (promotion-threshold + rule-retirement). Both build directly on the schema and apply path this story defines.
- The registry path `docs/discipline-rules.yaml` is already a **canonical managed-fs path** (writes require an MCP tool context); this story does not change that contract.

## Acceptance Criteria

**AC1 — the rule-registry schema parses and comment-preservingly round-trips `discipline-rules.yaml` (integration):**

A new Zod schema describes the registry file and a parse/serialize seam reads and rewrites it through the `yaml` package's comment-preserving Document API (not the lossy `parse`/`stringify` pair). A registry file carrying inline and leading comments, when read and rewritten with no logical change, round-trips byte-for-byte on its comments — every human-authored comment survives. An absent registry file parses to an empty-but-valid registry (zero rules), never an error, matching the existing `gatherRuleRegistry()` null-tolerance. A malformed registry (a rule missing a required field) raises a typed `RuleRegistryMalformedError` naming the offending rule and the Zod message. A vitest seeds a commented registry, reads it, rewrites it unchanged, and asserts the comments are byte-identical; seeds a malformed registry and asserts the typed error; and asserts an absent file yields an empty registry.
vitest: plugins/crew/mcp-server/src/schemas/__tests__/discipline-rules.test.ts

**AC2 — `apply-rule-proposal` appends an accepted `rule` proposal with a fresh ULID and an introduction timestamp, preserving comments (integration):**

The `rule`-kind apply handler takes an accepted `rule` proposal and appends a new rule to `docs/discipline-rules.yaml` carrying `text` and `target_failure_class` copied from the proposal, `level` set from the proposal's `recommended_promotion_level`, `id` set to a freshly minted ULID, and `introduced_at` set to now (ISO-8601 UTC). It writes through the managed-fs guard with the MCP tool context, returns the single repo-relative path it changed (`docs/discipline-rules.yaml`) so the gate commits it, and makes no commit of its own. Pre-existing rules and all human-authored comments in the file survive the append unchanged. A vitest drives the handler against a seeded registry (with a comment and one prior rule) and asserts: the new rule is present with all five fields, the prior rule and the comment are unchanged, `id` is a valid ULID, `introduced_at` is a valid ISO-8601 timestamp, and the returned `changedPaths` is exactly `["docs/discipline-rules.yaml"]`.
vitest: plugins/crew/mcp-server/src/tools/__tests__/apply-rule-proposal.test.ts

**AC3 — every rule in the post-apply registry validates against the rule schema (integration):**

The rule schema requires `id` (ULID), `text` (non-empty), `target_failure_class` (non-empty), `introduced_at` (ISO-8601), and an optional `level` constrained to `must | should | advisory`; it is `.strict()` (unknown keys are bugs). After an apply, re-parsing the registry validates cleanly and every rule satisfies the schema. A vitest applies a rule, re-parses the registry through the new parser, and asserts every rule passes the schema and the required fields are populated.
vitest: plugins/crew/mcp-server/src/tools/__tests__/apply-rule-proposal.test.ts

**AC4 — the `rule` handler is registered into the production registry and the 6.4 gate applies a `rule` proposal end-to-end (integration):**

`createProductionRegistry()` now returns a registry with the `rule` handler registered (it is no longer empty for that kind). Driving the real `acceptProposal` gate (no injected handlers) against a fresh `rule` proposal — preview then confirm — renders a diff in preview, mutates nothing on preview, and on confirm appends the rule, commits `docs/discipline-rules.yaml` together with the proposal-file stamp in one commit through the git wrapper, stamps the proposal `applied`, and emits one `retro.proposal.applied` telemetry event. A vitest drives the production gate (injecting only the git seam, not the handler) through preview + confirm and asserts the registry changed only on confirm, exactly one commit carried both files, the proposal is stamped, and one telemetry event landed.
vitest: plugins/crew/mcp-server/src/tools/__tests__/apply-rule-proposal.test.ts

**AC5 — re-applying an already-applied `rule` proposal stays an idempotent no-op (integration):**

Because the gate's idempotency is keyed on the proposal's persisted `applied` block (Story 6.4 AC4), re-running the gate against an already-applied `rule` proposal must read the block and no-op — no second rule is appended, no second commit, no second telemetry event — even though the handler is now a real one. A vitest applies a `rule` proposal, then re-invokes the gate on the same id with `confirm: true` and asserts the registry is byte-identical to its post-first-apply state, no second commit was made, and the gate reports `already-applied`.
vitest: plugins/crew/mcp-server/src/tools/__tests__/apply-rule-proposal.test.ts

**AC6 — the schema, parser, handler, and errors are wired with the DomainError envelope, and `rule-retirement` still fails closed pointing at its own story (artifact):**

The rule schema and the comment-preserving parser are exported from a schema module; the apply handler and `RuleRegistryMalformedError` (extending `DomainError`) are defined and the handler is registered into the production registry in `register.ts`, grouped with the other retro-path registrations. The `KIND_TO_STORY` entry for `rule-retirement` is repointed from `"Story 6.5"` to `"Story 6.6"` so that, until Story 6.6 lands its handler, accepting a `rule-retirement` proposal fails closed with an accurate story pointer. No `regenerate-standards` call is added in this story.
artifact: plugins/crew/mcp-server/src/tools/register.ts

## Definition of Done

- [ ] All six ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the two new test files cover every integration AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit (CI fails on `src`/`dist` drift).
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC1–AC5 are runnable vitest, AC6 is file-presence/registration; the reviewer's runnable-AC pass should be all-green.
- [ ] Comment preservation is proven by an assertion on byte-identical comments across a read→rewrite and an append cycle — not merely "the file still parses."
- [ ] Scope held: no `docs/standards.md` regeneration, no rule-retirement handler, no change to the gate's preview/confirm/commit/stamp machinery. The only canonical surface this story's code writes is `docs/discipline-rules.yaml` (via the handler) and the proposal markdown's `applied` stamp (via the gate, unchanged).

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** the `discipline-rules.yaml` Zod schema; a comment-preserving parse/serialize seam (Document API); `RuleRegistryMalformedError`; the `rule`-kind apply handler (`previewDiff` + `apply`); its registration into `createProductionRegistry()`; the `KIND_TO_STORY` repoint for `rule-retirement`; and the switch of `gatherRuleRegistry()`'s raw read to the validated parser.

**Does NOT build (deferred):** `regenerate-standards` and the ≤10-cap + version bump (Story 6.5b), the `rule-retirement` apply path and the promotion/retirement proposal generation (Story 6.6), any skill or team-change handler (6.7 / 6.10). This story keeps the registry as a standalone source of truth; standards regeneration is bolted onto the same apply path by 6.5b. Note this decomposition in the completion notes so the reviewer reads AC4 against a registry-only apply (the standards doc is intentionally untouched here).

### The registry↔standards relationship (why standards is NOT touched here)

Architecture (`skill-calibration-loop.md`) makes `discipline-rules.yaml` the **source of truth** and `docs/standards.md` a **regenerated projection** of it ("rules … live in `discipline-rules.yaml` → regenerated as `docs/standards.md`"). This story builds only the source-of-truth half. Keeping the rule schema minimal (the five fields the epic pins) and confining all rule→criterion projection logic to Story 6.5b is deliberate: it gives 6.5b one clean seam to own the cap, the version bump, and the projection, and avoids speculative criterion fields on the rule before the projection is designed.

### The comment-preserving seam (the load-bearing technical choice)

The plain `yaml.parse` / `yaml.stringify` pair (used elsewhere with `{ lineWidth: 0 }`) **discards comments**. The registry is explicitly human-authored ground-truth that operators annotate, so an append that silently strips their comments is a data-loss bug. Use the `yaml` package's Document API instead: `parseDocument(raw)` returns a CST-backed `Document` that retains comments; mutate via the document node API (e.g. append to the `rules` sequence) and serialize with `doc.toString({ lineWidth: 0 })`. Validate the document's plain-JS view (`doc.toJS()`) against the Zod schema separately — the Document carries comments; the schema guards shape. Pin comment survival with a byte-comparison assertion (AC1, AC2), because a regression here is invisible until an operator notices their notes vanished.

### The rule schema (exactly the epic's fields)

```ts
// plugins/crew/mcp-server/src/schemas/discipline-rules.ts
export const DisciplineRuleSchema = z.object({
  id: z.string().regex(ULID_RE),
  text: z.string().min(1),
  target_failure_class: z.string().min(1),
  introduced_at: z.string().min(1),                 // ISO-8601 UTC
  level: z.enum(["must", "should", "advisory"]).optional(),
}).strict();
export const DisciplineRulesFileSchema = z.object({
  rules: z.array(DisciplineRuleSchema),
}).strict();
```

- `id` and `introduced_at` are minted by the apply handler, never by the proposal author. `text`/`target_failure_class` copy from the proposal; `level` maps from the proposal's `recommended_promotion_level`.
- "Append or edit" (epic wording): for v1 this is append-only when `target_failure_class` is new; if a rule for that class already exists, the handler edits that rule's `text`/`level` in place (matching on `target_failure_class`) rather than appending a duplicate. State the chosen match key in the completion notes.

### The apply handler (registers into the 6.4 gate)

Implement `ProposalApplyHandler` for `type: "rule"`:

- `previewDiff(proposal, ctx)` — render a human-readable before/after of the registry showing the rule that would be appended/edited; **must not write or commit** (the gate's AC2 preview no-op depends on this).
- `apply(proposal, ctx)` — read the registry document, append/edit the rule (fresh ULID, `introduced_at` now), write it through `writeManagedFile` with `mcpToolContext: { toolName: "acceptProposal", role: ctx.role }`, return `{ changedPaths: ["docs/discipline-rules.yaml"] }`. **No commit** — the gate commits.

Register it by having `createProductionRegistry()` build a `Map` with `.set("rule", makeRuleApplyHandler())`. Keep the construction injectable for tests (a clock seam for `introduced_at`, a ULID seam for `id`) so AC2/AC3 can assert deterministic values.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/schemas/discipline-rules.ts` — the rule + registry schema and the comment-preserving parse/serialize seam.
- `plugins/crew/mcp-server/src/lib/apply-rule-proposal.ts` — the `rule`-kind `ProposalApplyHandler` (or co-locate with the registry if cleaner).
- `plugins/crew/mcp-server/src/schemas/__tests__/discipline-rules.test.ts` — AC1.
- `plugins/crew/mcp-server/src/tools/__tests__/apply-rule-proposal.test.ts` — AC2–AC5.

**UPDATE:**
- `plugins/crew/mcp-server/src/lib/proposal-apply-registry.ts` — `createProductionRegistry()` registers the `rule` handler; repoint `KIND_TO_STORY["rule-retirement"]` to `"Story 6.6"`.
- `plugins/crew/mcp-server/src/tools/gather-retro-inputs.ts` — switch `gatherRuleRegistry()`'s raw `yaml.parse` to the new validated parser (still null-tolerant on an absent file).
- `plugins/crew/mcp-server/src/errors.ts` — add `RuleRegistryMalformedError` (mirror the `StandardsDocMalformedError` constructor pattern).
- `plugins/crew/mcp-server/src/tools/register.ts` — only if a standalone registration is needed; the handler registers via the production registry, not as a separate MCP tool.

### Existing seams to wire into (do not reinvent)

- **Gate seam:** `ProposalApplyHandler` / `HandlerContext` / `ProposalApplyResult` / `createProductionRegistry()` / `KIND_TO_STORY` in `plugins/crew/mcp-server/src/lib/proposal-apply-registry.ts`. The gate (`tools/accept-proposal.ts`) owns commit + stamp + telemetry; the handler only mutates the tree and returns changed paths.
- **Managed-fs guard:** `writeManagedFile({ absPath, contents, targetRepoRoot, mcpToolContext })` in `lib/managed-fs.ts`. `docs/discipline-rules.yaml` is already in `CANONICAL_PATH_GLOBS`, so `mcpToolContext` is required.
- **ULID:** `import { ulid } from "ulid"` (as in `tools/mint-session-ulid.ts`).
- **YAML Document API:** the `yaml` package (`^2.9.0`, already a dependency) — `parseDocument` / `doc.toString({ lineWidth: 0 })` for comment preservation.
- **Proposal types:** `RuleProposalSchema`, `RetroProposal`, `parseRetroProposalFile` in `schemas/retro-proposal.ts`.
- **Errors:** `DomainError` base + the `StandardsDocMalformedError` constructor shape in `errors.ts`.
- **Test conventions:** mirror `tools/__tests__/accept-proposal.test.ts` — `mkdtemp` tmpRoot, seed proposals via `writeRetroProposal`, inject the git seam (`gitCommitImpl`), assert on telemetry by reading `.crew/telemetry/*.jsonl`.

### Edge cases worth surfacing in dev/review

- **Absent vs empty registry.** A missing file and a present-but-empty `rules: []` file must both parse to an empty registry; the first append creates the file with the canonical guard.
- **Comment survival across append.** The append must not reorder or reformat existing rules or strip leading/inline comments. Assert byte-identity on the untouched region (AC2).
- **Duplicate `target_failure_class`.** Decide edit-in-place vs append (recommended: edit-in-place on a class match) and pin it with a test so the registry never holds two rules for one class.
- **Idempotency is the gate's, not the handler's.** The handler is not re-entrant-safe on its own; AC5 proves the gate's persisted-`applied` no-op still holds with a real handler behind it.

### Risk + build notes (drain context)

- This is a `medium`-risk change: it registers the first real canonical-state mutation handler into the gate (the registry is now actually mutated on accept). Expect the auto-merge gate to **pause for a human merge** — the intended outcome for this story, not a failure.
- Code change touching schema + lib + tool-registry seams: rebuild and commit `dist/` in the same change; run the full `pnpm build` + `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. Keep the diff scoped to the files above.
- Do not write or edit any `.crew/state` manifest — the orchestration tools own that ledger. The only canonical surface this story's code writes is `docs/discipline-rules.yaml`.

### References

- Epic 6 file, Story 6.5 block; the 2026-05-27 phasing note (6b after self-bootstrap).
- Story 6.4 (shipped) — the gate this handler registers into: `_bmad-output/implementation-artifacts/6-4-accept-proposal-id-skill-diff-then-confirm-gate.md`.
- Architecture: `_bmad-output/planning-artifacts/architecture/skill-calibration-loop.md` ("rules … live in `discipline-rules.yaml` → regenerated as `docs/standards.md`").
- PRD: FR62 (rule registry + apply on accepted proposals).
- Deterministic-seam discipline: the registry is the tool-written source of truth; no load-bearing rule state lives in LLM prose.
