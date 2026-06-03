import { type RiskTieringSpec } from "../schemas/risk-tiering-spec.js";
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
export declare function parseRiskTieringSpec(raw: string, sourcePath: string, copyTarget: string): RiskTieringSpec;
