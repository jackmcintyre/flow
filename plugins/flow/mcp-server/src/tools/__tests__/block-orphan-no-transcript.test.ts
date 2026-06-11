/**
 * Unit tests for `blockOrphanNoTranscript` — Story 5.11 Task 3.4.
 *
 * Covers:
 *   (a) Successful move + blocked_by stamp.
 *   (b) Manifest no longer present in in-progress/<ref>.yaml after the call.
 *   (c) Chat line matches AC3's literal shape.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { blockOrphanNoTranscript } from "../block-orphan-no-transcript.js";
import { ManifestNotFoundError } from "../../errors.js";
import { isClaimable } from "../../state/manifest-state-machine.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_ULID = "01JVWX2STALE0000000000004B";
const SOURCE_HASH = "a".repeat(64);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifestYaml(ref: string, claimedBy: string): string {
  const manifest: Record<string, unknown> = {
    ref,
    status: "in-progress",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      { text: "Given AC, when done, then works.", kind: "integration" },
    ],
    title: "Block test story",
    narrative: "As a dev, I want to test block-orphan.",
    withdrawn: false,
    claimed_by: claimedBy,
  };
  return yamlStringify(manifest, { lineWidth: 0 });
}

async function seedInProgressManifest(
  stateRoot: string,
  ref: string,
  claimedBy: string,
): Promise<string> {
  const dir = path.join(stateRoot, "in-progress");
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${ref}.yaml`);
  await fs.writeFile(absPath, makeManifestYaml(ref, claimedBy), "utf8");
  return absPath;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let stateRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-5-11-block-"));
  stateRoot = path.join(tmpDir, ".flow", "state");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) Successful move + blocked_by stamp
// ---------------------------------------------------------------------------

describe("blockOrphanNoTranscript — successful move and stamp", () => {
  it("moves manifest to blocked/ and stamps blocked_by: orphan-no-transcript", async () => {
    const ref = "native:01JVWX2BLOCKTEST0000000001";
    await seedInProgressManifest(stateRoot, ref, STALE_ULID);

    const result = await blockOrphanNoTranscript({
      targetRepoRoot: tmpDir,
      ref,
      staleUlid: STALE_ULID,
    });

    // Verify the chatLog is returned.
    expect(result.chatLog).toHaveLength(1);

    // Verify the manifest now exists in blocked/ with the blocked_by stamp.
    const blockedPath = path.join(stateRoot, "blocked", `${ref}.yaml`);
    const raw = await fs.readFile(blockedPath, "utf8");
    const written = yamlParse(raw) as Record<string, unknown>;
    expect(written["blocked_by"]).toBe("orphan-no-transcript");
  });
});

// ---------------------------------------------------------------------------
// (b) Manifest no longer in in-progress/ after the call
// ---------------------------------------------------------------------------

describe("blockOrphanNoTranscript — manifest removed from in-progress/", () => {
  it("manifest is no longer present at in-progress/<ref>.yaml after blockOrphanNoTranscript", async () => {
    const ref = "native:01JVWX2BLOCKTEST0000000002";
    const absInProgressPath = await seedInProgressManifest(
      stateRoot,
      ref,
      STALE_ULID,
    );

    await blockOrphanNoTranscript({
      targetRepoRoot: tmpDir,
      ref,
      staleUlid: STALE_ULID,
    });

    // In-progress file should be gone (rename is atomic).
    await expect(fs.access(absInProgressPath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (c) Chat line matches AC3's literal shape
// ---------------------------------------------------------------------------

describe("blockOrphanNoTranscript — AC3 literal chat line", () => {
  it("returns the verbatim AC3 chat line", async () => {
    const ref = "native:01JVWX2BLOCKTEST0000000003";
    await seedInProgressManifest(stateRoot, ref, STALE_ULID);

    const result = await blockOrphanNoTranscript({
      targetRepoRoot: tmpDir,
      ref,
      staleUlid: STALE_ULID,
    });

    expect(result.chatLog[0]).toBe(
      `[blocked] ${ref} — orphan-no-transcript: no persisted transcript for session ${STALE_ULID}; manual recovery required`,
    );
  });
});

// ---------------------------------------------------------------------------
// ManifestNotFoundError when ref absent from in-progress/
// ---------------------------------------------------------------------------

describe("blockOrphanNoTranscript — ManifestNotFoundError on missing ref", () => {
  it("throws ManifestNotFoundError when ref does not exist in in-progress/", async () => {
    const ref = "native:01JVWX2BLOCKNOTFOUND00001";
    await fs.mkdir(path.join(stateRoot, "in-progress"), { recursive: true });

    await expect(
      blockOrphanNoTranscript({
        targetRepoRoot: tmpDir,
        ref,
        staleUlid: STALE_ULID,
      }),
    ).rejects.toThrow(ManifestNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// AC2 (story native:01KTSQXTDXGG53RMPMH904TZRV): blocking produces a clean
// state change — claimed_by cleared, status updated to blocked, snapshot
// sidecar removed, blocked_by stamped.
// ---------------------------------------------------------------------------

describe("blockOrphanNoTranscript — clean state change (AC2)", () => {
  it("clears claimed_by from the blocked manifest", async () => {
    const ref = "native:01JVWX2BLOCKCLEAN000000001";
    await seedInProgressManifest(stateRoot, ref, STALE_ULID);

    await blockOrphanNoTranscript({ targetRepoRoot: tmpDir, ref, staleUlid: STALE_ULID });

    const blockedPath = path.join(stateRoot, "blocked", `${ref}.yaml`);
    const raw = await fs.readFile(blockedPath, "utf8");
    const written = yamlParse(raw) as Record<string, unknown>;
    // claimed_by must be absent after blocking — the manifest carries no claim.
    expect(written["claimed_by"]).toBeUndefined();
  });

  it("sets status to 'blocked' in the blocked manifest", async () => {
    const ref = "native:01JVWX2BLOCKCLEAN000000002";
    await seedInProgressManifest(stateRoot, ref, STALE_ULID);

    await blockOrphanNoTranscript({ targetRepoRoot: tmpDir, ref, staleUlid: STALE_ULID });

    const blockedPath = path.join(stateRoot, "blocked", `${ref}.yaml`);
    const raw = await fs.readFile(blockedPath, "utf8");
    const written = yamlParse(raw) as Record<string, unknown>;
    expect(written["status"]).toBe("blocked");
  });

  it("removes the claim-time sidecar snapshot if it exists", async () => {
    const ref = "native:01JVWX2BLOCKCLEAN000000003";
    await seedInProgressManifest(stateRoot, ref, STALE_ULID);
    // Seed a sidecar snapshot to confirm it gets removed.
    const snapshotPath = path.join(stateRoot, "in-progress", `${ref}.snapshot.yaml`);
    await fs.writeFile(
      snapshotPath,
      yamlStringify({ source_hash: SOURCE_HASH, title: "Block test story" }, { lineWidth: 0 }),
      "utf8",
    );

    await blockOrphanNoTranscript({ targetRepoRoot: tmpDir, ref, staleUlid: STALE_ULID });

    // Sidecar must be gone after the block operation.
    await expect(fs.access(snapshotPath)).rejects.toThrow();
  });

  it("still succeeds when there is no sidecar snapshot to remove (idempotent)", async () => {
    const ref = "native:01JVWX2BLOCKCLEAN000000004";
    await seedInProgressManifest(stateRoot, ref, STALE_ULID);
    // No sidecar seeded — removeInProgressSnapshot should be a no-op.

    // Must not throw.
    await expect(
      blockOrphanNoTranscript({ targetRepoRoot: tmpDir, ref, staleUlid: STALE_ULID }),
    ).resolves.toBeDefined();
  });

  it("blocked manifest passes schema validation (no contradictions)", async () => {
    const ref = "native:01JVWX2BLOCKCLEAN000000005";
    await seedInProgressManifest(stateRoot, ref, STALE_ULID);

    await blockOrphanNoTranscript({ targetRepoRoot: tmpDir, ref, staleUlid: STALE_ULID });

    const blockedPath = path.join(stateRoot, "blocked", `${ref}.yaml`);
    const raw = await fs.readFile(blockedPath, "utf8");
    // parseExecutionManifest throws MalformedExecutionManifestError on any schema
    // violation — a round-trip parse proves the manifest is internally consistent.
    expect(() => parseExecutionManifest(yamlParse(raw) as unknown, { absPath: blockedPath })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC3 (story native:01KTSQXTDXGG53RMPMH904TZRV): a blocked story moved back to
// the waiting queue following the documented recovery is offered and claimable
// again by the build loop.
//
// The documented recovery: move the manifest from blocked/ back to to-do/ and
// update its status to "to-do". After that transition the manifest must satisfy
// `isClaimable()` so the claim loop will offer it.
// ---------------------------------------------------------------------------

describe("blockOrphanNoTranscript — resume claimable after recovery (AC3)", () => {
  it("a blocked manifest moved back to to-do/ becomes claimable (AC3)", async () => {
    const ref = "native:01JVWX2BLOCKRESUME000001A";
    await seedInProgressManifest(stateRoot, ref, STALE_ULID);

    // Block the story (the operation under test).
    await blockOrphanNoTranscript({ targetRepoRoot: tmpDir, ref, staleUlid: STALE_ULID });

    // Verify it's in blocked/ with a clean state.
    const blockedPath = path.join(stateRoot, "blocked", `${ref}.yaml`);
    const blockedRaw = await fs.readFile(blockedPath, "utf8");
    const blockedManifest = parseExecutionManifest(yamlParse(blockedRaw) as unknown, { absPath: blockedPath });
    expect(blockedManifest.claimed_by).toBeUndefined();
    expect(blockedManifest.status).toBe("blocked");

    // Simulate the documented operator recovery: move from blocked/ to to-do/
    // and update status to "to-do" and clear blocked_by. This is the same sequence
    // the operator would run to unstick the story.
    const todoDir = path.join(stateRoot, "to-do");
    await fs.mkdir(todoDir, { recursive: true });
    const todoPath = path.join(todoDir, `${ref}.yaml`);
    const { blocked_by: _clearBlock, ...withoutBlock } = blockedManifest;
    const resumedManifest = {
      ...withoutBlock,
      status: "to-do" as const,
      ready: true, // operator blesses it so the claim loop can pick it up
    };
    await fs.writeFile(todoPath, yamlStringify(resumedManifest, { lineWidth: 0 }), "utf8");
    // Remove from blocked/ (simulate moveBetweenStates from blocked → to-do).
    await fs.unlink(blockedPath);

    // Now verify the story is genuinely claimable by the claim loop.
    const todoRaw = await fs.readFile(todoPath, "utf8");
    const todoManifest = parseExecutionManifest(yamlParse(todoRaw) as unknown, { absPath: todoPath });
    expect(isClaimable(todoManifest)).toBe(true);
  });
});
