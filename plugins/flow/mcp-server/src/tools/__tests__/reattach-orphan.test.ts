/**
 * Unit tests for `reattachOrphan` — Story 5.11 Task 2.4.
 *
 * Covers:
 *   (a) Successful rewrite — manifest's claimed_by equals currentSessionUlid after the call.
 *   (b) NotAnOrphanError raised when claimed_by === currentSessionUlid.
 *   (c) ManifestNotFoundError raised when the ref is absent from in-progress/.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { reattachOrphan } from "../reattach-orphan.js";
import { ManifestNotFoundError, NotAnOrphanError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENT_SESSION_ULID = "01JVWX2CURRENT0000000001AB";
const STALE_ULID = "01JVWX2STALE0000000000003A";
const SOURCE_HASH = "a".repeat(64);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifestYaml(
  ref: string,
  claimedBy: string,
): string {
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
    title: "Reattach test story",
    narrative: "As a dev, I want to test reattach.",
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-5-11-reattach-"));
  stateRoot = path.join(tmpDir, ".flow", "state");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) Successful rewrite
// ---------------------------------------------------------------------------

describe("reattachOrphan — successful rewrite", () => {
  it("rewrites claimed_by to currentSessionUlid", async () => {
    const ref = "native:01JVWX2REATTACH0000000001";
    const absPath = await seedInProgressManifest(stateRoot, ref, STALE_ULID);

    const result = await reattachOrphan({
      targetRepoRoot: tmpDir,
      ref,
      currentSessionUlid: CURRENT_SESSION_ULID,
    });

    // Verify returned chatLog has the reattach line.
    expect(result.chatLog).toHaveLength(1);
    expect(result.chatLog[0]).toContain("reattaching");
    expect(result.chatLog[0]).toContain(ref);
    expect(result.chatLog[0]).toContain(STALE_ULID);
    expect(result.chatLog[0]).toContain(CURRENT_SESSION_ULID);

    // Verify the manifest was actually written with the new claimed_by.
    const raw = await fs.readFile(absPath, "utf8");
    const written = yamlParse(raw) as Record<string, unknown>;
    expect(written["claimed_by"]).toBe(CURRENT_SESSION_ULID);
  });

  it("chatLog line matches the verbatim shape from the spec", async () => {
    const ref = "native:01JVWX2REATTACH0000000002";
    await seedInProgressManifest(stateRoot, ref, STALE_ULID);

    const result = await reattachOrphan({
      targetRepoRoot: tmpDir,
      ref,
      currentSessionUlid: CURRENT_SESSION_ULID,
    });

    expect(result.chatLog[0]).toBe(
      `reattaching ${ref} — claimed_by rewritten from ${STALE_ULID} to ${CURRENT_SESSION_ULID} (resume attempt 1)`,
    );
  });

  it("bumps drain_resume_attempts and returns the post-increment count (crash-recovery cap)", async () => {
    const ref = "native:01JVWX2REATTACH0000000003";
    const absPath = await seedInProgressManifest(stateRoot, ref, STALE_ULID);

    // First reattach: undefined -> 1.
    const first = await reattachOrphan({
      targetRepoRoot: tmpDir,
      ref,
      currentSessionUlid: CURRENT_SESSION_ULID,
    });
    expect(first.resumeAttempts).toBe(1);
    let written = yamlParse(await fs.readFile(absPath, "utf8")) as Record<string, unknown>;
    expect(written["drain_resume_attempts"]).toBe(1);

    // Second reattach (a later session re-resuming the same orphan): 1 -> 2.
    const second = await reattachOrphan({
      targetRepoRoot: tmpDir,
      ref,
      currentSessionUlid: "01JVWX2CURRENT0000000002CD",
    });
    expect(second.resumeAttempts).toBe(2);
    written = yamlParse(await fs.readFile(absPath, "utf8")) as Record<string, unknown>;
    expect(written["drain_resume_attempts"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (b) NotAnOrphanError when claimed_by === currentSessionUlid
// ---------------------------------------------------------------------------

describe("reattachOrphan — NotAnOrphanError on race condition", () => {
  it("throws NotAnOrphanError when claimed_by already matches currentSessionUlid", async () => {
    const ref = "native:01JVWX2NOTORPHAN000000001";
    await seedInProgressManifest(stateRoot, ref, CURRENT_SESSION_ULID);

    await expect(
      reattachOrphan({
        targetRepoRoot: tmpDir,
        ref,
        currentSessionUlid: CURRENT_SESSION_ULID,
      }),
    ).rejects.toThrow(NotAnOrphanError);
  });
});

// ---------------------------------------------------------------------------
// (c) ManifestNotFoundError when ref absent from in-progress/
// ---------------------------------------------------------------------------

describe("reattachOrphan — ManifestNotFoundError on missing ref", () => {
  it("throws ManifestNotFoundError when ref does not exist in in-progress/", async () => {
    const ref = "native:01JVWX2NOTFOUND000000001";
    // Create in-progress/ dir but don't put any manifest there.
    await fs.mkdir(path.join(stateRoot, "in-progress"), { recursive: true });

    await expect(
      reattachOrphan({
        targetRepoRoot: tmpDir,
        ref,
        currentSessionUlid: CURRENT_SESSION_ULID,
      }),
    ).rejects.toThrow(ManifestNotFoundError);
  });
});
