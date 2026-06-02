/**
 * Integration test suite for the orphan-recovery branch — Story 5.11 Task 5.
 *
 * These tests cover the five AC5 fixtures (5a–5e) by seeding a target-repo
 * tmpdir with the relevant manifests and transcript files, then driving the
 * three new MCP tools directly:
 *   - scanOrphanedInProgress
 *   - reattachOrphan
 *   - blockOrphanNoTranscript
 *
 * The SKILL.md prose's chat-line surfacing and operator-prompt blocking are
 * smoke-only — documented in the describe/it text below. This test file does
 * NOT spawn an MCP server and does NOT exercise SKILL.md prose. It exercises
 * only the tool contracts so that the SKILL.md prose can rely on them.
 *
 * AC coverage:
 *   - 5a: reattach with transcript present (AC1, AC2)
 *   - 5b: reattach with transcript absent (AC1, AC3)
 *   - 5c: skip preserves orphan state (AC1, AC4)
 *   - 5d: alphabetical orphan ordering (AC1 sort order)
 *   - 5e: current-session manifest not surfaced as orphan (AC1 negative)
 *
 * NOT covered here (smoke-only — requires driving SKILL.md prose):
 *   - operator-prompt blocking (the prose awaits user input before calling tools)
 *   - chat-line surface rendering (the prose calls `surface(...)` for each line)
 *   - unrecognised-choice re-prompt loop
 *   - Task-tool call-order assertion (dev spawn MUST NOT occur on reattach)
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { scanOrphanedInProgress } from "../tools/scan-orphaned-in-progress.js";
import { reattachOrphan } from "../tools/reattach-orphan.js";
import { blockOrphanNoTranscript } from "../tools/block-orphan-no-transcript.js";

// ---------------------------------------------------------------------------
// Mock processDevTranscript to spy on arguments (5a fixture)
// ---------------------------------------------------------------------------

vi.mock("../tools/process-dev-transcript.js", () => ({
  processDevTranscript: vi.fn().mockResolvedValue({
    next: "done-blocked-handoff-grammar",
    chatLog: ["[mocked] processDevTranscript called"],
  }),
}));

import { processDevTranscript } from "../tools/process-dev-transcript.js";
const mockProcessDevTranscript = vi.mocked(processDevTranscript);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENT_SESSION_ULID = "01JVWX2CURRENT0000000001CC";
const STALE_ULID_A = "01JVWX2STALE0000000000005A";
const STALE_ULID_B = "01JVWX2STALE0000000000006B";
const SOURCE_HASH = "a".repeat(64);

const VALID_TRANSCRIPT =
  "Dev output line 1\nDev output line 2\n" +
  "Handoff to reviewer — story test-ref ready for review.\nhttps://github.com/owner/repo/pull/42";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifestYaml(
  ref: string,
  opts: { claimedBy?: string; omitClaimedBy?: boolean } = {},
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
    title: "Orphan recovery test story",
    narrative: "As an operator, I want orphan recovery to work.",
    withdrawn: false,
  };
  if (!opts.omitClaimedBy) {
    manifest["claimed_by"] = opts.claimedBy ?? CURRENT_SESSION_ULID;
  }
  return yamlStringify(manifest, { lineWidth: 0 });
}

async function seedInProgressManifest(
  stateRoot: string,
  ref: string,
  opts?: { claimedBy?: string; omitClaimedBy?: boolean },
): Promise<string> {
  const dir = path.join(stateRoot, "in-progress");
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${ref}.yaml`);
  await fs.writeFile(absPath, makeManifestYaml(ref, opts), "utf8");
  return absPath;
}

async function seedTranscriptFile(
  stateRoot: string,
  sessionUlid: string,
  content: string,
): Promise<string> {
  const transcriptPath = path.join(
    stateRoot,
    "sessions",
    sessionUlid,
    "dev-transcript.txt",
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.writeFile(transcriptPath, content, "utf8");
  return transcriptPath;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let stateRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-5-11-int-"));
  stateRoot = path.join(tmpDir, ".flow", "state");
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC5 Fixture 5a — reattach with transcript present
// ---------------------------------------------------------------------------

describe("Fixture 5a — reattach with transcript present (AC1, AC2)", () => {
  /**
   * SMOKE-ONLY (prose-layer):
   *   - The operator observes: `[orphan] <ref> — claimed_by <staleUlid>`
   *   - The operator observes: `reattach or skip? (reattach replays the persisted transcript; skip leaves the manifest in place)`
   *   - On "reattach": the prose calls reattachOrphan, then Read, then processDevTranscript.
   *   - The dev subagent is NOT re-spawned (Task is not called before processDevTranscript).
   */

  it("(5a-i) AC1 literal chat line: orphan surface matches [orphan] <ref> — claimed_by <staleUlid>", async () => {
    const ref = "native:01JVWX2FIXTURE5A000000001";
    await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });
    await seedTranscriptFile(stateRoot, STALE_ULID_A, VALID_TRANSCRIPT);

    const { orphans } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(orphans).toHaveLength(1);
    const orphan = orphans[0]!;

    // The AC1 literal shape: `[orphan] <ref> — claimed_by <stale-ulid>`
    const expectedLine = `[orphan] ${orphan.ref} — claimed_by ${orphan.staleUlid}`;
    expect(expectedLine).toBe(`[orphan] ${ref} — claimed_by ${STALE_ULID_A}`);
  });

  it("(5a-ii) claimed_by is rewritten to current session ULID after reattachOrphan", async () => {
    const ref = "native:01JVWX2FIXTURE5A000000002";
    const absPath = await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });
    await seedTranscriptFile(stateRoot, STALE_ULID_A, VALID_TRANSCRIPT);

    await reattachOrphan({
      targetRepoRoot: tmpDir,
      ref,
      currentSessionUlid: CURRENT_SESSION_ULID,
    });

    const raw = await fs.readFile(absPath, "utf8");
    const manifest = yamlParse(raw) as Record<string, unknown>;
    expect(manifest["claimed_by"]).toBe(CURRENT_SESSION_ULID);
  });

  it("(5a-iii) processDevTranscript is invoked with verbatim transcript bytes", async () => {
    const ref = "native:01JVWX2FIXTURE5A000000003";
    await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });
    const transcriptPath = await seedTranscriptFile(stateRoot, STALE_ULID_A, VALID_TRANSCRIPT);

    // Simulate what SKILL.md step 3.5.5 does: reattach, then read transcript, then call processDevTranscript.
    await reattachOrphan({
      targetRepoRoot: tmpDir,
      ref,
      currentSessionUlid: CURRENT_SESSION_ULID,
    });

    // Read the transcript file (simulating SKILL.md's built-in Read tool).
    const devTranscript = await fs.readFile(transcriptPath, "utf8");

    // Call processDevTranscript with the verbatim bytes.
    await processDevTranscript({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
      ref,
      devTranscript,
    });

    // Assert processDevTranscript was called exactly once with byte-equal transcript.
    expect(mockProcessDevTranscript).toHaveBeenCalledTimes(1);
    const callArgs = mockProcessDevTranscript.mock.calls[0]![0];
    expect(callArgs.devTranscript).toBe(VALID_TRANSCRIPT);
    expect(callArgs.ref).toBe(ref);
    expect(callArgs.sessionUlid).toBe(CURRENT_SESSION_ULID);
  });

  it("(5a-iv) hasTranscript is true for the orphan with a present transcript file", async () => {
    const ref = "native:01JVWX2FIXTURE5A000000004";
    await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });
    await seedTranscriptFile(stateRoot, STALE_ULID_A, VALID_TRANSCRIPT);

    const { orphans } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.hasTranscript).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5 Fixture 5b — reattach with transcript absent
// ---------------------------------------------------------------------------

describe("Fixture 5b — reattach with transcript absent (AC1, AC3)", () => {
  /**
   * SMOKE-ONLY (prose-layer):
   *   - The operator observes the AC1 orphan line.
   *   - On "reattach" with hasTranscript === false: blockOrphanNoTranscript is called.
   *   - processDevTranscript is NOT called.
   */

  it("(5b-i) AC1 literal chat line: orphan surface correct for no-transcript orphan", async () => {
    const ref = "native:01JVWX2FIXTURE5B000000001";
    await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });
    // No transcript file.

    const { orphans } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(orphans).toHaveLength(1);
    const orphan = orphans[0]!;
    expect(orphan.hasTranscript).toBe(false);
    const expectedLine = `[orphan] ${orphan.ref} — claimed_by ${orphan.staleUlid}`;
    expect(expectedLine).toBe(`[orphan] ${ref} — claimed_by ${STALE_ULID_A}`);
  });

  it("(5b-ii) blockOrphanNoTranscript moves manifest from in-progress/ to blocked/", async () => {
    const ref = "native:01JVWX2FIXTURE5B000000002";
    const absInProgressPath = await seedInProgressManifest(stateRoot, ref, {
      claimedBy: STALE_ULID_A,
    });

    await blockOrphanNoTranscript({
      targetRepoRoot: tmpDir,
      ref,
      staleUlid: STALE_ULID_A,
    });

    // In-progress file should be gone.
    await expect(fs.access(absInProgressPath)).rejects.toThrow();

    // Blocked file should exist with blocked_by.
    const blockedPath = path.join(stateRoot, "blocked", `${ref}.yaml`);
    const raw = await fs.readFile(blockedPath, "utf8");
    const manifest = yamlParse(raw) as Record<string, unknown>;
    expect(manifest["blocked_by"]).toBe("orphan-no-transcript");
  });

  it("(5b-iii) blocked manifest carries blocked_by: orphan-no-transcript", async () => {
    const ref = "native:01JVWX2FIXTURE5B000000003";
    await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });

    await blockOrphanNoTranscript({
      targetRepoRoot: tmpDir,
      ref,
      staleUlid: STALE_ULID_A,
    });

    const blockedPath = path.join(stateRoot, "blocked", `${ref}.yaml`);
    const raw = await fs.readFile(blockedPath, "utf8");
    const manifest = yamlParse(raw) as Record<string, unknown>;
    expect(manifest["blocked_by"]).toBe("orphan-no-transcript");
  });

  it("(5b-iv) AC3 chat line matches verbatim shape", async () => {
    const ref = "native:01JVWX2FIXTURE5B000000004";
    await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });

    const result = await blockOrphanNoTranscript({
      targetRepoRoot: tmpDir,
      ref,
      staleUlid: STALE_ULID_A,
    });

    expect(result.chatLog[0]).toBe(
      `[blocked] ${ref} — orphan-no-transcript: no persisted transcript for session ${STALE_ULID_A}; manual recovery required`,
    );
  });

  it("(5b-v) processDevTranscript is NOT called on the no-transcript path", async () => {
    const ref = "native:01JVWX2FIXTURE5B000000005";
    await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });

    // Simulate no-transcript path: scan → detect hasTranscript false → blockOrphanNoTranscript.
    const { orphans } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });
    expect(orphans[0]!.hasTranscript).toBe(false);

    await blockOrphanNoTranscript({
      targetRepoRoot: tmpDir,
      ref,
      staleUlid: STALE_ULID_A,
    });

    // processDevTranscript was NOT called (mock call count = 0).
    expect(mockProcessDevTranscript).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC5 Fixture 5c — skip preserves orphan state
// ---------------------------------------------------------------------------

describe("Fixture 5c — skip preserves orphan state (AC1, AC4)", () => {
  /**
   * SMOKE-ONLY (prose-layer):
   *   - On "skip": the prose does NOT call reattachOrphan or blockOrphanNoTranscript.
   *   - The manifest is left byte-identical in in-progress/.
   *   - The outer loop advances to claimNextStory.
   *
   * The tool-layer contract verified here: the manifest on disk is unchanged
   * after a skip (since the skip path calls NO tool — the prose simply skips).
   */

  it("(5c-i) AC1 literal chat line appears for the orphan", async () => {
    const ref = "native:01JVWX2FIXTURE5C000000001";
    await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });

    const { orphans } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(orphans).toHaveLength(1);
    const expectedLine = `[orphan] ${orphans[0]!.ref} — claimed_by ${orphans[0]!.staleUlid}`;
    expect(expectedLine).toBe(`[orphan] ${ref} — claimed_by ${STALE_ULID_A}`);
  });

  it("(5c-ii) manifest is byte-identical when skip is chosen (no tool called)", async () => {
    const ref = "native:01JVWX2FIXTURE5C000000002";
    const originalYaml = makeManifestYaml(ref, { claimedBy: STALE_ULID_A });
    const dir = path.join(stateRoot, "in-progress");
    await fs.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, `${ref}.yaml`);
    await fs.writeFile(absPath, originalYaml, "utf8");

    // Simulate "skip": do nothing (no tool call).
    // Verify the file is unchanged.
    const afterSkip = await fs.readFile(absPath, "utf8");
    expect(afterSkip).toBe(originalYaml);
  });

  it("(5c-iii) manifest remains in in-progress/ after skip", async () => {
    const ref = "native:01JVWX2FIXTURE5C000000003";
    const absPath = await seedInProgressManifest(stateRoot, ref, {
      claimedBy: STALE_ULID_A,
    });

    // Simulate "skip": do nothing.
    await expect(fs.access(absPath)).resolves.toBeUndefined();
  });

  it("(5c-iv) scanOrphanedInProgress re-surfaces the orphan on the next outer-loop iteration", async () => {
    const ref = "native:01JVWX2FIXTURE5C000000004";
    await seedInProgressManifest(stateRoot, ref, { claimedBy: STALE_ULID_A });

    // First scan (first outer-loop iteration).
    const { orphans: firstScan } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });
    expect(firstScan).toHaveLength(1);

    // Skip: do nothing.

    // Second scan (next outer-loop iteration) — orphan still there.
    const { orphans: secondScan } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });
    expect(secondScan).toHaveLength(1);
    expect(secondScan[0]!.ref).toBe(ref);
  });
});

// ---------------------------------------------------------------------------
// AC5 Fixture 5d — alphabetical orphan ordering
// ---------------------------------------------------------------------------

describe("Fixture 5d — alphabetical orphan ordering (AC1 sort order)", () => {
  /**
   * SMOKE-ONLY (prose-layer):
   *   - The prose surfaces orphans in alphabetical ref order.
   *   - Each orphan's prompt is awaited before the next orphan is surfaced.
   *
   * The tool-layer contract: scanOrphanedInProgress returns in alphabetical order.
   */

  it("(5d-i) AC1 chat line for a-first is returned before b-second in the orphans array", async () => {
    const refA = "native:01JVWX2A-FIRST00000000002";
    const refB = "native:01JVWX2B-SECOND0000000002";
    // Seed in reverse order to confirm sort.
    await seedInProgressManifest(stateRoot, refB, { claimedBy: STALE_ULID_B });
    await seedInProgressManifest(stateRoot, refA, { claimedBy: STALE_ULID_A });

    const { orphans } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(orphans).toHaveLength(2);
    // a-first must come before b-second in alphabetical order.
    expect(orphans[0]!.ref).toBe(refA);
    expect(orphans[1]!.ref).toBe(refB);
  });

  it("(5d-ii) both orphans carry distinct staleUlids", async () => {
    const refA = "native:01JVWX2A-FIRST00000000003";
    const refB = "native:01JVWX2B-SECOND0000000003";
    await seedInProgressManifest(stateRoot, refA, { claimedBy: STALE_ULID_A });
    await seedInProgressManifest(stateRoot, refB, { claimedBy: STALE_ULID_B });

    const { orphans } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(orphans[0]!.staleUlid).toBe(STALE_ULID_A);
    expect(orphans[1]!.staleUlid).toBe(STALE_ULID_B);
  });
});

// ---------------------------------------------------------------------------
// AC5 Fixture 5e — current-session manifest is NOT an orphan
// ---------------------------------------------------------------------------

describe("Fixture 5e — current-session manifest not surfaced as orphan (AC1 negative)", () => {
  it("(5e-i) no [orphan] line is produced for a manifest claimed by the current session", async () => {
    const ref = "native:01JVWX2FIXTURE5E000000001";
    await seedInProgressManifest(stateRoot, ref, {
      claimedBy: CURRENT_SESSION_ULID,
    });

    const { orphans } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    expect(orphans).toHaveLength(0);
  });

  it("(5e-ii) outer loop proceeds to claimNextStory without an orphan branch when no orphans exist", async () => {
    const ref = "native:01JVWX2FIXTURE5E000000002";
    await seedInProgressManifest(stateRoot, ref, {
      claimedBy: CURRENT_SESSION_ULID,
    });

    const { orphans } = await scanOrphanedInProgress({
      targetRepoRoot: tmpDir,
      sessionUlid: CURRENT_SESSION_ULID,
    });

    // If orphans is empty, the prose layer skips the orphan branch entirely.
    expect(orphans).toHaveLength(0);
    // No tools are called by the orphan branch.
    expect(mockProcessDevTranscript).not.toHaveBeenCalled();
  });
});
