/**
 * Unit tests for `processReviewerTranscript` — Story 4.6 Task 9.7 (revision 2).
 *
 * **Revision 2:** The suite is rewritten to cover the file-based verdict
 * transport. All tests that scanned the reviewer's chat for `**Verdict:**`
 * have been removed.
 *
 * Covers (per spec §4l, §4m):
 *   (a) reviewer-result.json present with READY FOR MERGE → done-ready-for-merge,
 *       completed: true, manifest moved to done/.
 *   (b) reviewer-result.json present with NEEDS CHANGES → done-blocked-reviewer-needs-changes,
 *       blocked_by: "reviewer-verdict-needs-changes".
 *   (c) reviewer-result.json present with BLOCKED → done-blocked-reviewer-blocked,
 *       blocked_by: "reviewer-verdict-blocked".
 *   (d) reviewer-result.json absent → done-blocked-no-session-result,
 *       blocked_by: "reviewer-no-session-result".
 *   (e) reviewer-result.json present but malformed JSON → ReviewerResultFileMalformedError thrown.
 *   (f) reviewer-result.json present but invalid shape (bad recommendedVerdict) →
 *       ReviewerResultFileMalformedError thrown.
 *
 * Story 4.6 Task 8b; Story 4.3b Task 9.1–9.2; Story 4.3c Task 5.1–5.5.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { processReviewerTranscript } from "../process-reviewer-transcript.js";
import { sanitiseRefForPathSegment } from "../../lib/read-reviewer-result-file.js";
import { ReviewerFirstCallSkippedError, ReviewerResultFileMalformedError } from "../../errors.js";
import { writeInProgressSnapshot } from "../../state/manifest-state-machine.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";
import type { ReviewerResultFileShape } from "../run-reviewer-session.js";

// ---------------------------------------------------------------------------
// Mock deriveSourceBaseline so completeStory's hand-edit guard passes.
// ---------------------------------------------------------------------------

vi.mock("../../state/derive-source-baseline.js", () => ({
  deriveSourceBaseline: vi.fn(),
}));

import { deriveSourceBaseline } from "../../state/derive-source-baseline.js";
const mockDeriveSourceBaseline = vi.mocked(deriveSourceBaseline);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_REF = "native:01J9P0K2N3MZX0YV4S5RTQ4DEF";
const SESSION_ULID = "01HZSESSION00000000000002";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeBaseManifest(ref: string, reworkCount?: number): ExecutionManifest {
  return {
    ref,
    status: "in-progress",
    adapter: "native",
    source_path: `.flow/native-stories/${ref}.yaml`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: "Test Story",
    narrative: "As a dev, I want to test.",
    withdrawn: false,
    ready: true,
    claimed_by: SESSION_ULID,
    ...(reworkCount !== undefined ? { rework_count: reworkCount } : {}),
  };
}

function makeReviewerResultFile(
  recommendedVerdict: ReviewerResultFileShape["recommendedVerdict"],
): ReviewerResultFileShape {
  return {
    sessionUlid: SESSION_ULID,
    ref: STORY_REF,
    recommendedVerdict,
    acResults: {},
    standardsByCriterionId: {},
    sourceStoryRef: STORY_REF,
    prNumber: 42,
    standardsVersion: "1.2.3",
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let manifestPath: string;
let sessionDir: string;
let resultFilePath: string;

async function seedManifest(manifest: ExecutionManifest): Promise<void> {
  await atomicWriteFile(manifestPath, yamlStringify(manifest, { lineWidth: 0 }));
  // Story 5.29: seed the claim-time sidecar so completeStory's hand-edit guard
  // has a baseline to compare against.
  await writeInProgressSnapshot({ targetRepoRoot: tmpRoot, ref: manifest.ref, manifest });
}

async function seedResultFile(content: ReviewerResultFileShape): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
  await atomicWriteFile(resultFilePath, JSON.stringify(content, null, 2));
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-process-reviewer-transcript-"));
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "in-progress"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "done"), { recursive: true });
  manifestPath = path.join(tmpRoot, ".flow", "state", "in-progress", `${STORY_REF}.yaml`);
  await seedManifest(makeBaseManifest(STORY_REF));

  // Session directory for reviewer-result.json (Story 8.15: per-ref namespaced path).
  sessionDir = path.join(
    tmpRoot,
    ".flow",
    "state",
    "sessions",
    SESSION_ULID,
    sanitiseRefForPathSegment(STORY_REF),
  );
  resultFilePath = path.join(sessionDir, "reviewer-result.json");

  // Persona needed for rework-dev path (completeStory guard)
  await fs.mkdir(path.join(tmpRoot, "team", "generalist-dev"), { recursive: true });
  await atomicWriteFile(
    path.join(tmpRoot, "team", "generalist-dev", "PERSONA.md"),
    [
      `---`,
      `role: generalist-dev`,
      `domain: "feature implementation in a story scope"`,
      `model_tier: sonnet`,
      `tools_allow:`,
      `  - Read`,
      `locked_phrases:`,
      `  handoff: "Handoff to reviewer — story <story-id> ready for review."`,
      `  yield: "This sits in <role>'s domain — handing off"`,
      `  verdict: "**Verdict: <SENTINEL>**"`,
      `hired_at: "2026-01-01T00:00:00.000Z"`,
      `catalogue_version: "0.1.0"`,
      `---`,
      ``,
      `# Generalist Dev`,
      ``,
      `## Domain`,
      ``,
      `Implements one story.`,
      ``,
      `## Mandate`,
      ``,
      `- Implement.`,
      ``,
      `## Out of mandate`,
      ``,
      `- Review.`,
      ``,
      `## Prompt`,
      ``,
      `You are the dev.`,
      ``,
      `## Knowledge`,
      ``,
      `No knowledge.`,
    ].join("\n"),
  );

  // Set up the mock so completeStory's hand-edit guard passes.
  mockDeriveSourceBaseline.mockResolvedValue({
    sourceHash: "a".repeat(64),
    sourceFields: {
      title: "Test Story",
      narrative: "As a dev, I want to test.",
      acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
      implementation_notes: undefined,
      depends_on: [],
      withdrawn: false,
    },
  });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readOnDiskManifest(): Promise<ExecutionManifest> {
  const raw = await fs.readFile(manifestPath, "utf8");
  return parseExecutionManifest(yamlParse(raw) as unknown, { absPath: manifestPath });
}

function makeOpts() {
  return {
    targetRepoRoot: tmpRoot,
    sessionUlid: SESSION_ULID,
    ref: STORY_REF,
    manifestPath,
  };
}

// ---------------------------------------------------------------------------
// (a) READY FOR MERGE — spec §4l
// ---------------------------------------------------------------------------

describe("(a) READY FOR MERGE → done-ready-for-merge, manifest STAYS in in-progress/", () => {
  // fix/run-isolation-coordination-honesty: processReviewerTranscript NO LONGER
  // completes the story on READY. The manifest stays in in-progress/; the
  // auto-merge GATE owns the done/ move and makes it only after confirming CI
  // green, so "done == reviewer-approved AND CI-green" holds by construction.
  it("returns done-ready-for-merge + completed:true, leaves the manifest in in-progress/, never moves it to done/", async () => {
    await seedResultFile(makeReviewerResultFile("READY FOR MERGE"));

    const result = await processReviewerTranscript(makeOpts());

    expect(result.next).toBe("done-ready-for-merge");
    if (result.next !== "done-ready-for-merge") return;
    expect(result.completed).toBe(true);

    expect(result.chatLog).toContain(
      `reviewer verdict: READY FOR MERGE — story ${STORY_REF} ready for the merge gate`,
    );

    // The manifest STAYS in in-progress/ (the gate completes it later).
    const inProgressRaw = await fs.readFile(
      path.join(tmpRoot, ".flow", "state", "in-progress", `${STORY_REF}.yaml`),
      "utf8",
    );
    const inProgressManifest = parseExecutionManifest(yamlParse(inProgressRaw) as unknown, {
      absPath: path.join(tmpRoot, ".flow", "state", "in-progress", `${STORY_REF}.yaml`),
    });
    expect(inProgressManifest.status).toBe("in-progress");
    expect(inProgressManifest.claimed_by).toBe(SESSION_ULID);

    // done/ is empty — the verdict step never moves the manifest.
    await expect(
      fs.stat(path.join(tmpRoot, ".flow", "state", "done", `${STORY_REF}.yaml`)),
    ).rejects.toThrow();
  });

  it("no completed field on result variants other than done-ready-for-merge", async () => {
    await seedResultFile(makeReviewerResultFile("NEEDS CHANGES"));
    const result = await processReviewerTranscript(makeOpts());
    expect("completed" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) NEEDS CHANGES — spec §4l
// ---------------------------------------------------------------------------

describe("(b) NEEDS CHANGES → done-blocked-reviewer-needs-changes", () => {
  it("stamps blocked_by: 'reviewer-verdict-needs-changes', manifest stays in in-progress/, no completed field", async () => {
    await seedResultFile(makeReviewerResultFile("NEEDS CHANGES"));

    const result = await processReviewerTranscript(makeOpts());

    expect(result.next).toBe("done-blocked-reviewer-needs-changes");
    expect("completed" in result).toBe(false);

    const onDisk = await readOnDiskManifest();
    expect(onDisk.blocked_by).toBe("reviewer-verdict-needs-changes");

    // done/ is empty
    const doneFiles = await fs.readdir(path.join(tmpRoot, ".flow", "state", "done"));
    expect(doneFiles.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (c) BLOCKED — spec §4l
// ---------------------------------------------------------------------------

describe("(c) BLOCKED → done-blocked-reviewer-blocked", () => {
  it("stamps blocked_by: 'reviewer-verdict-blocked', manifest stays in in-progress/, no completed field", async () => {
    await seedResultFile(makeReviewerResultFile("BLOCKED"));

    const result = await processReviewerTranscript(makeOpts());

    expect(result.next).toBe("done-blocked-reviewer-blocked");
    expect("completed" in result).toBe(false);

    const onDisk = await readOnDiskManifest();
    expect(onDisk.blocked_by).toBe("reviewer-verdict-blocked");

    // done/ is empty
    const doneFiles = await fs.readdir(path.join(tmpRoot, ".flow", "state", "done"));
    expect(doneFiles.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (d) Missing file → ReviewerFirstCallSkippedError — Story 5.21 seam
//
// The previous soft `done-blocked-no-session-result` return variant has been
// REMOVED (Story 5.21). When reviewer-result.json is absent, processReviewerTranscript
// now throws ReviewerFirstCallSkippedError after stamping the manifest.
// ---------------------------------------------------------------------------

describe("(d) reviewer-result.json absent → ReviewerFirstCallSkippedError (Story 5.21 seam)", () => {
  it("throws ReviewerFirstCallSkippedError, stamps blocked_by: 'reviewer-no-session-result', manifest stays in in-progress/", async () => {
    // Do NOT seed the result file.

    await expect(processReviewerTranscript(makeOpts())).rejects.toThrow(
      ReviewerFirstCallSkippedError,
    );

    // Manifest is stamped before the throw
    const onDisk = await readOnDiskManifest();
    expect(onDisk.blocked_by).toBe("reviewer-no-session-result");

    // done/ is empty — manifest was NOT moved
    const doneFiles = await fs.readdir(path.join(tmpRoot, ".flow", "state", "done"));
    expect(doneFiles.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
  });

  it("error message names the missing call and carries sessionUlid + ref", async () => {
    // Do NOT seed the result file.

    try {
      await processReviewerTranscript(makeOpts());
      throw new Error("expected ReviewerFirstCallSkippedError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewerFirstCallSkippedError);
      const e = err as ReviewerFirstCallSkippedError;
      expect(e.sessionUlid).toBe(SESSION_ULID);
      expect(e.ref).toBe(STORY_REF);
      expect(e.message).toContain("runReviewerSession");
      expect(e.message).toContain(SESSION_ULID);
      expect(e.message).toContain(STORY_REF);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) Malformed JSON → ReviewerResultFileMalformedError — spec §4m
// ---------------------------------------------------------------------------

describe("(e) malformed JSON in reviewer-result.json → ReviewerResultFileMalformedError", () => {
  it("throws ReviewerResultFileMalformedError with the file path", async () => {
    await fs.mkdir(sessionDir, { recursive: true });
    await atomicWriteFile(resultFilePath, "{ not valid json {{{{");

    await expect(processReviewerTranscript(makeOpts())).rejects.toThrow(
      ReviewerResultFileMalformedError,
    );

    try {
      await processReviewerTranscript(makeOpts());
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewerResultFileMalformedError);
      const e = err as ReviewerResultFileMalformedError;
      expect(e.path).toContain("reviewer-result.json");
    }
  });
});

// ---------------------------------------------------------------------------
// (f) Invalid shape (bad recommendedVerdict) → ReviewerResultFileMalformedError
// ---------------------------------------------------------------------------

describe("(f) invalid recommendedVerdict in reviewer-result.json → ReviewerResultFileMalformedError", () => {
  it("throws ReviewerResultFileMalformedError when recommendedVerdict is an unknown string", async () => {
    await fs.mkdir(sessionDir, { recursive: true });
    await atomicWriteFile(
      resultFilePath,
      JSON.stringify({
        sessionUlid: SESSION_ULID,
        ref: STORY_REF,
        recommendedVerdict: "APPROVED",  // not a valid value
        acResults: {},
        standardsByCriterionId: {},
        sourceStoryRef: STORY_REF,
        prNumber: 42,
      }),
    );

    await expect(processReviewerTranscript(makeOpts())).rejects.toThrow(
      ReviewerResultFileMalformedError,
    );
  });

  it("throws ReviewerResultFileMalformedError when recommendedVerdict is missing", async () => {
    await fs.mkdir(sessionDir, { recursive: true });
    await atomicWriteFile(
      resultFilePath,
      JSON.stringify({
        sessionUlid: SESSION_ULID,
        ref: STORY_REF,
        // recommendedVerdict deliberately omitted
        acResults: {},
      }),
    );

    await expect(processReviewerTranscript(makeOpts())).rejects.toThrow(
      ReviewerResultFileMalformedError,
    );
  });
});
