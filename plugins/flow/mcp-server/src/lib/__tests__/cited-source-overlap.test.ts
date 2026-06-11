/**
 * Unit tests for the cited-source overlap gate (`cited-source-overlap.ts`).
 *
 *  - `findOverlapBlockers` is pure: assert the matching/partition logic against
 *    hand-built universes.
 *  - `loadOverlapUniverse` reads real fixture dirs with `node:fs` (no mocking),
 *    matching the project convention.
 *
 * AC1 / AC2 integration: the end-to-end combination of `findOverlapBlockers` +
 * `areDependenciesMerged` that the `claimNextStory` claim loop drives. Tests in
 * the "overlap + merge-gate integration" describe block verify that:
 *   - AC1: a done/ blocker whose PR is confirmed merged via the recorded
 *     `pr_number` probe releases the held story (the later story becomes eligible).
 *   - AC2: a done/ blocker whose PR is NOT yet merged continues to hold the later
 *     story even when its done/ manifest is present.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../managed-fs.js";
import {
  findOverlapBlockers,
  loadOverlapUniverse,
  type OverlapStory,
} from "../cited-source-overlap.js";
import { areDependenciesMerged } from "../dep-merge-check.js";

const A = "native:01J9P0K2N3MZX0YV4S5RTQ4AAA";
const B = "native:01J9P0K2N3MZX0YV4S5RTQ4BBB";
const C = "native:01J9P0K2N3MZX0YV4S5RTQ4CCC";
const FILE_X = "plugins/flow/mcp-server/src/tools/build-persona-spawn-prompt.ts";
const FILE_Y = "plugins/flow/mcp-server/src/lib/unrelated.ts";

function story(
  ref: string,
  location: OverlapStory["location"],
  citedSources: string[],
  ready = true,
): OverlapStory {
  return { ref, location, citedSources, ready };
}

// ---------------------------------------------------------------------------
// findOverlapBlockers (pure)
// ---------------------------------------------------------------------------

describe("findOverlapBlockers", () => {
  it("returns no blockers when the candidate cites nothing", () => {
    const universe = [story(A, "done", [FILE_X]), story(B, "to-do", [])];
    expect(findOverlapBlockers(universe, B)).toEqual({ pendingRefs: [], doneRefs: [] });
  });

  it("returns no blockers when the candidate is unknown to the universe", () => {
    const universe = [story(A, "done", [FILE_X])];
    expect(findOverlapBlockers(universe, "native:does-not-exist")).toEqual({
      pendingRefs: [],
      doneRefs: [],
    });
  });

  it("flags an earlier overlapping done/ story as a doneRef (needs merge check)", () => {
    const universe = [story(A, "done", [FILE_X]), story(B, "to-do", [FILE_X])];
    expect(findOverlapBlockers(universe, B)).toEqual({ pendingRefs: [], doneRefs: [A] });
  });

  it("flags an earlier overlapping in-progress story as a pendingRef", () => {
    const universe = [story(A, "in-progress", [FILE_X]), story(B, "to-do", [FILE_X])];
    expect(findOverlapBlockers(universe, B)).toEqual({ pendingRefs: [A], doneRefs: [] });
  });

  it("flags an earlier overlapping blessed to-do story as a pendingRef", () => {
    const universe = [story(A, "to-do", [FILE_X], true), story(B, "to-do", [FILE_X])];
    expect(findOverlapBlockers(universe, B)).toEqual({ pendingRefs: [A], doneRefs: [] });
  });

  it("ignores an earlier overlapping but UNBLESSED to-do story (it may never ship)", () => {
    const universe = [story(A, "to-do", [FILE_X], false), story(B, "to-do", [FILE_X])];
    expect(findOverlapBlockers(universe, B)).toEqual({ pendingRefs: [], doneRefs: [] });
  });

  it("ignores a LATER overlapping story that is unstarted to-do/ (asymmetric — exactly one of a pair may start, preventing deadlock)", () => {
    const universe = [story(A, "to-do", [FILE_X]), story(B, "to-do", [FILE_X])];
    // For candidate A, B sorts later AND is unstarted → not a blocker (A may start).
    expect(findOverlapBlockers(universe, A)).toEqual({ pendingRefs: [], doneRefs: [] });
  });

  it("(AC2 — order-independent) blocks an EARLIER candidate when a LATER overlapping story is already in-progress", () => {
    // B is later-ordered but already in-progress. A (the earlier story) is being claimed.
    // Without this fix, A would not be blocked (s.ref > ref filtered it out).
    const universe = [story(A, "to-do", [FILE_X]), story(B, "in-progress", [FILE_X])];
    expect(findOverlapBlockers(universe, A)).toEqual({ pendingRefs: [B], doneRefs: [] });
  });

  it("(AC2 — order-independent) blocks an EARLIER candidate when a LATER overlapping story is in done/", () => {
    // B reached done/ first (approved or started before A). A must wait for B's merge.
    const universe = [story(A, "to-do", [FILE_X]), story(B, "done", [FILE_X])];
    expect(findOverlapBlockers(universe, A)).toEqual({ pendingRefs: [], doneRefs: [B] });
  });

  it("(no deadlock) a later unblessed to-do/ overlapping story never blocks the earlier candidate", () => {
    const universe = [story(A, "to-do", [FILE_X]), story(B, "to-do", [FILE_X], false)];
    expect(findOverlapBlockers(universe, A)).toEqual({ pendingRefs: [], doneRefs: [] });
  });

  it("(no deadlock) a later BLESSED to-do/ overlapping story does not block the earlier candidate", () => {
    // Both unstarted — only B (the later one) waits for A, not the reverse.
    const universe = [story(A, "to-do", [FILE_X], true), story(B, "to-do", [FILE_X], true)];
    expect(findOverlapBlockers(universe, A)).toEqual({ pendingRefs: [], doneRefs: [] });
  });

  it("ignores stories that cite non-overlapping files", () => {
    const universe = [story(A, "done", [FILE_Y]), story(B, "to-do", [FILE_X])];
    expect(findOverlapBlockers(universe, B)).toEqual({ pendingRefs: [], doneRefs: [] });
  });

  it("partitions multiple earlier overlapping blockers across pending and done", () => {
    const universe = [
      story(A, "done", [FILE_X]),
      story(B, "in-progress", [FILE_X]),
      story(C, "to-do", [FILE_X]),
    ];
    const { pendingRefs, doneRefs } = findOverlapBlockers(universe, C);
    expect(pendingRefs).toEqual([B]);
    expect(doneRefs).toEqual([A]);
  });
});

// ---------------------------------------------------------------------------
// loadOverlapUniverse (fs)
// ---------------------------------------------------------------------------

describe("loadOverlapUniverse", () => {
  let root: string;

  async function seed(
    location: "to-do" | "in-progress" | "done",
    filename: string,
    body: string,
  ): Promise<void> {
    const dir = path.join(root, ".flow", "state", location);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, filename), body);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-overlap-universe-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns an empty universe when no state dirs exist", async () => {
    expect(await loadOverlapUniverse(root)).toEqual([]);
  });

  it("reads ref, cited_sources, ready, and location across all three dirs", async () => {
    await seed("to-do", `${A}.yaml`, `ref: "${A}"\nready: true\ncited_sources:\n  - ${FILE_X}\n`);
    await seed("in-progress", `${B}.yaml`, `ref: "${B}"\nready: true\ncited_sources:\n  - ${FILE_Y}\n`);
    await seed("done", `${C}.yaml`, `ref: "${C}"\nready: true\n`); // no cited_sources

    const universe = await loadOverlapUniverse(root);
    const byRef = Object.fromEntries(universe.map((s) => [s.ref, s]));

    expect(byRef[A]).toEqual({ ref: A, location: "to-do", ready: true, citedSources: [FILE_X] });
    expect(byRef[B]).toEqual({ ref: B, location: "in-progress", ready: true, citedSources: [FILE_Y] });
    expect(byRef[C]).toEqual({ ref: C, location: "done", ready: true, citedSources: [] });
  });

  it("skips snapshot companions and non-yaml files", async () => {
    await seed("in-progress", `${A}.yaml`, `ref: "${A}"\ncited_sources:\n  - ${FILE_X}\n`);
    await seed("in-progress", `${A}.snapshot.yaml`, `anything: here\n`);
    await seed("in-progress", `notes.txt`, `not a manifest\n`);

    const universe = await loadOverlapUniverse(root);
    expect(universe.map((s) => s.ref)).toEqual([A]);
  });

  it("falls back to the filename for ref when the manifest omits it", async () => {
    await seed("done", `${A}.yaml`, `cited_sources:\n  - ${FILE_X}\n`); // no ref key
    const universe = await loadOverlapUniverse(root);
    expect(universe).toEqual([
      { ref: A, location: "done", ready: false, citedSources: [FILE_X] },
    ]);
  });

  it("skips a malformed manifest rather than throwing (fail-open for liveness)", async () => {
    await seed("done", `${A}.yaml`, `ref: "${A}"\ncited_sources: [oops, never, closed\n`);
    await seed("done", `${B}.yaml`, `ref: "${B}"\ncited_sources:\n  - ${FILE_X}\n`);

    const universe = await loadOverlapUniverse(root);
    // The good manifest is still loaded; the malformed one is silently skipped.
    expect(universe.map((s) => s.ref)).toEqual([B]);
  });
});

// ---------------------------------------------------------------------------
// Overlap + merge-gate integration (AC1 / AC2 / AC3)
//
// Simulates the decision the claimNextStory loop makes:
//   1. findOverlapBlockers → discovers done/ refs that need a merge check.
//   2. areDependenciesMerged (with the isMerged seam) → decides whether to
//      release or continue holding the later story.
//
// AC1: done/ blocker with a recorded pr_number that is confirmed merged →
//      the later story is RELEASED (isMerged returns true → eligible).
// AC2: done/ blocker whose PR is genuinely NOT merged →
//      the later story is HELD (isMerged returns false → not eligible).
// AC3: a story held by an in-flight later-ordered overlap is released after merge.
//
// New order-independent coverage (story fix):
//   - Out-of-order approval ordering 1: B approved/in-progress before A is claimed.
//   - Out-of-order approval ordering 2: A is the later story waiting for earlier B.
//   - AC3: held-then-released path when a later-ordered in-flight story merges.
//   - AC4: no-overlap fast path — different files, no hold in either direction.
// ---------------------------------------------------------------------------

describe("overlap + merge-gate integration (AC1 / AC2 / AC3)", () => {
  let root: string;
  let doneDir: string;
  let todoDir: string;
  let inProgressDir: string;

  function makeDoneManifest(ref: string, prNumber?: number): string {
    const base: Record<string, unknown> = {
      ref,
      status: "done",
      adapter: "native",
      source_path: `.flow/native-stories/${ref}.yaml`,
      source_hash: "a".repeat(64),
      depends_on: [],
      acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
      title: `Title for ${ref}`,
      narrative: "As a dev, I want to test.",
      withdrawn: false,
      ready: true,
      cited_sources: [FILE_X],
    };
    if (prNumber !== undefined) {
      base["pr_number"] = prNumber;
    }
    return yamlStringify(base, { lineWidth: 0 });
  }

  function makeInProgressManifest(ref: string): string {
    const base: Record<string, unknown> = {
      ref,
      status: "in-progress",
      adapter: "native",
      source_path: `.flow/native-stories/${ref}.yaml`,
      source_hash: "a".repeat(64),
      depends_on: [],
      acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
      title: `Title for ${ref}`,
      narrative: "As a dev, I want to test.",
      withdrawn: false,
      ready: true,
      cited_sources: [FILE_X],
    };
    return yamlStringify(base, { lineWidth: 0 });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-overlap-merge-"));
    doneDir = path.join(root, ".flow", "state", "done");
    todoDir = path.join(root, ".flow", "state", "to-do");
    inProgressDir = path.join(root, ".flow", "state", "in-progress");
    await fs.mkdir(doneDir, { recursive: true });
    await fs.mkdir(todoDir, { recursive: true });
    await fs.mkdir(inProgressDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("(AC1) releases a later story when the done/ blocker's PR is confirmed merged (even if real branch != title slug)", async () => {
    // A: earlier story, done, with a recorded pr_number (real branch may differ from title slug).
    // B: later story, to-do, cites the same file.
    await atomicWriteFile(
      path.join(doneDir, `${A}.yaml`),
      makeDoneManifest(A, 123), // pr_number=123 recorded
    );
    await atomicWriteFile(
      path.join(todoDir, `${B}.yaml`),
      `ref: "${B}"\nready: true\ncited_sources:\n  - ${FILE_X}\n`,
    );

    const universe = await loadOverlapUniverse(root);
    const { pendingRefs, doneRefs } = findOverlapBlockers(universe, B);

    // A is a done/ blocker for B.
    expect(pendingRefs).toEqual([]);
    expect(doneRefs).toEqual([A]);

    // isMerged seam returns true (PR 123 is merged — confirmed via recorded pr_number).
    // In production this is isDependencyPrMerged with the real gh probe.
    const allMerged = await areDependenciesMerged({
      targetRepoRoot: root,
      deps: doneRefs,
      isMerged: async ({ prNumber }) => {
        // The merge-check received the recorded pr_number from the done/ manifest.
        expect(prNumber).toBe(123);
        return true; // confirmed merged
      },
    });

    // B is RELEASED: the blocker is merged, so the later story may be built.
    expect(allMerged).toBe(true);
  });

  it("(AC2) continues to hold a later story when the done/ blocker's PR is genuinely NOT merged", async () => {
    // A: earlier story in done/, but its PR has NOT been merged yet.
    // B: later story to-do, cites the same file.
    await atomicWriteFile(
      path.join(doneDir, `${A}.yaml`),
      makeDoneManifest(A, 456), // pr_number recorded but NOT merged
    );
    await atomicWriteFile(
      path.join(todoDir, `${B}.yaml`),
      `ref: "${B}"\nready: true\ncited_sources:\n  - ${FILE_X}\n`,
    );

    const universe = await loadOverlapUniverse(root);
    const { doneRefs } = findOverlapBlockers(universe, B);

    expect(doneRefs).toEqual([A]);

    // isMerged seam returns false (PR 456 is NOT yet merged).
    const allMerged = await areDependenciesMerged({
      targetRepoRoot: root,
      deps: doneRefs,
      isMerged: async () => false, // not merged
    });

    // B remains HELD: the blocker's PR has not landed, so B must wait.
    expect(allMerged).toBe(false);
  });

  it("(AC1) handles legacy done/ blocker without pr_number — isMerged receives undefined", async () => {
    // Legacy manifest: no pr_number recorded (story shipped before this change).
    // The slug-based fallback probe runs (via isDependencyPrMerged with prNumber=undefined).
    await atomicWriteFile(
      path.join(doneDir, `${A}.yaml`),
      makeDoneManifest(A), // no pr_number → legacy path
    );
    await atomicWriteFile(
      path.join(todoDir, `${B}.yaml`),
      `ref: "${B}"\nready: true\ncited_sources:\n  - ${FILE_X}\n`,
    );

    const universe = await loadOverlapUniverse(root);
    const { doneRefs } = findOverlapBlockers(universe, B);
    expect(doneRefs).toEqual([A]);

    const probed: Array<{ prNumber?: number }> = [];
    await areDependenciesMerged({
      targetRepoRoot: root,
      deps: doneRefs,
      isMerged: async ({ prNumber }) => {
        probed.push({ prNumber });
        return true; // pretend merged via slug probe
      },
    });

    // Legacy path: prNumber is undefined → slug-based fallback will be used in production.
    expect(probed[0]!.prNumber).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Order-independent protection (the fix)
  // ---------------------------------------------------------------------------

  it("(AC2 / ordering-1) holds EARLIER story A when LATER story B is already in-progress", async () => {
    // Scenario: B was approved and claimed first (out-of-order). A is now being claimed.
    // Both cite FILE_X. Without the fix, A would not be blocked.
    await atomicWriteFile(
      path.join(inProgressDir, `${B}.yaml`),
      makeInProgressManifest(B),
    );
    await atomicWriteFile(
      path.join(todoDir, `${A}.yaml`),
      `ref: "${A}"\nready: true\ncited_sources:\n  - ${FILE_X}\n`,
    );

    const universe = await loadOverlapUniverse(root);
    const { pendingRefs, doneRefs } = findOverlapBlockers(universe, A);

    // B is later-ordered but in-progress → must block A (new direction).
    expect(pendingRefs).toEqual([B]);
    expect(doneRefs).toEqual([]);
  });

  it("(AC2 / ordering-2) holds LATER story B when EARLIER story A is already in-progress", async () => {
    // Normal order: A was claimed first. B is now being claimed.
    await atomicWriteFile(
      path.join(inProgressDir, `${A}.yaml`),
      makeInProgressManifest(A),
    );
    await atomicWriteFile(
      path.join(todoDir, `${B}.yaml`),
      `ref: "${B}"\nready: true\ncited_sources:\n  - ${FILE_X}\n`,
    );

    const universe = await loadOverlapUniverse(root);
    const { pendingRefs, doneRefs } = findOverlapBlockers(universe, B);

    // A is earlier-ordered and in-progress → must block B (existing behaviour preserved).
    expect(pendingRefs).toEqual([A]);
    expect(doneRefs).toEqual([]);
  });

  it("(AC3) releases earlier story A after later story B finishes and its PR is merged", async () => {
    // B was in-progress (later-ordered) and has now reached done/ with its PR merged.
    // A was held because B was in-progress. After B's PR is merged, A should be released.
    await atomicWriteFile(
      path.join(doneDir, `${B}.yaml`),
      makeDoneManifest(B, 789), // B reached done/, pr_number=789
    );
    await atomicWriteFile(
      path.join(todoDir, `${A}.yaml`),
      `ref: "${A}"\nready: true\ncited_sources:\n  - ${FILE_X}\n`,
    );

    const universe = await loadOverlapUniverse(root);
    const { pendingRefs, doneRefs } = findOverlapBlockers(universe, A);

    // B is later-ordered and in done/ → doneRef (merge check gates release).
    expect(pendingRefs).toEqual([]);
    expect(doneRefs).toEqual([B]);

    // B's PR is confirmed merged → A is RELEASED.
    const allMerged = await areDependenciesMerged({
      targetRepoRoot: root,
      deps: doneRefs,
      isMerged: async ({ prNumber }) => {
        expect(prNumber).toBe(789);
        return true; // confirmed merged
      },
    });

    expect(allMerged).toBe(true);
  });

  it("(AC3) keeps earlier story A held while later story B's PR is not yet merged", async () => {
    // B reached done/ but its PR has not landed yet. A must still wait.
    await atomicWriteFile(
      path.join(doneDir, `${B}.yaml`),
      makeDoneManifest(B, 789),
    );
    await atomicWriteFile(
      path.join(todoDir, `${A}.yaml`),
      `ref: "${A}"\nready: true\ncited_sources:\n  - ${FILE_X}\n`,
    );

    const universe = await loadOverlapUniverse(root);
    const { doneRefs } = findOverlapBlockers(universe, A);
    expect(doneRefs).toEqual([B]);

    const allMerged = await areDependenciesMerged({
      targetRepoRoot: root,
      deps: doneRefs,
      isMerged: async () => false, // not yet merged
    });

    // A is still HELD.
    expect(allMerged).toBe(false);
  });

  it("(AC4) does not hold stories that cite entirely different files", async () => {
    // A cites FILE_X; B cites FILE_Y. B is already in-progress.
    // A should be free to start immediately — no overlap.
    await atomicWriteFile(
      path.join(inProgressDir, `${B}.yaml`),
      yamlStringify(
        {
          ref: B,
          status: "in-progress",
          ready: true,
          cited_sources: [FILE_Y], // different file
        },
        { lineWidth: 0 },
      ),
    );
    await atomicWriteFile(
      path.join(todoDir, `${A}.yaml`),
      `ref: "${A}"\nready: true\ncited_sources:\n  - ${FILE_X}\n`,
    );

    const universe = await loadOverlapUniverse(root);
    const result = findOverlapBlockers(universe, A);

    // No shared file → no hold.
    expect(result).toEqual({ pendingRefs: [], doneRefs: [] });
  });
});
