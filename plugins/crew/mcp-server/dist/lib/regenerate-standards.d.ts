/**
 * `regenerate-standards` — pure projection of the discipline-rule registry into
 * `docs/standards.md` (Story 6.5b, FR48).
 *
 * This is a **reusable library function**: the `rule`-apply handler (Story 6.5)
 * calls it after appending a new rule, and the future rule-retirement handler
 * (Story 6.6) will call it after removing/demoting a rule.
 *
 * ## Projection mapping (deterministic, total)
 *
 * A discipline rule carries `{ id, text, target_failure_class, introduced_at, level? }`;
 * a standards criterion needs `{ name, what, check, anti_criterion }`. Mapping:
 *
 *   - `name`          ← `slugifyStandardsCriterion(target_failure_class)`
 *   - `what`          ← the rule's `text` verbatim
 *   - `check`         ← `"Inspect the diff for <target_failure_class>; flag any hunk that exhibits it."`
 *   - `anti_criterion`← `"The failure this rule guards against: <target_failure_class>."`
 *
 * ## Determinism
 *
 * `regenerateStandards` is a **pure function of `(registry, targetVersion, updatedTimestamp)`**:
 * given the same inputs, two calls produce byte-identical YAML. Callers at the
 * apply site compute `targetVersion` once (from the prior doc's version via a
 * patch increment) and supply `updatedTimestamp` via a clock seam.
 *
 * ## Cap enforcement (FR46)
 *
 * If the registry projects more than `cap` criteria (read from `StandardsDocSchema`,
 * not hard-coded), `regenerateStandards` raises `StandardsCapExceededError` BEFORE
 * writing anything. The caller is responsible for any working-tree rollback.
 *
 * ## Seed version
 *
 * When no prior `docs/standards.md` exists, the caller passes `"0.1.0"` as the
 * seed version (documented here so every caller uses the same default).
 *
 * ## YAML output
 *
 * `yaml.stringify(..., { lineWidth: 0 })` — no line wrapping, byte-stable across
 * regenerations with the same inputs. Comment preservation is NOT needed for the
 * regenerated doc (it is fully derived; human-authored comments belong in the
 * rule registry).
 *
 * (Story 6.5b — FR48, FR46, Architecture §Skill calibration loop)
 */
import type { DisciplineRulesFile } from "../schemas/discipline-rules.js";
/** The repo-relative path this function writes. */
export declare const STANDARDS_REL_PATH = "docs/standards.md";
/**
 * The seed version used when no prior `docs/standards.md` exists. Every caller
 * on the happy path reads the prior version via `lookupStandards`; this
 * constant is the documented fallback for the "first-ever regeneration" case.
 */
export declare const STANDARDS_SEED_VERSION = "0.1.0";
export declare const STANDARDS_CRITERIA_CAP: number;
/**
 * Bump a semver patch version deterministically: `x.y.z → x.y.(z+1)`.
 * This is the documented default bump rule for `regenerateStandards`.
 */
export declare function bumpPatchVersion(version: string): string;
/**
 * Options for `regenerateStandards`. All three inputs are required so the
 * function is a pure function of its arguments — no I/O needed for the core
 * projection (I/O only in the write step).
 */
export interface RegenerateStandardsOptions {
    /**
     * The parsed rule registry. Callers pass the post-append registry (after a
     * rule was added or edited), never the pre-append one.
     */
    registry: DisciplineRulesFile;
    /**
     * The semver version to stamp on the regenerated doc. Callers compute this
     * once (e.g. `bumpPatchVersion(priorVersion)`) and pass it here so the
     * function is pure.
     */
    targetVersion: string;
    /**
     * The ISO-8601 timestamp to stamp as `updated` on the regenerated doc.
     * Injected by the caller so two regenerations with a fixed clock produce
     * byte-identical output.
     */
    updatedTimestamp: string;
    /** Absolute path to the target repository root. Used for the write path. */
    targetRepoRoot: string;
    /**
     * MCP tool context for the managed-fs write guard. Callers pass their own
     * `{ toolName, role }` — the guard enforces that `docs/standards.md` can only
     * be written from an MCP tool.
     */
    mcpToolContext: {
        toolName: string;
        role: string;
    };
}
/**
 * Project the rule registry into `docs/standards.md`, writing via
 * `writeManagedFile`, and raise `StandardsCapExceededError` BEFORE writing if
 * the projection would produce more criteria than the cap.
 *
 * ### Atomicity
 * The cap check happens BEFORE any write. If `StandardsCapExceededError` is
 * raised, `docs/standards.md` is left untouched. The caller (the rule-apply
 * handler) must also roll back the registry write before re-raising.
 *
 * ### Determinism
 * Given the same `(registry, targetVersion, updatedTimestamp)`, two calls
 * produce byte-identical output. `yaml.stringify(..., { lineWidth: 0 })` ensures
 * no line-wrapping variation.
 *
 * @throws {StandardsCapExceededError} when `registry.rules.length > cap`.
 */
export declare function regenerateStandards(opts: RegenerateStandardsOptions): Promise<void>;
