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
import { promises as fs } from "node:fs";
import * as path from "node:path";
import pm from "picomatch";

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

// ---------------------------------------------------------------------------
// Specialist auto-engage: path→area matching
// (Story native:01KVPSZ14HH48J9NEH7N6S6QDR)
// ---------------------------------------------------------------------------

/**
 * Result of a specialist match against a story's cited-source paths.
 */
export interface SpecialistMatchResult {
  /** The role id of the matched specialist. */
  role: string;
  /** The domain string declared on the specialist's persona. */
  domain: string;
}

/**
 * Match a story's cited-source paths against hired specialists' declared
 * `capabilities.path_patterns` to find the specialist whose area covers
 * the story's work.
 *
 * Algorithm:
 *  1. Walk `<targetRepoRoot>/team/`. Skip `custom` and `_archived` (mirrors
 *     lookupRoleByDomain's exclusion list).
 *  2. For each hired role, read its PERSONA.md frontmatter. Skip roles that
 *     lack a `capabilities.path_patterns` declaration (back-compat) or whose
 *     pattern list is empty.
 *  3. For each cited source, test it against every pattern in the role's
 *     `path_patterns` using picomatch. picomatch is already a project
 *     dependency (package.json) used elsewhere in the codebase.
 *  4. Return the FIRST role whose patterns match any cited source.
 *     A story whose cited paths match no hired specialist returns `null`
 *     (generalists-only; the existing no-match path is unchanged).
 *  5. Backbone generalist roles (generalist-dev, generalist-reviewer) are
 *     NEVER auto-engaged as a specialist — they handle all stories already.
 *     Any match against one of them is treated as no-match.
 *
 * Custom and built-in roles are treated identically — no special-casing of
 * role origin (Story native:01KVPSZ14HH48J9NEH7N6S6QDR AC3).
 *
 * @param citedSources - Repo-relative source paths from the story manifest.
 * @param targetRepoRoot - Absolute path to the target repository root.
 * @returns The first specialist whose path_patterns match, or `null` when no
 *          hired specialist's patterns match any cited source.
 */
export async function matchSpecialistByCitedSources(
  citedSources: string[],
  targetRepoRoot: string,
): Promise<SpecialistMatchResult | null> {
  if (citedSources.length === 0) return null;

  const teamDir = path.join(targetRepoRoot, "team");

  let entries: string[];
  try {
    entries = await fs.readdir(teamDir);
  } catch (err) {
    // No team directory — no specialists hired.
    if (isEnoentError(err)) return null;
    throw err;
  }

  const SKIP_DIRS = new Set(["custom", "_archived"]);
  // Backbone generalists are never auto-engaged as a specialist.
  const BACKBONE_ROLES = new Set(["generalist-dev", "generalist-reviewer"]);

  for (const entry of entries.sort()) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    if (BACKBONE_ROLES.has(entry)) continue;

    const personaPath = path.join(teamDir, entry, "PERSONA.md");
    let raw: string;
    try {
      raw = await fs.readFile(personaPath, "utf8");
    } catch {
      continue;
    }

    const frontmatter = extractFrontmatter(raw);
    if (!frontmatter) continue;

    const { capabilities, domain } = frontmatter;
    if (!domain) continue;

    const pathPatterns: string[] =
      capabilities?.path_patterns ?? [];

    if (pathPatterns.length === 0) continue;

    // picomatch: test each cited source against each pattern.
    // pm.isMatch handles both glob and plain-prefix patterns.
    for (const src of citedSources) {
      for (const pattern of pathPatterns) {
        if (pm.isMatch(src, pattern, { dot: true })) {
          return { role: entry, domain };
        }
      }
    }
  }

  return null;
}

/**
 * Parse YAML frontmatter (between the opening and closing `---` fences)
 * from a PERSONA.md string. Returns the `domain` and `capabilities` fields
 * if present, otherwise `null` on any parse failure.
 */
function extractFrontmatter(raw: string): {
  domain: string | undefined;
  capabilities?: { path_patterns?: string[] };
} | null {
  const normalised = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) return null;
  const closeIdx = normalised.indexOf("\n---", 4);
  if (closeIdx === -1) return null;
  const fmRaw = normalised.slice(4, closeIdx);

  // Minimal YAML extraction — only pull `domain:` and `capabilities:` block.
  // Using a simple line-by-line parse to avoid adding a parse dependency.
  let domain: string | undefined;
  let pathPatterns: string[] | undefined;
  let inCapabilities = false;
  let inPathPatterns = false;

  for (const line of fmRaw.split("\n")) {
    // Top-level domain field.
    const domainMatch = line.match(/^domain:\s*["']?([^"'\n]+?)["']?\s*$/);
    if (domainMatch) {
      domain = domainMatch[1]!.trim();
      inCapabilities = false;
      inPathPatterns = false;
      continue;
    }

    // Capabilities block start.
    if (line.match(/^capabilities:\s*$/)) {
      inCapabilities = true;
      inPathPatterns = false;
      continue;
    }

    if (inCapabilities) {
      // path_patterns list start.
      if (line.match(/^\s{2}path_patterns:\s*(?:\[\s*\])?\s*$/)) {
        inPathPatterns = true;
        pathPatterns = [];
        continue;
      }

      // path_patterns inline list.
      const inlineListMatch = line.match(/^\s{2}path_patterns:\s*\[(.+)\]\s*$/);
      if (inlineListMatch) {
        inPathPatterns = false;
        const items = inlineListMatch[1]!
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        pathPatterns = items;
        continue;
      }

      if (inPathPatterns) {
        // Dash-prefixed list item.
        const itemMatch = line.match(/^\s{4}-\s+["']?(.+?)["']?\s*$/);
        if (itemMatch) {
          if (!pathPatterns) pathPatterns = [];
          pathPatterns.push(itemMatch[1]!.trim());
          continue;
        }
        // Non-matching line exits the path_patterns sub-block.
        if (line.trim() !== "") {
          inPathPatterns = false;
        }
      }

      // Any other top-level key exits capabilities block.
      if (line.match(/^[a-z_]/i)) {
        inCapabilities = false;
        inPathPatterns = false;
      }
    }
  }

  return {
    domain,
    capabilities: pathPatterns !== undefined ? { path_patterns: pathPatterns } : undefined,
  };
}

function isEnoentError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
