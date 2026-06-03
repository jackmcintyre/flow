/**
 * AC5 (user-surface) operator-smoke extension for Story 4.6b — Task 10.
 * Extended for Story 4.7 AC4 — idempotent rerun and version stamping.
 *
 * @description
 * Extends the Story 4.6 rubber-stamp reproducer with the post-reviewer step:
 *   1. Same scratch repo — one ready story with `artifact: target-file.txt`.
 *   2. Dev handoffs without creating the artifact (rubber-stamp).
 *   3. `runReviewerSession` executes — finds artifact missing, returns NEEDS CHANGES.
 *   4. `postReviewerComments` is called AFTER runReviewerSession returns and
 *      BEFORE processReviewerTranscript runs.
 *   5. The captured `gh api` body is asserted per spec §5b:
 *      - Body contains `standards_version:` and `plugin_version:` literals
 *      - Footer marker `<!-- flow:verdict:` is last line of body
 *      - `comments` array has length 1 (failing artifact path appears in diff)
 *      - Inline comment body contains both `target-file.txt` and `ENOENT`
 *   6. Second `postReviewerComments` invocation (rerun scenario) — GET returns
 *      prior verdict with footer marker → PATCH called once, POST not called.
 *   7. processReviewerTranscript is still called — manifest stays in in-progress/
 *      with `blocked_by: "reviewer-verdict-needs-changes"` (spec §5c).
 *
 * Smoke-gate: per `plugins/flow/docs/user-surface-acs.md` § Pre-PR gate,
 * this test provides the CI-level evidence for AC5 (user-surface) and AC4 (user-surface).
 * The operator may substitute manual-paste evidence per spec §5d.
 *
 * Story 4.6b Task 10.1–10.4; Story 4.7 Task 6.1–6.3.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { writeInProgressSnapshot } from "../../state/manifest-state-machine.js";
import { processDevTranscript } from "../../tools/process-dev-transcript.js";
import { processReviewerTranscript } from "../../tools/process-reviewer-transcript.js";
import { runReviewerSession } from "../../tools/run-reviewer-session.js";
import { postReviewerComments } from "../../tools/post-reviewer-comments.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
import { __resetPluginVersionCacheForTests } from "../../lib/plugin-version.js";
import {
  SMOKE_STORY_ULID,
  SMOKE_STORY_REF,
  SMOKE_ARTIFACT_PATH,
  makeRubberStampDevTranscript,
  assertManifestStaysInProgress,
} from "./rubber-stamp-reproducer.js";
import { makeGhExecaStub } from "../test-helpers/gh-execa-stub.js";

// ---------------------------------------------------------------------------
// Mock deriveSourceBaseline (same pattern as ac5-rubber-stamp.smoke.test.ts)
// ---------------------------------------------------------------------------

vi.mock("../../state/derive-source-baseline.js", () => ({
  deriveSourceBaseline: vi.fn(),
}));

import { deriveSourceBaseline } from "../../state/derive-source-baseline.js";
const mockDeriveSourceBaseline = vi.mocked(deriveSourceBaseline);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_ULID = "01HZSMOKE4_6B_SESSION000000";

/**
 * A diff where target-file.txt appears as a new file, giving the inline-comment
 * generator a hunk anchor for the failing artifact-check AC.
 */
const FAKE_PR_DIFF_WITH_ARTIFACT = `diff --git a/target-file.txt b/target-file.txt
new file mode 100644
--- /dev/null
+++ b/target-file.txt
@@ -0,0 +1,1 @@
+built by dev
`;

const SMOKE_SOURCE_STORY = `# Smoke Story — Post Reviewer Comments

## Narrative

As an operator, I want target-file.txt to exist so that I can verify
the reviewer detects its absence.

## Acceptance Criteria

**AC1:**
**Given** the dev has completed implementation,
**When** the reviewer checks the artifact,
**Then** target-file.txt exists at the repository root.
artifact: ${SMOKE_ARTIFACT_PATH}

## Implementation Notes

None.
`;

const SMOKE_STANDARDS = `version: "0.1.0"
updated: "2026-05-24"
criteria:
  - name: "story-aligned"
    what: "The PR's diff implements only what the story's ACs require."
    check: "Map each diff hunk to one or more ACs."
    anti_criterion: "Scope creep."
`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let manifestPath: string;
let pluginRoot: string;

// Plugin version used in smoke tests — avoids calling real plugin.json
const SMOKE_PLUGIN_VERSION = "0.1.0-smoke";

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();
  __resetPluginVersionCacheForTests();

  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "flow-4-6b-ac5-smoke-"));
  pluginRoot = path.join(tmpRoot, "plugin");

  // .flow state dirs
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "in-progress"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "to-do"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "done"), { recursive: true });

  // .flow/config.yaml (native adapter)
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );

  // Native story spec file
  const storiesDir = path.join(tmpRoot, ".flow", "native-stories");
  await fs.mkdir(storiesDir, { recursive: true });
  await atomicWriteFile(
    path.join(storiesDir, `${SMOKE_STORY_ULID}.md`),
    SMOKE_SOURCE_STORY,
  );

  // In-progress manifest — story is pre-claimed
  manifestPath = path.join(
    tmpRoot,
    ".flow",
    "state",
    "in-progress",
    `${SMOKE_STORY_REF}.yaml`,
  );
  await atomicWriteFile(
    manifestPath,
    [
      `ref: "${SMOKE_STORY_REF}"`,
      `status: in-progress`,
      `adapter: native`,
      `source_path: ".flow/native-stories/${SMOKE_STORY_ULID}.md"`,
      `source_hash: "${"a".repeat(64)}"`,
      `depends_on: []`,
      `acceptance_criteria:`,
      `  - text: "Given the dev has completed implementation."`,
      `    kind: integration`,
      `title: "Smoke Story — Post Reviewer Comments"`,
      `narrative: "As an operator, I want target-file.txt to exist."`,
      `withdrawn: false`,
      `claimed_by: "${SESSION_ULID}"`,
    ].join("\n"),
  );

  // Story 5.29: seed the claim-time sidecar so completeStory's hand-edit guard
  // has a baseline to compare against.
  {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = yamlParse(raw) as Record<string, unknown>;
    const manifest = parseExecutionManifest(parsed, { absPath: manifestPath });
    await writeInProgressSnapshot({
      targetRepoRoot: tmpRoot,
      ref: SMOKE_STORY_REF,
      manifest,
    });
  }

  // docs/standards.md
  await fs.mkdir(path.join(tmpRoot, "docs"), { recursive: true });
  await atomicWriteFile(path.join(tmpRoot, "docs", "standards.md"), SMOKE_STANDARDS);

  // Persona files
  await fs.mkdir(path.join(tmpRoot, "team", "generalist-dev"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, "team", "generalist-reviewer"), { recursive: true });

  const devPersona = [
    "---",
    "role: generalist-dev",
    `domain: "implementation"`,
    "model_tier: sonnet",
    "tools_allow:",
    "  - Read",
    "locked_phrases:",
    `  handoff: "Handoff to reviewer — story <story-id> ready for review."`,
    `  yield: "This sits in <role>'s domain — handing off"`,
    `  verdict: "**Verdict: <SENTINEL>**"`,
    `hired_at: "2026-01-01T00:00:00.000Z"`,
    `catalogue_version: "0.1.0"`,
    "---",
    "",
    "# Generalist Dev",
    "",
    "## Domain",
    "",
    "Implements stories.",
    "",
    "## Mandate",
    "",
    "- Implement.",
    "",
    "## Out of mandate",
    "",
    "- Review.",
    "",
    "## Prompt",
    "",
    "You are the dev.",
    "",
    "## Knowledge",
    "",
    "None.",
  ].join("\n");

  const reviewerPersona = [
    "---",
    "role: generalist-reviewer",
    `domain: "code review"`,
    "model_tier: sonnet",
    "tools_allow:",
    "  - runReviewerSession",
    "locked_phrases:",
    `  handoff: "Handoff to reviewer — story <story-id> ready for review."`,
    `  yield: "This sits in <role>'s domain — handing off"`,
    `  verdict: "**Verdict: <SENTINEL>**"`,
    `hired_at: "2026-01-01T00:00:00.000Z"`,
    `catalogue_version: "0.1.0"`,
    "---",
    "",
    "# Generalist Reviewer",
    "",
    "## Domain",
    "",
    "Reviews stories.",
    "",
    "## Mandate",
    "",
    "- Review.",
    "",
    "## Out of mandate",
    "",
    "- Implement.",
    "",
    "## Prompt",
    "",
    "You are the reviewer.",
    "",
    "## Knowledge",
    "",
    "None.",
  ].join("\n");

  await atomicWriteFile(
    path.join(tmpRoot, "team", "generalist-dev", "PERSONA.md"),
    devPersona,
  );
  await atomicWriteFile(
    path.join(tmpRoot, "team", "generalist-reviewer", "PERSONA.md"),
    reviewerPersona,
  );

  // Plugin permissions for postReviewerComments
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

  // NOTE: target-file.txt intentionally NOT created here.

  // Mock deriveSourceBaseline
  mockDeriveSourceBaseline.mockResolvedValue({
    sourceHash: "a".repeat(64),
    sourceFields: {
      title: "Smoke Story — Post Reviewer Comments",
      narrative: "As an operator, I want target-file.txt to exist.",
      acceptance_criteria: [
        { text: "Given the dev has completed implementation.", kind: "integration" },
      ],
      implementation_notes: undefined,
      depends_on: [],
      withdrawn: false,
    },
  });

});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC5 (user-surface): post-reviewer step inserts a PR review with inline comments
// ---------------------------------------------------------------------------

describe("AC5 (user-surface): postReviewerComments posts a PR review with inline comments and summary verdict", () => {
  it(
    "dev claims handoff without artifact → runReviewerSession detects ENOENT → postReviewerComments posts review with inline comment → processReviewerTranscript stamps manifest",
    async () => {
      // -----------------------------------------------------------------------
      // Step 1: Dev handoff (rubber-stamp — no artifact)
      // -----------------------------------------------------------------------
      const devTranscript = makeRubberStampDevTranscript(SMOKE_STORY_REF);

      const devResult = await processDevTranscript({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: SMOKE_STORY_REF,
        devTranscript,
      });

      expect(devResult.next).toBe("spawn-reviewer");
      if (devResult.next !== "spawn-reviewer") return;
      expect(devResult.prNumber).toBe(99);

      // -----------------------------------------------------------------------
      // Step 2: runReviewerSession — target-file.txt missing → NEEDS CHANGES
      // (stub provides the diff WITH the artifact path for the inline-comment anchor)
      // -----------------------------------------------------------------------
      // Story 5.26: stub must handle git worktree add/remove (materialisePrBranchWorktree)
      // and gh pr view --json headRefName,headRefOid (AC1 of 5.26).
      // git worktree add creates an empty directory — no artifact in the PR branch worktree
      // (the artifact was intentionally not created by the dev, matching the test scenario).
      const reviewerSessionStub = vi.fn().mockImplementation(
        async (cmd: string, args: string[], _opts?: unknown) => {
          if (cmd === "gh") {
            const argsArr = args as string[];
            const isHeadRefQuery =
              argsArr.includes("headRefName,headRefOid") ||
              (argsArr.includes("--json") && argsArr.some((a) => a.includes("headRefOid")));
            if (isHeadRefQuery) {
              return {
                stdout: JSON.stringify({ headRefName: "pr-head", headRefOid: "aabbccddaabbccddaabbccddaabbccddaabbccdd" }),
                stderr: "", exitCode: 0, timedOut: false,
              };
            }
            return { stdout: FAKE_PR_DIFF_WITH_ARTIFACT, stderr: "", exitCode: 0, timedOut: false };
          }
          if (cmd === "git") {
            const argsArr = args as string[];
            if (argsArr[0] === "worktree" && argsArr[1] === "add") {
              const worktreePath = argsArr[2];
              if (worktreePath) {
                await fs.mkdir(worktreePath, { recursive: true });
              }
              return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
            }
            if (argsArr[0] === "worktree" && argsArr[1] === "remove") {
              const removePath = argsArr[2];
              if (removePath) {
                await fs.rm(removePath, { recursive: true, force: true }).catch(() => {});
              }
              return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
            }
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }
          if (cmd === "pnpm") {
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }
          return { stdout: "", stderr: `unexpected: ${cmd}`, exitCode: 1, timedOut: false };
        },
      ) as unknown as typeof import("execa").execa;

      const sessionResult = await runReviewerSession({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: SMOKE_STORY_REF,
        prNumber: devResult.prNumber,
        execaImpl: reviewerSessionStub,
      });

      // AC1 must fail (target-file.txt absent)
      const ac1 = sessionResult.acResults[1];
      expect(ac1!.applicability).toBe("runnable-artifact-check");
      if (ac1!.applicability !== "runnable-artifact-check") return;
      expect(ac1!.status).toBe("fail");
      expect(ac1!.reason).toContain(SMOKE_ARTIFACT_PATH);
      expect(ac1!.reason).toContain("ENOENT");

      // Verdict must be NEEDS CHANGES
      expect(sessionResult.recommendedVerdict).toBe("NEEDS CHANGES");

      // -----------------------------------------------------------------------
      // Step 3: postReviewerComments — first run (no prior verdict)
      // GET returns empty list → POST creates new review
      // (spec §5b and AC4 Story 4.7 assertions)
      // -----------------------------------------------------------------------
      const reviewsUrl = `/repos/jackmcintyre/crew/pulls/${devResult.prNumber}/reviews`;

      let capturedPostInput: string | undefined;
      const firstPostStub = makeGhExecaStub({
        prDiff: { stdout: FAKE_PR_DIFF_WITH_ARTIFACT },
        apiRoutes: [
          {
            url: reviewsUrl,
            method: "GET",
            response: { stdout: JSON.stringify([]), exitCode: 0 },
          },
          {
            url: reviewsUrl,
            method: "POST",
            response: { stdout: JSON.stringify({ id: 1001 }), exitCode: 0 },
            onCall: (input) => { capturedPostInput = input; },
          },
        ],
      });

      const firstPostResult = await postReviewerComments({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: SMOKE_STORY_REF,
        execaImpl: firstPostStub,
        pluginRootOverride: pluginRoot,
        pluginVersionOverride: SMOKE_PLUGIN_VERSION,
      });

      // (5b): Tool must have posted
      expect(firstPostResult.next).toBe("posted");
      if (firstPostResult.next !== "posted") return;

      // First run: POST path
      expect(firstPostResult.wasEdit).toBe(false);
      expect(firstPostResult.priorReviewId).toBeNull();

      // Parse the captured gh api body
      const firstApiBody = JSON.parse(capturedPostInput!) as {
        event: string;
        body: string;
        comments: Array<{ path: string; line: number; body: string }>;
      };

      // (AC4 4b): version tokens present in POST body
      expect(firstApiBody.body).toContain("standards_version:");
      expect(firstApiBody.body).toContain("plugin_version:");
      expect(firstApiBody.body).toContain("<!-- flow:verdict:");

      // (AC4 4b): footer marker is absolute last line
      const footerMarker = `<!-- flow:verdict:${SMOKE_PLUGIN_VERSION}:${SMOKE_STORY_REF} -->`;
      expect(firstApiBody.body.split("\n").at(-1)).toBe(footerMarker);

      // (5b): verdict is in body (not necessarily last line after Story 4.7)
      expect(firstApiBody.body).toContain("**Verdict: NEEDS CHANGES** [1 issues, 0 questions]");

      // (5b): comments array has length 1 (failing artifact in diff)
      expect(firstApiBody.comments).toHaveLength(1);

      // (5b): Inline comment body contains target-file.txt and ENOENT
      const inlineComment = firstApiBody.comments[0]!;
      expect(inlineComment.body).toContain(SMOKE_ARTIFACT_PATH);
      expect(inlineComment.body).toContain("ENOENT");

      // (5b): event is COMMENT
      expect(firstApiBody.event).toBe("COMMENT");

      // -----------------------------------------------------------------------
      // Step 3b: Second postReviewerComments — rerun scenario (AC4 Story 4.7)
      // GET returns prior verdict with footer marker → PATCH, not POST
      // -----------------------------------------------------------------------
      const priorBody = firstApiBody.body; // body from first run (has footer marker)

      let capturedPatchInput: string | undefined;
      const secondPostStub = makeGhExecaStub({
        prDiff: { stdout: FAKE_PR_DIFF_WITH_ARTIFACT },
        apiRoutes: [
          {
            url: reviewsUrl,
            method: "GET",
            response: {
              stdout: JSON.stringify([{ id: 1001, body: priorBody }]),
              exitCode: 0,
            },
          },
          {
            url: new RegExp(`${reviewsUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/1001$`),
            method: "PATCH",
            response: { stdout: JSON.stringify({ id: 1001 }), exitCode: 0 },
            onCall: (input) => { capturedPatchInput = input; },
          },
        ],
      });

      const secondPostResult = await postReviewerComments({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: SMOKE_STORY_REF,
        execaImpl: secondPostStub,
        pluginRootOverride: pluginRoot,
        pluginVersionOverride: SMOKE_PLUGIN_VERSION,
      });

      // (AC4 4a): second run: PATCH path taken, not POST
      expect(secondPostResult.next).toBe("posted");
      if (secondPostResult.next !== "posted") return;
      expect(secondPostResult.wasEdit).toBe(true);
      expect(secondPostResult.priorReviewId).toBe(1001);
      expect(secondPostResult.inlineCommentCount).toBeNull();

      // (AC4 4b): PATCH body also contains version tokens and footer marker
      expect(capturedPatchInput).toBeDefined();
      const patchPayload = JSON.parse(capturedPatchInput!) as { body: string };
      expect(patchPayload.body).toContain("standards_version:");
      expect(patchPayload.body).toContain("plugin_version:");
      expect(patchPayload.body.split("\n").at(-1)).toBe(footerMarker);

      // (AC4 4a): POST stub called exactly once, PATCH stub called exactly once on second run
      type RawCall = [cmd: string, args: string[], ...rest: unknown[]];
      const secondRunApiCalls = vi.mocked(secondPostStub).mock.calls as unknown as RawCall[];
      const secondRunPostCalls = secondRunApiCalls.filter(
        ([cmd, args]) => cmd === "gh" && args?.[0] === "api" && args?.includes("POST"),
      );
      expect(secondRunPostCalls).toHaveLength(0); // no POST on second run

      const secondRunPatchCalls = secondRunApiCalls.filter(
        ([cmd, args]) => cmd === "gh" && args?.[0] === "api" && args?.includes("PATCH"),
      );
      expect(secondRunPatchCalls).toHaveLength(1);

      // -----------------------------------------------------------------------
      // Step 4: processReviewerTranscript — reads same file, stamps manifest
      // (spec §5c: manifest stays in in-progress/ with blocked_by)
      // -----------------------------------------------------------------------
      const reviewerResult = await processReviewerTranscript({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: SMOKE_STORY_REF,
        manifestPath,
      });

      expect(reviewerResult.next).toBe("done-blocked-reviewer-needs-changes");

      // (5c): Manifest stays in in-progress/ NOT done/
      await assertManifestStaysInProgress(tmpRoot, SMOKE_STORY_REF);

      // (5c): blocked_by is stamped
      const manifestContent = await fs.readFile(manifestPath, "utf8");
      expect(manifestContent).toContain("blocked_by: reviewer-verdict-needs-changes");
    },
    30000, // 30s timeout for smoke test
  );
});
