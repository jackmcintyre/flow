/**
 * `analyzeTeamFit` MCP tool — Story native:01KVFAF2T7DPJ5T18PQ534D7XM.
 *
 * Reads the live roster, backlog (with spec text + risk tier), and
 * telemetry and emits concrete hire / unhire / gap recommendations
 * where every item carries the evidence (story refs, stall counts) that
 * triggered it.
 *
 * Detection rules are ALL deterministic (no LLM):
 *  - High-risk stories → recommend hiring security-specialist.
 *  - Test-heavy backlog → recommend hiring test-specialist.
 *  - Docs-heavy backlog → recommend hiring docs-specialist.
 *  - Recurring stall (≥2) on an uncovered domain → hire gap (with stall count).
 *  - Specialist with no role-attributable useful work in the window →
 *    unhire candidate, UNLESS removing them would leave the grading panel
 *    unable to staff all five distinct lenses.
 *
 * Input: `{ targetRepoRoot }`.
 * Output: `{ hire: [{role, reason, evidence}], unhire: [{role, reason, evidence}], gaps: [{domain, signal}] }`.
 *
 * This tool builds ONLY the analysis; later stories feed it into the
 * hiring conversation and the retrospective.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { readBacklogInventory } from "./read-backlog-inventory.js";
import { resolveLensRoleBinding } from "./judge-panel.js";
import { TelemetryEventSchema } from "../schemas/telemetry-events.js";
import {
  specialistRoleForDomain,
  ALL_SPECIALIST_ROLES,
} from "../lib/specialist-domain-map.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const AnalyzeTeamFitInputSchema = z.object({
  targetRepoRoot: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** A hire recommendation with the evidence refs / counts that triggered it. */
interface HireRecommendation {
  /** The specialist role to hire (matches catalogue role id). */
  role: string;
  /** Plain-language reason for this recommendation. */
  reason: string;
  /**
   * The concrete evidence: story refs (for backlog-triggered rules) or
   * a stall count string (for the recurring-stall rule). At least one
   * evidence item is always present.
   */
  evidence: string[];
}

/** A recommendation to let a specialist go, with evidence. */
interface UnhireRecommendation {
  /** The specialist role to let go. */
  role: string;
  /** Plain-language reason for this recommendation. */
  reason: string;
  /**
   * Evidence items explaining zero useful work. At least one item is
   * always present (typically "no useful work in the recent window").
   */
  evidence: string[];
}

/** A capability gap: a domain where recurring stalls show the team lacks coverage. */
interface CapabilityGap {
  /** The uncovered domain string (from the stall events). */
  domain: string;
  /** Plain-language signal: stall count and specialist to hire. */
  signal: string;
}

export interface AnalyzeTeamFitResult {
  hire: HireRecommendation[];
  unhire: UnhireRecommendation[];
  gaps: CapabilityGap[];
}

// ---------------------------------------------------------------------------
// Telemetry reader (reads all JSONL from .flow/telemetry/)
// ---------------------------------------------------------------------------

const MONTH_BUCKET_REGEX = /^\d{4}-\d{2}\.jsonl$/;

interface TelemetrySummary {
  /**
   * Number of `yield.handoff` events per (domain, story_id) pair where the
   * target role was NOT hired at event time. Used for the recurring-stall rule.
   * Keyed: domain → Set of story_ids that triggered a stall on it.
   */
  stallsByDomain: Map<string, Set<string>>;
  /**
   * Per-role "useful work" signals from role-attributable events:
   * - `agent.invoke` with agent = role id (direct invocations)
   * - `reviewer.verdict` with agent = role id (reviewer verdicts)
   * Keyed: role → count of attributable events.
   */
  usefulWorkByRole: Map<string, number>;
}

async function readTelemetrySummary(targetRepoRoot: string): Promise<TelemetrySummary> {
  const telemetryDir = path.join(targetRepoRoot, ".flow", "telemetry");
  const stallsByDomain = new Map<string, Set<string>>();
  const usefulWorkByRole = new Map<string, number>();

  let entries: string[];
  try {
    entries = await fs.readdir(telemetryDir);
  } catch {
    // No telemetry yet — return empty.
    return { stallsByDomain, usefulWorkByRole };
  }

  for (const entry of entries) {
    if (!MONTH_BUCKET_REGEX.test(entry)) continue;

    const filePath = path.join(telemetryDir, entry);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const result = TelemetryEventSchema.safeParse(parsed);
      if (!result.success) continue;

      const event = result.data;

      // Role-attributable useful work signals.
      if (event.type === "agent.invoke" || event.type === "reviewer.verdict") {
        const role = event.agent;
        usefulWorkByRole.set(role, (usefulWorkByRole.get(role) ?? 0) + 1);
      }

      // Yield-handoff events reveal stalls: a handoff means the reviewer
      // needed a domain that nobody on the team covered at that moment.
      // `data.domain` is the uncovered domain that caused the yield.
      if (event.type === "yield.handoff") {
        const domain = event.data.domain;
        const storyId = event.story_id ?? "unknown";
        if (!stallsByDomain.has(domain)) {
          stallsByDomain.set(domain, new Set());
        }
        stallsByDomain.get(domain)!.add(storyId);
      }
    }
  }

  return { stallsByDomain, usefulWorkByRole };
}

// ---------------------------------------------------------------------------
// Roster reader (mirrors getTeamSnapshot / resolveLensRoles roster scan)
// ---------------------------------------------------------------------------

/** Enumerate hired roles (role ids with a PERSONA.md in team/). */
async function readHiredRoles(targetRepoRoot: string): Promise<string[]> {
  const teamDir = path.join(targetRepoRoot, "team");

  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(teamDir);
  } catch {
    return [];
  }

  const SKIP_DIRS = new Set(["custom", "_archived"]);
  const hiredRoles: string[] = [];

  for (const entry of dirEntries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path.join(teamDir, entry));
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    try {
      await fs.access(path.join(teamDir, entry, "PERSONA.md"));
    } catch {
      continue;
    }

    hiredRoles.push(entry);
  }

  hiredRoles.sort();
  return hiredRoles;
}

// ---------------------------------------------------------------------------
// Grading-panel guard
// ---------------------------------------------------------------------------

/**
 * Return true iff removing `role` from `hiredRoles` would leave the
 * grading panel unable to staff all five lenses.
 *
 * Uses `resolveLensRoleBinding` (the same algorithm gate-1 uses) over
 * the roster WITHOUT the candidate role. If the call throws
 * `LensJudgeUnavailableError`, the role is essential to the panel.
 */
function wouldBreakPanel(role: string, hiredRoles: string[]): boolean {
  const rosterWithout = hiredRoles.filter((r) => r !== role);
  try {
    resolveLensRoleBinding(rosterWithout);
    return false; // Panel can still staff with remaining roster.
  } catch {
    return true; // Removing this role breaks the panel.
  }
}

// ---------------------------------------------------------------------------
// Backlog spec-text classifiers
// ---------------------------------------------------------------------------

/**
 * Heuristic: does the spec text indicate this story is test-heavy?
 * Looks for test-design language in the spec text.
 */
function isTestHeavy(specText: string): boolean {
  const lower = specText.toLowerCase();
  return (
    /\btest[- ]?(coverage|design|suite|plan|strategy)\b/.test(lower) ||
    /\bwrite tests?\b/.test(lower) ||
    /\btest specialist\b/.test(lower) ||
    /\btest[- ]?heavy\b/.test(lower) ||
    /\btest[- ]?first\b/.test(lower)
  );
}

/**
 * Heuristic: does the spec text indicate this story is documentation work?
 */
function isDocsHeavy(specText: string): boolean {
  const lower = specText.toLowerCase();
  return (
    /\bdocumentation\b/.test(lower) ||
    /\bdocs[- ]?(specialist|work|coverage|update|improve|generate|write)\b/.test(lower) ||
    /\breadme\b/.test(lower) ||
    /\bdocs[- ]?heavy\b/.test(lower) ||
    /\bdocs[- ]?only\b/.test(lower)
  );
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function analyzeTeamFit(rawInput: unknown): Promise<AnalyzeTeamFitResult> {
  const input = AnalyzeTeamFitInputSchema.parse(rawInput);
  const { targetRepoRoot } = input;

  // Read all three inputs in parallel.
  const [hiredRoles, backlog, telemetry] = await Promise.all([
    readHiredRoles(targetRepoRoot),
    readBacklogInventory({
      targetRepoRoot,
      includeSpecText: true,
    }),
    readTelemetrySummary(targetRepoRoot),
  ]);

  const hire: HireRecommendation[] = [];
  const unhire: UnhireRecommendation[] = [];
  const gaps: CapabilityGap[] = [];
  const hiredRoleSet = new Set(hiredRoles);

  // -------------------------------------------------------------------------
  // Hire rules (backlog-triggered)
  // -------------------------------------------------------------------------

  // Rule 1: High-risk stories → security-specialist.
  if (!hiredRoleSet.has("security-specialist")) {
    const highRiskRefs = backlog.backlog_inventory
      .filter((e) => e.riskTier === "high" && !e.withdrawn && e.state !== "done")
      .map((e) => e.ref);

    if (highRiskRefs.length > 0) {
      hire.push({
        role: "security-specialist",
        reason: `${highRiskRefs.length} high-risk stor${highRiskRefs.length === 1 ? "y" : "ies"} in the backlog require security coverage.`,
        evidence: highRiskRefs,
      });
    }
  }

  // Rule 2: Test-heavy backlog → test-specialist.
  if (!hiredRoleSet.has("test-specialist")) {
    const testHeavyRefs = backlog.backlog_inventory
      .filter(
        (e) =>
          !e.withdrawn &&
          e.state !== "done" &&
          e.specText !== undefined &&
          isTestHeavy(e.specText),
      )
      .map((e) => e.ref);

    if (testHeavyRefs.length > 0) {
      hire.push({
        role: "test-specialist",
        reason: `${testHeavyRefs.length} queued stor${testHeavyRefs.length === 1 ? "y" : "ies"} contain test-heavy work that a test specialist should lead.`,
        evidence: testHeavyRefs,
      });
    }
  }

  // Rule 3: Docs-heavy backlog → docs-specialist.
  if (!hiredRoleSet.has("docs-specialist")) {
    const docsHeavyRefs = backlog.backlog_inventory
      .filter(
        (e) =>
          !e.withdrawn &&
          e.state !== "done" &&
          e.specText !== undefined &&
          isDocsHeavy(e.specText),
      )
      .map((e) => e.ref);

    if (docsHeavyRefs.length > 0) {
      hire.push({
        role: "docs-specialist",
        reason: `${docsHeavyRefs.length} queued stor${docsHeavyRefs.length === 1 ? "y" : "ies"} contain documentation work that a docs specialist should own.`,
        evidence: docsHeavyRefs,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Recurring-stall gap rule
  // -------------------------------------------------------------------------

  // Any domain that stalled ≥2 times on work that nobody covered → gap.
  const STALL_THRESHOLD = 2;
  for (const [domain, storySet] of telemetry.stallsByDomain) {
    if (storySet.size < STALL_THRESHOLD) continue;

    const specialistRole = specialistRoleForDomain(domain);
    const stallCount = storySet.size;

    gaps.push({
      domain,
      signal:
        specialistRole !== null
          ? `Work stalled ${stallCount} time${stallCount === 1 ? "" : "s"} on uncovered domain "${domain}". Hiring ${specialistRole} would close this gap.`
          : `Work stalled ${stallCount} time${stallCount === 1 ? "" : "s"} on uncovered domain "${domain}". No specialist in the catalogue maps to this domain.`,
    });

    // Also produce a hire recommendation if there IS a specialist for this domain
    // and they are not already hired.
    if (specialistRole !== null && !hiredRoleSet.has(specialistRole)) {
      // Avoid a duplicate entry (the backlog rules above may already recommend this role).
      const alreadyHireEntry = hire.find((h) => h.role === specialistRole);
      if (!alreadyHireEntry) {
        hire.push({
          role: specialistRole,
          reason: `Work stalled ${stallCount} time${stallCount === 1 ? "" : "s"} waiting for "${domain}" expertise that nobody on the team covers.`,
          evidence: [`stall-count:${stallCount}`, `domain:${domain}`],
        });
      } else {
        // Append the stall signal to the existing hire entry's evidence.
        alreadyHireEntry.evidence.push(`stall-count:${stallCount}`, `domain:${domain}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Unhire rule
  // -------------------------------------------------------------------------

  // Only specialist roles are ever unhire candidates (generalist backbone is
  // never let go by this tool).
  for (const role of hiredRoles) {
    if (!ALL_SPECIALIST_ROLES.includes(role)) continue;

    // Useful-work signal: role-attributable events in telemetry.
    const usefulWork = telemetry.usefulWorkByRole.get(role) ?? 0;
    if (usefulWork > 0) continue; // Has contributed — not a candidate.

    // Grading-panel guard: never recommend unhiring someone the panel needs.
    if (wouldBreakPanel(role, hiredRoles)) continue;

    unhire.push({
      role,
      reason: `${role} produced no useful work in the recent window and their absence would not prevent the grading panel from running.`,
      evidence: ["no useful work in the recent window"],
    });
  }

  return { hire, unhire, gaps };
}
