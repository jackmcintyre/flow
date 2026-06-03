/**
 * Tests for Story 5.20: orphan-recovery reviewer-only re-spawn when PR exists.
 *
 * AC3 (integration): orphan with hasTranscript: false + open PR → hasOpenPR: true,
 *   reattachOrphan called (claimed_by rewritten), no blocked_by stamp.
 *
 * AC4 (regression): same orphan shape but no open PR → hasOpenPR: false,
 *   blockOrphanNoTranscript called, manifest stamped blocked_by: orphan-no-transcript.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { scanOrphanedInProgress } from "../scan-orphaned-in-progress.js";
import { reattachOrphan } from "../reattach-orphan.js";
import { blockOrphanNoTranscript } from "../block-orphan-no-transcript.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENT_SESSION_ULID = "01JVWX2CURRENT0000000020AC";
const STALE_ULID = "01JVWX2STALE000000000020ST";
const SOURCE_HASH = "a".repeat(64);
// Story title used in the manifest — the branch slug will be derived from ref + title.
const STORY_TITLE = "Orphan reviewer only respawn";
// The ref chosen here must produce a deterministic branch slug via buildBranchSlug.
// buildBranchSlug({ ref: "native:01JVWX2ORPHAN0000000020PR", title: STORY_TITLE })
// → "story/native-01jvwx2orphan0000000020pr-orphan-reviewer-only-respawn"
const REF = "native:01JVWX2ORPHAN0000000020PR";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifestYaml(ref: string, title: string, claimedBy: string): string {
  const manifest: Record<string, unknown> = {
    ref,
    status: "in-progress",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      { text: "Given orphan AC, when PR open, then reviewer spawns.", kind: "integration" },
    ],
    title,
    narrative: "As a plugin operator, I want orphan reviewer-only respawn.",
    withdrawn: false,
    claimed_by: claimedBy,
  };
  return yamlStringify(manifest, { lineWidth: 0 });
}

async function seedInProgressManifest(
  stateRoot: string,
  ref: string,
  title: string,
  claimedBy: string,
): Promise<string> {
  const dir = path.join(stateRoot, "in-progress");
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${ref}.yaml`);
  await fs.writeFile(absPath, makeManifestYaml(ref, title, claimedBy), "utf8");
  return absPath;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let stateRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-5-20-orphan-"));
  stateRoot = path.join(tmpDir, ".flow", "state");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC3 (integration): hasTranscript: false + open PR → hasOpenPR: true,
//   reattachOrphan produces no blocked_by stamp.
// ---------------------------------------------------------------------------

describe("AC3 — orphan with no transcript but open PR routes to reviewer-only respawn", () => {
  it("scanOrphanedInProgress returns hasOpenPR: true when gh reports an open PR", async () => {
    await seedInProgressManifest(stateRoot, REF, STORY_TITLE, STALE_ULID);
    // No transcript seeded — hasTranscript will be false.

    // Mock gh to return a single open PR.
    const mockExeca = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ number: 42 }]),
      stderr: "",
      exitCode: 0,
    });

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
      execaImpl: mockExeca as never,
    });

    expect(result.orphans).toHaveLength(1);
    const orphan = result.orphans[0]!;
    expect(orphan.ref).toBe(REF);
    expect(orphan.hasTranscript).toBe(false);
    expect(orphan.hasOpenPR).toBe(true);

    // Verify gh was called with --head and --state open flags.
    expect(mockExeca).toHaveBeenCalledOnce();
    const ghArgs = mockExeca.mock.calls[0] as [string, string[]];
    expect(ghArgs[0]).toBe("gh");
    expect(ghArgs[1]).toContain("--head");
    expect(ghArgs[1]).toContain("--state");
    expect(ghArgs[1]).toContain("open");
  });

  it("reattachOrphan succeeds and manifest retains no blocked_by stamp when PR exists", async () => {
    await seedInProgressManifest(stateRoot, REF, STORY_TITLE, STALE_ULID);

    // Reattach the orphan (simulates the reviewer-only respawn routing step).
    const reattachResult = await reattachOrphan({
      targetRepoRoot: tmpDir,
      ref: REF,
      currentSessionUlid: CURRENT_SESSION_ULID,
    });

    // Verify reattach succeeded.
    expect(reattachResult.chatLog).toHaveLength(1);
    expect(reattachResult.chatLog[0]).toContain("reattaching");

    // Verify manifest's claimed_by was updated and NO blocked_by was stamped.
    const manifestPath = path.join(stateRoot, "in-progress", `${REF}.yaml`);
    const raw = await fs.readFile(manifestPath, "utf8");
    const written = yamlParse(raw) as Record<string, unknown>;
    expect(written["claimed_by"]).toBe(CURRENT_SESSION_ULID);
    // Key assertion: no blocked_by stamp — the reviewer-only path does NOT block.
    expect(written["blocked_by"]).toBeUndefined();
    // Manifest is still in in-progress/ (not moved to blocked/).
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();
  });

  it("gh error during PR check defaults hasOpenPR to false (safe fallback)", async () => {
    await seedInProgressManifest(stateRoot, REF, STORY_TITLE, STALE_ULID);

    // Mock gh to throw (network error, auth failure, etc.).
    const mockExeca = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
      execaImpl: mockExeca as never,
    });

    expect(result.orphans).toHaveLength(1);
    const orphan = result.orphans[0]!;
    // Safe fallback — do not throw, default to false.
    expect(orphan.hasOpenPR).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 (regression): hasTranscript: false + no open PR → hasOpenPR: false,
//   blockOrphanNoTranscript called, manifest stamped blocked_by: orphan-no-transcript.
// ---------------------------------------------------------------------------

describe("AC4 — orphan with no transcript and no open PR preserves blockOrphanNoTranscript behaviour", () => {
  it("scanOrphanedInProgress returns hasOpenPR: false when gh reports no open PRs", async () => {
    await seedInProgressManifest(stateRoot, REF, STORY_TITLE, STALE_ULID);
    // No transcript seeded.

    // Mock gh to return empty array (no open PRs).
    const mockExeca = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([]),
      stderr: "",
      exitCode: 0,
    });

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
      execaImpl: mockExeca as never,
    });

    expect(result.orphans).toHaveLength(1);
    const orphan = result.orphans[0]!;
    expect(orphan.hasTranscript).toBe(false);
    expect(orphan.hasOpenPR).toBe(false);
  });

  it("blockOrphanNoTranscript stamps blocked_by: orphan-no-transcript when no PR exists", async () => {
    await seedInProgressManifest(stateRoot, REF, STORY_TITLE, STALE_ULID);

    // Simulate the no-PR path: call blockOrphanNoTranscript directly.
    const result = await blockOrphanNoTranscript({
      targetRepoRoot: tmpDir,
      ref: REF,
      staleUlid: STALE_ULID,
    });

    // Verify chatLog is returned.
    expect(result.chatLog).toHaveLength(1);
    expect(result.chatLog[0]).toContain("orphan-no-transcript");

    // Verify manifest moved to blocked/ with blocked_by stamp.
    const blockedPath = path.join(stateRoot, "blocked", `${REF}.yaml`);
    const raw = await fs.readFile(blockedPath, "utf8");
    const written = yamlParse(raw) as Record<string, unknown>;
    expect(written["blocked_by"]).toBe("orphan-no-transcript");

    // Verify manifest is NOT in in-progress/ any more.
    const inProgressPath = path.join(stateRoot, "in-progress", `${REF}.yaml`);
    await expect(fs.access(inProgressPath)).rejects.toThrow();
  });

  it("multiple open PRs on same branch treats as hasOpenPR: true (first-match acceptable)", async () => {
    await seedInProgressManifest(stateRoot, REF, STORY_TITLE, STALE_ULID);

    // Mock gh to return two PRs (edge case: duplicate PRs on same branch).
    const mockExeca = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ number: 42 }, { number: 43 }]),
      stderr: "",
      exitCode: 0,
    });

    const result = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
      execaImpl: mockExeca as never,
    });

    expect(result.orphans[0]!.hasOpenPR).toBe(true);
  });
});
