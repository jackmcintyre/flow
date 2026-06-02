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
