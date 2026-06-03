/**
 * The four `skill-*` apply handlers — Story 6.7.
 *
 * Registers `skill-create`, `skill-revise`, `skill-supersede`, and
 * `skill-retire` into the Story 6.4 diff-then-confirm gate. Accepting a skill
 * proposal writes, replaces, supersedes, or archives a project-scope skill file
 * under `<target-repo>/.flow/skills/` — the **constructive twin** of the rule
 * work (Stories 6.5/6.5b).
 *
 * Each handler implements `ProposalApplyHandler` for its `type`:
 *  - `previewDiff` — renders a human-readable before/after; NO write, NO commit.
 *  - `apply` — performs the file effect(s) via `writeManagedFile` (skill files
 *    live under `.flow/skills/**`, made canonical in Story 6.7), returns the
 *    repo-relative `changedPaths`; NO commit (the gate commits).
 *
 * **Scope (Story 6.7).** This is purely the apply surface. It does NOT build
 * `skill.invoke` telemetry or effectiveness measurement (Story 6.8) — the skill
 * files written here are inert until 6.8 measures their use.
 *
 * **`skill-supersede` is one atomic proposal.** The shipped 6.3 schema models
 * supersede as a SINGLE proposal carrying an embedded `replacement` (not a pair
 * of independently-acceptable halves). One accept applies both halves
 * atomically: write the replacement, then archive the superseded skill. If
 * either half throws, the gate commits nothing (it only commits on a clean
 * apply return) — the effects are ordered (replacement write first, archive
 * second) so a throw never leaves a committed half-applied state.
 *
 * (Story 6.7 — FR63, Architecture §Skill calibration loop)
 */
import type { ProposalApplyHandler } from "./proposal-apply-registry.js";
/**
 * Bump a semver `x.y.z` per the `version_bump` rule:
 *   - `patch` → `x.y.(z+1)`
 *   - `minor` → `x.(y+1).0`
 *
 * Pure so AC2 can assert it deterministically. Throws on a non-semver input
 * (the frontmatter schema guarantees the shape, but the helper is defensive).
 */
export declare function bumpVersion(version: string, bump: "patch" | "minor"): string;
export interface SkillHandlerDeps {
    /** Returns the current instant; the source of `introduced_at` / `retired_at`. */
    now: () => Date;
}
/**
 * Build the four `skill-*` apply handlers. The clock seam is injectable so
 * tests can assert `introduced_at` / `retired_at` deterministically; production
 * passes nothing and the real `Date` clock is used.
 */
export declare function createSkillProposalHandlers(deps?: SkillHandlerDeps): ProposalApplyHandler[];
