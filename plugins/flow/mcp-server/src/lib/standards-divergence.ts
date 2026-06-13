/**
 * Doc/registry divergence guard — Story native:01KTZ7TAR2W5KDYY9Y4CX1P21R (AC3).
 *
 * Before any regeneration of `docs/standards.md`, callers MUST invoke
 * `assertNoDivergence` to verify that every criterion name in the current
 * standards document is known to the rule registry. If the document holds a
 * criterion the registry does not project, the guard refuses with a typed
 * `StandardsDivergenceError` and changes NOTHING.
 *
 * ## Why fail-closed here?
 *
 * Regeneration is a PURE PROJECTION of the registry. Retirement legitimately
 * drops a criterion from the document by removing its rule from the registry.
 * But if the document holds a criterion that was hand-authored (never through
 * the proposal loop) and the registry does not know about it, a regeneration
 * would SILENTLY DESTROY that criterion. The guard catches this before any write.
 *
 * ## Name-only comparison
 *
 * The guard compares criterion NAMES ONLY, never body text (what / check /
 * anti_criterion). This ensures that a rule using projection-override fields and
 * a rule using templated defaults both pass the guard as long as their projected
 * names match those in the document. Different wording for the same criterion
 * is never a false-positive.
 *
 * ## Integration with the apply handlers
 *
 * Both `apply-rule-proposal.ts` and `apply-rule-retirement.ts` call this guard
 * BEFORE regenerating. In `apply-rule-proposal.ts` the guard runs AFTER the
 * registry is written but BEFORE `regenerateStandards` — the snapshot-rollback
 * machinery already in place for `StandardsCapExceededError` also rolls back
 * when the guard throws, so the caller sees a clean working tree.
 *
 * (Story native:01KTZ7TAR2W5KDYY9Y4CX1P21R — AC3)
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { StandardsDivergenceError } from "../errors.js";
import { STANDARDS_REL_PATH, projectRegistryCriterionNames } from "./regenerate-standards.js";
import { parseStandardsDoc } from "../validators/standards-doc.js";
import type { DisciplineRulesFile } from "../schemas/discipline-rules.js";

/** The repo-relative path of the rule registry (for error messages). */
const REGISTRY_REL_PATH = "docs/discipline-rules.yaml";

/**
 * Assert that the standards document at `<targetRepoRoot>/docs/standards.md`
 * does not contain any criterion whose name is absent from the registry
 * projection. Throws `StandardsDivergenceError` on the first unknown criterion
 * (names are compared in document order); returns `void` on success.
 *
 * When the standards document does not exist (ENOENT / `StandardsDocMissingError`),
 * the guard passes silently — an absent document cannot have unknown criteria,
 * and the first regeneration will create it from the registry.
 *
 * @param registry     The current rule registry (post-mutation for apply handlers).
 * @param targetRepoRoot  Absolute path to the target repository root.
 * @throws {StandardsDivergenceError}  If any document criterion is unknown.
 */
export async function assertNoDivergence(
  registry: DisciplineRulesFile,
  targetRepoRoot: string,
): Promise<void> {
  const absStandardsPath = path.join(targetRepoRoot, STANDARDS_REL_PATH);
  const absRegistryPath = path.join(targetRepoRoot, REGISTRY_REL_PATH);

  // Read the current standards document.
  let raw: string;
  try {
    raw = await fs.readFile(absStandardsPath, "utf8");
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      // Standards doc absent → no criteria to check → guard passes.
      return;
    }
    throw err;
  }

  // Parse the standards document. If it is malformed we let the parse error
  // propagate — a malformed doc is a separate problem from divergence.
  const parsed = parseStandardsDoc(raw, absStandardsPath);
  const docCriteria = parsed.criteria;

  // Project the registry's criterion names.
  const projectedNames = projectRegistryCriterionNames(registry);

  // Check each document criterion against the projected set.
  for (const criterion of docCriteria) {
    if (!projectedNames.has(criterion.name)) {
      throw new StandardsDivergenceError({
        unknownCriterionName: criterion.name,
        registryPath: absRegistryPath,
        standardsPath: absStandardsPath,
      });
    }
  }
}
