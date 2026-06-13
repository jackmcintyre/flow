/**
 * `docs/discipline-rules.yaml` schema + a **comment-preserving** parse/serialize
 * seam — Story 6.5 (FR62).
 *
 * The discipline-rule registry is the **source of truth** for the operator-readable
 * rules the calibration loop accrues ("what shouldn't happen again"). It is
 * explicitly human-authored ground-truth: operators annotate it with comments
 * explaining why each rule earns its slot. `docs/standards.md` is a *regenerated
 * projection* of this registry (Story 6.5b owns that projection); this story builds
 * only the source-of-truth half.
 *
 * **The load-bearing technical choice — comment preservation.** The plain
 * `yaml.parse` / `yaml.stringify` pair (used elsewhere with `{ lineWidth: 0 }`)
 * DISCARDS comments. An append that silently strips operator comments is a
 * data-loss bug that is invisible until someone notices their notes vanished. So
 * the parse/serialize seam uses the `yaml` package's Document API:
 * `parseDocument(raw)` returns a CST-backed `Document` that retains comments;
 * mutate via the document node API (append to the `rules` sequence) and serialize
 * with `doc.toString({ lineWidth: 0 })`. The Zod schema validates the document's
 * plain-JS view (`doc.toJS()`) separately — the Document carries the comments, the
 * schema guards the shape.
 *
 * (Story 6.5 — FR62, Architecture §Skill calibration loop)
 */

import { z } from "zod";
import { parseDocument, isSeq, type Document, YAMLSeq } from "yaml";
import { RuleRegistryMalformedError } from "../errors.js";

// ---------------------------------------------------------------------------
// Primitives + schemas (exactly the epic's five fields)
// ---------------------------------------------------------------------------

/**
 * ULID shape — 26 chars, Crockford's base32 (A–Z 0–9 minus I L O U). Mirrors
 * the regex the `ulid` package emits and the one used in `retro-proposal.ts`.
 */
const UlidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID");

/**
 * A single discipline rule. Core five fields plus optional projection-override
 * fields added in Story native:01KTZ7TAR2W5KDYY9Y4CX1P21R:
 *
 *  - `id`                   — freshly minted ULID (minted by the apply handler,
 *                             never by the proposal author).
 *  - `text`                 — the operator-readable rule text (copied from the
 *                             proposal).
 *  - `target_failure_class` — the failure class the rule guards against (copied
 *                             from the proposal; also the edit-in-place match key).
 *  - `introduced_at`        — ISO-8601 UTC timestamp (stamped by the apply handler).
 *  - `level`                — optional promotion level (`must | should | advisory`),
 *                             mapped from the proposal's `recommended_promotion_level`.
 *
 * Optional projection-override fields (for hand-seeded entries):
 *  - `criterion_name`       — override for the projected criterion's `name` field.
 *                             When absent, the name is derived via
 *                             `slugifyStandardsCriterion(target_failure_class)`.
 *  - `criterion_check`      — override for the projected criterion's `check` field.
 *                             When absent, the templated string is used.
 *  - `criterion_anti`       — override for the projected criterion's `anti_criterion`
 *                             field. When absent, the templated string is used.
 *
 * `.strict()` — unknown keys are bugs, consistent with every other schema in
 * the codebase.
 */
export const DisciplineRuleSchema = z
  .object({
    id: UlidSchema,
    text: z.string().min(1),
    target_failure_class: z.string().min(1),
    introduced_at: z.string().min(1),
    level: z.enum(["must", "should", "advisory"]).optional(),
    // Optional projection-override fields (Story native:01KTZ7TAR2W5KDYY9Y4CX1P21R)
    criterion_name: z.string().min(1).optional(),
    criterion_check: z.string().min(1).optional(),
    criterion_anti: z.string().min(1).optional(),
  })
  .strict();

export type DisciplineRule = z.infer<typeof DisciplineRuleSchema>;

/**
 * The registry file shape: a single `rules` array. `.strict()` on the wrapper.
 * An empty `rules: []` is valid (a registry with zero rules).
 */
export const DisciplineRulesFileSchema = z
  .object({
    rules: z.array(DisciplineRuleSchema),
  })
  .strict();

export type DisciplineRulesFile = z.infer<typeof DisciplineRulesFileSchema>;

// ---------------------------------------------------------------------------
// Comment-preserving parse/serialize seam (the load-bearing seam)
// ---------------------------------------------------------------------------

/**
 * A parsed registry that carries BOTH the comment-preserving `Document` (for a
 * byte-stable rewrite) and the schema-validated plain-JS view (for shape-safe
 * reads and mutation decisions).
 *
 * The `doc` is the CST-backed `yaml` Document — mutate it via the node API and
 * `serializeRuleRegistry(doc)` to rewrite with comments intact. The `data` is
 * the validated `{ rules }` projection.
 */
export interface ParsedRuleRegistry {
  /** The comment-preserving `yaml` Document. Mutate via the node API. */
  doc: Document;
  /** The schema-validated plain-JS view of the registry. */
  data: DisciplineRulesFile;
}

/**
 * The canonical empty-registry document: `rules: []`. Used when the registry
 * file is absent so the first append has a well-formed `rules` sequence to
 * push onto. Built fresh per call (never a shared mutable singleton).
 */
function emptyRegistryDocument(): Document {
  return parseDocument("rules: []\n");
}

/**
 * Parse the registry through the comment-preserving Document API.
 *
 * - `raw === null` (absent file) parses to an empty-but-valid registry (zero
 *   rules) — NEVER an error, matching `gatherRuleRegistry()`'s null-tolerance.
 * - A present file is parsed via `parseDocument` (comments retained) and its
 *   `doc.toJS()` view is validated through the Zod schema.
 * - A malformed registry (a rule missing a required field, an unknown key, a
 *   YAML syntax error) raises a typed `RuleRegistryMalformedError` naming the
 *   offending rule path and the Zod / parse message.
 *
 * @param raw  The raw file contents, or `null` when the file is absent.
 * @param sourcePath  The path used in the error message (for diagnostics).
 * @throws {RuleRegistryMalformedError} On any shape or syntax failure.
 */
export function parseRuleRegistry(
  raw: string | null,
  sourcePath = "docs/discipline-rules.yaml",
): ParsedRuleRegistry {
  if (raw === null) {
    const doc = emptyRegistryDocument();
    return { doc, data: { rules: [] } };
  }

  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new RuleRegistryMalformedError({
      sourcePath,
      yamlPath: "(root)",
      zodMessage: first.message,
    });
  }

  // A document whose top-level value is null (empty file / only comments) is a
  // valid empty registry.
  const js = (doc.toJS() ?? { rules: [] }) as unknown;
  const normalised =
    js && typeof js === "object" && !Array.isArray(js) ? js : { rules: [] };

  const result = DisciplineRulesFileSchema.safeParse(normalised);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const yamlPath = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    throw new RuleRegistryMalformedError({
      sourcePath,
      yamlPath,
      zodMessage: issue.message,
    });
  }

  return { doc, data: result.data };
}

/**
 * Serialize the comment-preserving Document back to YAML with `{ lineWidth: 0 }`
 * (no wrapping — matches the codebase convention) so comments survive a
 * read→rewrite round-trip byte-for-byte when no logical change is made.
 */
export function serializeRuleRegistry(doc: Document): string {
  return doc.toString({ lineWidth: 0 });
}

/**
 * Append a fully-formed rule node to the document's `rules` sequence, mutating
 * the Document in place (comments on existing rules survive). The caller is
 * responsible for having validated `rule` against `DisciplineRuleSchema` and
 * for the edit-vs-append decision; this helper only does the structural append.
 *
 * If the document has no `rules` key yet (an empty/absent registry parsed via
 * the empty document), a fresh `rules` sequence is created.
 */
export function appendRuleNode(doc: Document, rule: DisciplineRule): void {
  let seq = doc.get("rules", true) as unknown;
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    doc.set("rules", seq);
  }
  (seq as YAMLSeq).add(doc.createNode(rule));
}

/**
 * Replace the rule at `index` in the document's `rules` sequence with `rule`
 * (edit-in-place on a `target_failure_class` match). Comments on OTHER rules
 * survive; the edited rule's node is replaced wholesale with a fresh node
 * carrying the merged fields. The original node's `commentBefore` (the comment
 * that precedes the rule item in the YAML sequence) is preserved on the new
 * node so hand-authored annotations survive a relax/edit operation.
 */
export function replaceRuleNode(
  doc: Document,
  index: number,
  rule: DisciplineRule,
): void {
  const seq = doc.get("rules", true) as unknown;
  if (!isSeq(seq)) {
    throw new RuleRegistryMalformedError({
      sourcePath: "docs/discipline-rules.yaml",
      yamlPath: "rules",
      zodMessage: `cannot replace rule at index ${index}: 'rules' is not a sequence`,
    });
  }
  // Preserve the existing node's comment (if any) on the replacement node so
  // hand-authored annotations survive an edit-in-place (relax or text update).
  const existing = (seq as YAMLSeq).items[index] as { commentBefore?: string | null } | undefined;
  const newNode = doc.createNode(rule) as { commentBefore?: string | null };
  if (existing?.commentBefore !== undefined) {
    newNode.commentBefore = existing.commentBefore;
  }
  (seq as YAMLSeq).set(index, newNode);
}

/**
 * Remove the rule at `index` from the document's `rules` sequence.
 * Comments on OTHER rules survive; the removed rule's node is deleted.
 * Used by the rule-retirement apply handler (Story 6.6).
 */
export function removeRuleNode(doc: Document, index: number): void {
  const seq = doc.get("rules", true) as unknown;
  if (!isSeq(seq)) {
    throw new RuleRegistryMalformedError({
      sourcePath: "docs/discipline-rules.yaml",
      yamlPath: "rules",
      zodMessage: `cannot remove rule at index ${index}: 'rules' is not a sequence`,
    });
  }
  (seq as YAMLSeq).delete(index);
}
