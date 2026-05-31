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
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { writeManagedFile } from "./managed-fs.js";
import { slugifyStandardsCriterion } from "./slugify-standards-criterion.js";
import { StandardsCapExceededError } from "../errors.js";
import { StandardsDocSchema } from "../schemas/standards-doc.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** The repo-relative path this function writes. */
export const STANDARDS_REL_PATH = "docs/standards.md";
/**
 * The seed version used when no prior `docs/standards.md` exists. Every caller
 * on the happy path reads the prior version via `lookupStandards`; this
 * constant is the documented fallback for the "first-ever regeneration" case.
 */
export const STANDARDS_SEED_VERSION = "0.1.0";
/** Tool name threaded into the managed-fs role-trace for the standards write. */
const TOOL_NAME = "acceptProposal";
// ---------------------------------------------------------------------------
// Cap — read from the schema, never hard-coded
// ---------------------------------------------------------------------------
/**
 * Extract the hard cap from `StandardsDocSchema`'s `criteria` array definition
 * at import time. The cap is `.max(10)` per FR46; this accessor reads the
 * schema's own `maxLength` rather than duplicating the literal `10` here.
 *
 * If the schema shape changes (e.g. a future story relaxes the cap), this
 * automatically picks up the new value without a code change here.
 */
function readCapFromSchema() {
    // Zod v3 stores array constraints on `._def.maxLength`.
    // We access it defensively, falling back to 10 (the documented FR46 value)
    // so a schema refactor never silently removes the cap guard.
    const criteriaField = StandardsDocSchema.shape.criteria;
    const maxLength = criteriaField._def
        .maxLength;
    if (maxLength !== undefined && typeof maxLength.value === "number") {
        return maxLength.value;
    }
    // Fallback: the documented FR46 cap. A test asserts this path is never taken
    // (i.e. the schema always carries the constraint), so the fallback is only
    // a safety net against a future schema change that removes _def.maxLength.
    return 10;
}
export const STANDARDS_CRITERIA_CAP = readCapFromSchema();
// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------
/**
 * Project one discipline rule into one standards criterion. Deterministic and
 * total (every well-formed rule produces a valid criterion).
 */
function projectRuleToCriterion(rule) {
    return {
        name: slugifyStandardsCriterion(rule.target_failure_class),
        what: rule.text,
        check: `Inspect the diff for ${rule.target_failure_class}; flag any hunk that exhibits it.`,
        anti_criterion: `The failure this rule guards against: ${rule.target_failure_class}.`,
    };
}
/**
 * Bump a semver patch version deterministically: `x.y.z → x.y.(z+1)`.
 * This is the documented default bump rule for `regenerateStandards`.
 */
export function bumpPatchVersion(version) {
    const parts = version.split(".");
    if (parts.length !== 3) {
        throw new Error(`bumpPatchVersion: expected a semver string 'x.y.z', got '${version}'`);
    }
    const patch = parseInt(parts[2], 10);
    if (Number.isNaN(patch)) {
        throw new Error(`bumpPatchVersion: patch segment '${parts[2]}' is not a number in '${version}'`);
    }
    return `${parts[0]}.${parts[1]}.${patch + 1}`;
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
export async function regenerateStandards(opts) {
    const { registry, targetVersion, updatedTimestamp, targetRepoRoot, mcpToolContext } = opts;
    // Project every rule to a criterion. Check for duplicate names (defensive
    // guard against a registry that slipped in two rules for the same failure
    // class by hand).
    const criteria = registry.rules.map(projectRuleToCriterion);
    // --- Cap check BEFORE any write ---
    if (criteria.length > STANDARDS_CRITERIA_CAP) {
        throw new StandardsCapExceededError({
            criteriaCount: criteria.length,
            cap: STANDARDS_CRITERIA_CAP,
        });
    }
    // --- Duplicate-name guard ---
    const names = criteria.map((c) => c.name);
    const seen = new Set();
    for (const name of names) {
        if (seen.has(name)) {
            throw new Error(`regenerate-standards: duplicate criterion name '${name}' in projection. ` +
                `Two or more rules in the registry share the same target_failure_class ` +
                `(or classes that slugify identically). Remove the duplicate rule. ` +
                `(Story 6.5b)`);
        }
        seen.add(name);
    }
    // --- Build the standards doc ---
    const doc = {
        version: targetVersion,
        updated: updatedTimestamp,
        criteria,
    };
    // Validate against the schema as a sanity check (should always pass given the
    // cap and duplicate guards above, but schema validation is cheap and prevents
    // silent drift if the schema changes).
    const result = StandardsDocSchema.safeParse(doc);
    if (!result.success) {
        throw new Error(`regenerate-standards: projected doc failed StandardsDocSchema validation: ` +
            `${result.error.issues[0]?.message ?? "unknown"}. ` +
            `This is a programming error in the projection logic. (Story 6.5b)`);
    }
    // --- Write via the managed-fs guard ---
    const contents = yamlStringify(doc, { lineWidth: 0 });
    const absPath = path.join(targetRepoRoot, STANDARDS_REL_PATH);
    await writeManagedFile({
        absPath,
        contents,
        targetRepoRoot,
        mcpToolContext,
    });
}
