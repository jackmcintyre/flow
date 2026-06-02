/**
 * AC3 (structural-anchor) test for Story 4.6b.
 *
 * Story 4.6b AC3 asserts that verdict-grammar drift is structurally impossible:
 *   (a) `composeVerdictLine` always returns one of the three AC2 forms or
 *       throws `UnreachableBlockedReasonError` — no other output is reachable.
 *   (b) No LLM-output-parsing code path exists in `postReviewerComments` —
 *       the entire composition chain is:
 *         reviewer-result.json → composeVerdictLine/composeSummaryBody (pure) → gh api POST
 *       Verified here by running `postReviewerComments` over every closed-table
 *       verdict variant and asserting the verdict line always matches the
 *       AC2-specified regex — without any LLM call or text-parsing intermediary.
 *
 * This file references the unit suite in `lib/__tests__/compose-reviewer-summary.test.ts`
 * (which exercises every `composeVerdictLine` branch in isolation) and adds an
 * integration-level structural gate: the full tool path must produce an
 * AC2-matching verdict line for every valid `reviewer-result.json` shape.
 *
 * Story 4.6b Task 8 (AC3 structural-anchor complement).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { sanitiseRefForPathSegment } from "../../lib/read-reviewer-result-file.js";
import { postReviewerComments } from "../post-reviewer-comments.js";
import { composeVerdictLine } from "../../lib/compose-reviewer-summary.js";
import { UnreachableBlockedReasonError } from "../../errors.js";
import { makeGhExecaStub } from "../../__tests__/test-helpers/gh-execa-stub.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
import { __resetPluginVersionCacheForTests } from "../../lib/plugin-version.js";
import type { ReviewerResultFileShape, AcResult } from "../run-reviewer-session.js";

// ---------------------------------------------------------------------------
// AC2-specified verdict-line regex (closed-table grammar)
// ---------------------------------------------------------------------------

const VERDICT_READY = /^\*\*Verdict: READY FOR MERGE\*\*$/;
const VERDICT_NEEDS = /^\*\*Verdict: NEEDS CHANGES\*\* \[\d+ issues, \d+ questions\]$/;
const VERDICT_BLOCKED = /^\*\*Verdict: BLOCKED\*\* \[.+\]$/;

function matchesAc2Grammar(line: string): boolean {
  return VERDICT_READY.test(line) || VERDICT_NEEDS.test(line) || VERDICT_BLOCKED.test(line);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ULID = "01HZAC3STRUCT000000000000";
const STORY_REF = "native:01HZAC3STRUCT000000000000";
const PR_NUMBER = 99;

function makePassAc(index: number): AcResult {
  return {
    index,
    tag: null,
    applicability: "runnable-artifact-check",
    artifactPath: `artifact-${index}.txt`,
    status: "pass",
    reason: `artifact-${index}.txt exists`,
  };
}

function makeFailAc(index: number): AcResult {
  return {
    index,
    tag: null,
    applicability: "runnable-artifact-check",
    artifactPath: `missing-${index}.txt`,
    status: "fail",
    reason: `artifact: missing-${index}.txt — ENOENT`,
  };
}

function makeManualAc(index: number): AcResult {
  return {
    index,
    tag: null,
    applicability: "manual-check-required",
    reason: `Operator must verify AC${index} manually.`,
  };
}

function makeResult(
  verdict: "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED",
  acResults: Record<number, AcResult>,
): ReviewerResultFileShape {
  return {
    sessionUlid: SESSION_ULID,
    ref: STORY_REF,
    recommendedVerdict: verdict,
    acResults,
    standardsByCriterionId: {} as ReviewerResultFileShape["standardsByCriterionId"],
    sourceStoryRef: STORY_REF,
    prNumber: PR_NUMBER,
    standardsVersion: "1.2.3",
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let pluginRoot: string;

const AC3_PLUGIN_VERSION = "1.0.0-test";
// Reviews URL uses the PR_NUMBER from the makeResult fixture (99)
const AC3_REVIEWS_URL = `/repos/jackmcintyre/crew/pulls/${PR_NUMBER}/reviews`;

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();
  __resetPluginVersionCacheForTests();

  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "flow-4-6b-ac3-"));
  pluginRoot = path.join(tmpRoot, "plugin");

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
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
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
  await atomicWriteFile(path.join(sessDir, "reviewer-result.json"), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// AC3(a): composeVerdictLine always returns AC2-form or throws
// ---------------------------------------------------------------------------

describe("AC3(a): composeVerdictLine closed-table exhaustion", () => {
  it("READY FOR MERGE result → VERDICT_READY grammar", () => {
    const line = composeVerdictLine(makeResult("READY FOR MERGE", { 1: makePassAc(1) }));
    expect(line).toMatch(VERDICT_READY);
    expect(matchesAc2Grammar(line)).toBe(true);
  });

  it("NEEDS CHANGES result with fail → VERDICT_NEEDS grammar", () => {
    const line = composeVerdictLine(makeResult("NEEDS CHANGES", { 1: makeFailAc(1) }));
    expect(line).toMatch(VERDICT_NEEDS);
    expect(matchesAc2Grammar(line)).toBe(true);
  });

  it("BLOCKED with empty acResults → VERDICT_BLOCKED grammar [no ACs declared]", () => {
    const line = composeVerdictLine(makeResult("BLOCKED", {}));
    expect(line).toMatch(VERDICT_BLOCKED);
    expect(matchesAc2Grammar(line)).toBe(true);
    expect(line).toContain("no ACs declared");
  });

  it("BLOCKED with manual-check-required → VERDICT_BLOCKED grammar [manual checks required]", () => {
    const line = composeVerdictLine(makeResult("BLOCKED", { 1: makeManualAc(1) }));
    expect(line).toMatch(VERDICT_BLOCKED);
    expect(matchesAc2Grammar(line)).toBe(true);
    expect(line).toContain("manual checks required");
  });

  it("BLOCKED with only passing ACs (out-of-band mutation) → throws UnreachableBlockedReasonError", () => {
    expect(() =>
      composeVerdictLine(makeResult("BLOCKED", { 1: makePassAc(1) })),
    ).toThrow(UnreachableBlockedReasonError);
  });

  it("no verdict string other than the three AC2 forms is reachable via the closed table", () => {
    // All valid verdict variants produce AC2-matching lines.
    const variants: ReviewerResultFileShape[] = [
      makeResult("READY FOR MERGE", { 1: makePassAc(1) }),
      makeResult("NEEDS CHANGES", { 1: makeFailAc(1) }),
      makeResult("NEEDS CHANGES", { 1: makeFailAc(1), 2: makeManualAc(2) }),
      makeResult("BLOCKED", {}),
      makeResult("BLOCKED", { 1: makeManualAc(1) }),
    ];
    for (const v of variants) {
      const line = composeVerdictLine(v);
      expect(matchesAc2Grammar(line), `verdict line "${line}" does not match AC2 grammar`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3(b): postReviewerComments has NO LLM-output-parsing code path
//
// The tool's composition chain is: reviewer-result.json → composeSummaryBody
// (pure) → gh api POST. No text-scraping, no regex-based verdict extraction
// from LLM prose. We verify this integration-level contract by running the
// full tool path over every valid verdict variant and asserting:
//   1. The posted gh api body's final non-empty line matches AC2 grammar.
//   2. The tool's return includes a `verdictLine` that also matches AC2 grammar.
// If any LLM-text-parsing intermediary were introduced, it would need to handle
// the LLM's prose output, which cannot be deterministically unit-tested this way.
// ---------------------------------------------------------------------------

describe("AC3(b): postReviewerComments produces AC2-grammar verdict with no LLM parsing", () => {
  const verdictVariants: Array<{
    label: string;
    data: ReviewerResultFileShape;
    expectedPattern: RegExp;
  }> = [
    {
      label: "READY FOR MERGE",
      data: makeResult("READY FOR MERGE", { 1: makePassAc(1) }),
      expectedPattern: VERDICT_READY,
    },
    {
      label: "NEEDS CHANGES (1 fail, 0 manual)",
      data: makeResult("NEEDS CHANGES", { 1: makeFailAc(1) }),
      expectedPattern: VERDICT_NEEDS,
    },
    {
      label: "BLOCKED (no ACs)",
      data: makeResult("BLOCKED", {}),
      expectedPattern: VERDICT_BLOCKED,
    },
    {
      label: "BLOCKED (manual checks required)",
      data: makeResult("BLOCKED", { 1: makeManualAc(1) }),
      expectedPattern: VERDICT_BLOCKED,
    },
  ];

  for (const { label, data, expectedPattern } of verdictVariants) {
    it(`${label} → posted body contains AC2 grammar verdict and footer marker is last line (no LLM parsing)`, async () => {
      await writeResultFile(data);

      let capturedInput: string | undefined;
      const stub = makeGhExecaStub({
        apiRoutes: [
          {
            url: AC3_REVIEWS_URL,
            method: "GET",
            response: { stdout: JSON.stringify([]), exitCode: 0 },
          },
          {
            url: AC3_REVIEWS_URL,
            method: "POST",
            response: { stdout: JSON.stringify({ id: 12345 }), exitCode: 0 },
            onCall: (input) => { capturedInput = input; },
          },
        ],
      });

      const result = await postReviewerComments({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: STORY_REF,
        execaImpl: stub,
        pluginRootOverride: pluginRoot,
        pluginVersionOverride: AC3_PLUGIN_VERSION,
      });

      expect(result.next).toBe("posted");
      if (result.next !== "posted") return;

      // (b-i): Tool's verdictLine return field matches AC2 grammar.
      expect(result.verdictLine).toMatch(expectedPattern);
      expect(matchesAc2Grammar(result.verdictLine), `verdictLine "${result.verdictLine}" does not match AC2 grammar`).toBe(true);

      // (b-ii): Posted gh api body CONTAINS a verdict line matching AC2 grammar.
      // (Note: after Story 4.7, the footer marker is the absolute last line — not the verdict.)
      const apiBody = JSON.parse(capturedInput!) as { body: string };
      const verdictLineInBody = apiBody.body.split("\n").find((l) => l.startsWith("**Verdict:"));
      expect(verdictLineInBody).toBeDefined();
      expect(verdictLineInBody!).toMatch(expectedPattern);
      expect(matchesAc2Grammar(verdictLineInBody!), `posted body verdict line "${verdictLineInBody}" does not match AC2 grammar`).toBe(true);

      // (b-iii) Story 4.7: footer marker is the absolute last line.
      expect(apiBody.body.split("\n").at(-1)).toMatch(/^<!-- crew:verdict:/);
    });
  }
});
