/**
 * `getHelpAdvice` — context-aware next-action advisor.
 *
 * Story native:01KVEHE5XNBHKVVZ624GPAW9FF.
 *
 * Reads live project state (team presence, backlog contents and readiness,
 * in-progress builds) and returns the single best next action for the
 * operator to take right now, with the command that performs it.
 *
 * This replaces the anti-pattern of pointing operators at a static command
 * reference — instead it grounds the recommendation in the actual state of
 * the project at the time of the call.
 *
 * Design rationale:
 *  - Pure file reads, no LLM, no network. Fails fast on unexpected IO errors.
 *  - The recommendation logic is a simple priority ladder — topmost matching
 *    condition wins. This is deterministic and independently testable.
 *  - `renderHelpAdvice` is a pure function of the typed `HelpAdvice` result,
 *    enabling unit tests that cover the recommendation text without any IO.
 *  - The MCP handler returns rendered text (not JSON) so the skill body can
 *    print it verbatim.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import { isClaimable } from "../state/manifest-state-machine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The result of advising the operator.
 *
 * `situation` is a short label for the matched state (for testing).
 * `recommendation` is the plain-language suggestion.
 * `command` is the slash command that performs the recommended action.
 */
export interface HelpAdvice {
  situation:
    | "no-team"
    | "parked-drafts"
    | "approved-and-idle"
    | "work-in-progress"
    | "backlog-empty";
  recommendation: string;
  command: string;
}

export interface GetHelpAdviceOptions {
  targetRepoRoot: string;
}

// ---------------------------------------------------------------------------
// State readers (all private — callers go through getHelpAdvice)
// ---------------------------------------------------------------------------

/** Return true iff the `team/` directory contains at least one hired role. */
async function hasHiredTeam(targetRepoRoot: string): Promise<boolean> {
  const teamDir = path.join(targetRepoRoot, "team");
  const SKIP_DIRS = new Set(["custom", "_archived"]);

  let entries: string[];
  try {
    entries = await fs.readdir(teamDir);
  } catch (err) {
    if (isEnoent(err)) {
      return false;
    }
    throw err;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
      continue;
    }
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path.join(teamDir, entry));
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // At least one role directory — team is hired.
      return true;
    }
  }

  return false;
}

/**
 * Read backlog state summary from `.flow/state/`.
 *
 * Returns:
 *  - `readyAndClaimable`: count of to-do items that are ready AND deps-ready
 *    (what `/flow:run` would immediately pick up).
 *  - `parkedDrafts`: count of to-do items that are NOT ready (parked —
 *    awaiting operator approval via `/flow:ready`).
 *  - `inProgressCount`: count of in-progress manifests.
 */
async function readBacklogSummary(targetRepoRoot: string): Promise<{
  readyAndClaimable: number;
  parkedDrafts: number;
  inProgressCount: number;
}> {
  const stateRoot = path.join(targetRepoRoot, ".flow", "state");
  const todoDir = path.join(stateRoot, "to-do");
  const inProgressDir = path.join(stateRoot, "in-progress");
  const doneDir = path.join(stateRoot, "done");

  // Read to-do directory.
  let todoEntries: string[];
  try {
    todoEntries = await fs.readdir(todoDir);
  } catch (err) {
    if (isEnoent(err)) {
      todoEntries = [];
    } else {
      throw err;
    }
  }

  const yamlEntries = todoEntries.filter((f) => f.endsWith(".yaml")).sort();

  let readyAndClaimable = 0;
  let parkedDrafts = 0;

  for (const entry of yamlEntries) {
    const absPath = path.join(todoDir, entry);
    let raw: string;
    try {
      raw = await fs.readFile(absPath, "utf8");
    } catch (err) {
      if (isEnoent(err)) {
        continue;
      }
      throw err;
    }

    const parsed = yamlParse(raw) as unknown;
    const manifest = parseExecutionManifest(parsed, { absPath });

    if (!isClaimable(manifest)) {
      continue;
    }

    // Check if the item is operator-ready.
    if (!manifest.ready) {
      parkedDrafts++;
      continue;
    }

    // Check dep readiness.
    let depsReady = true;
    for (const dep of manifest.depends_on) {
      const depPath = path.join(doneDir, `${dep}.yaml`);
      try {
        await fs.stat(depPath);
      } catch (err) {
        if (isEnoent(err)) {
          depsReady = false;
          break;
        }
        throw err;
      }
    }

    if (depsReady) {
      readyAndClaimable++;
    }
    // A ready but deps-blocked item is neither parked nor claimable — it just
    // waits. We don't count it in either bucket: the advisor will surface the
    // "approved work" bucket based on claimable items only.
  }

  // Count in-progress manifests.
  let inProgressCount = 0;
  try {
    const inProgressEntries = await fs.readdir(inProgressDir);
    inProgressCount = inProgressEntries.filter(
      (f) => f.endsWith(".yaml") && !f.endsWith(".snapshot.yaml"),
    ).length;
  } catch (err) {
    if (!isEnoent(err)) {
      throw err;
    }
  }

  return { readyAndClaimable, parkedDrafts, inProgressCount };
}

// ---------------------------------------------------------------------------
// Priority ladder — pure function (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Map a project-state snapshot to the single best next action.
 *
 * Priority (highest to lowest):
 *  1. No team → hire first.
 *  2. Parked drafts → get them approved before building anything.
 *  3. Approved work waiting, nothing in progress → start a run.
 *  4. Work already in progress → check on it.
 *  5. Nothing queued → plan new work.
 *
 * Pure — no IO. Exported so unit tests can drive the ladder without
 * constructing a real filesystem.
 */
export function advise(snapshot: {
  hasTeam: boolean;
  readyAndClaimable: number;
  parkedDrafts: number;
  inProgressCount: number;
}): HelpAdvice {
  const { hasTeam, readyAndClaimable, parkedDrafts, inProgressCount } = snapshot;

  if (!hasTeam) {
    return {
      situation: "no-team",
      recommendation:
        "Your first step is to set up a team. " +
        "Run /flow:hire to hire a project-shaped team through a short conversation, " +
        "or /flow:hire default to instantly hire the default roster (planner, dev, reviewer, retro-analyst, orchestrator).",
      command: "/flow:hire",
    };
  }

  if (parkedDrafts > 0 && inProgressCount === 0) {
    const count = parkedDrafts === 1 ? "1 draft" : `${parkedDrafts} drafts`;
    return {
      situation: "parked-drafts",
      recommendation:
        `You have ${count} waiting for approval before they can be built. ` +
        "Run /flow:ready to see them, grade each one with the judge panel, and approve the ones you want built next.",
      command: "/flow:ready",
    };
  }

  if (readyAndClaimable > 0 && inProgressCount === 0) {
    const count = readyAndClaimable === 1 ? "1 story" : `${readyAndClaimable} stories`;
    return {
      situation: "approved-and-idle",
      recommendation:
        `You have ${count} approved and ready to build, with nothing currently running. ` +
        "Run /flow:run to start building — the run picks up the next approved story automatically.",
      command: "/flow:run",
    };
  }

  if (inProgressCount > 0) {
    const count = inProgressCount === 1 ? "1 story" : `${inProgressCount} stories`;
    return {
      situation: "work-in-progress",
      recommendation:
        `You have ${count} currently building. ` +
        "Run /flow:dashboard to see the live state of each in-progress story, " +
        "or /flow:run to pick up the next approved story if there is one waiting.",
      command: "/flow:dashboard",
    };
  }

  // Nothing queued — prompt planning.
  return {
    situation: "backlog-empty",
    recommendation:
      "Your backlog is empty — nothing queued, nothing building. " +
      "Run /flow:plan to open a planning conversation and author the next batch of stories.",
    command: "/flow:plan",
  };
}

// ---------------------------------------------------------------------------
// Renderer — pure function (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Render a `HelpAdvice` to the short, plain-language string the operator sees.
 * No trailing newline. Pure — no IO.
 */
export function renderHelpAdvice(advice: HelpAdvice): string {
  return [
    `flow:help — next recommended action: ${advice.command}`,
    "",
    advice.recommendation,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read live project state and return the single best next action for the
 * operator. Combines `hasHiredTeam` and `readBacklogSummary` then runs them
 * through the priority ladder.
 */
export async function getHelpAdvice(
  opts: GetHelpAdviceOptions,
): Promise<HelpAdvice> {
  const { targetRepoRoot } = opts;

  const [hasTeam, backlog] = await Promise.all([
    hasHiredTeam(targetRepoRoot),
    readBacklogSummary(targetRepoRoot),
  ]);

  return advise({
    hasTeam,
    readyAndClaimable: backlog.readyAndClaimable,
    parkedDrafts: backlog.parkedDrafts,
    inProgressCount: backlog.inProgressCount,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
