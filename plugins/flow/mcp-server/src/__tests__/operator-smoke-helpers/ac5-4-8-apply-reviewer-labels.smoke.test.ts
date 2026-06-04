/**
 * AC5 (user-surface) operator-smoke extension for Story 4.8 — Task 7.
 *
 * @description
 * Extends the Story 4.6b / 4.7 operator-smoke harness with the
 * `applyReviewerLabels` step after `processReviewerTranscript`:
 *   1. Same scratch repo — one ready story with `artifact: target-file.txt`.
 *   2. Dev handoffs without creating the artifact (rubber-stamp).
 *   3. `runReviewerSession` executes — finds artifact missing, returns NEEDS CHANGES.
 *   4. `postReviewerComments` is called AFTER runReviewerSession returns.
 *   5. `processReviewerTranscript` is called — manifest stays in in-progress/
 *      with `blocked_by: reviewer-verdict-needs-changes`.
 *   6. `applyReviewerLabels` is called — asserts two sequential `gh api POST /labels`
 *      calls: first for `reviewed-by-agent`, second for `needs-human`.
 *   7. Return value is `{ next: "applied", labelsApplied: ["reviewed-by-agent", "needs-human"] }`.
 *   8. Story 4.6b / 4.7 invariants still hold per AC5 (5c): manifest stays in in-progress/.
 *
 * AC5 smoke-gate: per `plugins/flow/docs/user-surface-acs.md` § Pre-PR gate,
 * this test provides CI-level evidence for AC5 (user-surface) of Story 4.8.
 *
 * Story 4.8 Task 7.1–7.4.
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
import { applyReviewerLabels } from "../../tools/apply-reviewer-labels.js";
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

const SESSION_ULID = "01HZSMOKE4_8_SESSION0000000";

const FAKE_PR_DIFF_WITH_ARTIFACT = `diff --git a/target-file.txt b/target-file.txt
new file mode 100644
--- /dev/null
+++ b/target-file.txt
@@ -0,0 +1,1 @@
+built by dev
`;

const SMOKE_SOURCE_STORY = `# Smoke Story — Apply Reviewer Labels

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

// Plugin version used in smoke tests — avoids calling real plugin.json
const SMOKE_PLUGIN_VERSION = "0.1.0-smoke";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let manifestPath: string;
let pluginRoot: string;

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();
  __resetPluginVersionCacheForTests();

  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "flow-4-8-ac5-smoke-"));
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
      `title: "Smoke Story — Apply Reviewer Labels"`,
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

  // Persona files (required by runReviewerSession indirectly via permissions loading)
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

  // Plugin permissions for postReviewerComments and applyReviewerLabels
  await fs.mkdir(path.join(pluginRoot, "permissions"), { recursive: true });

  await atomicWriteFile(
    path.join(pluginRoot, "permissions", "gh-error-map.yaml"),
    `entries:\n  - exit_code: 4\n    stderr_regex: "API rate limit exceeded"\n    class: defer\n`,
  );

  // generalist-reviewer.yaml — production state after Task 1 (no pr-comment, no pr-review)
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
      title: "Smoke Story — Apply Reviewer Labels",
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
// AC5 (user-surface): applyReviewerLabels applies two labels on NEEDS CHANGES
// ---------------------------------------------------------------------------

describe("AC5 (user-surface): applyReviewerLabels applies reviewed-by-agent + needs-human on NEEDS CHANGES", () => {
  it(
    "dev claims handoff without artifact → runReviewerSession detects ENOENT → postReviewerComments posts review → processReviewerTranscript stamps manifest → applyReviewerLabels posts two labels",
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
      const prNumber = devResult.prNumber;
      expect(prNumber).toBe(99);

      // -----------------------------------------------------------------------
      // Step 2: runReviewerSession — target-file.txt missing → NEEDS CHANGES
      // -----------------------------------------------------------------------
      // Story 5.26: stub must handle git worktree add/remove (materialisePrBranchWorktree)
      // and gh pr view --json headRefName,headRefOid.
      // git worktree add creates an empty directory (no artifact) → NEEDS CHANGES expected.
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
              if (worktreePath) { await fs.mkdir(worktreePath, { recursive: true }); }
              return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
            }
            if (argsArr[0] === "worktree" && argsArr[1] === "remove") {
              const removePath = argsArr[2];
              if (removePath) { await fs.rm(removePath, { recursive: true, force: true }).catch(() => {}); }
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
        prNumber,
        execaImpl: reviewerSessionStub,
      });

      expect(sessionResult.recommendedVerdict).toBe("NEEDS CHANGES");

      // -----------------------------------------------------------------------
      // Step 3: postReviewerComments (required prior step in the inner cycle)
      // -----------------------------------------------------------------------
      const reviewsUrl = `/repos/jackmcintyre/crew/pulls/${prNumber}/reviews`;

      const postStub = makeGhExecaStub({
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
            response: { stdout: JSON.stringify({ id: 2001 }), exitCode: 0 },
          },
        ],
      });

      const postResult = await postReviewerComments({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: SMOKE_STORY_REF,
        execaImpl: postStub,
        pluginRootOverride: pluginRoot,
        pluginVersionOverride: SMOKE_PLUGIN_VERSION,
      });

      expect(postResult.next).toBe("posted");

      // -----------------------------------------------------------------------
      // Step 4: processReviewerTranscript — stamps manifest
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

      // -----------------------------------------------------------------------
      // Step 5: applyReviewerLabels — assert two sequential label calls
      // (5a, 5b): captured input fields on the gh api stub
      // -----------------------------------------------------------------------
      const LABELS_URL_PATTERN = /\/labels$/;

      const capturedInputs: string[] = [];
      const labelsStub = makeGhExecaStub({
        apiRoutes: [
          {
            url: LABELS_URL_PATTERN,
            method: "POST",
            response: {
              stdout: JSON.stringify([
                { id: 1, name: "reviewed-by-agent", color: "0075ca" },
                { id: 2, name: "needs-human", color: "e4e669" },
              ]),
              exitCode: 0,
            },
            onCall: (input) => {
              capturedInputs.push(input ?? "");
            },
          },
        ],
      });

      const labelsResult = await applyReviewerLabels({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: SMOKE_STORY_REF,
        pluginRootOverride: pluginRoot,
        execaImpl: labelsStub,
      });

      // (5b): Return value is { next: "applied", labelsApplied: [...] }
      expect(labelsResult).toEqual({
        next: "applied",
        labelsApplied: ["reviewed-by-agent", "needs-human"],
      });

      // (5b): Exactly two sequential gh api POST /labels calls
      expect(capturedInputs).toHaveLength(2);
      expect(JSON.parse(capturedInputs[0]!)).toEqual({ labels: ["reviewed-by-agent"] });
      expect(JSON.parse(capturedInputs[1]!)).toEqual({ labels: ["needs-human"] });

      // Verify labelsUrl was actually used (via stub call inspection)
      type RawCall = [cmd: string, args: string[], ...rest: unknown[]];
      const stubCalls = vi.mocked(labelsStub).mock.calls as unknown as RawCall[];
      const labelApiCalls = stubCalls.filter(
        ([cmd, args]) =>
          cmd === "gh" &&
          args?.[0] === "api" &&
          typeof args?.[1] === "string" &&
          (args[1] as string).endsWith("/labels"),
      );
      expect(labelApiCalls).toHaveLength(2);

      // (5c): Manifest STILL in in-progress after labels applied (non-regression)
      await assertManifestStaysInProgress(tmpRoot, SMOKE_STORY_REF);
    },
    30000, // 30s timeout for smoke test
  );
});
