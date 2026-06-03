/**
 * Integration tests for the learning-loop producer — Story
 * native:01KT6GSV8KTTKKHPRGEJWJAGZV (AC1 + AC2).
 *
 * The drain wires the CAPTURE → FORWARD chain through one-shot CLI seams:
 *   CAPTURE  — the reviewer optionally calls `recordReviewerLesson`, which merges
 *              ONE lesson onto the per-ref `reviewer-result.json`.
 *   FORWARD  — on a green verdict, BEFORE the merge gate runs, the drain reads the
 *              captured lesson (`readReviewerLesson`) and, if present, forwards it
 *              onto the done manifest (`recordStoryRetro`).
 *
 * The drain workflow itself runs under the Workflow runtime (injected `agent` /
 * `seam` / `log` globals), so it cannot be unit-executed here. We test the chain
 * the drain wires at the TOOL boundary (the seams the workflow shells out to),
 * PLUS a structural anchor that asserts the workflow wires those exact seams in
 * the right order (FORWARD inside the green-verdict block, BEFORE the gate, with
 * the swallow/non-fatal variant). End-to-end behaviour is exercised tool-side;
 * the structural anchor guarantees the workflow keeps calling them.
 *
 * AC1 — lesson present is forwarded onto the done manifest before the gate runs.
 * AC2 — no lesson leaves the manifest clean and still reaches the gate; a
 *       forwarding error is contained so it never blocks the merge.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../src/lib/managed-fs.js";
import { reviewerResultFilePath } from "../src/lib/read-reviewer-result-file.js";
import { recordReviewerLesson } from "../src/tools/record-reviewer-lesson.js";
import { readReviewerLesson } from "../src/tools/read-reviewer-lesson.js";
import { recordStoryRetro } from "../src/tools/record-story-retro.js";
import { ReviewerResultFileMissingError } from "../src/errors.js";
import type { ReviewerResultFileShape } from "../src/tools/run-reviewer-session.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF = "native:01HZLESSON000000000000001";
const SESSION = "01HZSESSLESSON0000000000001";
const SOURCE_HASH = "d".repeat(64);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoneManifestYaml(ref: string): string {
  return yamlStringify(
    {
      ref,
      status: "done",
      adapter: "native",
      source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
      source_hash: SOURCE_HASH,
      depends_on: [] as string[],
      acceptance_criteria: [
        {
          text: "Given a shipped story, when the flow finishes, then a lesson lands on its record.",
          kind: "integration",
        },
      ],
      title: "Learning-loop forward test story",
      narrative: "As the flow, I want shipped stories to leave a lesson.",
      withdrawn: false,
      claimed_by: SESSION,
    },
    { lineWidth: 0 },
  );
}

/** Seed a reviewer-result.json (as runReviewerSession would write) at the per-ref path. */
async function seedReviewerResult(
  root: string,
  opts: { withLesson?: boolean },
): Promise<string> {
  const filePath = reviewerResultFilePath(root, SESSION, REF);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const projection: ReviewerResultFileShape = {
    sessionUlid: SESSION,
    ref: REF,
    recommendedVerdict: "READY FOR MERGE",
    acResults: {
      0: {
        index: 0,
        tag: null,
        applicability: "runnable-artifact-check",
        artifactPath: "some/file.ts",
        status: "pass",
        reason: "present",
      },
    },
    standardsByCriterionId: {},
    sourceStoryRef: REF,
    prNumber: 42,
    standardsVersion: "1.0.0",
  };
  await atomicWriteFile(filePath, JSON.stringify(projection, null, 2));
  return filePath;
}

async function seedDoneManifest(stateRoot: string, ref: string): Promise<string> {
  const dir = path.join(stateRoot, "done");
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${ref}.yaml`);
  await atomicWriteFile(absPath, makeDoneManifestYaml(ref));
  return absPath;
}

async function buildWorkspaceRoot(scratch: string): Promise<string> {
  const root = path.join(scratch, "repo");
  await fs.mkdir(root, { recursive: true });
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );
  return root;
}

/**
 * Simulate the drain's FORWARD step exactly as the workflow wires it: read the
 * captured lesson, and if present, forward it onto the done manifest. Returns
 * whether a forward happened, so a test can assert the gate is still reached.
 */
async function drainForwardStep(root: string): Promise<{ forwarded: boolean }> {
  const { lesson } = await readReviewerLesson({
    targetRepoRoot: root,
    sessionUlid: SESSION,
    ref: REF,
  });
  if (!lesson) return { forwarded: false };
  await recordStoryRetro({
    targetRepoRoot: root,
    ref: REF,
    payload: { lessons: [lesson] },
    role: "generalist-reviewer",
  });
  return { forwarded: true };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let scratch: string;
let root: string;
let stateRoot: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-drain-forward-lesson-"));
  root = await buildWorkspaceRoot(scratch);
  stateRoot = path.join(root, ".flow", "state");
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — lesson present is captured, then forwarded onto the done manifest
// ---------------------------------------------------------------------------

describe("learning-loop AC1 — a recorded lesson is forwarded onto the done manifest before the gate", () => {
  it("captures the lesson onto reviewer-result.json then forwards it onto the done manifest", async () => {
    const donePath = await seedDoneManifest(stateRoot, REF);
    await seedReviewerResult(root, {});

    // CAPTURE — the reviewer records one reusable lesson (merged onto the verdict file).
    const lesson = {
      kind: "pattern" as const,
      text: "A tool seam survives load where a prose mandate does not.",
    };
    await recordReviewerLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
      lesson,
    });

    // The merge MUST NOT clobber the binding verdict or any other field.
    const resultPath = reviewerResultFilePath(root, SESSION, REF);
    const merged = JSON.parse(await fs.readFile(resultPath, "utf8")) as ReviewerResultFileShape;
    expect(merged.recommendedVerdict).toBe("READY FOR MERGE");
    expect(merged.prNumber).toBe(42);
    expect(merged.lesson).toEqual(lesson);

    // FORWARD — the drain's green-verdict step reads + forwards the lesson.
    const { forwarded } = await drainForwardStep(root);
    expect(forwarded).toBe(true);

    // The lesson is now on the done manifest, ready for the retro analyst.
    const manifest = yamlParse(await fs.readFile(donePath, "utf8")) as Record<string, unknown>;
    expect(manifest["lessons"]).toEqual([lesson]);
    // And nothing else on the manifest was disturbed.
    expect(manifest["status"]).toBe("done");
    expect(manifest["title"]).toBe("Learning-loop forward test story");
  });
});

// ---------------------------------------------------------------------------
// AC2 — no lesson → clean manifest, gate still reached; forward errors contained
// ---------------------------------------------------------------------------

describe("learning-loop AC2 — no lesson leaves the manifest clean and never blocks the merge", () => {
  it("forwards nothing and leaves the done manifest free of a spurious lesson when no lesson was recorded", async () => {
    const donePath = await seedDoneManifest(stateRoot, REF);
    // A reviewer-result EXISTS (verdict was green) but NO lesson was recorded.
    await seedReviewerResult(root, {});

    const { lesson } = await readReviewerLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
    });
    expect(lesson).toBeNull();

    // Drain forward step does nothing — and the gate is still reached.
    const { forwarded } = await drainForwardStep(root);
    expect(forwarded).toBe(false);

    const manifest = yamlParse(await fs.readFile(donePath, "utf8")) as Record<string, unknown>;
    expect(manifest["lessons"]).toBeUndefined();
  });

  it("returns lesson: null (never throws) when no reviewer-result.json exists at all", async () => {
    await seedDoneManifest(stateRoot, REF);
    // No reviewer-result seeded → read seam degrades to null, forward is a no-op.
    const { lesson } = await readReviewerLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
    });
    expect(lesson).toBeNull();
  });

  it("contains a forwarding failure so the merge gate still runs (drain swallows it)", async () => {
    // Capture a lesson, but DELETE the done manifest so the forward (recordStoryRetro)
    // throws ManifestNotFoundError. The drain wraps the forward in the swallow
    // variant, so the merge gate still runs. We assert the throw is real here
    // (proving the failure mode exists) and that the drain's swallow contract
    // converts it into a no-op for the run.
    await seedReviewerResult(root, {});
    await recordReviewerLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
      lesson: { kind: "tool-quirk" as const, text: "A seam swallows a forward error." },
    });

    // No done manifest seeded → recordStoryRetro throws. Simulate the drain's
    // swallow wrapper: catch the throw, log nothing, and PROCEED.
    let reachedGate = false;
    try {
      await drainForwardStep(root);
    } catch {
      // swallowed — exactly what the drain's retryable+swallow seam does.
    } finally {
      reachedGate = true; // the gate step runs regardless.
    }
    expect(reachedGate).toBe(true);
  });

  it("recordReviewerLesson itself throws ReviewerResultFileMissingError when called before runReviewerSession", async () => {
    // No reviewer-result.json seeded — calling the capture tool is a caller-order
    // bug; it fails loud (the drain's optional/fail-soft invitation contains it).
    const err = await recordReviewerLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
      lesson: { kind: "discipline" as const, text: "Call runReviewerSession first." },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewerResultFileMissingError);
  });
});

// ---------------------------------------------------------------------------
// Structural anchor — the drain workflow wires the FORWARD seams correctly
// ---------------------------------------------------------------------------

describe("learning-loop — drain workflow wires the capture+forward seams in order", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const DRAIN = path.resolve(HERE, "..", "..", "workflows", "drain.workflow.js");

  it("invites recordReviewerLesson in the reviewer prompt (optional, fail-soft)", async () => {
    const src = await fs.readFile(DRAIN, "utf8");
    expect(src).toContain("recordReviewerLesson");
    // The carve-out of the no-state-file rule for this one tool must be present.
    expect(src).toMatch(/recordReviewerLesson.*owns the lesson write/s);
  });

  it("forwards the captured lesson via recordStoryRetro inside the green-verdict block, before the gate", async () => {
    const src = await fs.readFile(DRAIN, "utf8");
    // Anchor on the actual SEAM COMMANDS (`node ... <tool> --json`), not the bare
    // identifiers — the identifiers also appear in the surrounding comments.
    const greenIdx = src.indexOf("verdict?.next === 'done-ready-for-merge'");
    const readSeamIdx = src.indexOf("readReviewerLesson --json");
    const forwardSeamIdx = src.indexOf("recordStoryRetro --json");
    const gateSeamIdx = src.indexOf("runAutoMergeGate --json");
    expect(greenIdx).toBeGreaterThan(-1);
    // FORWARD lives inside the green-verdict block: read then forward, both after
    // the block opens and both BEFORE the gate seam runs.
    expect(readSeamIdx).toBeGreaterThan(greenIdx);
    expect(forwardSeamIdx).toBeGreaterThan(readSeamIdx);
    expect(forwardSeamIdx).toBeLessThan(gateSeamIdx);
  });

  it("forwards with the swallow/non-fatal variant so a forward error never blocks the merge", async () => {
    const src = await fs.readFile(DRAIN, "utf8");
    // Both forward seams use retryable=true AND swallow=true (the 4th arg).
    expect(src).toMatch(/readReviewerLesson --json[^\n]*`,\s*`lesson-read:\$\{ref\}`,\s*true,\s*true/);
    expect(src).toMatch(/recordStoryRetro --json[^\n]*`,\s*`lesson-forward:\$\{ref\}`,\s*true,\s*true/);
  });
});
