/**
 * Unit tests for the cited-source overlap gate (`cited-source-overlap.ts`).
 *
 *  - `findOverlapBlockers` is pure: assert the matching/partition logic against
 *    hand-built universes.
 *  - `loadOverlapUniverse` reads real fixture dirs with `node:fs` (no mocking),
 *    matching the project convention.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findOverlapBlockers,
  loadOverlapUniverse,
  type OverlapStory,
} from "../cited-source-overlap.js";

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

  it("ignores a LATER overlapping story (asymmetric — only the later one waits)", () => {
    const universe = [story(A, "to-do", [FILE_X]), story(B, "done", [FILE_X])];
    // For candidate A, B sorts later → not a blocker.
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
    await fs.writeFile(path.join(dir, filename), body);
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
