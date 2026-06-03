/**
 * `processReviewerTranscript` MCP tool — Story 4.3b Task 3; Story 4.3c Task 2;
 * **Story 4.6 revision 2 (deterministic-verdict-transport).**
 *
 * **Revision 2 architectural change (Story 4.6 revision 2):**
 * The `reviewerTranscript` parameter has been DROPPED. The reviewer's chat is
 * no longer the load-bearing verdict transport. Instead, this tool reads the
 * persisted `reviewer-result.json` file written by `runReviewerSession` and
 * switches on its `recommendedVerdict` field.
 *
 * Migration from revision 1:
 *  - `reviewerTranscript` parameter removed from `ProcessReviewerTranscriptOptions`.
 *  - `done-blocked-reviewer-verdict` and `done-blocked-reviewer-grammar` result
 *    variants DELETED — no backward-compat path. `runReviewerSession` is now the
 *    ONLY valid reviewer entrypoint; these variants are structurally subsumed by
 *    the new variants below.
 *  - New variants added: `done-blocked-reviewer-needs-changes`,
 *    `done-blocked-reviewer-blocked`, `done-blocked-no-session-result`.
 *
 * Story 5.21 revision (reviewer-first-call-seam):
 *  - `done-blocked-no-session-result` return variant DELETED. The file-absent path
 *    now throws `ReviewerFirstCallSkippedError` instead. No backward-compat path.
 *    The inner cycle's error handler (SKILL.md step 10) catches and halts.
 *  - `import { parseVerdict }` removed (no callers after revision 2).
 *
 * **New input shape:** `{ targetRepoRoot, sessionUlid, ref, manifestPath }`
 * **File path read:** `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/reviewer-result.json`
 *
 * **Result routing:**
 *  - `recommendedVerdict === "READY FOR MERGE"` → calls `completeStory` internally,
 *    returns `done-ready-for-merge` with `completed: true`. (4.3c semantics preserved.)
 *  - `recommendedVerdict === "NEEDS CHANGES"` → stamps `blocked_by: "reviewer-verdict-needs-changes"`,
 *    returns `done-blocked-reviewer-needs-changes`.
 *  - `recommendedVerdict === "BLOCKED"` → stamps `blocked_by: "reviewer-verdict-blocked"`,
 *    returns `done-blocked-reviewer-blocked`.
 *  - File absent (ENOENT) → stamps `blocked_by: "reviewer-no-session-result"`,
 *    then **throws `ReviewerFirstCallSkippedError`** (Story 5.21 seam).
 *    The previous soft `done-blocked-no-session-result` return variant has been
 *    removed. Throwing makes the skipped first-call structurally undeniable —
 *    the inner cycle MUST surface and halt rather than silently continuing.
 *  - File present but malformed/invalid → throws `ReviewerResultFileMalformedError`.
 *
 * **Behavioural contract sources:**
 * `_bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md § Behavioural contract`
 * `_bmad-output/implementation-artifacts/4-3c-call-completestory-after-ready-for-merge.md § Behavioural contract`
 * `_bmad-output/implementation-artifacts/4-6-reviewer-subagent-read-sources-and-run-acs.md § Task 8b`
 *
 * On `READY FOR MERGE`: calls `completeStory` internally (via direct function
 * import from `./complete-story.js`) to atomically move the manifest to `done/`
 * BEFORE returning. The `completeStory` call is NOT made through the MCP
 * `register.ts` surface — it is a plain Node import.
 *
 * This tool MUST NOT spawn anything. The MCP server runs over JSON-RPC stdio
 * and has no access to Claude Code's `Task` tool. Spawn responsibility belongs
 * exclusively to the SKILL.md prose layer.
 *
 * Chat lines flow through the returned `chatLog: string[]` — no console.*.
 * Errors propagate as typed `DomainError`s; `register.ts` wraps them.
 *
 * Story 4.3b Task 3.1–3.5; Story 4.3c Task 2.1–2.7; Story 4.6 Task 8b.
 */

import { readManifest, writeManifest } from "../lib/manifest-io.js";
import { completeStory } from "./complete-story.js";
import { readReviewerResultFile } from "../lib/read-reviewer-result-file.js";
import { ReviewerFirstCallSkippedError } from "../errors.js";
import type { RecommendedVerdict } from "./run-reviewer-session.js";

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

/**
 * Story 5.21 — reviewer-first-call-seam:
 * The `done-blocked-no-session-result` soft return variant has been REMOVED.
 * When `reviewer-result.json` is absent, `processReviewerTranscript` now
 * throws `ReviewerFirstCallSkippedError` (a typed DomainError), making the
 * missing first-call a structurally undeniable failure rather than a soft
 * discriminant the caller could silently continue past.
 * The deterministic seam lives in the file-absent branch of
 * `processReviewerTranscript` (see implementation below).
 * The prose mandate in the reviewer PERSONA.md is now belt-and-braces only.
 */
export type ProcessReviewerTranscriptResult =
  | { next: "done-ready-for-merge"; completed: true; chatLog: string[] }
  | {
      /** Reviewer's `runReviewerSession` found one or more failing ACs. Dev must iterate. */
      next: "done-blocked-reviewer-needs-changes";
      chatLog: string[];
    }
  | {
      /** Reviewer's `runReviewerSession` returned BLOCKED (empty ACs or manual-check-required). */
      next: "done-blocked-reviewer-blocked";
      chatLog: string[];
    };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ProcessReviewerTranscriptOptions {
  targetRepoRoot: string;
  sessionUlid: string;
  ref: string;
  manifestPath: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Process the reviewer subagent's session result.
 *
 * **Revision 2:** reads `reviewer-result.json` from
 * `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/reviewer-result.json`
 * and switches on its `recommendedVerdict` field. The reviewer's chat
 * transcript is no longer consulted.
 *
 * - Missing file → stamps `blocked_by: "reviewer-no-session-result"`, throws
 *   `ReviewerFirstCallSkippedError`. The reviewer skipped `runReviewerSession`.
 * - `recommendedVerdict === "READY FOR MERGE"` → calls `completeStory` internally;
 *   manifest moves to `done/`; returns `done-ready-for-merge` with `completed: true`.
 * - `recommendedVerdict === "NEEDS CHANGES"` → stamps `blocked_by: "reviewer-verdict-needs-changes"`;
 *   returns `done-blocked-reviewer-needs-changes`.
 * - `recommendedVerdict === "BLOCKED"` → stamps `blocked_by: "reviewer-verdict-blocked"`;
 *   returns `done-blocked-reviewer-blocked`.
 *
 * The `completeStory` call errors (`InProgressHandEditError`, `WrongClaimantError`,
 * `ManifestNotFoundError`) propagate verbatim — no catch, no wrap. The
 * `register.ts` `DomainError` → `isError: true` path handles serialisation.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.sessionUlid - ULID of the calling dev session.
 * @param opts.ref - Story ref (e.g. `"native:01HZ..."`).
 * @param opts.manifestPath - Absolute path to the in-progress manifest.
 */
export async function processReviewerTranscript(
  opts: ProcessReviewerTranscriptOptions,
): Promise<ProcessReviewerTranscriptResult> {
  const { targetRepoRoot, ref, sessionUlid, manifestPath } = opts;
  const chatLog: string[] = [];

  // Read the persisted reviewer-result.json file (Story 8.15: per-ref path).
  const resultFile = await readReviewerResultFile(targetRepoRoot, sessionUlid, ref);

  if (resultFile === null) {
    // File absent — reviewer skipped runReviewerSession.
    // Story 5.21 (reviewer-first-call-seam): stamp the manifest then throw a
    // typed error. This replaces the previous soft `done-blocked-no-session-result`
    // return variant. Throwing makes the missing first-call structurally undeniable
    // — the inner cycle's error handler (step 10 in SKILL.md) MUST surface this and
    // halt rather than soft-continuing to the outer loop.
    const currentManifest = await readManifest(manifestPath);
    await writeManifest(manifestPath, {
      ...currentManifest,
      blocked_by: "reviewer-no-session-result",
    });

    throw new ReviewerFirstCallSkippedError({ sessionUlid, ref });
  }

  const verdict: RecommendedVerdict = resultFile.recommendedVerdict;

  if (verdict === "READY FOR MERGE") {
    chatLog.push(`reviewer verdict: READY FOR MERGE — story ${ref} ready for merge gate`);
    // Atomically move the manifest to done/ via internal function import.
    // Errors propagate verbatim — no try/catch (behavioural contract §
    // _bmad-output/implementation-artifacts/4-3c-call-completestory-after-ready-for-merge.md
    // § Behavioural contract).
    await completeStory({ targetRepoRoot, ref, sessionUlid });
    return { next: "done-ready-for-merge", completed: true as const, chatLog };
  }

  if (verdict === "NEEDS CHANGES") {
    // Stamp blocked_by; return new variant. Manifest stays in in-progress/.
    const currentManifest = await readManifest(manifestPath);
    await writeManifest(manifestPath, {
      ...currentManifest,
      blocked_by: "reviewer-verdict-needs-changes",
    });

    chatLog.push(
      `reviewer verdict: NEEDS CHANGES — story ${ref} blocked. ` +
        `reviewer-result.json carries recommendedVerdict NEEDS CHANGES. ` +
        `Clear blocked_by on the manifest and re-run /flow:start after addressing the reviewer's findings.`,
    );

    return { next: "done-blocked-reviewer-needs-changes", chatLog };
  }

  // verdict === "BLOCKED"
  const currentManifest = await readManifest(manifestPath);
  await writeManifest(manifestPath, {
    ...currentManifest,
    blocked_by: "reviewer-verdict-blocked",
  });

  chatLog.push(
    `reviewer verdict: BLOCKED — story ${ref} blocked. ` +
      `reviewer-result.json carries recommendedVerdict BLOCKED (empty ACs or manual-check-required). ` +
      `Human operator must review before this story can proceed.`,
  );

  return { next: "done-blocked-reviewer-blocked", chatLog };
}
