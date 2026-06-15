/**
 * Integration test for the crash-in-the-gap recovery fix —
 * this story (native:01KTSQXX61SQ6CSE94YHW0PP27), AC3.
 *
 * AC3: Given a run that crashed while a story was being claimed — its claim
 *      is recorded (claimed_by is set) but its starting snapshot was never
 *      written — When a later run encounters that interrupted story via
 *      claimStory, Then the story can still be picked up and finished rather
 *      than being rejected forever.
 *
 * The crash is injected directly: an in-progress manifest with claimed_by set
 * but no snapshot sidecar. claimStory re-establishes the snapshot (re-baseline)
 * and returns { ref, absPath } so the story can proceed to completion.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { claimStory } from "../claim-story.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF = "native:01HZCRASH0000000000000001";
const ORIGINAL_SESSION_ULID = "01HZSESSION00000000000OLD";
const SESSION_ULID = "01HZSESSION00000000000NEW";
const SOURCE_HASH = "a".repeat(64);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Simulate a crash-interrupted claim: in-progress manifest with claimed_by set
 *  but no snapshot (crash after rename+field-rewrite, before snapshot write). */
function makeCrashedManifest(claimedBy: string): ExecutionManifest {
  return {
    ref: REF,
    status: "in-progress" as const,
    adapter: "native" as const,
    source_path: `.flow/native-stories/${REF}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      { text: "Given x, when y, then z.", kind: "integration" as const },
    ],
    title: "Crash-recovery test story",
    narrative: "As a dev, I want to recover from crash.",
    withdrawn: false,
    ready: true,
    claimed_by: claimedBy,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let inProgressDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-crash-recovery-"));
  inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
  await fs.mkdir(inProgressDir, { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "to-do"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "done"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function seedCrashedManifest(claimedBy: string): Promise<string> {
  const absPath = path.join(inProgressDir, `${REF}.yaml`);
  await atomicWriteFile(
    absPath,
    yamlStringify(makeCrashedManifest(claimedBy), { lineWidth: 0 }),
  );
  // Deliberately NO snapshot — simulates crash between claim and snapshot write.
  return absPath;
}

function snapshotPath(): string {
  return path.join(inProgressDir, `${REF}.snapshot.yaml`);
}

// ---------------------------------------------------------------------------
// AC3 — crash-interrupted story is recoverable via claimStory re-baseline
// ---------------------------------------------------------------------------

describe("AC3: crash-interrupted story (claimed_by set, no snapshot) is recoverable", () => {
  it(
    "claimStory with a matching sessionUlid re-establishes the snapshot and returns { ref, absPath }",
    async () => {
      // Seed the crashed manifest with the original session's claimed_by.
      await seedCrashedManifest(ORIGINAL_SESSION_ULID);

      // A later run re-claims the story using the SAME session for which it was
      // originally claimed (or after reattachOrphan has updated claimed_by to the
      // new session). We call claimStory with the ORIGINAL session ulid here to
      // directly test the re-baseline path (claimed_by matches the on-disk value).
      const result = await claimStory({
        targetRepoRoot: tmpRoot,
        ref: REF,
        sessionUlid: ORIGINAL_SESSION_ULID,
      });

      // Must return successfully.
      expect(result.ref).toBe(REF);
      expect(result.absPath).toBe(path.join(inProgressDir, `${REF}.yaml`));
    },
    15_000,
  );

  it(
    "after re-claiming, the snapshot sidecar is written so detectInProgressHandEdit no longer throws _snapshot_missing",
    async () => {
      await seedCrashedManifest(ORIGINAL_SESSION_ULID);

      // Snapshot must not exist before the re-claim.
      await expect(fs.stat(snapshotPath())).rejects.toMatchObject({ code: "ENOENT" });

      await claimStory({
        targetRepoRoot: tmpRoot,
        ref: REF,
        sessionUlid: ORIGINAL_SESSION_ULID,
      });

      // Snapshot must exist after the re-claim.
      await expect(fs.stat(snapshotPath())).resolves.toBeTruthy();
    },
    15_000,
  );

  it(
    "claimStory with a NEW sessionUlid also re-establishes the snapshot (after orphan reattach scenario)",
    async () => {
      // Simulate what the run does: reattachOrphan rewrites claimed_by to the
      // new session's ULID. Then claimStory is called with the new session.
      // We simulate this by writing the crashed manifest with NEW_SESSION's claimed_by.
      await seedCrashedManifest(SESSION_ULID);

      const result = await claimStory({
        targetRepoRoot: tmpRoot,
        ref: REF,
        sessionUlid: SESSION_ULID,
      });

      expect(result.ref).toBe(REF);
      // Snapshot must now exist.
      await expect(fs.stat(snapshotPath())).resolves.toBeTruthy();
    },
    15_000,
  );

  it(
    "after recovery, the story is NOT permanently wedged — calling claimStory again succeeds idempotently (snapshot exists)",
    async () => {
      await seedCrashedManifest(ORIGINAL_SESSION_ULID);

      // First recovery call.
      await claimStory({
        targetRepoRoot: tmpRoot,
        ref: REF,
        sessionUlid: ORIGINAL_SESSION_ULID,
      });

      // Second call (idempotent — snapshot already written). The story is in
      // in-progress/ with a valid snapshot and claimed_by, so detectInProgressHandEdit
      // passes, then the to-do/ read throws ManifestNotFoundError (not a tamper error).
      // This is the expected re-entry behaviour for an already-claimed story.
      const { ManifestNotFoundError } = await import("../../errors.js");
      await expect(
        claimStory({
          targetRepoRoot: tmpRoot,
          ref: REF,
          sessionUlid: ORIGINAL_SESSION_ULID,
        }),
      ).rejects.toBeInstanceOf(ManifestNotFoundError);
    },
    15_000,
  );
});
