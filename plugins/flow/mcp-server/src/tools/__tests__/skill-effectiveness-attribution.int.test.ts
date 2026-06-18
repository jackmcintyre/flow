/**
 * END-TO-END attribution integration test — issue #390.
 *
 * The existing unit tests for `computeSkillEffectiveness` hand-build matching
 * `session_id`s on the invoke and verdict events, which masked the production
 * bug: the REAL capture seam (`captureSkillInvoke`) stamps the Claude Code
 * HARNESS session id on `skill.invoke`, while the REAL verdict path
 * (`postReviewerComments`, seeded by `mintSessionUlid`) stamps a run ULID on
 * `reviewer.verdict`. Those two ids come from different namespaces and NEVER
 * match — so the session-only join scored `useful_fire_count: 0` for EVERY
 * skill.
 *
 * This test exercises BOTH real producers writing into one real
 * `.flow/telemetry/` dir, then runs the real scorer over it, and asserts the
 * useful fire IS credited (joined on the story ref) even though the two
 * session ids differ. It is the regression guard the unit tests lacked: it must
 * FAIL on the old session-only join and PASS on the story_id join.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureSkillInvoke } from "../capture-skill-invoke.js";
import { recordSkillInvoke } from "../record-skill-invoke.js";
import { mintSessionUlid } from "../mint-session-ulid.js";
import { postReviewerComments } from "../post-reviewer-comments.js";
import { computeSkillEffectiveness } from "../compute-skill-effectiveness.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { sanitiseRefForPathSegment } from "../../lib/read-reviewer-result-file.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
import { __resetPluginVersionCacheForTests } from "../../lib/plugin-version.js";
import { makeGhExecaStub } from "../../__tests__/test-helpers/gh-execa-stub.js";
import type { ReviewerResultFileShape, AcResult } from "../run-reviewer-session.js";

const STORY_REF = "native:01HZTEST390ATTRIBUTION00";
const PR_NUMBER = 390;
const PLUGIN_VERSION = "1.0.0";

const FAKE_DIFF = `diff --git a/README.md b/README.md
--- /dev/null
+++ b/README.md
@@ -0,0 +1,1 @@
+# Hello
`;

const STANDARDS = {
  "story-aligned": {
    name: "story-aligned",
    what: "The PR diff implements only what the story requires.",
    check: "Map each diff hunk to an AC.",
    anti_criterion: "Scope creep.",
  },
} as unknown as ReviewerResultFileShape["standardsByCriterionId"];

function makeArtifactPassResult(index: number): AcResult {
  return {
    index,
    tag: null,
    applicability: "runnable-artifact-check",
    artifactPath: `artifact-${index}.txt`,
    status: "pass",
    reason: `artifact-${index}.txt exists`,
  };
}

let tmpRoot: string;
let pluginRoot: string;
let reviewSession: string;

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();
  __resetPluginVersionCacheForTests();

  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "skill-attr-390-"));
  pluginRoot = path.join(tmpRoot, "plugin");

  // Minimal target-repo + plugin scaffolding the verdict path needs.
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );
  await fs.mkdir(path.join(pluginRoot, "permissions"), { recursive: true });
  await atomicWriteFile(
    path.join(pluginRoot, "permissions", "gh-error-map.yaml"),
    `entries:\n  - exit_code: 4\n    stderr_regex: "API rate limit exceeded"\n    class: defer\n`,
  );
  await atomicWriteFile(
    path.join(pluginRoot, "permissions", "generalist-reviewer.yaml"),
    [
      "role: generalist-reviewer",
      "tools_allow:",
      "  - runReviewerSession",
      "gh_allow:",
      "  - pr-view",
      "  - pr-diff",
      "  - api",
      "  - repo-view",
      "gh_allow_args: {}",
    ].join("\n"),
  );

  // The reviewer verdict's session id is a freshly minted run ULID — the
  // namespace that will NOT match the harness session id of the skill invoke.
  reviewSession = mintSessionUlid().sessionUlid;

  const resultData: ReviewerResultFileShape = {
    sessionUlid: reviewSession,
    ref: STORY_REF,
    recommendedVerdict: "READY FOR MERGE",
    acResults: { 1: makeArtifactPassResult(1) },
    standardsByCriterionId: STANDARDS,
    sourceStoryRef: STORY_REF,
    prNumber: PR_NUMBER,
    standardsVersion: "1.2.3",
  };
  const sessDir = path.join(
    tmpRoot,
    ".flow",
    "state",
    "sessions",
    reviewSession,
    sanitiseRefForPathSegment(STORY_REF),
  );
  await fs.mkdir(sessDir, { recursive: true });
  await atomicWriteFile(
    path.join(sessDir, "reviewer-result.json"),
    JSON.stringify(resultData),
  );

  // A real in-progress manifest so the capture seam can resolve the active
  // story ref to stamp on the skill.invoke (the join key). Only `status` +
  // `ref` are read by resolveActiveStoryRef.
  const inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
  await fs.mkdir(inProgressDir, { recursive: true });
  await atomicWriteFile(
    path.join(inProgressDir, `${sanitiseRefForPathSegment(STORY_REF)}.yaml`),
    `ref: "${STORY_REF}"\nstatus: in-progress\nclaimed_by: "${reviewSession}"\n`,
  );
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("skill-effectiveness attribution end-to-end (issue #390)", () => {
  it("credits a useful fire across the divergent harness/run session namespaces", async () => {
    // 1) REAL capture seam: a programmatic skill invocation whose session id is
    //    the Claude Code HARNESS session id — deliberately != reviewSession.
    const harnessSession = "01HZHARNESSSESSION000000390";
    expect(harnessSession).not.toBe(reviewSession); // the whole point of the bug
    const captured = await captureSkillInvoke(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "flow:run", args: "" },
        session_id: harnessSession,
        cwd: tmpRoot,
      },
      {
        // Real recorder, but pin the invoke clock to an instant strictly BEFORE
        // the verdict's wall-clock stamp so the "later verdict" rule is met
        // deterministically (no same-millisecond flake). The real production
        // ordering is identical: the skill fires, then the verdict lands later.
        recordImpl: (opts) =>
          recordSkillInvoke({
            ...opts,
            now: () => new Date("2020-01-01T00:00:00.000Z"),
          }),
        // No plugin version lookup needed; defaults are fine for the join key.
        pluginRoot: undefined,
      },
    );
    expect(captured).toEqual({ recorded: true });

    // 2) REAL verdict path: writes a real reviewer.verdict JSONL line with
    //    session_id = reviewSession (the run ULID) and story_id = STORY_REF.
    const stub = makeGhExecaStub({
      prDiff: { stdout: FAKE_DIFF },
      apiRoutes: [
        {
          url: `/repos/jackmcintyre/crew/pulls/${PR_NUMBER}/reviews`,
          method: "GET",
          response: { stdout: JSON.stringify([]), exitCode: 0 },
        },
        {
          url: `/repos/jackmcintyre/crew/pulls/${PR_NUMBER}/reviews`,
          method: "POST",
          response: { stdout: JSON.stringify({ id: 999 }), exitCode: 0 },
        },
      ],
    });
    const verdict = await postReviewerComments({
      targetRepoRoot: tmpRoot,
      sessionUlid: reviewSession,
      ref: STORY_REF,
      execaImpl: stub,
      pluginRootOverride: pluginRoot,
      pluginVersionOverride: PLUGIN_VERSION,
    });
    expect(verdict.next).toBe("posted");

    // Sanity: the two real events really do carry different session ids. Read
    // EVERY telemetry file (the pinned invoke clock buckets it into a different
    // month file than the live verdict, just as the scorer reads all files).
    const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
    const files = (await fs.readdir(telemetryDir)).filter((f) => f.endsWith(".jsonl"));
    const events = (
      await Promise.all(
        files.map(async (f) => (await fs.readFile(path.join(telemetryDir, f), "utf8")).trim()),
      )
    )
      .filter(Boolean)
      .flatMap((content) => content.split("\n"))
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; session_id: string; story_id?: string });
    const invoke = events.find((e) => e.type === "skill.invoke");
    const verdictEvt = events.find((e) => e.type === "reviewer.verdict");
    expect(invoke?.session_id).toBe(harnessSession);
    expect(verdictEvt?.session_id).toBe(reviewSession);
    expect(invoke?.session_id).not.toBe(verdictEvt?.session_id); // bug condition
    // Both carry the story ref — the only shared join key.
    expect(invoke?.story_id).toBe(STORY_REF);
    expect(verdictEvt?.story_id).toBe(STORY_REF);

    // 3) REAL scorer over the real telemetry dir — the useful fire MUST be
    //    credited despite the mismatched session ids (joined on story_id).
    const result = await computeSkillEffectiveness({ targetRepoRoot: tmpRoot });
    expect(result.per_skill["flow:run"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 1,
      effectiveness_ratio: 1,
    });
    expect(result.attribution).toBe("attributed");
  });
});
