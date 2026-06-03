/**
 * Integration tests for the dev-transcript persistence contract (Story 5.10).
 *
 * These tests cover the path-and-content contract that SKILL.md step 4.5
 * implements via Claude Code's built-in `Write` tool:
 *   given (targetRepoRoot, sessionUlid, devTranscript),
 *   the file at <targetRepoRoot>/.flow/state/sessions/<sessionUlid>/dev-transcript.txt
 *   contains byte-for-byte the devTranscript string.
 *
 * AC coverage:
 *   - 6a: path computation
 *   - 6b: content fidelity
 *   - 6c: idempotency / overwrite
 *   - 6d: parent-directory creation
 *   - 6g: replay path (read-only sanity check for Story 5.11)
 *
 * NOT covered here (smoke-only — requires driving SKILL.md prose):
 *   - 6e: order assertion (Write observed strictly before processDevTranscript)
 *   - 6f: write-failure halt (mocking Write to throw ENOSPC)
 *
 * These tests do NOT spawn an MCP server, do NOT invoke processDevTranscript,
 * and do NOT exercise SKILL.md prose. They exercise only the filesystem
 * contract so that Story 5.11 can rely on the file's location and content.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the canonical dev-transcript path — mirrors the path assembled by
 * SKILL.md step 4.5.
 */
function devTranscriptPath(targetRepoRoot: string, sessionUlid: string): string {
  return path.join(targetRepoRoot, ".flow", "state", "sessions", sessionUlid, "dev-transcript.txt");
}

/**
 * Write devTranscript to disk, creating parent directories as needed.
 * This function models exactly what SKILL.md step 4.5 does via the built-in
 * `Write` tool (which creates parent directories automatically).
 */
async function persistDevTranscript(
  targetRepoRoot: string,
  sessionUlid: string,
  devTranscript: string,
): Promise<string> {
  const filePath = devTranscriptPath(targetRepoRoot, sessionUlid);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, devTranscript, "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-5-10-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC6a: Path computation
// ---------------------------------------------------------------------------

describe("devTranscriptPath — path computation (AC6a)", () => {
  it("resolves to <targetRepoRoot>/.flow/state/sessions/<sessionUlid>/dev-transcript.txt", () => {
    const root = "/some/repo";
    const ulid = "01ABC123456789ABCDEFGHIJKL";
    const resolved = devTranscriptPath(root, ulid);
    expect(resolved).toBe(
      `/some/repo/.flow/state/sessions/${ulid}/dev-transcript.txt`,
    );
  });

  it("uses the tmp dir as targetRepoRoot with a realistic ULID", () => {
    const ulid = "01JVWX2YZ3ABC4DEF5GHI6JKL7";
    const resolved = devTranscriptPath(tmpDir, ulid);
    expect(resolved).toBe(
      path.join(tmpDir, ".flow", "state", "sessions", ulid, "dev-transcript.txt"),
    );
  });
});

// ---------------------------------------------------------------------------
// AC6b: Content fidelity
// ---------------------------------------------------------------------------

describe("persistDevTranscript — content fidelity (AC6b)", () => {
  it("writes the verbatim devTranscript string including the locked handoff phrase", async () => {
    const sessionUlid = "01JVWX2YZ3ABC4DEF5GHI6JKL7";
    const devTranscript = [
      "Some dev output line 1",
      "Some dev output line 2",
      "",
      "Handoff to reviewer — story 5-10-persist-dev-transcript-to-disk-before-any-mcp-call ready for review.",
    ].join("\n");

    const filePath = await persistDevTranscript(tmpDir, sessionUlid, devTranscript);
    const written = await fs.readFile(filePath, "utf8");

    expect(written).toBe(devTranscript);
  });

  it("preserves multi-line content with special characters byte-for-byte", async () => {
    const sessionUlid = "01JVWX2YZ3ABC4DEF5GHI6JKL8";
    const devTranscript =
      "Line with unicode: éàü\n" +
      "Line with tab:\there\n" +
      "Line with CR+LF:\r\n" +
      "Final line — no trailing newline";

    const filePath = await persistDevTranscript(tmpDir, sessionUlid, devTranscript);
    const writtenBytes = await fs.readFile(filePath);

    // Compare raw bytes to guarantee no normalisation occurred
    expect(writtenBytes).toEqual(Buffer.from(devTranscript, "utf8"));
  });

  it("preserves an empty string (zero-byte file)", async () => {
    const sessionUlid = "01JVWX2YZ3ABC4DEF5GHI6JKL9";
    const devTranscript = "";

    const filePath = await persistDevTranscript(tmpDir, sessionUlid, devTranscript);
    const written = await fs.readFile(filePath, "utf8");

    expect(written).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AC6c: Idempotency / overwrite
// ---------------------------------------------------------------------------

describe("persistDevTranscript — idempotency / overwrite (AC6c)", () => {
  it("second write to the same sessionUlid replaces the file; second content wins", async () => {
    const sessionUlid = "01JVWX2YZ3OVERWRITE1234567";
    const firstTranscript = "First iteration transcript\nHandoff to reviewer — story x ready for review.";
    const secondTranscript = "Second iteration transcript\nHandoff to reviewer — story x ready for review.";

    await persistDevTranscript(tmpDir, sessionUlid, firstTranscript);
    const filePath = await persistDevTranscript(tmpDir, sessionUlid, secondTranscript);

    const written = await fs.readFile(filePath, "utf8");
    expect(written).toBe(secondTranscript);
    expect(written).not.toBe(firstTranscript);
  });
});

// ---------------------------------------------------------------------------
// AC6d: Parent-directory creation
// ---------------------------------------------------------------------------

describe("persistDevTranscript — parent-directory creation (AC6d)", () => {
  it("succeeds even when the session directory does not pre-exist", async () => {
    const sessionUlid = "01JVWX2YZ3NEWDIR1234567890";
    // Confirm the directory does NOT exist before the write
    const sessionDir = path.join(tmpDir, ".flow", "state", "sessions", sessionUlid);
    await expect(fs.access(sessionDir)).rejects.toThrow();

    const devTranscript = "transcript text\nHandoff to reviewer — story x ready for review.";
    const filePath = await persistDevTranscript(tmpDir, sessionUlid, devTranscript);

    // Directory and file should now exist
    await expect(fs.access(sessionDir)).resolves.toBeUndefined();
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("creates the full nested path .flow/state/sessions/<ulid>/ from a bare tmp root", async () => {
    const sessionUlid = "01JVWX2YZNESTED1234567890A";
    const filePath = await persistDevTranscript(tmpDir, sessionUlid, "content");

    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6g: Replay path — read-only sanity check for Story 5.11
// ---------------------------------------------------------------------------

describe("replay path sanity — Story 5.11 readability (AC6g)", () => {
  it("file written by persistDevTranscript is readable with fs.readFile and matches original", async () => {
    const sessionUlid = "01JVWX2YZREPLAY1234567890A";
    const devTranscript =
      "Dev output line 1\n" +
      "Dev output line 2\n" +
      "Handoff to reviewer — story 5-10-persist-dev-transcript-to-disk-before-any-mcp-call ready for review.";

    await persistDevTranscript(tmpDir, sessionUlid, devTranscript);

    // Story 5.11 will read this file by constructing the same path from the manifest's claimed_by ULID
    const replayPath = devTranscriptPath(tmpDir, sessionUlid);
    const replayed = await fs.readFile(replayPath, "utf8");

    expect(replayed).toBe(devTranscript);
  });

  it("replay path is stable across multiple reads (idempotent read)", async () => {
    const sessionUlid = "01JVWX2YZREPLAY1234567890B";
    const devTranscript = "stable content\nHandoff to reviewer — story x ready for review.";

    await persistDevTranscript(tmpDir, sessionUlid, devTranscript);

    const replayPath = devTranscriptPath(tmpDir, sessionUlid);
    const read1 = await fs.readFile(replayPath, "utf8");
    const read2 = await fs.readFile(replayPath, "utf8");

    expect(read1).toBe(devTranscript);
    expect(read2).toBe(devTranscript);
    expect(read1).toBe(read2);
  });
});
