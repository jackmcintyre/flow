/**
 * Rubber-stamp reproducer for AC5 operator-smoke harness — Story 4.6 Task 10.1.
 *
 * This module provides:
 *
 *   1. `RUBBER_STAMP_DEV_TRANSCRIPT` — a deterministic dev subagent transcript
 *      that emits the verbatim Story 4.3 handoff phrase AND a GitHub PR URL,
 *      but deliberately DOES NOT create `target-file.txt` on disk. This is the
 *      exact rubber-stamp setup from the 4.3c smoke: the dev "claims" to have
 *      built the artifact without actually building it.
 *
 *   2. `assertAc5Contract` — assertion helper that the AC5 test wires against the
 *      reviewer's verdict transcript and the post-cycle manifest state.
 *
 * The harness is SMOKE-ONLY. It does not run a real LLM, does not call `gh`, and
 * does not create or push any branch. It demonstrates the TOOL-LAYER contract:
 * given a missing artifact, `runReviewerSession` returns `acResults[1].status === "fail"`,
 * and a reviewer that composes its verdict from that structured result MUST NOT emit
 * `READY FOR MERGE`.
 *
 * Spec: _bmad-output/implementation-artifacts/4-6-reviewer-subagent-read-sources-and-run-acs.md §5a–5d
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { expect } from "vitest";
import type { AcResult } from "../../tools/run-reviewer-session.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The fake PR URL used by the dev transcript. The smoke harness is purely
 * local; no real GitHub org/repo is needed — the URL just needs to match the
 * `processDevTranscript` extraction regex.
 */
const SMOKE_PR_URL = "https://github.com/smoke-org/smoke-repo/pull/99";

/**
 * The ref for the smoke story. Must be a valid Crockford ULID prefixed with "native:".
 * Chosen to be distinct from other test fixtures (01J9P0K2N3MZX0YV4S5RTQ4REV).
 * Crockford base32 alphabet: 0-9A-HJKMNP-TV-Z (excludes I, L, O, U).
 */
export const SMOKE_STORY_ULID = "01J9AC5SMKSTX0YV4S5RTQ4REV";
export const SMOKE_STORY_REF = `native:${SMOKE_STORY_ULID}`;

/**
 * The AC artifact that the smoke story declares. The dev never creates this
 * file, which is what makes the rubber-stamp scenario deterministic.
 */
export const SMOKE_ARTIFACT_PATH = "target-file.txt";

// ---------------------------------------------------------------------------
// Deterministic dev transcript — handoff without artifact creation.
//
// Spec §5a: "the dev 'claims' it built the artifact and emits the handoff
// phrase, but the file is not on disk."
// ---------------------------------------------------------------------------

/**
 * A dev subagent transcript that:
 *  - Contains the verbatim Story 4.3 handoff phrase for `SMOKE_STORY_REF`.
 *  - Contains `SMOKE_PR_URL` so `processDevTranscript` can extract `prNumber`.
 *  - Does NOT create `target-file.txt` on disk (the caller sets up the tmpdir
 *    without that file).
 */
export function makeRubberStampDevTranscript(ref: string): string {
  return [
    `I have implemented the story and pushed the branch.`,
    ``,
    `The PR is available at: ${SMOKE_PR_URL}`,
    ``,
    `Handoff to reviewer — story ${ref} ready for review.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reviewer verdict composer — simulates what the persona emits given a
// structured result where acResults[1] has status: "fail".
//
// In the CI harness we cannot run a real LLM, so we synthesise the transcript
// the persona SHOULD emit under the verdict composition rules from Task 8.3:
//   - MUST NOT emit READY FOR MERGE if any acResults[*].status === "fail".
//   - Reason field MUST be quoted verbatim in the summary.
// ---------------------------------------------------------------------------

/**
 * Compose a reviewer verdict transcript from structured AC results.
 * Mirrors what the `generalist-reviewer` persona is instructed to emit
 * per the Task 8.3 verdict composition rules.
 *
 * If any AC has status "fail", emits `NEEDS CHANGES` with the failing
 * reason(s) quoted verbatim. Otherwise emits `READY FOR MERGE`.
 */
export function composeReviewerTranscript(acResults: Record<number, AcResult>): string {
  // Collect failing ACs. The AcResult union has "status" only on the runnable variants;
  // we access it via type assertion after confirming the discriminant.
  const failingAcs: Array<{ index: number; reason: string }> = [];
  for (const ac of Object.values(acResults)) {
    if (ac.applicability === "runnable-artifact-check" && ac.status === "fail") {
      failingAcs.push({ index: ac.index, reason: ac.reason });
    } else if (ac.applicability === "runnable-vitest" && ac.status === "fail") {
      failingAcs.push({ index: ac.index, reason: ac.reason });
    }
  }

  if (failingAcs.length === 0) {
    return [
      `All acceptance criteria passed.`,
      ``,
      `**Verdict: READY FOR MERGE**`,
    ].join("\n");
  }

  const lines: string[] = [
    `## Review Summary`,
    ``,
    `The following acceptance criteria failed:`,
    ``,
  ];

  for (const ac of failingAcs) {
    lines.push(`- **AC${ac.index}**: ${ac.reason}`);
  }

  lines.push(``);
  lines.push(`**Verdict: NEEDS CHANGES**`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AC5 assertion helpers — spec §5b, 5c, 5d
// ---------------------------------------------------------------------------

/**
 * Assert that the reviewer verdict transcript satisfies the AC5 contract:
 *   (5b) The verdict MUST NOT be `READY FOR MERGE`.
 *   (5b) The verdict MUST be `NEEDS CHANGES` or `BLOCKED`.
 *   (5d) The transcript MUST contain `target-file.txt` (the artifact path).
 *   (5d) The transcript MUST contain a fail-signal word:
 *        "missing", "absent", "not found", "ENOENT", or "fail".
 */
export function assertVerdictTranscriptContract(reviewerTranscript: string): void {
  // (5b) MUST NOT be READY FOR MERGE
  expect(reviewerTranscript).not.toContain("**Verdict: READY FOR MERGE**");

  // (5b) MUST be NEEDS CHANGES or BLOCKED
  const hasNeedsChanges = reviewerTranscript.includes("**Verdict: NEEDS CHANGES**");
  const hasBlocked = reviewerTranscript.includes("**Verdict: BLOCKED**");
  expect(hasNeedsChanges || hasBlocked).toBe(true);

  // (5d) References the missing artifact by path
  expect(reviewerTranscript).toContain(SMOKE_ARTIFACT_PATH);

  // (5d) Contains a fail-signal word
  const failSignals = ["missing", "absent", "not found", "ENOENT", "fail"];
  const hasFailSignal = failSignals.some((sig) => reviewerTranscript.includes(sig));
  expect(hasFailSignal).toBe(true);
}

/**
 * Assert that the in-progress manifest for `ref` exists at
 * `<targetRepoRoot>/.flow/state/in-progress/<ref>.yaml` AND that it does
 * NOT exist at `<targetRepoRoot>/.flow/state/done/<ref>.yaml`.
 *
 * Spec §5c: "the in-progress manifest does NOT move to done/".
 */
export async function assertManifestStaysInProgress(
  targetRepoRoot: string,
  ref: string,
): Promise<void> {
  const inProgressPath = path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "in-progress",
    `${ref}.yaml`,
  );
  const donePath = path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "done",
    `${ref}.yaml`,
  );

  // in-progress/ file MUST exist.
  await expect(fs.access(inProgressPath)).resolves.toBeUndefined();

  // done/ file MUST NOT exist.
  await expect(fs.access(donePath)).rejects.toThrow();
}
