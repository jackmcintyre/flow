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
import { type Document } from "yaml";
/**
 * A single discipline rule. The five fields the epic pins, nothing more
 * (criterion-projection fields are deliberately deferred to Story 6.5b so that
 * the rule schema stays minimal until the projection is designed):
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
 * `.strict()` — unknown keys are bugs, consistent with every other schema in
 * the codebase.
 */
export declare const DisciplineRuleSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    target_failure_class: z.ZodString;
    introduced_at: z.ZodString;
    level: z.ZodOptional<z.ZodEnum<{
        advisory: "advisory";
        must: "must";
        should: "should";
    }>>;
}, z.core.$strict>;
export type DisciplineRule = z.infer<typeof DisciplineRuleSchema>;
/**
 * The registry file shape: a single `rules` array. `.strict()` on the wrapper.
 * An empty `rules: []` is valid (a registry with zero rules).
 */
export declare const DisciplineRulesFileSchema: z.ZodObject<{
    rules: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        target_failure_class: z.ZodString;
        introduced_at: z.ZodString;
        level: z.ZodOptional<z.ZodEnum<{
            advisory: "advisory";
            must: "must";
            should: "should";
        }>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type DisciplineRulesFile = z.infer<typeof DisciplineRulesFileSchema>;
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
export declare function parseRuleRegistry(raw: string | null, sourcePath?: string): ParsedRuleRegistry;
/**
 * Serialize the comment-preserving Document back to YAML with `{ lineWidth: 0 }`
 * (no wrapping — matches the codebase convention) so comments survive a
 * read→rewrite round-trip byte-for-byte when no logical change is made.
 */
export declare function serializeRuleRegistry(doc: Document): string;
/**
 * Append a fully-formed rule node to the document's `rules` sequence, mutating
 * the Document in place (comments on existing rules survive). The caller is
 * responsible for having validated `rule` against `DisciplineRuleSchema` and
 * for the edit-vs-append decision; this helper only does the structural append.
 *
 * If the document has no `rules` key yet (an empty/absent registry parsed via
 * the empty document), a fresh `rules` sequence is created.
 */
export declare function appendRuleNode(doc: Document, rule: DisciplineRule): void;
/**
 * Replace the rule at `index` in the document's `rules` sequence with `rule`
 * (edit-in-place on a `target_failure_class` match). Comments on OTHER rules
 * survive; the edited rule's node is replaced wholesale with a fresh node
 * carrying the merged fields. The original node's `commentBefore` (the comment
 * that precedes the rule item in the YAML sequence) is preserved on the new
 * node so hand-authored annotations survive a relax/edit operation.
 */
export declare function replaceRuleNode(doc: Document, index: number, rule: DisciplineRule): void;
/**
 * Remove the rule at `index` from the document's `rules` sequence.
 * Comments on OTHER rules survive; the removed rule's node is deleted.
 * Used by the rule-retirement apply handler (Story 6.6).
 */
export declare function removeRuleNode(doc: Document, index: number): void;
