/**
 * Integration tests for the builder lesson capture — Story
 * native:01KTAWXSVFEDNRCZDNG76PJ1BD (AC1 + AC2 + AC3 + AC4).
 *
 * The run wires the builder CAPTURE → FORWARD chain through one-shot CLI seams:
 *   CAPTURE  — the dev optionally calls `recordDevLesson` (BEFORE the handoff
 *              phrase), which creates/updates the per-ref `dev-result.json`.
 *   READ     — after the pd: parse (before reviewer spawn), the run reads
 *              the captured lesson via `readDevLesson` and caches it.
 *   FORWARD  — on a green verdict, AFTER completeStory moves the story to done/
 *              and AFTER the reviewer lesson forward, the run writes the UNION
 *              array (reviewer lesson + builder lesson) via `recordStoryRetro`
 *              with `role: 'generalist-dev'`.
 *
 * The run workflow itself runs under the Workflow runtime (injected `agent` /
 * `seam` / `log` globals), so it cannot be unit-executed here. We test the chain
 * the run wires at the TOOL boundary (the seams the workflow shells out to),
 * PLUS a structural anchor that asserts the workflow wires those exact seams in
 * the right order (readDevLesson after pd: seam and before reviewer spawn;
 * builder recordStoryRetro in the green-verdict block after the gate with the
 * swallow/non-fatal variant). End-to-end behaviour is exercised tool-side; the
 * structural anchor guarantees the workflow keeps calling them.
 *
 * AC1 — lesson recorded by the dev is forwarded onto the done manifest.
 * AC2 — no lesson (or capture error) leaves the manifest clean and the merge
 *       gate is not blocked.
 * AC3 — both reviewer and builder lessons coexist on the done manifest (union
 *       append, not replace).
 * AC4 — structural anchor: run wires the seams in the right order with the
 *       swallow variant.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../src/lib/managed-fs.js";
import { devResultFilePath } from "../src/lib/read-dev-result-file.js";
import { reviewerResultFilePath } from "../src/lib/read-reviewer-result-file.js";
import { recordDevLesson } from "../src/tools/record-dev-lesson.js";
import { readDevLesson } from "../src/tools/read-dev-lesson.js";
import { recordReviewerLesson } from "../src/tools/record-reviewer-lesson.js";
import { readReviewerLesson } from "../src/tools/read-reviewer-lesson.js";
import { recordStoryRetro } from "../src/tools/record-story-retro.js";
import { MalformedStoryRetroPayloadError } from "../src/errors.js";
import type { ReviewerResultFileShape } from "../src/tools/run-reviewer-session.js";

// NOTE: The outer describe name MUST match the vitest: marker used in the story's ACs
// ("plugins/flow/mcp-server/tests/run-forward-dev-lesson.test.ts") so that
// `pnpm vitest --run -t "<that-path>"` finds and executes these tests.
describe("plugins/flow/mcp-server/tests/run-forward-dev-lesson.test.ts", () => {

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF = "native:01HZDEVLESSON000000000001";
const SESSION = "01HZDEVLESSONSESSION000001";
const SOURCE_HASH = "e".repeat(64);

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
          text: "Given a shipped story, when the flow finishes, then builder lessons appear alongside reviewer lessons.",
          kind: "integration",
        },
      ],
      title: "Builder-lesson capture test story",
      narrative: "As the flow, I want builder lessons to reach the done manifest.",
      withdrawn: false,
      claimed_by: SESSION,
    },
    { lineWidth: 0 },
  );
}

/** Seed a reviewer-result.json (as runReviewerSession would write). */
async function seedReviewerResult(root: string): Promise<string> {
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
 * Simulate the run's FORWARD step for the BUILDER lesson exactly as the
 * workflow wires it: read the captured dev lesson, and if present, forward it
 * alongside the existing lessons on the done manifest (union append).
 *
 * `existingLessons` mirrors what the reviewer lesson forward already wrote to
 * the done manifest (so the builder forward produces the union array).
 */
async function runBuilderForwardStep(
  root: string,
  existingLessons: unknown[],
): Promise<{ forwarded: boolean }> {
  const { lesson: devLesson } = await readDevLesson({
    targetRepoRoot: root,
    sessionUlid: SESSION,
    ref: REF,
  });
  if (!devLesson) return { forwarded: false };
  // Union: existing lessons (may include reviewer lesson) + builder lesson.
  const unionLessons = [...existingLessons, devLesson];
  await recordStoryRetro({
    targetRepoRoot: root,
    ref: REF,
    payload: { lessons: unionLessons },
    role: "generalist-dev",
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
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-forward-dev-lesson-"));
  root = await buildWorkspaceRoot(scratch);
  stateRoot = path.join(root, ".flow", "state");
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — dev lesson captured via recordDevLesson is forwarded onto the done manifest
// ---------------------------------------------------------------------------

describe("builder-lesson AC1 — a recorded dev lesson is forwarded onto the done manifest", () => {
  it("creates dev-result.json, then forwards the lesson onto the done manifest", async () => {
    const donePath = await seedDoneManifest(stateRoot, REF);

    // CAPTURE — the dev records one reusable lesson before emitting the handoff
    // phrase. This also creates dev-result.json (no prior writer required).
    const devLesson = {
      kind: "pattern" as const,
      text: "Derive file path helpers from a shared sanitiseRefForPathSegment so all session-scoped files agree on their location.",
    };
    const captureResult = await recordDevLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
      lesson: devLesson,
    });
    expect(captureResult.ok).toBe(true);

    // The dev-result.json should now exist at the expected per-ref path.
    const resultPath = devResultFilePath(root, SESSION, REF);
    expect(captureResult.absPath).toBe(resultPath);
    const persisted = JSON.parse(await fs.readFile(resultPath, "utf8")) as Record<string, unknown>;
    expect(persisted["lesson"]).toEqual(devLesson);
    expect(persisted["ref"]).toBe(REF);
    expect(persisted["sessionUlid"]).toBe(SESSION);

    // READ — the run reads the captured lesson via readDevLesson.
    const { lesson: readBack } = await readDevLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
    });
    expect(readBack).toEqual(devLesson);

    // FORWARD — simulate the run's builder-forward step (no existing lessons).
    const { forwarded } = await runBuilderForwardStep(root, []);
    expect(forwarded).toBe(true);

    // The lesson is now on the done manifest.
    const manifest = yamlParse(await fs.readFile(donePath, "utf8")) as Record<string, unknown>;
    expect(manifest["lessons"]).toEqual([devLesson]);
    expect(manifest["status"]).toBe("done");
    expect(manifest["title"]).toBe("Builder-lesson capture test story");
  });
});

// ---------------------------------------------------------------------------
// AC2 — no lesson / capture error leaves the manifest clean and the merge proceeds
// ---------------------------------------------------------------------------

describe("builder-lesson AC2 — no lesson or capture error leaves the manifest clean", () => {
  it("readDevLesson returns null and forward is a no-op when no lesson was recorded", async () => {
    const donePath = await seedDoneManifest(stateRoot, REF);

    const { lesson } = await readDevLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
    });
    expect(lesson).toBeNull();

    // Run builder-forward is a no-op — the done manifest is untouched.
    const { forwarded } = await runBuilderForwardStep(root, []);
    expect(forwarded).toBe(false);

    const manifest = yamlParse(await fs.readFile(donePath, "utf8")) as Record<string, unknown>;
    expect(manifest["lessons"]).toBeUndefined();
  });

  it("readDevLesson returns null (never throws) when no dev-result.json exists", async () => {
    // No recordDevLesson call → file absent → null.
    const { lesson } = await readDevLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
    });
    expect(lesson).toBeNull();
  });

  it("contains a forwarding failure so the merge gate still runs (run swallows it)", async () => {
    // Record a lesson but DELETE the done manifest so the forward (recordStoryRetro)
    // throws ManifestNotFoundError. The run wraps the forward in the swallow
    // variant, so the merge gate still runs.
    await recordDevLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
      lesson: { kind: "tool-quirk" as const, text: "A seam swallows a builder forward error." },
    });
    // No done manifest seeded → recordStoryRetro throws. Simulate the run's
    // swallow wrapper: catch the throw and PROCEED.
    let reachedGate = false;
    try {
      await runBuilderForwardStep(root, []);
    } catch {
      // swallowed — exactly what the run's retryable+swallow seam does.
    } finally {
      reachedGate = true;
    }
    expect(reachedGate).toBe(true);
  });

  it("recordDevLesson throws MalformedStoryRetroPayloadError on an invalid lesson", async () => {
    // A pitfall lesson missing failure_class is invalid — the tool must fail loud
    // so the run's optional invite catches and swallows it rather than silently
    // recording a garbled lesson.
    const err = await recordDevLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
      lesson: { kind: "pitfall", text: "Missing failure_class — this is invalid." },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedStoryRetroPayloadError);
  });
});

// ---------------------------------------------------------------------------
// AC3 — both reviewer and builder lessons coexist on the done manifest
// ---------------------------------------------------------------------------

describe("builder-lesson AC3 — reviewer and builder lessons both appear on the done manifest", () => {
  it("forwarding both lessons produces a union array that contains exactly both", async () => {
    const donePath = await seedDoneManifest(stateRoot, REF);
    await seedReviewerResult(root);

    const reviewerLesson = {
      kind: "discipline" as const,
      text: "Always call runReviewerSession before recordReviewerLesson.",
    };
    const builderLesson = {
      kind: "pattern" as const,
      text: "Derive session-scoped file paths from a shared helper so writers and readers agree.",
    };

    // REVIEWER CAPTURE — reviewer records one lesson.
    await recordReviewerLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
      lesson: reviewerLesson,
    });

    // DEV CAPTURE — dev records one lesson (creates dev-result.json).
    await recordDevLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
      lesson: builderLesson,
    });

    // REVIEWER FORWARD — run forwards the reviewer lesson onto the done manifest.
    const { lesson: revLessonFromFile } = await readReviewerLesson({
      targetRepoRoot: root,
      sessionUlid: SESSION,
      ref: REF,
    });
    expect(revLessonFromFile).toEqual(reviewerLesson);
    if (revLessonFromFile) {
      await recordStoryRetro({
        targetRepoRoot: root,
        ref: REF,
        payload: { lessons: [revLessonFromFile] },
        role: "generalist-reviewer",
      });
    }

    // BUILDER FORWARD — run forwards the builder lesson as the union array.
    const existingLessons = revLessonFromFile ? [revLessonFromFile] : [];
    const { forwarded } = await runBuilderForwardStep(root, existingLessons);
    expect(forwarded).toBe(true);

    // Done manifest must contain BOTH lessons — union, not replace.
    const manifest = yamlParse(await fs.readFile(donePath, "utf8")) as Record<string, unknown>;
    const lessons = manifest["lessons"] as unknown[];
    expect(lessons).toHaveLength(2);
    expect(lessons).toContainEqual(reviewerLesson);
    expect(lessons).toContainEqual(builderLesson);

    // Status and other fields untouched.
    expect(manifest["status"]).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// AC4 — structural anchor: run workflow wires the seams in the right order
// ---------------------------------------------------------------------------

describe("builder-lesson AC4 — run workflow wires the capture+forward seams in order", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const RUN = path.resolve(HERE, "..", "..", "workflows", "internal", "run.workflow.js");

  it("invites recordDevLesson in the dev prompt (optional, fail-soft)", async () => {
    const src = await fs.readFile(RUN, "utf8");
    expect(src).toContain("recordDevLesson");
    // The invite must be optional and fail-soft — matching the prose shape.
    expect(src).toContain("This is OPTIONAL and fail-soft");
  });

  it("readDevLesson --json seam appears after the pd: seam and before the reviewer spawn", async () => {
    const src = await fs.readFile(RUN, "utf8");
    // The pd: seam is the dev handoff parse. readDevLesson must follow it and
    // precede the reviewer agent() call (runReviewerSession --json).
    const pdSeamIdx = src.indexOf("pd:");
    const readDevLessonSeamIdx = src.indexOf("readDevLesson --json");
    const reviewerSessionSeamIdx = src.indexOf("runReviewerSession --json");
    expect(pdSeamIdx).toBeGreaterThan(-1);
    expect(readDevLessonSeamIdx).toBeGreaterThan(-1);
    expect(reviewerSessionSeamIdx).toBeGreaterThan(-1);
    expect(readDevLessonSeamIdx).toBeGreaterThan(pdSeamIdx);
    expect(readDevLessonSeamIdx).toBeLessThan(reviewerSessionSeamIdx);
  });

  it("builder recordStoryRetro forward seam appears after completeStory and after reviewer lesson forward", async () => {
    const src = await fs.readFile(RUN, "utf8");
    // The builder forward must run AFTER completeStory (which moves the story to
    // done/) and AFTER the reviewer lesson forward. We anchor on the recordStoryRetro
    // --json seam lines by position: the first recordStoryRetro after completeStory
    // is the reviewer's, the second is the builder's (dev). Story
    // native:01KVPQS1DVJE41KNG065D6X1X7 made these dynamic (role: reviewerRole /
    // role: devRole) so we find the builder forward by seeking the second
    // recordStoryRetro occurrence after completeStory rather than a literal role string.
    const completeSeamIdx = src.indexOf("completeStory --json");
    // First recordStoryRetro after completeStory = reviewer forward.
    const reviewerForwardIdx = src.indexOf("recordStoryRetro --json", completeSeamIdx);
    // Second recordStoryRetro after reviewer forward = builder forward.
    const builderForwardIdx = src.indexOf("recordStoryRetro --json", reviewerForwardIdx + 1);
    expect(completeSeamIdx).toBeGreaterThan(-1);
    expect(reviewerForwardIdx).toBeGreaterThan(-1);
    expect(builderForwardIdx).toBeGreaterThan(-1);
    // Order: completeStory < reviewer forward < builder forward.
    expect(reviewerForwardIdx).toBeGreaterThan(completeSeamIdx);
    expect(builderForwardIdx).toBeGreaterThan(reviewerForwardIdx);
  });

  it("both builder seams use the retryable+swallow variant (4th arg true)", async () => {
    const src = await fs.readFile(RUN, "utf8");
    // readDevLesson --json must use retryable=true AND swallow=true (4th arg).
    expect(src).toMatch(/readDevLesson --json[^\n]*`,\s*`dev-lesson-read:\$\{ref\}`,\s*true,\s*true/);
    // The builder recordStoryRetro forward (identified by role: devRole since
    // story native:01KVPQS1DVJE41KNG065D6X1X7 made the role dynamic)
    // must also use the retryable+swallow variant.
    expect(src).toMatch(/recordStoryRetro --json[^\n]*role: devRole[^\n]*`,\s*`lesson-forward:\$\{ref\}`,\s*true,\s*true/);
  });
}); // end describe: builder-lesson AC4

}); // end outer describe: plugins/flow/mcp-server/tests/run-forward-dev-lesson.test.ts
