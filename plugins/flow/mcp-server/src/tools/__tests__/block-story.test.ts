/**
 * `blockStory` unit test — fix/run-isolation-coordination-honesty.
 *
 * blockStory is the live run's "give up on this story" primitive: it moves a
 * story THIS session owns from in-progress/ to blocked/ as a clean state change.
 * This is the non-termination fix's load-bearing seam — without moving an
 * abandoned story OUT of in-progress/, claimNextStory keeps reporting
 * waiting-on-in-progress and the run spins forever.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { blockStory } from "../block-story.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { ManifestNotFoundError, WrongClaimantError } from "../../errors.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";

const STORY_REF = "native:01BLOCKSTORYTEST0000000000";
const SESSION_ULID = "01TESTULID0000000000000000";

let tmpRoot: string;
let inProgressDir: string;
let blockedDir: string;

function makeInProgressManifestYaml(opts: {
  claimed_by?: string;
  blocked_by?: string;
}): string {
  const manifest: Record<string, unknown> = {
    ref: STORY_REF,
    status: "in-progress",
    adapter: "native",
    source_path: `.flow/native-stories/${STORY_REF.replace("native:", "")}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [
      { text: "Given x, when y, then z.", kind: "integration" as const },
    ],
    title: "blockStory test story",
    narrative: "As a dev, I want blockStory to move a story cleanly to blocked/.",
    withdrawn: false,
  };
  if (opts.claimed_by !== undefined) manifest["claimed_by"] = opts.claimed_by;
  if (opts.blocked_by !== undefined) manifest["blocked_by"] = opts.blocked_by;
  return yamlStringify(manifest, { lineWidth: 0 });
}

async function seedInProgress(opts: { claimed_by?: string; blocked_by?: string }): Promise<void> {
  await atomicWriteFile(
    path.join(inProgressDir, `${STORY_REF}.yaml`),
    makeInProgressManifestYaml(opts),
  );
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-block-story-"));
  inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
  blockedDir = path.join(tmpRoot, ".flow", "state", "blocked");
  await fs.mkdir(inProgressDir, { recursive: true });
  await fs.mkdir(blockedDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("blockStory — clean in-progress → blocked move", () => {
  it("moves the manifest to blocked/, stamps blocked_by, clears claimed_by, sets status blocked", async () => {
    await seedInProgress({ claimed_by: SESSION_ULID });

    const result = await blockStory({
      targetRepoRoot: tmpRoot,
      ref: STORY_REF,
      sessionUlid: SESSION_ULID,
      blockedBy: "rework-exhausted",
    });

    expect(result.ref).toBe(STORY_REF);

    // in-progress/ no longer has the ref.
    await expect(
      fs.stat(path.join(inProgressDir, `${STORY_REF}.yaml`)),
    ).rejects.toThrow();

    // blocked/ has a clean, contradiction-free manifest.
    const blockedRaw = await fs.readFile(path.join(blockedDir, `${STORY_REF}.yaml`), "utf8");
    const blocked = parseExecutionManifest(yamlParse(blockedRaw) as unknown, {
      absPath: path.join(blockedDir, `${STORY_REF}.yaml`),
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_by).toBe("rework-exhausted");
    expect(blocked.claimed_by).toBeUndefined();
  });

  it("overwrites a stale blocked_by from a prior NEEDS-CHANGES round with the give-up reason", async () => {
    await seedInProgress({ claimed_by: SESSION_ULID, blocked_by: "reviewer-verdict-needs-changes" });

    await blockStory({
      targetRepoRoot: tmpRoot,
      ref: STORY_REF,
      sessionUlid: SESSION_ULID,
      blockedBy: "worker-threw",
    });

    const blockedRaw = await fs.readFile(path.join(blockedDir, `${STORY_REF}.yaml`), "utf8");
    const blocked = parseExecutionManifest(yamlParse(blockedRaw) as unknown, {
      absPath: path.join(blockedDir, `${STORY_REF}.yaml`),
    });
    expect(blocked.blocked_by).toBe("worker-threw");
  });

  it("refuses to block a story claimed by another session (WrongClaimantError) — and leaves it in in-progress/", async () => {
    await seedInProgress({ claimed_by: "01OTHERSESSION00000000000000" });

    await expect(
      blockStory({
        targetRepoRoot: tmpRoot,
        ref: STORY_REF,
        sessionUlid: SESSION_ULID,
        blockedBy: "worker-threw",
      }),
    ).rejects.toBeInstanceOf(WrongClaimantError);

    // The manifest is untouched in in-progress/ — a concurrent worker can't steal it.
    await expect(
      fs.stat(path.join(inProgressDir, `${STORY_REF}.yaml`)),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(blockedDir, `${STORY_REF}.yaml`)),
    ).rejects.toThrow();
  });

  it("treats an absent claimed_by as a mismatch (WrongClaimantError)", async () => {
    await seedInProgress({}); // no claimed_by

    await expect(
      blockStory({
        targetRepoRoot: tmpRoot,
        ref: STORY_REF,
        sessionUlid: SESSION_ULID,
        blockedBy: "worker-threw",
      }),
    ).rejects.toBeInstanceOf(WrongClaimantError);
  });

  it("throws ManifestNotFoundError when the ref is not in in-progress/", async () => {
    await expect(
      blockStory({
        targetRepoRoot: tmpRoot,
        ref: STORY_REF,
        sessionUlid: SESSION_ULID,
        blockedBy: "worker-threw",
      }),
    ).rejects.toBeInstanceOf(ManifestNotFoundError);
  });
});
