/**
 * `matchRule` — three-signal AND-combination rule matcher for risk-tier classification.
 *
 * Story 4.9b — Pattern §11, AND-combination semantics.
 *
 * A rule matches when EVERY declared signal field on it matches the diff:
 * - `path_patterns`: if present, AT LEAST ONE `changedPaths` entry matches
 *   AT LEAST ONE pattern (via `picomatch` with default options). With
 *   `all_paths_match: true`, instead EVERY changed file must match a pattern
 *   (and there must be ≥1) — the conservative low-tier semantic.
 * - `change_types`: if present, AT LEAST ONE detected change type appears
 *   in the rule's array.
 * - `diff_size_thresholds`: if present, `diffSize` satisfies the bounds
 *   (`min_lines_changed ≤ diffSize ≤ max_lines_changed`, with absent bounds
 *   treated as -∞ and +∞ respectively).
 * - `additive_only`: if `true`, the PR's diff must be additive-only (every
 *   changed file is a new-file addition — `ctx.additiveOnly`).
 * - `path_excludes`: subtractive guard — if ANY changed file matches any of
 *   these globs, the rule does NOT match, regardless of its positive signals.
 *
 * Absent signal fields are "not declared" and do NOT constrain the match.
 * Story 4.9's schema guarantees every rule declares at least one signal, so
 * the all-absent case is unreachable in production.
 */

import picomatch from "picomatch";
import type { Rule } from "../schemas/risk-tiering-spec.js";
import type { ChangeType } from "../schemas/risk-tiering-spec.js";

export interface MatchRuleContext {
  changedPaths: string[];
  detectedChangeTypes: ChangeType[];
  diffSize: number;
  /**
   * True iff every changed file in the PR is a brand-new file addition — no
   * existing file modified, deleted, or renamed (Stage-2 part C). Consulted
   * only by rules that declare `additive_only: true`. Absent/undefined reads
   * as "not additive" (conservative: such a rule won't match without proof).
   */
  additiveOnly?: boolean;
}

export interface MatchRuleResult {
  matched: boolean;
  /** Subset of `changedPaths` that hit any path_pattern. Empty when no path match occurred. */
  matchedPaths: string[];
}

/**
 * Test whether a single rule matches the diff context.
 *
 * Uses `picomatch` with default options (dot: false). The matcher is compiled
 * once per `path_patterns` array invocation — not cached across rules.
 *
 * @param rule  The parsed `Rule` from the risk-tiering spec.
 * @param ctx   Diff context: paths, detected types, and diff size.
 * @returns `{ matched, matchedPaths }` — `matchedPaths` is populated only
 *          when `path_patterns` was present and matched.
 */
export function matchRule(rule: Rule, ctx: MatchRuleContext): MatchRuleResult {
  // --- path_excludes guard (subtractive) — any excluded path disqualifies ---
  if (rule.path_excludes !== undefined) {
    const isExcluded = picomatch(rule.path_excludes);
    if (ctx.changedPaths.some((p) => isExcluded(p))) {
      return { matched: false, matchedPaths: [] };
    }
  }

  // --- path_patterns signal ---
  let pathSignalSatisfied = rule.path_patterns === undefined; // absent ⇒ satisfied
  let matchedPaths: string[] = [];

  if (rule.path_patterns !== undefined) {
    const isMatch = picomatch(rule.path_patterns);
    matchedPaths = ctx.changedPaths.filter((p) => isMatch(p));
    if (rule.all_paths_match === true) {
      // Conservative (low-tier) semantic: EVERY changed file must match, and
      // there must be at least one. A single non-matching file (e.g. code
      // alongside docs) disqualifies the rule — so an empty diff never matches.
      pathSignalSatisfied =
        ctx.changedPaths.length > 0 && matchedPaths.length === ctx.changedPaths.length;
    } else {
      // Default: AT LEAST ONE changed file matches (correct for high rules).
      pathSignalSatisfied = matchedPaths.length > 0;
    }
  }

  // Short-circuit: path signal failed
  if (!pathSignalSatisfied) {
    return { matched: false, matchedPaths: [] };
  }

  // --- change_types signal ---
  if (rule.change_types !== undefined) {
    const ruleTypeSet = new Set(rule.change_types);
    const typeMatched = ctx.detectedChangeTypes.some((t) => ruleTypeSet.has(t));
    if (!typeMatched) {
      return { matched: false, matchedPaths: [] };
    }
  }

  // --- diff_size_thresholds signal ---
  if (rule.diff_size_thresholds !== undefined) {
    const { min_lines_changed, max_lines_changed } = rule.diff_size_thresholds;
    if (min_lines_changed !== undefined && ctx.diffSize < min_lines_changed) {
      return { matched: false, matchedPaths: [] };
    }
    if (max_lines_changed !== undefined && ctx.diffSize > max_lines_changed) {
      return { matched: false, matchedPaths: [] };
    }
  }

  // --- additive_only signal ---
  if (rule.additive_only === true && !ctx.additiveOnly) {
    return { matched: false, matchedPaths: [] };
  }

  return { matched: true, matchedPaths };
}
