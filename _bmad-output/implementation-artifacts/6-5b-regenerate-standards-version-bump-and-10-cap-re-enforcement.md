# Story 6.5b: `regenerate-standards`, version bump, and ≤10-cap re-enforcement

story_shape: substrate
Status: review

## Story

As a **plugin operator**,
I want **`docs/standards.md` deterministically regenerated from the rule registry on every accepted rule change — with a monotonic version bump and a hard refusal (plus a clean rollback) when the registry would project more than ten criteria**,
So that **the reviewer's rubric and the rule registry can never silently drift, the standards doc stays inside the load-bearing ≤10 budget that keeps reviews focused, and a rule that would overflow the budget is refused outright instead of quietly bloating the rubric**.

This story makes `docs/standards.md` a **derived projection** of `docs/discipline-rules.yaml` (per the calibration-loop architecture: "rules … live in `discipline-rules.yaml` → regenerated as `docs/standards.md`"). Story 6.5 built the registry and the `rule` apply handler, which today appends a rule and leaves the standards doc untouched. This story bolts a `regenerate-standards` step onto that same apply path so an accepted rule updates the registry **and** the standards doc in one commit, bumps the standards `version` monotonically, and — critically — enforces the FR46 ≤10-criteria cap by refusing the whole apply (rolling the registry append back out of the working tree) when the projection would exceed ten. It builds only the regeneration + cap + version machinery; it does not change the gate, the registry schema, or add the rule-retirement path (Story 6.6).

## Dependencies

- **Builds directly on Story 6.5:** the `discipline-rules.yaml` schema + comment-preserving parser and the `rule`-kind apply handler. This story extends that handler's `apply` to also regenerate the standards doc (and adds `docs/standards.md` to the handler's `changedPaths` so the gate commits both files together).
- **Consumes the existing standards-doc contract (shipped, Epic 4):** the `StandardsDocSchema` (`version` semver, `updated`, `criteria` `.min(1).max(10)`, each criterion `{ name, what, check, anti_criterion }`, `.strict()`) in `schemas/standards-doc.ts`; `lookupStandards` (reads + parses the current doc, used for the prior version); and `slugify-standards-criterion.ts` (derives a kebab criterion `name`).
- **Consumes the Story 6.4 gate model:** the handler mutates the working tree and returns `changedPaths`; the **gate** makes the single commit. There is therefore no committed state to "git revert" on a cap breach — the rollback is a working-tree restore performed before the handler returns (see Implementation Notes).
- **Is a prerequisite for** Story 6.6's rule-retirement apply path, which must also regenerate standards after removing/demoting a rule (it reuses this story's `regenerate-standards`).

## Acceptance Criteria

**AC1 — `regenerate-standards` projects the registry into a valid `docs/standards.md` deterministically (integration):**

A `regenerate-standards` function reads the parsed rule registry and writes `docs/standards.md` as a valid `StandardsDocSchema` document: each rule projects to exactly one criterion with a non-empty `name`, `what`, `check`, and `anti_criterion` derived deterministically from the rule's fields (see Implementation Notes for the projection). Given the same registry content, the same target version, and a fixed clock, two regenerations produce byte-identical output (the only nondeterministic input — the `updated` timestamp — is injected via a clock seam). The regenerated doc re-parses cleanly through the existing standards parser. A vitest regenerates from a seeded multi-rule registry twice with a fixed clock and asserts byte-identical output, asserts one criterion per rule with all four fields non-empty, and asserts the result re-parses against `StandardsDocSchema`.
vitest: plugins/crew/mcp-server/src/tools/__tests__/regenerate-standards.test.ts

**AC2 — the regenerated standards `version` bumps monotonically from the prior doc (integration):**

`regenerate-standards` reads the prior `docs/standards.md` version (via `lookupStandards`, defaulting to a documented seed version when no standards doc exists yet) and writes a strictly greater semver version on a regeneration that follows an accepted rule change — the bump is deterministic (a patch increment by default) so the same prior version always yields the same next version. Re-parsing the new doc shows the bumped version. A vitest seeds a standards doc at a known version, regenerates after an accepted rule change, and asserts the new version is strictly greater and matches the deterministic bump rule.
vitest: plugins/crew/mcp-server/src/tools/__tests__/regenerate-standards.test.ts

**AC3 — a registry that would project more than ten criteria is refused atomically with a typed cap error (integration):**

When the registry would project more than ten criteria, `regenerate-standards` raises a typed `StandardsCapExceededError` citing the offending criteria count and the cap, **before** writing `docs/standards.md`. On this path, the rule-apply handler restores `docs/discipline-rules.yaml` to its pre-append bytes (working-tree rollback) and re-raises, so the gate commits nothing and the working tree is left byte-identical to its pre-accept state — no half-applied rule, no partial standards doc. A vitest seeds a registry already holding ten rules, drives an accepted eleventh `rule` proposal through the production gate, and asserts: `StandardsCapExceededError` is raised with the count, `docs/discipline-rules.yaml` is byte-identical to its pre-accept content, `docs/standards.md` is unchanged, no commit was made, and no `retro.proposal.applied` telemetry event was emitted.
vitest: plugins/crew/mcp-server/src/tools/__tests__/regenerate-standards.test.ts

**AC4 — accepting a `rule` proposal updates the registry and the standards doc in one commit (integration):**

With regeneration wired into the `rule`-apply path, accepting a (within-cap) `rule` proposal through the production gate appends the rule to `docs/discipline-rules.yaml`, regenerates `docs/standards.md` from the post-append registry, and the gate commits **both files plus the proposal stamp in a single commit**. The handler returns both repo-relative paths in `changedPaths`. A vitest drives an accepted within-cap `rule` proposal through the production gate and asserts both files changed, the standards doc now contains the criterion projected from the new rule, and exactly one commit carried `docs/discipline-rules.yaml`, `docs/standards.md`, and the proposal file together.
vitest: plugins/crew/mcp-server/src/tools/__tests__/regenerate-standards.test.ts

**AC5 — `regenerate-standards` and `StandardsCapExceededError` are wired with the DomainError envelope (artifact):**

`regenerate-standards` is implemented as a reusable library function (so Story 6.6's retirement path can call it) and, if exposed as an MCP tool, registered with the standard `DomainError` envelope. `StandardsCapExceededError` is defined in the errors module extending `DomainError`, carrying the offending criteria count and the cap (mirroring the `StandardsDocMalformedError` constructor shape). The existing `StandardsDocSchema` `.max(10)` cap is preserved and remains the single definition of the cap value, which `regenerate-standards` reads rather than hard-coding `10`.
artifact: plugins/crew/mcp-server/src/lib/regenerate-standards.ts

## Definition of Done

- [ ] All five ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the new test file covers every integration AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit (CI fails on `src`/`dist` drift).
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC1–AC4 are runnable vitest, AC5 is file-presence; the reviewer's runnable-AC pass should be all-green.
- [ ] Determinism is proven by a byte-identical assertion across two regenerations with a fixed clock — not merely "the doc re-parses."
- [ ] Cap rollback is proven by asserting the registry is byte-identical to its pre-accept state on the over-cap path — not merely "the error is thrown."
- [ ] Scope held: no change to the rule schema (6.5), the gate machinery (6.4), or the rule-retirement path (6.6). The cap value stays defined once, in the standards-doc schema.

## Implementation Notes

### The rule→criterion projection (the central design decision)

A discipline rule carries `{ id, text, target_failure_class, introduced_at, level? }`; a standards criterion needs `{ name, what, check, anti_criterion }`, all non-empty. The projection must be **deterministic and total** (every well-formed rule yields a valid criterion). Recommended mapping:

- `name` ← `slugifyStandardsCriterion(target_failure_class)` (reuse the existing helper; this also keys reviewer fire-counts to the failure class, which Story 6.6 depends on).
- `what` ← the rule's `text` verbatim (the rule statement *is* "what the reviewer checks for").
- `check` ← a deterministic template referencing the failure class, e.g. `"Inspect the diff for <target_failure_class>; flag any hunk that exhibits it."`
- `anti_criterion` ← a deterministic template, e.g. `"The failure this rule guards against: <target_failure_class>."`

This keeps Story 6.5's rule schema minimal (the epic's five fields) and confines all projection logic here. The `check`/`anti_criterion` templates are intentionally formulaic for v1; if richer criterion content is wanted later, the cleanest path is to extend the **rule proposal** schema (6.3) additively so the analyst can supply `check`/`anti_criterion`, and have the projection prefer the rule's own values when present and fall back to the templates when absent. Pin the chosen templates in a test so the projection is stable across runs, and record the decision in the completion notes.

### Determinism vs. the version bump (how they coexist)

These two requirements look contradictory ("same registry → identical bytes" vs. "version bumps every accepted change") but are not: regeneration is a **pure function of `(registry, targetVersion, updatedTimestamp)`**. The version bump is computed once at the apply site (read prior version via `lookupStandards`, increment the patch) and passed in as `targetVersion`; the timestamp is injected via a clock seam. Determinism (AC1) is asserted by fixing both inputs and regenerating twice. The monotonic bump (AC2) is asserted by letting the apply site compute the next version from the prior one. Default bump rule: patch increment (`x.y.z → x.y.(z+1)`); state it in the completion notes. Seed version when no standards doc exists yet: document a starting version (e.g. `0.1.0`) so the first regeneration is well-defined.

### Atomicity + the cap rollback (no committed state to revert)

The Story 6.4 gate commits the handler's `changedPaths` **after** `apply` returns. So on a cap breach there is no commit to `git revert`; the requirement is that `apply` leaves the working tree clean. Order inside the rule-apply handler:

1. Snapshot the current `docs/discipline-rules.yaml` bytes.
2. Append the rule to the registry (working tree).
3. Call `regenerate-standards` against the post-append registry.
4. If it raises `StandardsCapExceededError`: restore the registry to the snapshot bytes (working-tree rollback) and re-raise. The gate sees the throw, commits nothing, stamps nothing, emits no telemetry (this reuses the gate's existing partial-failure posture from 6.4 AC3).
5. Otherwise: write the regenerated `docs/standards.md` and return `{ changedPaths: ["docs/discipline-rules.yaml", "docs/standards.md"] }`.

The epic's phrase "reverted via the git wrapper" predates this commit-after-handler model; the deterministic-seam-correct interpretation is **fail-before-commit with a working-tree restore**, which leaves nothing for the operator to clean up. Call this out in the completion notes so the reviewer reads AC3 against a working-tree rollback, not a git revert.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/lib/regenerate-standards.ts` — the pure projection + version-bump function (reusable by 6.5 apply and 6.6 retirement).
- `plugins/crew/mcp-server/src/tools/__tests__/regenerate-standards.test.ts` — AC1–AC4.

**UPDATE:**
- `plugins/crew/mcp-server/src/lib/apply-rule-proposal.ts` (from 6.5) — extend `apply` to regenerate standards, add the cap-rollback ordering, return both changed paths.
- `plugins/crew/mcp-server/src/errors.ts` — add `StandardsCapExceededError` extending `DomainError`.
- `plugins/crew/mcp-server/src/tools/register.ts` — only if `regenerate-standards` is also exposed as a standalone MCP tool; otherwise no registry change (it's a library function the handler calls).

### Existing seams to wire into (do not reinvent)

- **Standards contract:** `StandardsDocSchema` / `CriterionSchema` in `schemas/standards-doc.ts` (the `.max(10)` cap lives here — read it, don't re-hard-code). `lookupStandards` in `state/lookup-standards.ts` for the prior version. `slugify-standards-criterion.ts` for the criterion `name`.
- **Managed-fs guard:** `writeManagedFile` — `docs/standards.md` is canonical, so the MCP tool context is required (same as the registry write).
- **YAML:** `yaml.stringify(..., { lineWidth: 0 })` for byte-stable output (the standards doc is plain front-matter-style YAML; comment preservation is not needed for the regenerated doc, which is fully derived).
- **Gate partial-failure posture:** `tools/accept-proposal.ts` AC3 ordering — a throw from `apply` leaves no commit/stamp/telemetry. Reuse it; do not add a second commit path.

### Edge cases worth surfacing in dev/review

- **Exactly ten is allowed; eleven is refused.** The cap is `≤ 10` (`.min(1).max(10)`). Test the boundary: ten rules regenerate fine, the eleventh is refused.
- **No prior standards doc.** First regeneration must define the seed version and produce a valid doc (≥1 criterion). An empty registry would project zero criteria and violate `.min(1)` — decide and document whether a zero-rule registry is even reachable on the apply path (it is not, because apply always appends first), and what `regenerate-standards` does if called on an empty registry directly (recommended: raise a clear error, since `.min(1)` forbids an empty criteria array).
- **Duplicate failure classes → duplicate criterion names.** Story 6.5 edits-in-place on a class match, so the registry should not hold two rules for one class; assert the projection's `name`s are unique and surface a clear error if not (a defensive guard against a registry that slipped a duplicate in by hand).
- **Determinism regressions are invisible.** A reordering or formatting drift in the projection won't fail parsing — only the byte-identity assertion catches it. Keep it.

### Risk + build notes (drain context)

- This is a `medium`-risk change: it makes accepting a rule mutate two canonical docs and introduces a hard refusal path. Expect the auto-merge gate to **pause for a human merge** — the intended outcome.
- Code change touching lib + errors + the 6.5 handler: rebuild and commit `dist/` in the same change; full `pnpm build` + `pnpm test` green from `plugins/crew/mcp-server` before the PR.
- Do not write any `.crew/state` manifest. The canonical surfaces this story writes are `docs/standards.md` (regenerated) and, via the unchanged 6.5 handler, `docs/discipline-rules.yaml`.

### References

- Epic 6 file, Story 6.5b block.
- Story 6.5 (the registry + rule-apply handler this extends): `_bmad-output/implementation-artifacts/6-5-rule-registry-parser-and-apply-rule-proposal.md`.
- Architecture: `_bmad-output/planning-artifacts/architecture/skill-calibration-loop.md` (rules regenerated as standards).
- Standards-doc contract + cap: `schemas/standards-doc.ts` (FR46, the `.max(10)` cap and the typed-error requirement).
- PRD: FR48 (deterministic standards regeneration + version bump), FR46 (≤10 criteria cap).
