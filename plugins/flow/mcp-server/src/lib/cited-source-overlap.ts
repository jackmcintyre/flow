/**
 * Cited-source overlap gate — the undeclared-sibling fix.
 *
 * The #294 wait-for-merge gate (`dep-merge-check.ts`) only serializes stories
 * that DECLARE a dependency on each other. But two stories with no declared
 * edge can still collide if they edit the same source file: each builds its
 * worktree from an `origin/main` that lacks the other, so each is green in
 * isolation while the merged result is silently wrong (the #300/#301 bug —
 * one story's rewrite path dropped a section the other added; tsc, each story's
 * own CI, and the judge gate all passed).
 *
 * The signal to prevent it is already in the manifests: every native story
 * carries `cited_sources` (the files it expects to touch). When two unshipped
 * stories cite an overlapping file, we treat that overlap as an IMPLICIT
 * dependency — the later-ordered story is parked until the earlier one's PR is
 * merged, so it builds on top of that change instead of blind.
 *
 * Ordering is by ref ascending, which for `native:<ULID>` refs is creation
 * order. The relation is asymmetric on purpose: only the later story of an
 * overlapping pair waits, so exactly one is claimable at a time and there is no
 * deadlock. Unblessed `to-do/` stories never block (they may never ship);
 * `in-progress/` and `done/` stories always count (they are actively heading
 * for the trunk). A `done/` blocker only blocks until its PR is genuinely
 * merged — the caller verifies that via the same GitHub-backed check the
 * declared-dependency gate uses.
 *
 * Trade-off (intended): two stories that cite the same file but edit unrelated
 * parts of it are serialized unnecessarily. Correctness over throughput — the
 * cost is a slightly smaller concurrent batch, never a blind build.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";

type OverlapLocation = "to-do" | "in-progress" | "done";

export interface OverlapStory {
  /** Story ref, e.g. `native:01HZ...` (from the manifest, or the filename). */
  ref: string;
  /** The `cited_sources` paths from the manifest (empty when absent). */
  citedSources: string[];
  /** Operator readiness flag (only meaningful for `to-do/` entries). */
  ready: boolean;
  location: OverlapLocation;
}

export interface OverlapBlockers {
  /**
   * Overlapping stories that unconditionally block the candidate because they
   * have no merged PR yet. This includes:
   *   - Earlier-ordered stories in `to-do/` (blessed) or `in-progress/`.
   *   - Later-ordered stories in `in-progress/` (already actively building
   *     against the shared file — letting an earlier story also start would
   *     produce a blind concurrent build).
   * Neither category has a merged PR yet, so each unconditionally blocks the
   * candidate.
   */
  pendingRefs: string[];
  /**
   * Overlapping stories in `done/`. These are approved but may not be merged
   * yet — the caller blocks the candidate only for the ones whose PR is not
   * proven merged (via the GitHub-backed merge check). Includes both
   * earlier-ordered and later-ordered done/ stories (a later story that
   * reached done/ is heading for the trunk; the candidate must wait).
   */
  doneRefs: string[];
}

const STATE_DIRS: readonly OverlapLocation[] = ["to-do", "in-progress", "done"];

/**
 * Lenient load of every story manifest across `to-do/`, `in-progress/`, and
 * `done/` for overlap analysis. Reads only the three fields the gate needs
 * (`ref`, `cited_sources`, `ready`) directly from the YAML so it survives schema
 * drift in historical `done/` manifests and never throws on a malformed file (a
 * manifest it cannot read simply cannot contribute a blocker). Snapshot
 * companions (`<ref>.snapshot.yaml`) are skipped.
 */
export async function loadOverlapUniverse(
  targetRepoRoot: string,
): Promise<OverlapStory[]> {
  const stateRoot = path.join(targetRepoRoot, ".flow", "state");
  const stories: OverlapStory[] = [];

  for (const location of STATE_DIRS) {
    const dir = path.join(stateRoot, location);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".yaml") || entry.endsWith(".snapshot.yaml")) continue;

      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, entry), "utf8");
      } catch {
        continue; // vanished / unreadable → cannot contribute a blocker
      }

      let doc: unknown;
      try {
        doc = yamlParse(raw);
      } catch {
        continue; // unparseable YAML → skip
      }

      const rec =
        doc !== null && typeof doc === "object"
          ? (doc as Record<string, unknown>)
          : {};
      const ref =
        typeof rec["ref"] === "string" && (rec["ref"] as string).length > 0
          ? (rec["ref"] as string)
          : entry.slice(0, -".yaml".length); // filename is `<ref>.yaml`
      const citedSources = Array.isArray(rec["cited_sources"])
        ? (rec["cited_sources"] as unknown[]).filter(
            (p): p is string => typeof p === "string",
          )
        : [];
      const ready = rec["ready"] === true;

      stories.push({ ref, citedSources, ready, location });
    }
  }

  return stories;
}

/**
 * Find the stories that must merge before `ref` may be claimed because they cite
 * an overlapping source file. Pure in-memory — load the universe once per pass
 * and call this per candidate.
 *
 * A candidate with no `cited_sources` (e.g. a non-native story) has no blockers.
 *
 * **Blocker rules (order-aware):**
 *
 * 1. Earlier-ordered (`s.ref < ref`) overlapping blessed `to-do/` or
 *    `in-progress/` stories always block — they haven't merged yet and sort
 *    before the candidate (asymmetric: exactly one of a not-yet-started pair is
 *    claimable → no deadlock).
 *
 * 2. Earlier-ordered overlapping `done/` stories block until their PR is merged
 *    (caller verifies via GitHub-backed merge check).
 *
 * 3. **Later-ordered (`s.ref > ref`) overlapping `in-progress/` stories also
 *    block.** A later story can already be building against the shared file if it
 *    was approved or claimed first. Letting the earlier story also start would
 *    create a blind concurrent build — both stories would build from the same
 *    `origin/main` baseline and produce a silent integration hazard on merge.
 *    A story that is already `in-progress/` will progress to done/merge, so
 *    waiting on it is bounded and self-releasing (no cycle/deadlock).
 *
 * 4. **Later-ordered overlapping `done/` stories also block** (until their PR is
 *    merged, same as rule 2). If a later story reached done/ it is heading for the
 *    trunk; the earlier candidate must wait for that merge just like any other
 *    in-flight overlap.
 *
 * 5. Later-ordered overlapping `to-do/` (unstarted) stories do NOT block, even if
 *    blessed. The asymmetric rule (rule 1) stays in place for unstarted work to
 *    prevent deadlock: if both A and B are unstarted, only B waits for A.
 */
export function findOverlapBlockers(
  universe: readonly OverlapStory[],
  ref: string,
): OverlapBlockers {
  const self = universe.find((s) => s.ref === ref);
  const cited = self?.citedSources ?? [];
  if (cited.length === 0) return { pendingRefs: [], doneRefs: [] };
  const citedSet = new Set(cited);

  const pendingRefs: string[] = [];
  const doneRefs: string[] = [];

  for (const s of universe) {
    if (s.ref === ref) continue;
    if (!s.citedSources.some((p) => citedSet.has(p))) continue;

    if (s.ref < ref) {
      // Earlier-ordered story: classic asymmetric rule.
      // Blessed to-do/ and in-progress/ → unconditional block (pendingRefs).
      // done/ → conditional on merge (doneRefs).
      // Unblessed to-do/ → skip (may never ship).
      if (s.location === "to-do") {
        if (s.ready) pendingRefs.push(s.ref);
        // else: unblessed → skip
      } else if (s.location === "in-progress") {
        pendingRefs.push(s.ref);
      } else {
        // done/
        doneRefs.push(s.ref);
      }
    } else {
      // Later-ordered story (s.ref > ref): only block when already IN FLIGHT.
      // to-do/ (even blessed) → skip — asymmetric rule prevents deadlock.
      if (s.location === "in-progress") {
        pendingRefs.push(s.ref);
      } else if (s.location === "done") {
        doneRefs.push(s.ref);
      }
      // to-do/ → no block
    }
  }

  return { pendingRefs, doneRefs };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
