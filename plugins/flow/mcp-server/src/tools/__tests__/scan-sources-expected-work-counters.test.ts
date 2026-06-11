/**
 * Integration tests for Story native:01KTSR3E7FE61XB2PN8VJ24289 AC1.
 *
 * AC1: Given a backlog folder that contains a story file the team cannot use
 * because its filename does not match the expected naming, When the operator
 * runs a scan, Then the scan's summary reports a non-zero "files rejected"
 * count naming that file and the reason it was rejected, instead of returning
 * all-zero counts with no explanation.
 *
 * Also verifies AC4 on the scan surface: a clean scan (no rejected files)
 * renders an explicit all-zero expected-work counter line.
 *
 * Fixture pattern mirrors scan-sources-readfile-resilience.test.ts:
 * - Fresh tmpdir per test via beforeEach/afterEach.
 * - Minimal native-adapter workspace (config.yaml + native-stories dir).
 * - scanSources() called directly on the workspace root.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { scanSources } from "../scan-sources.js";
import { renderScanResult } from "../scan-sources.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// A valid Crockford Base32 ULID.
const VALID_ULID = "01HZDRF000000000000000001Z";
const VALID_REF = `native:${VALID_ULID}`;

// The cited source path used in the story body (must match the seeded file below).
const CITED_SOURCE_PATH = "src/counter.ts";

/** Build a minimal native story body that passes the discipline gate. */
function makeStoryBody(suffix = ""): string {
  return [
    `# Expected-work counters test story${suffix}`,
    ``,
    `## Narrative`,
    ``,
    `As a user, I want counters${suffix} so that I can trust the summary.`,
    ``,
    `## Acceptance Criteria`,
    ``,
    `**AC1 (integration):**`,
    `**Given** the system, **When** I run a scan, **Then** counters appear.`,
    `vitest: src/__tests__/counter.test.ts`,
    ``,
    `## Tasks`,
    ``,
    `- Implement the counter (AC: 1)`,
    ``,
    `## Cited Sources`,
    ``,
    `- ${CITED_SOURCE_PATH}`,
    ``,
    `## Implementation Notes`,
    ``,
    `Wire the counter.`,
    ``,
    `## Dependencies`,
    ``,
    ``,
  ].join("\n");
}

/** Seed the cited source file so the T0-5 disk check passes. */
async function seedCitedSource(root: string): Promise<void> {
  const citedDir = path.join(root, "src");
  await fs.mkdir(citedDir, { recursive: true });
  await atomicWriteFile(path.join(root, CITED_SOURCE_PATH), "// seeded\n");
}

let scratch: string;

/** Write the minimal .flow/config.yaml so the native adapter is active. */
async function writeFlowConfig(root: string): Promise<void> {
  const configDir = path.join(root, ".flow");
  await fs.mkdir(configDir, { recursive: true });
  await atomicWriteFile(
    path.join(configDir, "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );
}

/** Write a native story file at the expected ULID path. */
async function writeNativeStoryFile(root: string, ulid: string, body: string): Promise<void> {
  const storiesDir = path.join(root, ".flow", "native-stories");
  await fs.mkdir(storiesDir, { recursive: true });
  await atomicWriteFile(path.join(storiesDir, `${ulid}.md`), body);
}

/** Write a file with a bad (non-ULID) name into the native-stories folder. */
async function writeBadFilenameStory(root: string, filename: string): Promise<void> {
  const storiesDir = path.join(root, ".flow", "native-stories");
  await fs.mkdir(storiesDir, { recursive: true });
  await atomicWriteFile(path.join(storiesDir, filename), "# bad file\n");
}

/** Create the state subdirs the scan touches. */
async function initStateDir(root: string): Promise<void> {
  for (const state of ["to-do", "in-progress", "blocked", "done"]) {
    await fs.mkdir(path.join(root, ".flow", "state", state), { recursive: true });
  }
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-scan-ew-counters-"));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1: bad-filename rejection surfaced in scan result
// ---------------------------------------------------------------------------

describe("AC1 — scan surfaces rejected bad-filename files in expected-work counters", () => {
  it("reports a non-zero files-rejected count and names the offending file when a bad-named file exists alongside valid ones", async () => {
    const root = path.join(scratch, "workspace");
    await writeFlowConfig(root);
    await initStateDir(root);
    await seedCitedSource(root);
    // One valid story file.
    await writeNativeStoryFile(root, VALID_ULID, makeStoryBody());
    // One file whose name does not match the ULID pattern.
    await writeBadFilenameStory(root, "README.md");

    const result = await scanSources({ targetRepoRoot: root });

    // filesSeenCount: 2 (the valid story + the bad file).
    expect(result.filesSeenCount).toBe(2);
    // filesRejected: exactly the bad file.
    expect(result.filesRejected).toHaveLength(1);
    expect(result.filesRejected[0]!.filename).toBe("README.md");
    expect(result.filesRejected[0]!.reason).toBe("bad-filename");

    // The valid story was scanned normally.
    expect(result.createdRefs).toContain(VALID_REF);
  });

  it("names the rejected file and its reason in the rendered scan summary", async () => {
    const root = path.join(scratch, "workspace2");
    await writeFlowConfig(root);
    await initStateDir(root);
    await seedCitedSource(root);
    await writeNativeStoryFile(root, VALID_ULID, makeStoryBody());
    await writeBadFilenameStory(root, "not-a-ulid.md");

    const result = await scanSources({ targetRepoRoot: root });
    const summary = renderScanResult(result);

    expect(summary).toContain("1 rejected");
    expect(summary).toContain("not-a-ulid.md");
    expect(summary).toContain("bad-filename");
  });

  it("surfaces multiple rejected files when more than one bad-named file exists", async () => {
    const root = path.join(scratch, "workspace3");
    await writeFlowConfig(root);
    await initStateDir(root);
    await writeBadFilenameStory(root, "story-1.md");
    await writeBadFilenameStory(root, "story-2.txt");
    await writeBadFilenameStory(root, "notes.json");

    const result = await scanSources({ targetRepoRoot: root });

    // 3 bad files, 0 valid.
    expect(result.filesSeenCount).toBe(3);
    expect(result.filesRejected).toHaveLength(3);
    const filenames = result.filesRejected.map((f) => f.filename).sort();
    expect(filenames).toEqual(["notes.json", "story-1.md", "story-2.txt"]);
  });
});

// ---------------------------------------------------------------------------
// AC4 on scan surface: all-zero counter line emitted even when nothing is wrong
// ---------------------------------------------------------------------------

describe("AC4 on scan surface — explicit zero counter line on a clean scan", () => {
  it("renders an explicit expected-work counter line even when no files are rejected or held", async () => {
    const root = path.join(scratch, "clean");
    await writeFlowConfig(root);
    await initStateDir(root);
    await seedCitedSource(root);
    await writeNativeStoryFile(root, VALID_ULID, makeStoryBody());

    const result = await scanSources({ targetRepoRoot: root });
    const summary = renderScanResult(result);

    // The summary must contain the expected-work line even on a fully clean scan.
    expect(summary).toContain("expected-work:");
    // Zero rejected and zero held.
    expect(summary).toContain("0 rejected");
    expect(summary).toContain("0 held");
  });
});
