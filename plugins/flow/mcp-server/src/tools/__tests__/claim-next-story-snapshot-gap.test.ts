/**
 * Integration test for the rename→snapshot gap lost-race fix —
 * this story (native:01KTSQXX61SQ6CSE94YHW0PP27), AC1.
 *
 * AC1: Given two workers that reach for the same story at the same moment and
 *      the loser arrives after the winner's rename but before the winner's
 *      snapshot write (the gap), When the loser tries to claim it, Then the
 *      loser quietly moves on to the next story and the run keeps claiming
 *      work — instead of stopping with a misleading "someone hand-edited" message.
 *
 * The gap is injected directly (manifest in in-progress/ with no claimed_by and
 * no snapshot) rather than relying on real race timing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { claimNextStory } from "../claim-next-story.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_REF_A = "native:01J9P0K2N3MZX0YV4SNAPGAP01";
const STORY_REF_B = "native:01J9P0K2N3MZX0YV4SNAPGAP02";
const SESSION_ULID = "01HZSESSION00000000000099";
const SOURCE_HASH = "a".repeat(64);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTodoManifest(ref: string): ExecutionManifest {
  return {
    ref,
    status: "to-do" as const,
    adapter: "native" as const,
    source_path: `.flow/native-stories/${ref}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" as const }],
    title: `Snapshot-gap test story ${ref}`,
    narrative: "As a dev, I want to test the gap.",
    withdrawn: false,
    ready: true,
  };
}

/** Simulate the narrow gap: story already renamed to in-progress/ but claimed_by
 *  not yet written (winner is between step 4 and step 5 of claimStory). No snapshot. */
function makeGapManifest(ref: string): ExecutionManifest {
  return {
    ref,
    // status is still "to-do" — winner hasn't finished the field-rewrite yet
    status: "to-do" as const,
    adapter: "native" as const,
    source_path: `.flow/native-stories/${ref}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" as const }],
    title: `Snapshot-gap test story ${ref}`,
    narrative: "As a dev, I want to test the gap.",
    withdrawn: false,
    ready: true,
    // Deliberately no claimed_by — gap window, winner hasn't written fields yet
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let todoDir: string;
let inProgressDir: string;
let doneDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-snap-gap-claim-"));
  todoDir = path.join(tmpRoot, ".flow", "state", "to-do");
  inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
  doneDir = path.join(tmpRoot, ".flow", "state", "done");

  await fs.mkdir(todoDir, { recursive: true });
  await fs.mkdir(inProgressDir, { recursive: true });
  await fs.mkdir(doneDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function seedTodoStory(manifest: ExecutionManifest): Promise<void> {
  await atomicWriteFile(
    path.join(todoDir, `${manifest.ref}.yaml`),
    yamlStringify(manifest, { lineWidth: 0 }),
  );
}

/**
 * Inject the gap state for a story:
 *  - Seed the READY manifest in to-do/ so listClaimableTodos picks it up.
 *  - ALSO seed the gap manifest in in-progress/ (no claimed_by, no snapshot)
 *    so claimStory's step-1 stat finds it and fires the _snapshot_missing guard.
 *
 * This simulates the moment after the winner's atomic rename (to-do→in-progress)
 * but before the winner's field-rewrite (claimed_by not yet stamped) and before
 * the snapshot write. Having both files is artificial (normally only one exists),
 * but it is the only deterministic way to inject the race condition without relying
 * on wall-clock timing — consistent with the story's implementation notes.
 */
async function seedGapStory(ref: string): Promise<void> {
  // In to-do/ so listClaimableTodos sees it as eligible.
  await atomicWriteFile(
    path.join(todoDir, `${ref}.yaml`),
    yamlStringify(makeTodoManifest(ref), { lineWidth: 0 }),
  );
  // In in-progress/ with no claimed_by and no snapshot — the gap window.
  await atomicWriteFile(
    path.join(inProgressDir, `${ref}.yaml`),
    yamlStringify(makeGapManifest(ref), { lineWidth: 0 }),
  );
  // Deliberately do NOT write a snapshot.
}

// ---------------------------------------------------------------------------
// AC1 — loser arriving in the gap moves on to the next story
// ---------------------------------------------------------------------------

describe("AC1: loser arriving in the rename→snapshot gap moves on gracefully", () => {
  it(
    "claimNextStory skips a story in the gap and claims the next available candidate",
    async () => {
      // Story A is in the gap: it's in BOTH to-do/ (so listClaimableTodos sees it)
      // AND in in-progress/ with no claimed_by and no snapshot (simulating the
      // moment after the winner's rename but before field-rewrite + snapshot write).
      // Story B is ready in to-do/ only.
      await seedGapStory(STORY_REF_A);
      await seedTodoStory(makeTodoManifest(STORY_REF_B));

      // The loser calls claimNextStory. It should attempt A first (alphabetically),
      // hit _snapshot_missing on the in-progress guard, skip A, then claim B.
      const result = await claimNextStory({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
      });

      // Must claim B successfully.
      expect(result.next).toBe("spawn-dev");
      if (result.next !== "spawn-dev") return;
      expect(result.ref).toBe(STORY_REF_B);

      // The chatLog must contain the "already claimed" skip line for A.
      expect(result.chatLog.join("\n")).toContain(
        `${STORY_REF_A} already claimed by another worker`,
      );
    },
    15_000,
  );

  it(
    "when the only candidate is in the gap, claimNextStory does not halt — run continues",
    async () => {
      // Only A is available and it's in the gap.
      await seedGapStory(STORY_REF_A);

      // The loser must NOT throw a misleading "hand-edited" error.
      // After skipping A, the eligible list is exhausted. Since A is in in-progress/
      // (even though it's in the gap), inProgressCount > 0, so we get waiting-on-in-progress.
      const result = await claimNextStory({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
      });

      // Must NOT throw — run keeps going.
      expect(["waiting-on-in-progress", "queue-emptied"]).toContain(result.next);
    },
    15_000,
  );

  it(
    "run claims all available work — gap story does not block other stories from being claimed",
    async () => {
      // A is in the gap; B is ready in to-do/ only.
      await seedGapStory(STORY_REF_A);
      await seedTodoStory(makeTodoManifest(STORY_REF_B));

      const result = await claimNextStory({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
      });

      // B must be claimed — the gap on A does not block the run.
      expect(result.next).toBe("spawn-dev");
      if (result.next !== "spawn-dev") return;
      expect(result.ref).toBe(STORY_REF_B);
    },
    15_000,
  );
});
