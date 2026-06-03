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
import type { AcResult } from "../../tools/run-reviewer-session.js";
/**
 * The fake PR URL used by the dev transcript. The smoke harness is purely
 * local; no real GitHub org/repo is needed — the URL just needs to match the
 * `processDevTranscript` extraction regex.
 */
export declare const SMOKE_PR_URL = "https://github.com/smoke-org/smoke-repo/pull/99";
/**
 * The ref for the smoke story. Must be a valid Crockford ULID prefixed with "native:".
 * Chosen to be distinct from other test fixtures (01J9P0K2N3MZX0YV4S5RTQ4REV).
 * Crockford base32 alphabet: 0-9A-HJKMNP-TV-Z (excludes I, L, O, U).
 */
export declare const SMOKE_STORY_ULID = "01J9AC5SMKSTX0YV4S5RTQ4REV";
export declare const SMOKE_STORY_REF = "native:01J9AC5SMKSTX0YV4S5RTQ4REV";
/**
 * The AC artifact that the smoke story declares. The dev never creates this
 * file, which is what makes the rubber-stamp scenario deterministic.
 */
export declare const SMOKE_ARTIFACT_PATH = "target-file.txt";
/**
 * A dev subagent transcript that:
 *  - Contains the verbatim Story 4.3 handoff phrase for `SMOKE_STORY_REF`.
 *  - Contains `SMOKE_PR_URL` so `processDevTranscript` can extract `prNumber`.
 *  - Does NOT create `target-file.txt` on disk (the caller sets up the tmpdir
 *    without that file).
 */
export declare function makeRubberStampDevTranscript(ref: string): string;
/**
 * Compose a reviewer verdict transcript from structured AC results.
 * Mirrors what the `generalist-reviewer` persona is instructed to emit
 * per the Task 8.3 verdict composition rules.
 *
 * If any AC has status "fail", emits `NEEDS CHANGES` with the failing
 * reason(s) quoted verbatim. Otherwise emits `READY FOR MERGE`.
 */
export declare function composeReviewerTranscript(acResults: Record<number, AcResult>): string;
/**
 * Assert that the reviewer verdict transcript satisfies the AC5 contract:
 *   (5b) The verdict MUST NOT be `READY FOR MERGE`.
 *   (5b) The verdict MUST be `NEEDS CHANGES` or `BLOCKED`.
 *   (5d) The transcript MUST contain `target-file.txt` (the artifact path).
 *   (5d) The transcript MUST contain a fail-signal word:
 *        "missing", "absent", "not found", "ENOENT", or "fail".
 */
export declare function assertVerdictTranscriptContract(reviewerTranscript: string): void;
/**
 * Assert that the in-progress manifest for `ref` exists at
 * `<targetRepoRoot>/.flow/state/in-progress/<ref>.yaml` AND that it does
 * NOT exist at `<targetRepoRoot>/.flow/state/done/<ref>.yaml`.
 *
 * Spec §5c: "the in-progress manifest does NOT move to done/".
 */
export declare function assertManifestStaysInProgress(targetRepoRoot: string, ref: string): Promise<void>;
