import { parse as yamlParse } from "yaml";
import { MalformedRiskTieringSpecError } from "../errors.js";
import { RiskTieringSpecSchema } from "../schemas/risk-tiering-spec.js";
/**
 * Pure validator for `docs/risk-tiering.md` (YAML frontmatter + Markdown body).
 *
 * Story 4.9 — FR40a / Architecture § "Risk-Tier Classification (FR40a) — Spec Format".
 *
 * `copyTarget` is the third parameter (path of the shipped default) so that
 * `MalformedRiskTieringSpecError` can cite the canonical shape regardless of
 * whether the file being parsed is the override or the default. The IO wrapper
 * (`lookupRiskTieringSpec`) always knows both paths and passes the default path
 * as `copyTarget`; this keeps the pure validator free of any pluginRoot resolution.
 *
 * Mirrors the structure of `validators/standards-doc.ts` with frontmatter
 * extraction added (standards-doc is pure YAML; risk-tiering.md has a Markdown body).
 */
/**
 * Format a list of Zod issues into a one-line, user-facing string.
 * We surface only the first issue (the most specific). Mirrors the
 * file-local helper in `validators/standards-doc.ts`.
 */
function formatZodIssues(issues) {
    const first = issues[0];
    if (!first)
        return "(no issue details)";
    const dottedPath = first.path.length > 0 ? first.path.join(".") : "<root>";
    return `${dottedPath}: ${first.message}`;
}
/**
 * Extract the YAML block from a `---`-delimited frontmatter file.
 *
 * Returns the raw YAML string (the text between the two `---` lines).
 * Throws `MalformedRiskTieringSpecError` on missing delimiter, empty file,
 * or malformed structure.
 */
function extractFrontmatter(raw, sourcePath, copyTarget) {
    const lines = raw.split("\n");
    // Find the first non-empty line
    const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
    if (firstNonEmptyIdx === -1) {
        throw new MalformedRiskTieringSpecError({
            sourcePath,
            reason: "file is empty or whitespace-only",
            copyTarget,
        });
    }
    if (lines[firstNonEmptyIdx].trim() !== "---") {
        throw new MalformedRiskTieringSpecError({
            sourcePath,
            reason: "missing YAML frontmatter opener (file does not start with '---')",
            copyTarget,
        });
    }
    // Find the closing ---
    const closerIdx = lines.findIndex((l, i) => i > firstNonEmptyIdx && l.trim() === "---");
    if (closerIdx === -1) {
        throw new MalformedRiskTieringSpecError({
            sourcePath,
            reason: "missing YAML frontmatter closer (no second '---' line found)",
            copyTarget,
        });
    }
    return lines.slice(firstNonEmptyIdx + 1, closerIdx).join("\n");
}
/**
 * Parse the contents of a `docs/risk-tiering.md` file (YAML frontmatter
 * + Markdown body) into a typed `RiskTieringSpec`. Pure — no IO.
 *
 * The caller (`lookupRiskTieringSpec`) supplies `sourcePath` for error
 * reporting and to stamp onto the returned value. `copyTarget` is the
 * absolute path of the shipped default so the error message can cite it.
 *
 * Throws `MalformedRiskTieringSpecError` on:
 * - Missing or malformed frontmatter delimiters
 * - YAML syntax errors
 * - Zod schema failures (unknown keys, wrong types, enum mismatches)
 * - Post-Zod invariant violations (duplicate id, min>max threshold)
 */
export function parseRiskTieringSpec(raw, sourcePath, copyTarget) {
    const yamlBlock = extractFrontmatter(raw, sourcePath, copyTarget);
    // YAML parse
    let parsedYaml;
    try {
        parsedYaml = yamlParse(yamlBlock);
    }
    catch (err) {
        throw new MalformedRiskTieringSpecError({
            sourcePath,
            reason: err instanceof Error ? err.message : String(err),
            copyTarget,
        });
    }
    // Zod parse
    const parsed = RiskTieringSpecSchema.safeParse(parsedYaml);
    if (!parsed.success) {
        throw new MalformedRiskTieringSpecError({
            sourcePath,
            reason: formatZodIssues(parsed.error.issues),
            copyTarget,
        });
    }
    const tierNames = ["low", "medium", "high"];
    const seen = new Map();
    for (const tier of tierNames) {
        const rules = parsed.data.tiers[tier] ?? [];
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            const existing = seen.get(rule.id);
            if (existing) {
                throw new MalformedRiskTieringSpecError({
                    sourcePath,
                    reason: `duplicate rule id '${rule.id}' in tiers.${existing.tier}[${existing.index}] and tiers.${tier}[${i}]`,
                    copyTarget,
                });
            }
            seen.set(rule.id, { tier, index: i });
        }
    }
    // Post-Zod invariant: min_lines_changed <= max_lines_changed
    for (const tier of tierNames) {
        const rules = parsed.data.tiers[tier] ?? [];
        for (const rule of rules) {
            const thresholds = rule.diff_size_thresholds;
            if (thresholds?.min_lines_changed !== undefined &&
                thresholds.max_lines_changed !== undefined &&
                thresholds.min_lines_changed > thresholds.max_lines_changed) {
                throw new MalformedRiskTieringSpecError({
                    sourcePath,
                    reason: `min_lines_changed exceeds max_lines_changed in rule ${rule.id}`,
                    copyTarget,
                });
            }
        }
    }
    return { ...parsed.data, sourcePath };
}
