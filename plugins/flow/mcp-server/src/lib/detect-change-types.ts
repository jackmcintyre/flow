/**
 * `detectChangeTypes` — infer structured change-type labels from diff signals.
 *
 * Story 4.9b — FR40a (risk-tier classifier v1 heuristic taxonomy).
 * Pattern §11: the classifier's `evidence.change_types` captures what the
 * classifier *saw* — the full detected set — regardless of which rule matched.
 *
 * **v1 taxonomy (four literals — Story 4.9 schema `ChangeType`):**
 * - `migration`  — path inside a `migrations/` or `migration/` directory.
 * - `schema`     — path matching `**\/schema.{sql,prisma,graphql}` or `**\/*.sql`.
 * - `dep-bump`   — path is a known package-manager manifest or lockfile.
 * - `revert`     — any commit message starts with the literal `Revert "`.
 *
 * **Additive extension contract:** adding a new `ChangeType` literal requires a
 * coordinated edit to Story 4.9's `ChangeTypeSchema` enum AND this detector.
 * Do not add literals here without also updating the schema.
 *
 * @param changedPaths   POSIX-style relative paths from the PR diff
 *                       (e.g. `["src/foo.ts", "db/migrations/0001.sql"]`).
 * @param commitMessages Verbatim commit subject lines from the PR.
 * @returns Sorted, deduplicated array of detected `ChangeType` literals.
 */

import * as path from "node:path";
import picomatch from "picomatch";
import type { ChangeType } from "../schemas/risk-tiering-spec.js";

// ---------------------------------------------------------------------------
// Compiled matchers (module-level, compiled once)
// ---------------------------------------------------------------------------

const isMigrationPath = picomatch(["**/migrations/**", "**/migration/**"]);
const isSchemaPath = picomatch(["**/schema.sql", "**/schema.prisma", "**/schema.graphql", "**/*.sql"]);

/** Exact basenames that signal a dep-bump when changed. */
const DEP_BUMP_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Gemfile.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Pipfile",
  "requirements.txt",
]);

// ---------------------------------------------------------------------------
// Per-path classifier (also exported for use in `pathsContributingToChangeTypes`)
// ---------------------------------------------------------------------------

/**
 * Classify a single path into zero or more `ChangeType` labels.
 * Internal helper — exported so `classify-risk-tier.ts` can reuse it.
 *
 * @internal
 */
export function classifyPath(filePath: string): ChangeType[] {
  const types: ChangeType[] = [];
  const basename = path.basename(filePath);

  if (isMigrationPath(filePath)) {
    types.push("migration");
  }
  if (isSchemaPath(filePath)) {
    types.push("schema");
  }
  if (DEP_BUMP_BASENAMES.has(basename)) {
    types.push("dep-bump");
  }
  return types;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect structured change types from a PR's diff signals.
 *
 * @param changedPaths   POSIX-style relative paths changed in the PR.
 * @param commitMessages Verbatim commit subject lines.
 * @returns Sorted lexicographically, deduplicated `ChangeType[]`.
 */
export function detectChangeTypes(
  changedPaths: string[],
  commitMessages: string[],
): ChangeType[] {
  const detected = new Set<ChangeType>();

  for (const filePath of changedPaths) {
    for (const type of classifyPath(filePath)) {
      detected.add(type);
    }
  }

  // `revert` is commit-message-signal only
  for (const msg of commitMessages) {
    if (msg.startsWith('Revert "')) {
      detected.add("revert");
      break; // one revert commit is sufficient
    }
  }

  return [...detected].sort();
}
