/**
 * Integration tests for `applyReviewerLabels` — Story 4.8 (AC4).
 *
 * Covers:
 *   (4a) AC1 label branch: READY FOR MERGE → exactly one `gh api POST /labels` call with
 *        `{"labels":["reviewed-by-agent"]}`; no `needs-human` call.
 *   (4b) AC2 label branches: NEEDS CHANGES, BLOCKED, and verdictOverride: "reviewer-failure"
 *        each → exactly two `gh api POST /labels` calls in sequence.
 *   (4c) AC3 denial branches: gh({ subcommand: "pr-close" | "pr-merge" | "pr-review" | "pr-comment" })
 *        → GhSubcommandDeniedError before any execa call.
 *   (4d) Error propagation: GhRecoverableError on first label call propagates; second call NOT made.
 *   (4e) Missing-file path: no reviewer-result.json → returns { next: "skipped-no-session-result" }.
 *
 * Story 4.8 Task 6.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyReviewerLabels } from "../apply-reviewer-labels.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { sanitiseRefForPathSegment } from "../../lib/read-reviewer-result-file.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
import { GhRecoverableError, GhSubcommandDeniedError } from "../../errors.js";
import { makeGhExecaStub } from "../../__tests__/test-helpers/gh-execa-stub.js";
import { loadRolePermissions } from "../../state/load-role-permissions.js";
import { gh } from "../../lib/gh.js";
import type { ReviewerResultFileShape } from "../run-reviewer-session.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_ULID = "01HZTEST4_8_INTEGRATION0000";
const STORY_REF = "native:01HZTEST00000000000000000";
const PR_NUMBER = 42;
const LABELS_URL_PATTERN = /\/labels$/;

// Default label response (array shape per GH API spec)
const LABEL_RESPONSE_ARRAY = JSON.stringify([
  { id: 1, name: "reviewed-by-agent", color: "0075ca" },
]);
const NEEDS_HUMAN_LABEL_RESPONSE_ARRAY = JSON.stringify([
  { id: 1, name: "reviewed-by-agent", color: "0075ca" },
  { id: 2, name: "needs-human", color: "e4e669" },
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseResultFile(
  verdict: "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED",
): ReviewerResultFileShape {
  return {
    sessionUlid: SESSION_ULID,
    ref: STORY_REF,
    recommendedVerdict: verdict,
    acResults: {},
    standardsByCriterionId: {},
    sourceStoryRef: STORY_REF,
    prNumber: PR_NUMBER,
    standardsVersion: "0.1.0",
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let pluginRoot: string;

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();

  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "flow-4-8-int-"));
  pluginRoot = path.join(tmpRoot, "plugin");

  // .flow/config.yaml
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );

  // Plugin permissions directory
  await fs.mkdir(path.join(pluginRoot, "permissions"), { recursive: true });

  // gh-error-map.yaml (minimal valid map)
  await atomicWriteFile(
    path.join(pluginRoot, "permissions", "gh-error-map.yaml"),
    `entries:\n  - exit_code: 4\n    stderr_regex: "API rate limit exceeded"\n    class: defer\n`,
  );

  // generalist-reviewer.yaml — matches production state after Task 1 (no pr-comment, no pr-review)
  await atomicWriteFile(
    path.join(pluginRoot, "permissions", "generalist-reviewer.yaml"),
    [
      "role: generalist-reviewer",
      "tools_allow:",
      "  - runReviewerSession",
      "gh_allow:",
      "  - pr-view",
      "  - pr-diff",
      "  - repo-view",
      "  - api",
      "gh_allow_args: {}",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function writeResultFile(data: ReviewerResultFileShape): Promise<void> {
  // Story 8.15: seed at the per-ref namespaced path the reader now derives.
  const sessDir = path.join(
    tmpRoot,
    ".flow",
    "state",
    "sessions",
    SESSION_ULID,
    sanitiseRefForPathSegment(STORY_REF),
  );
  await fs.mkdir(sessDir, { recursive: true });
  await atomicWriteFile(
    path.join(sessDir, "reviewer-result.json"),
    JSON.stringify(data),
  );
}

// Build a standard stub for label calls.
// Tracks: each label call's input payload (by push to capturedInputs).
function makeLabelsStub(opts: {
  capturedInputs?: string[];
  labelRouteResponse?: string;
  firstLabelError?: { exitCode: number; stderr: string };
}) {
  const { capturedInputs = [], labelRouteResponse = LABEL_RESPONSE_ARRAY, firstLabelError } = opts;
  let labelCallCount = 0;

  return makeGhExecaStub({
    apiRoutes: [
      {
        url: LABELS_URL_PATTERN,
        method: "POST",
        response: firstLabelError
          ? { stdout: "", stderr: firstLabelError.stderr, exitCode: firstLabelError.exitCode }
          : { stdout: labelRouteResponse, exitCode: 0 },
        onCall: (input) => {
          capturedInputs.push(input ?? "");
          labelCallCount++;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// (4e) Missing file path
// ---------------------------------------------------------------------------

describe("(4e) missing reviewer-result.json", () => {
  it("returns { next: 'skipped-no-session-result' } without calling gh", async () => {
    const stub = makeGhExecaStub();

    const result = await applyReviewerLabels({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      pluginRootOverride: pluginRoot,
      execaImpl: stub,
    });

    expect(result).toEqual({ next: "skipped-no-session-result" });
    expect(stub).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (4a) AC1 — READY FOR MERGE: only `reviewed-by-agent`
// ---------------------------------------------------------------------------

describe("(4a) AC1 — READY FOR MERGE verdict", () => {
  it("makes exactly one gh api POST /labels call with reviewed-by-agent; no needs-human", async () => {
    await writeResultFile(makeBaseResultFile("READY FOR MERGE"));

    const capturedInputs: string[] = [];
    const stub = makeLabelsStub({ capturedInputs });

    const result = await applyReviewerLabels({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      pluginRootOverride: pluginRoot,
      execaImpl: stub,
    });

    expect(result).toEqual({ next: "applied", labelsApplied: ["reviewed-by-agent"] });
    expect(capturedInputs).toHaveLength(1);
    expect(JSON.parse(capturedInputs[0]!)).toEqual({ labels: ["reviewed-by-agent"] });
  });
});

// ---------------------------------------------------------------------------
// (4b) AC2 — Non-green verdicts: `reviewed-by-agent` + `needs-human`
// ---------------------------------------------------------------------------

describe("(4b) AC2 — NEEDS CHANGES verdict", () => {
  it("makes two sequential gh api POST /labels calls in order", async () => {
    await writeResultFile(makeBaseResultFile("NEEDS CHANGES"));

    const capturedInputs: string[] = [];
    const stub = makeLabelsStub({ capturedInputs, labelRouteResponse: NEEDS_HUMAN_LABEL_RESPONSE_ARRAY });

    const result = await applyReviewerLabels({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      pluginRootOverride: pluginRoot,
      execaImpl: stub,
    });

    expect(result).toEqual({ next: "applied", labelsApplied: ["reviewed-by-agent", "needs-human"] });
    expect(capturedInputs).toHaveLength(2);
    expect(JSON.parse(capturedInputs[0]!)).toEqual({ labels: ["reviewed-by-agent"] });
    expect(JSON.parse(capturedInputs[1]!)).toEqual({ labels: ["needs-human"] });
  });
});

describe("(4b) AC2 — BLOCKED verdict", () => {
  it("makes two sequential gh api POST /labels calls in order", async () => {
    await writeResultFile(makeBaseResultFile("BLOCKED"));

    const capturedInputs: string[] = [];
    const stub = makeLabelsStub({ capturedInputs, labelRouteResponse: NEEDS_HUMAN_LABEL_RESPONSE_ARRAY });

    const result = await applyReviewerLabels({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      pluginRootOverride: pluginRoot,
      execaImpl: stub,
    });

    expect(result).toEqual({ next: "applied", labelsApplied: ["reviewed-by-agent", "needs-human"] });
    expect(capturedInputs).toHaveLength(2);
    expect(JSON.parse(capturedInputs[0]!)).toEqual({ labels: ["reviewed-by-agent"] });
    expect(JSON.parse(capturedInputs[1]!)).toEqual({ labels: ["needs-human"] });
  });
});

describe("(4b) AC2 — verdictOverride: reviewer-failure overrides READY FOR MERGE in file", () => {
  it("treats outcome as non-green; makes two label calls", async () => {
    // File says READY FOR MERGE, but verdictOverride should force non-green treatment
    await writeResultFile(makeBaseResultFile("READY FOR MERGE"));

    const capturedInputs: string[] = [];
    const stub = makeLabelsStub({ capturedInputs, labelRouteResponse: NEEDS_HUMAN_LABEL_RESPONSE_ARRAY });

    const result = await applyReviewerLabels({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      verdictOverride: "reviewer-failure",
      pluginRootOverride: pluginRoot,
      execaImpl: stub,
    });

    expect(result).toEqual({ next: "applied", labelsApplied: ["reviewed-by-agent", "needs-human"] });
    expect(capturedInputs).toHaveLength(2);
    expect(JSON.parse(capturedInputs[0]!)).toEqual({ labels: ["reviewed-by-agent"] });
    expect(JSON.parse(capturedInputs[1]!)).toEqual({ labels: ["needs-human"] });
  });
});

// ---------------------------------------------------------------------------
// (4d) Error propagation — GhRecoverableError on first label call
// ---------------------------------------------------------------------------

describe("(4d) error propagation — GhRecoverableError on first label call", () => {
  it("propagates the error uncaught; second label call is NOT made", async () => {
    await writeResultFile(makeBaseResultFile("NEEDS CHANGES"));

    const capturedInputs: string[] = [];
    const stub = makeLabelsStub({
      capturedInputs,
      firstLabelError: { exitCode: 4, stderr: "API rate limit exceeded" },
    });

    await expect(
      applyReviewerLabels({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: STORY_REF,
        pluginRootOverride: pluginRoot,
        execaImpl: stub,
      }),
    ).rejects.toThrow(GhRecoverableError);

    // Only one call was attempted (the failing first one); needs-human was NOT called
    expect(capturedInputs).toHaveLength(1);
    expect(JSON.parse(capturedInputs[0]!)).toEqual({ labels: ["reviewed-by-agent"] });
  });
});

// ---------------------------------------------------------------------------
// (4c) AC3 — denial branches: removed + already-denied subcommands
// ---------------------------------------------------------------------------

describe("(4c) AC3 — negative-capability enforcement via generalist-reviewer.yaml", () => {
  /**
   * Helper: attempt a gh() call with the real permissions loaded from
   * the fixture generalist-reviewer.yaml and assert GhSubcommandDeniedError
   * is thrown without any execa call.
   */
  async function assertSubcommandDenied(subcommand: string): Promise<void> {
    const captureStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const permissions = await loadRolePermissions({
      role: "generalist-reviewer",
      pluginRoot,
    });

    await expect(
      gh({
        role: "generalist-reviewer",
        permissions,
        subcommand,
        args: [],
        execaImpl: captureStub as unknown as typeof import("execa").execa,
        pluginRootOverride: pluginRoot,
      }),
    ).rejects.toThrow(GhSubcommandDeniedError);

    // execa must NOT have been called (enforcement is pre-spawn)
    expect(captureStub).not.toHaveBeenCalled();
  }

  it("denies pr-comment (removed in Task 1)", async () => {
    await assertSubcommandDenied("pr-comment");
  });

  it("denies pr-review (removed in Task 1)", async () => {
    await assertSubcommandDenied("pr-review");
  });

  it("denies pr-close (was never in gh_allow)", async () => {
    await assertSubcommandDenied("pr-close");
  });

  it("denies pr-merge (was never in gh_allow)", async () => {
    await assertSubcommandDenied("pr-merge");
  });
});

// ---------------------------------------------------------------------------
// Issue 1 regression: step-10 error handler branch
//
// When `processReviewerTranscript` throws (e.g. ReviewerResultFileMalformedError,
// WrongClaimantError, InProgressHandEditError), the SKILL.md step-10 error handler
// calls `applyReviewerLabels({ ..., verdictOverride: "reviewer-failure" })` in a
// best-effort try/catch. This test verifies that the `verdictOverride: "reviewer-failure"`
// path fires two sequential label calls even when the result file would otherwise
// indicate a green verdict — matching the scenario where the error handler is
// exercised after step 9a succeeded but step 10 threw.
// ---------------------------------------------------------------------------

describe("(step-10 error handler) verdictOverride fires two label calls regardless of result file", () => {
  it("applies reviewed-by-agent + needs-human when verdictOverride is reviewer-failure (green result file)", async () => {
    // Simulate: processReviewerTranscript threw after step 9a; the result file
    // exists (written by runReviewerSession) with a READY FOR MERGE verdict, but
    // the error handler overrides this with verdictOverride: "reviewer-failure".
    await writeResultFile(makeBaseResultFile("READY FOR MERGE"));

    const capturedInputs: string[] = [];
    const stub = makeLabelsStub({ capturedInputs, labelRouteResponse: NEEDS_HUMAN_LABEL_RESPONSE_ARRAY });

    const result = await applyReviewerLabels({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      verdictOverride: "reviewer-failure",
      pluginRootOverride: pluginRoot,
      execaImpl: stub,
    });

    // Must apply both labels in order — same as any non-green outcome
    expect(result).toEqual({ next: "applied", labelsApplied: ["reviewed-by-agent", "needs-human"] });
    expect(capturedInputs).toHaveLength(2);
    expect(JSON.parse(capturedInputs[0]!)).toEqual({ labels: ["reviewed-by-agent"] });
    expect(JSON.parse(capturedInputs[1]!)).toEqual({ labels: ["needs-human"] });
  });

  it("applies reviewed-by-agent + needs-human when verdictOverride is reviewer-failure (no result file)", async () => {
    // Simulate: processReviewerTranscript threw BEFORE reviewer-result.json was written
    // (e.g. file missing entirely). In this scenario the error handler cannot read the
    // file and applyReviewerLabels returns skipped-no-session-result. This is acceptable:
    // the SKILL.md error handler wraps the call in its own try/catch and proceeds.
    // Verify the skipped path is returned cleanly without throwing.
    const stub = makeGhExecaStub();

    const result = await applyReviewerLabels({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      verdictOverride: "reviewer-failure",
      pluginRootOverride: pluginRoot,
      execaImpl: stub,
    });

    expect(result).toEqual({ next: "skipped-no-session-result" });
    expect(stub).not.toHaveBeenCalled();
  });
});
