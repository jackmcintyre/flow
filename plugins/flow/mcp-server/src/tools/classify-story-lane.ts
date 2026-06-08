/**
 * `classifyStoryLane` tool — Story native:01KTKJXP6DWN5YHKVG96DH16V0.
 *
 * A pure deterministic classifier over execution-manifest signals that returns
 * `lane: 'fast' | 'full'` before any judge is invoked — so trivial low-risk
 * work can take a cheap path and only substantial work pays for full scrutiny.
 *
 * **Conservative-by-design:**
 * - `fast` requires ALL of: risk_tier = 'low' AND ≤3 cited_sources AND a
 *   safe change intent (docs-only / tests-only / config-or-dead-line-removal /
 *   small-additive). ANY missing signal defaults to `full`.
 * - ANY high.* signal OR any risk_tier other than 'low' forces `full`.
 * - Absent or ambiguous signals (no risk_tier, empty cited_sources) default to
 *   `full` — an unknown story is never cheapened.
 *
 * The author's optional `lane` hint (carried on the manifest or supplied
 * directly) is downgrade-only: a 'fast' hint is honoured only if the
 * classifier independently also returns 'fast'; a 'full' hint always wins.
 *
 * **No I/O:** The classifier is a pure function over manifest fields. It does
 * not load the risk-tiering spec, read the filesystem, or call an LLM. The
 * post-build `classifyRiskTier` on the real diff is the safety backstop.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants: paths / change-types that force full scrutiny
// ---------------------------------------------------------------------------

/**
 * Path-fragment patterns that force `full` regardless of risk_tier.
 * Derived from the high.* rules in risk-tiering.md and the `path_excludes`
 * guard lists used by low.* rules.
 */
const SECURITY_SENSITIVE_PATTERNS: RegExp[] = [
  /migrations?\//i,
  /\.sql$/i,
  /schema\.(ts|js|json|yaml|yml)$/i,
  /\/schemas?\//i,
  // Package manifests and lock files can change behaviour by convention
  /package\.json$/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /\.npmrc$/,
  // Build/test config can change behaviour without import wiring
  /tsconfig.*\.json$/,
  /\.config\.(js|ts|mjs|cjs)$/,
  // Docker and env files
  /Dockerfile(\..*)?$/,
  /\.env(\.|$)/,
  /\.sh$/,
  // CI workflows (convention-wired)
  /\.github\//,
];

/**
 * The safe-intent rule names checked by the classifier (mirrors the `low.*`
 * ids from risk-tiering.md).
 */
const FAST_RULE_IDS = [
  "low.docs-only",
  "low.tests-only",
  "low.config-dead-lines",
  "low.additive-only",
] as const;

type FastRuleId = (typeof FAST_RULE_IDS)[number];

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const StoryLaneResultSchema = z
  .object({
    lane: z.enum(["fast", "full"]),
    /**
     * The rule id that determined the lane.
     * - One of the `FAST_RULE_IDS` when lane = 'fast'.
     * - 'full.high-risk-tier' when risk_tier is 'high'.
     * - 'full.non-low-risk-tier' when risk_tier is 'medium' or missing.
     * - 'full.security-path' when a cited source matches a sensitive pattern.
     * - 'full.no-risk-tier' when risk_tier is absent.
     * - 'full.ambiguous-signals' for any other conservative fall-through.
     * - 'full.hint-override' when the author hint forced full.
     */
    matched_rule: z.string().min(1),
    /**
     * The signals that triggered the matched rule.
     */
    evidence: z.object({
      risk_tier: z.enum(["low", "medium", "high"]).nullable(),
      cited_sources_count: z.number().int().nonnegative(),
      /** The cited source paths that triggered the 'full.security-path' rule, if any. */
      security_paths: z.array(z.string()),
      /** The author hint that was supplied, if any. */
      author_hint: z.enum(["fast", "full"]).nullable(),
    }),
  })
  .strict();

export type StoryLaneResult = z.infer<typeof StoryLaneResultSchema>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Signals drawn from an execution manifest (plus an optional author hint).
 * All fields are optional so the classifier can be called on a partial or
 * freshly-composed manifest with graceful fall-to-full.
 */
export interface ClassifyStoryLaneOptions {
  /**
   * The story ref — used only for logging / telemetry; not part of classification.
   */
  storyId: string;
  /**
   * Risk tier persisted on the manifest by `scanSources` (author-time signal
   * from declared `cited_sources`). `undefined` = not yet stamped → forces
   * `full` (conservative default).
   */
  risk_tier?: "low" | "medium" | "high";
  /**
   * Repo-relative paths declared as `cited_sources` on the source story.
   * Used for security-path matching and scope bounding.
   * `undefined` or empty → forces `full`.
   */
  cited_sources?: string[];
  /**
   * Author-supplied lane hint (optional). Carried on the manifest or passed
   * directly. Downgrade-only: a 'fast' hint is honoured only if the classifier
   * independently also returns 'fast'; a 'full' hint always wins.
   */
  lane_hint?: "fast" | "full";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return true if any cited-source path triggers the security-sensitive guard.
 */
function hasSecurityPath(citedSources: string[]): { found: boolean; paths: string[] } {
  const matched: string[] = [];
  for (const src of citedSources) {
    if (SECURITY_SENSITIVE_PATTERNS.some((re) => re.test(src))) {
      matched.push(src);
    }
  }
  return { found: matched.length > 0, paths: matched };
}

/**
 * Test whether all cited sources match docs-only patterns (mirrors `low.docs-only`
 * from risk-tiering.md, restricted to the pre-build declared paths).
 */
function isDocsOnly(citedSources: string[]): boolean {
  if (citedSources.length === 0) return false;
  return citedSources.every((src) => /docs\//i.test(src) || /\.md$/i.test(src));
}

/**
 * Test whether all cited sources match tests-only patterns (mirrors `low.tests-only`).
 */
function isTestsOnly(citedSources: string[]): boolean {
  if (citedSources.length === 0) return false;
  const TEST_PATTERNS = [/\.test\.ts$/, /\.test\.js$/, /\.test\.d\.ts$/, /__tests__\//, /^tests\//];
  return citedSources.every((src) => TEST_PATTERNS.some((re) => re.test(src)));
}

/**
 * Determine whether the cited sources are all "small-additive" compatible:
 * none of them appear in the path_excludes guard list used by low.additive-only
 * (config, build, lock files, etc.).
 *
 * NOTE: `additive_only` (brand-new files) cannot be confirmed at pre-build time;
 * this check is the next best proxy — if ALL cited sources are brand-new-file
 * targets (paths that don't exist yet can't be excludes), we conservatively allow
 * the intent to classify as low.additive-only only when there are ≤3 of them.
 */
function isAdditiveIntent(citedSources: string[]): boolean {
  if (citedSources.length === 0) return false;
  // The additive-only rule also has path_excludes — any excluded path disqualifies.
  const EXCLUDE_PATTERNS: RegExp[] = [
    /package\.json$/,
    /package-lock\.json$/,
    /pnpm-lock\.yaml$/,
    /yarn\.lock$/,
    /\.npmrc$/,
    /tsconfig.*\.json$/,
    /\.config\.(js|ts|mjs|cjs)$/,
    /Dockerfile(\..*)?$/,
    /\.env(\.|$)/,
    /\.sh$/,
    /\.github\//,
  ];
  return !citedSources.some((src) => EXCLUDE_PATTERNS.some((re) => re.test(src)));
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/**
 * Classify a story's judge lane from its manifest signals.
 *
 * Algorithm (conservative-first):
 *  1. No `risk_tier` → `full` (unknown story is never cheapened).
 *  2. `risk_tier` is 'high' → `full.high-risk-tier`.
 *  3. `risk_tier` is 'medium' → `full.non-low-risk-tier`.
 *  4. `risk_tier` is 'low' but any cited source hits a security-path pattern → `full.security-path`.
 *  5. `risk_tier` is 'low' but cited_sources is empty/absent → `full.ambiguous-signals`.
 *  6. `risk_tier` is 'low' and >3 cited sources → `full.ambiguous-signals` (blast-radius too wide).
 *  7. `risk_tier` is 'low', ≤3 cited sources, safe intent → `fast` with matched rule id.
 *  8. Fallback → `full.ambiguous-signals`.
 *
 * Then apply author hint (downgrade-only):
 *  - If result is already `full`, hint is irrelevant (returns `full`).
 *  - If result is `fast` and hint is `full` → override to `full.hint-override`.
 *  - If result is `fast` and hint is `fast` or absent → honour `fast`.
 *
 * @returns StoryLaneResult with `lane`, `matched_rule`, and `evidence`.
 */
export function classifyStoryLane(opts: ClassifyStoryLaneOptions): StoryLaneResult {
  const { risk_tier, cited_sources, lane_hint } = opts;
  const citedSources = cited_sources ?? [];
  const authorHint = lane_hint ?? null;
  const riskTier = risk_tier ?? null;

  // Helper: build a `full` result.
  function fullResult(matched_rule: string, securityPaths: string[] = []): StoryLaneResult {
    return {
      lane: "full",
      matched_rule,
      evidence: {
        risk_tier: riskTier,
        cited_sources_count: citedSources.length,
        security_paths: securityPaths,
        author_hint: authorHint,
      },
    };
  }

  // Helper: build a `fast` result.
  function fastResult(matched_rule: FastRuleId): StoryLaneResult {
    return {
      lane: "fast",
      matched_rule,
      evidence: {
        risk_tier: riskTier,
        cited_sources_count: citedSources.length,
        security_paths: [],
        author_hint: authorHint,
      },
    };
  }

  // Step 1: No risk_tier → full.
  if (riskTier === null || riskTier === undefined) {
    return fullResult("full.no-risk-tier");
  }

  // Step 2: high risk tier → full.
  if (riskTier === "high") {
    return fullResult("full.high-risk-tier");
  }

  // Step 3: medium risk tier → full.
  if (riskTier === "medium") {
    return fullResult("full.non-low-risk-tier");
  }

  // risk_tier === 'low' from here on.

  // Step 4: Any cited source triggers a security-path pattern → full.
  const { found: hasSecurity, paths: secPaths } = hasSecurityPath(citedSources);
  if (hasSecurity) {
    return fullResult("full.security-path", secPaths);
  }

  // Step 5: No cited sources → ambiguous (can't classify intent) → full.
  if (citedSources.length === 0) {
    return fullResult("full.ambiguous-signals");
  }

  // Step 6: More than 3 cited sources → blast radius too wide for fast lane.
  if (citedSources.length > 3) {
    return fullResult("full.ambiguous-signals");
  }

  // Step 7: Low risk_tier, ≤3 cited sources, no security paths.
  // Check safe-intent rules in priority order (mirrors risk-tiering.md order).

  if (isDocsOnly(citedSources)) {
    return applyHint(fastResult("low.docs-only"), authorHint, fullResult);
  }

  if (isTestsOnly(citedSources)) {
    return applyHint(fastResult("low.tests-only"), authorHint, fullResult);
  }

  if (isAdditiveIntent(citedSources)) {
    return applyHint(fastResult("low.additive-only"), authorHint, fullResult);
  }

  // Step 8: Fallback — low risk_tier but no recognisable safe intent.
  return fullResult("full.ambiguous-signals");
}

/**
 * Apply the author hint as downgrade-only: a 'fast' hint is irrelevant (already
 * fast), a 'full' hint overrides a classifier-fast result to 'full'.
 */
function applyHint(
  classified: StoryLaneResult,
  authorHint: "fast" | "full" | null,
  fullResultFn: (rule: string, paths?: string[]) => StoryLaneResult,
): StoryLaneResult {
  if (classified.lane === "full") return classified; // already full — hint irrelevant
  if (authorHint === "full") return fullResultFn("full.hint-override");
  return classified;
}
