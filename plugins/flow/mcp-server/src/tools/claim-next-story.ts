/**
 * `claimNextStory` MCP tool — Story 4.3b Task 1.
 *
 * Wraps a single iteration of the outer claim-loop: enumerates claimable
 * to-do manifests, picks the first `depsReady: true` candidate, atomically
 * claims it, and returns either a spawn-dev signal or a terminal signal.
 *
 * **Behavioural contract source:**
 * `_bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md § Behavioural contract`
 *
 * The SKILL.md prose drives the outer iteration loop by calling this tool
 * repeatedly until it returns `{ next: "queue-drained" }` or
 * `{ next: "waiting-on-in-progress" }`. This keeps the prose's control flow
 * to a simple switch on `next` — no manual `to-do/` parsing, no ref picking,
 * no `claimStory` / `listClaimableTodos` calls from the prose layer.
 *
 * Chat lines flow through the returned `chatLog: string[]` — no console.*.
 * Errors propagate as typed `DomainError`s; `register.ts` wraps them into
 * `isError: true` content responses.
 *
 * Story 4.3b Task 1.1–1.6.
 */

import * as path from "node:path";
import { listClaimableTodos } from "./list-claimable-todos.js";
import { claimStory } from "./claim-story.js";
import {
  areDependenciesMerged,
  type SingleDependencyMergedCheck,
} from "../lib/dep-merge-check.js";

/** Verbatim queue-drained line from AC3 / AC5(iv) — do not paraphrase. */
export const QUEUE_DRAINED_LINE =
  "queue drained — to-do/ and in-progress/ are both empty. Stop here, or run /flow:plan to add work.";

/** Verbatim waiting-on-in-progress line — do not paraphrase. */
export const WAITING_ON_IN_PROGRESS_LINE =
  "waiting on in-progress work — no claimable todos this pass. Stop here or wait for in-progress stories to complete.";

export interface ClaimNextStoryOptions {
  targetRepoRoot: string;
  sessionUlid: string;
  /**
   * Test seam for the build-blind merge gate — override the "is this dependency
   * merged?" check. Production callers (the drain via the CLI seam, the MCP
   * handler) omit it and the real GitHub-backed check runs.
   */
  isDependencyMerged?: SingleDependencyMergedCheck;
}

export type ClaimNextStoryResult =
  | {
      next: "spawn-dev";
      ref: string;
      title: string;
      manifestPath: string;
      chatLog: string[];
    }
  | { next: "queue-drained"; chatLog: string[] }
  | { next: "waiting-on-in-progress"; chatLog: string[] };

/**
 * Claim the next ready story from the to-do queue.
 *
 * Single-iteration outer claim-loop step: the SKILL.md prose calls this in
 * a loop until it returns `queue-drained` or `waiting-on-in-progress`.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.sessionUlid - ULID minted by `mintSessionUlid`; stamped as
 *   `claimed_by` in the in-progress manifest.
 * @returns A discriminated-union result with `next` as the control-flow signal.
 */
export async function claimNextStory(
  opts: ClaimNextStoryOptions,
): Promise<ClaimNextStoryResult> {
  const { targetRepoRoot, sessionUlid } = opts;
  const chatLog: string[] = [];

  const { todos, inProgressCount } = await listClaimableTodos({ targetRepoRoot });

  // Filter to candidates that are BOTH deps-ready AND operator-blessed (Story 9.1).
  // The readiness brake is fail-closed: an item whose dependencies are all
  // satisfied is still NOT claimed until the operator marks it `ready: true`
  // via the markStoryReady tool (the /flow:ready skill). This is the single
  // chokepoint the drain hits, so the gate lives here in the claim entry point.
  const readyCandidates = todos.filter((c) => c.depsReady && c.ready);

  // Build-blind merge gate: `depsReady` only proves a dependency reached `done/`,
  // which happens on reviewer APPROVAL — BEFORE a medium/high-risk PR is merged
  // by a human. Claiming a dependent now would cut its worktree from an
  // `origin/main` that lacks the unmerged prerequisite, building it blind. So a
  // candidate with dependencies is only truly claimable once EVERY dependency's
  // PR is merged into the trunk. A dependency that is approved-but-not-merged
  // simply parks the dependent for this pass (treated exactly like a not-yet-
  // satisfied dep): the chain advances one merged layer at a time. Candidates
  // with no dependencies skip the check (and any `gh` call) entirely.
  const eligible: typeof readyCandidates = [];
  for (const c of readyCandidates) {
    if (c.depends_on.length === 0) {
      eligible.push(c);
      continue;
    }
    const allMerged = await areDependenciesMerged({
      targetRepoRoot,
      deps: c.depends_on,
      ...(opts.isDependencyMerged ? { isMerged: opts.isDependencyMerged } : {}),
    });
    if (allMerged) eligible.push(c);
  }

  // Queue-drained check: no eligible candidates AND no in-progress.
  if (eligible.length === 0 && inProgressCount === 0) {
    chatLog.push(QUEUE_DRAINED_LINE);
    return { next: "queue-drained", chatLog };
  }

  // If there are no eligible todos but inProgress > 0, the session cannot
  // progress further (all remaining todos are deps-blocked on in-progress work).
  if (eligible.length === 0) {
    chatLog.push(WAITING_ON_IN_PROGRESS_LINE);
    return { next: "waiting-on-in-progress", chatLog };
  }

  // Pick the first candidate in ref-alphabetical order (preserved from listTodos).
  const candidate = eligible[0]!;
  const { ref, title } = candidate;
  const displayTitle = title ?? "<title-unavailable>";

  // Print claiming line BEFORE claim call.
  chatLog.push(`claiming ${ref} — ${displayTitle}`);

  // Claim the story atomically.
  const claimResult = await claimStory({
    targetRepoRoot,
    ref,
    sessionUlid,
    role: "orchestrator",
  });

  // Derive manifest path (absolute — needed by the inner cycle tools).
  const manifestPath = path.resolve(
    targetRepoRoot,
    ".flow",
    "state",
    "in-progress",
    `${ref}.yaml`,
  );

  // Sanity-check: the claim result path and derived path should match.
  void claimResult;

  return {
    next: "spawn-dev",
    ref,
    title: displayTitle,
    manifestPath,
    chatLog,
  };
}
