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
import {
  loadOverlapUniverse,
  findOverlapBlockers,
} from "../lib/cited-source-overlap.js";
import { InProgressHandEditError, ManifestNotFoundError } from "../errors.js";
import { writeSessionHeartbeat } from "../lib/session-liveness.js";

/** Verbatim queue-drained line from AC3 / AC5(iv) — do not paraphrase. */
export const QUEUE_DRAINED_LINE =
  "queue drained — to-do/ and in-progress/ are both empty. Stop here, or run /flow:plan to add work.";

/** Verbatim waiting-on-in-progress line — do not paraphrase. */
export const WAITING_ON_IN_PROGRESS_LINE =
  "waiting on in-progress work — no claimable todos this pass. Stop here or wait for in-progress stories to complete.";

/**
 * Verbatim waiting-on-unmerged-overlap line (Story native:01KTNH6N1E64W0EM3FS5A4B4TP) —
 * do not paraphrase. Returned when every ready story is parked solely because it
 * overlaps an approved-but-unmerged PR in done/. NOT a clean drain.
 */
export const WAITING_ON_UNMERGED_OVERLAP_LINE =
  "WAITING — ready story held for an unmerged overlapping pull request. Stop here or wait for the overlapping PR to merge.";

/**
 * Verbatim waiting-on-unmerged-dependency line (review finding B4) — the twin of
 * the overlap hold above. Returned when every ready story is parked SOLELY because
 * a DECLARED dependency's PR is approved-but-unmerged. Without this the
 * declared-dep hold falls through to a false "queue drained". NOT a clean drain.
 */
export const WAITING_ON_UNMERGED_DEPENDENCY_LINE =
  "WAITING — ready story held for an unmerged declared dependency. Stop here or wait for the dependency PR to merge.";

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
  | { next: "waiting-on-in-progress"; chatLog: string[] }
  | {
      /**
       * Every ready story is parked solely because it overlaps an approved-but-unmerged
       * pull request in done/. This is NOT a clean drain — the queue is not empty.
       * `heldRefs` names the held story ref(s) so the operator knows what to wait for.
       */
      next: "waiting-on-unmerged-overlap";
      heldRefs: string[];
      chatLog: string[];
    }
  | {
      /**
       * Twin of the overlap hold (finding B4): every ready story is parked solely
       * because a DECLARED dependency's PR is approved-but-unmerged. Also NOT a
       * clean drain. `heldRefs` names the held story ref(s).
       */
      next: "waiting-on-unmerged-dependency";
      heldRefs: string[];
      chatLog: string[];
    };

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

  // HEARTBEAT REFRESH (Story native:01KTSQWJ — liveness WRITE side). The drain
  // calls claimNextStory once per story, immediately before the long dev build,
  // so refreshing here keeps this session visible as alive across the build that
  // follows. Combined with the post-build refresh in processDevTranscript, the
  // longest gap between refreshes is a single build (bounded by the 20-min build
  // timeout), comfortably inside the 30-min staleness window. Fail-soft: a missed
  // heartbeat must never block a claim — the next seam refreshes it.
  try {
    await writeSessionHeartbeat(targetRepoRoot, sessionUlid);
  } catch {
    /* best-effort liveness refresh; never blocks claiming */
  }

  const { todos, inProgressCount } = await listClaimableTodos({ targetRepoRoot });

  // Filter to candidates that are BOTH deps-ready AND operator-blessed (Story 9.1).
  // The readiness brake is fail-closed: an item whose dependencies are all
  // satisfied is still NOT claimed until the operator marks it `ready: true`
  // via the markStoryReady tool (the /flow:ready skill). This is the single
  // chokepoint the drain hits, so the gate lives here in the claim entry point.
  const readyCandidates = todos.filter((c) => c.depsReady && c.ready);

  // Two gates park a candidate that would otherwise build BLIND to a change it
  // shares ground with. Both reduce to the same GitHub-backed "is this PR
  // merged?" check (`areDependenciesMerged`); a story reaches `done/` on
  // reviewer APPROVAL, before a medium/high-risk PR is human-merged, so `done/`
  // alone is not proof the change is on the trunk.
  //
  //  (1) Declared-dependency gate (#294): a candidate with `depends_on` is only
  //      claimable once EVERY declared dependency's PR is merged. Until then its
  //      worktree (cut from `origin/main`) would lack the prerequisite.
  //
  //  (2) Cited-source overlap gate: two stories with NO declared edge still
  //      collide if they edit the same file. We treat an overlapping
  //      `cited_sources` entry as an implicit dependency — a candidate is parked
  //      while any EARLIER-ordered story citing the same file is still in flight
  //      (`to-do`/`in-progress` → never merged → always blocks) or approved but
  //      not yet merged (`done/` → verified via the merge check). The later
  //      story then builds on top of the earlier one instead of blind. See
  //      `cited-source-overlap.ts` (the #300/#301 silent-integration-bug fix).
  //
  // Candidates with no dependencies AND no cited-source overlap skip every `gh`
  // call. The overlap universe is loaded once per pass (in-memory matching).
  const overlapUniverse =
    readyCandidates.length > 0 ? await loadOverlapUniverse(targetRepoRoot) : [];

  const eligible: typeof readyCandidates = [];
  // Track ready candidates that were dropped ONLY by the cited-source overlap gate
  // against an unmerged done/ sibling (not by declared deps, not by a pending/in-progress
  // blocker). These are the stories that produce a WAITING/parked outcome rather than a
  // genuine clean drain.
  const heldOnUnmergedOverlapRefs: string[] = [];
  // Track ready candidates dropped ONLY because a DECLARED dependency's PR is not
  // yet merged (review finding B4 — the twin of the overlap hold). Without this
  // an all-deps-blocked queue reports a false clean drain.
  const heldOnUnmergedDepRefs: string[] = [];

  for (const c of readyCandidates) {
    // (1) declared dependencies
    if (c.depends_on.length > 0) {
      const allMerged = await areDependenciesMerged({
        targetRepoRoot,
        deps: c.depends_on,
        ...(opts.isDependencyMerged ? { isMerged: opts.isDependencyMerged } : {}),
      });
      if (!allMerged) {
        // Held solely by an unmerged declared dependency — track it so the drain
        // reports WAITING instead of a false "queue-drained" (finding B4).
        heldOnUnmergedDepRefs.push(c.ref);
        continue;
      }
    }

    // (2) cited-source overlap
    const { pendingRefs, doneRefs } = findOverlapBlockers(overlapUniverse, c.ref);
    if (pendingRefs.length > 0) continue; // earlier overlapping story still in flight
    if (doneRefs.length > 0) {
      const overlapMerged = await areDependenciesMerged({
        targetRepoRoot,
        deps: doneRefs,
        ...(opts.isDependencyMerged ? { isMerged: opts.isDependencyMerged } : {}),
      });
      if (!overlapMerged) {
        // This candidate is held SOLELY by an unmerged done/ overlap. Track it so
        // the drain can report WAITING instead of false "queue-drained".
        heldOnUnmergedOverlapRefs.push(c.ref);
        continue;
      }
    }

    eligible.push(c);
  }

  // Queue-drained check: no eligible candidates AND no in-progress.
  if (eligible.length === 0 && inProgressCount === 0) {
    // If EVERY non-eligible ready candidate was dropped solely by the cited-source
    // overlap gate against an unmerged done/ PR, we must NOT report a clean drain —
    // the queue is not empty. Return the WAITING/parked outcome naming the held refs.
    if (heldOnUnmergedOverlapRefs.length > 0) {
      const held = heldOnUnmergedOverlapRefs.join(", ");
      chatLog.push(
        `${WAITING_ON_UNMERGED_OVERLAP_LINE} Held: ${held}`,
      );
      return {
        next: "waiting-on-unmerged-overlap",
        heldRefs: heldOnUnmergedOverlapRefs,
        chatLog,
      };
    }
    // Twin of the above (finding B4): every ready candidate dropped solely by an
    // unmerged DECLARED dependency. Also NOT a clean drain — surface WAITING.
    if (heldOnUnmergedDepRefs.length > 0) {
      const held = heldOnUnmergedDepRefs.join(", ");
      chatLog.push(`${WAITING_ON_UNMERGED_DEPENDENCY_LINE} Held: ${held}`);
      return {
        next: "waiting-on-unmerged-dependency",
        heldRefs: heldOnUnmergedDepRefs,
        chatLog,
      };
    }
    chatLog.push(QUEUE_DRAINED_LINE);
    return { next: "queue-drained", chatLog };
  }

  // If there are no eligible todos but inProgress > 0, the session cannot
  // progress further (all remaining todos are deps-blocked on in-progress work).
  if (eligible.length === 0) {
    chatLog.push(WAITING_ON_IN_PROGRESS_LINE);
    return { next: "waiting-on-in-progress", chatLog };
  }

  // Walk the eligible candidates in ref-alphabetical order (preserved from listTodos).
  // On a lost-race (ManifestNotFoundError from claimStory with fromState "to-do"),
  // another concurrent worker already claimed this story — skip to the next candidate
  // and try again rather than halting the run. Any other error is a genuine failure
  // and propagates immediately to preserve the no-silent-failure contract.
  for (const candidate of eligible) {
    const { ref, title } = candidate;
    const displayTitle = title ?? "<title-unavailable>";

    // Print claiming line BEFORE claim call.
    chatLog.push(`claiming ${ref} — ${displayTitle}`);

    let claimSucceeded = false;
    try {
      // Claim the story atomically.
      await claimStory({
        targetRepoRoot,
        ref,
        sessionUlid,
        role: "orchestrator",
      });
      claimSucceeded = true;
    } catch (err) {
      // A ManifestNotFoundError from the to-do/ state means another concurrent
      // worker already renamed this story out of to-do/ (lost the rename race).
      // Skip to the next eligible candidate — do NOT halt the run.
      if (
        err instanceof ManifestNotFoundError &&
        err.fromState === "to-do"
      ) {
        chatLog.push(
          `${ref} already claimed by another worker — skipping to next candidate`,
        );
        continue;
      }
      // An InProgressHandEditError whose ONLY changed field is "_snapshot_missing"
      // signals a concurrent lost race in the narrow rename→snapshot gap (this story,
      // AC1/AC2): another worker claimed the story atomically but has not yet written
      // its claim-time snapshot. The story is NOT ours — skip to the next candidate
      // rather than halting the run with a misleading "someone hand-edited" message.
      // A genuine hand-edit (any real field drift) still carries more than one field
      // in changedFields and MUST propagate so it surfaces to the operator.
      if (
        err instanceof InProgressHandEditError &&
        err.changedFields.length === 1 &&
        err.changedFields[0] === "_snapshot_missing"
      ) {
        chatLog.push(
          `${ref} already claimed by another worker — skipping to next candidate`,
        );
        continue;
      }
      // Any other error is a genuine claim failure — propagate immediately.
      throw err;
    }

    if (claimSucceeded) {
      // Derive manifest path (absolute — needed by the inner cycle tools).
      const manifestPath = path.resolve(
        targetRepoRoot,
        ".flow",
        "state",
        "in-progress",
        `${ref}.yaml`,
      );

      return {
        next: "spawn-dev",
        ref,
        title: displayTitle,
        manifestPath,
        chatLog,
      };
    }
  }

  // All eligible candidates were lost to concurrent workers. Re-evaluate the
  // queue state: if anything is now in-progress (claimed by the winners), wait
  // rather than falsely reporting the queue as drained.
  const { inProgressCount: refreshedInProgress } = await listClaimableTodos({
    targetRepoRoot,
  });
  if (refreshedInProgress > 0) {
    chatLog.push(WAITING_ON_IN_PROGRESS_LINE);
    return { next: "waiting-on-in-progress", chatLog };
  }
  chatLog.push(QUEUE_DRAINED_LINE);
  return { next: "queue-drained", chatLog };
}
