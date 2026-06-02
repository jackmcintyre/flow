/**
 * `postReviewerComments` MCP tool — Story 4.6b.
 *
 * Behavioural contract source:
 *   _bmad-output/implementation-artifacts/4-6b-reviewer-posts-inline-comments-and-summary-verdict.md
 *
 * Reads the persisted `reviewer-result.json` written by `runReviewerSession`,
 * composes a deterministic PR review summary body plus zero-or-more inline
 * comments, and posts them as a single PR review via `gh api` with event: COMMENT.
 *
 * The reviewer LLM's chat output is NOT consulted — the entire composition path
 * is: `reviewer-result.json` → pure composer functions → `gh api` POST.
 *
 * Invoked from SKILL.md prose AFTER the reviewer Task returns and BEFORE
 * `processReviewerTranscript` runs. It is a sibling of `processReviewerTranscript`,
 * not a wrapper.
 *
 * On ENOENT for `reviewer-result.json`: returns
 *   `{ next: "skipped-no-session-result", postedReviewId: null }` silently
 *   (the loud blocker is `processReviewerTranscript`'s job downstream).
 *
 * On malformed JSON / invalid shape: propagates `ReviewerResultFileMalformedError`.
 * On `GhRecoverableError`, `GhApiResponseShapeError`, `GhSubcommandDeniedError`:
 * propagates verbatim (no retry, no swallow).
 *
 * TODO(future): wire `reviewer.comments_posted` telemetry event here.
 *
 * Story 4.6b Task 4.
 */

import * as path from "node:path";
import { execa as defaultExeca } from "execa";
import { loadRolePermissions } from "../state/load-role-permissions.js";
import { gh } from "../lib/gh.js";
import { getPluginRoot } from "../lib/plugin-root.js";
import { getPluginVersion } from "../lib/plugin-version.js";
import { readReviewerResultFile } from "../lib/read-reviewer-result-file.js";
import { composeSummaryBody } from "../lib/compose-reviewer-summary.js";
import { findHunkLineForPath } from "../lib/find-hunk-line.js";
import { GhApiResponseShapeError, ReviewerResultMissingStandardsVersionError } from "../errors.js";
import { logTelemetryEvent } from "../lib/logger.js";
import { readManifest, writeManifest } from "../lib/manifest-io.js";
import type { execa } from "execa";
import type { RiskTierBlock } from "./classify-risk-tier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PostReviewerCommentsResult =
  | {
      /** File was absent — no verdict to post. processReviewerTranscript handles it. */
      next: "skipped-no-session-result";
      postedReviewId: null;
    }
  | {
      /** Review successfully posted (first run) or PATCH-edited in place (rerun). */
      next: "posted";
      postedReviewId: number;
      /**
       * Number of inline comments submitted on POST. `null` on PATCH path —
       * signals "unknown / unchanged from prior pass", not zero.
       */
      inlineCommentCount: number | null;
      verdictLine: string;
      /** True when the prior verdict was PATCH-edited in place; false on first POST. */
      wasEdit: boolean;
      /** ID of the prior verdict review that was PATCH-edited. null on POST path. */
      priorReviewId: number | null;
    };

export interface PostReviewerCommentsOptions {
  targetRepoRoot: string;
  sessionUlid: string;
  /**
   * Story ref (e.g. `"bmad:8.15"`). Required to derive the per-story
   * reviewer-result path (Story 8.15) so a multi-story drain reads THIS
   * story's verdict, not whichever story last ran in the shared session.
   */
  ref: string;
  role?: string;
  /** Test seam — production callers do not pass this. */
  execaImpl?: typeof defaultExeca;
  /** Plugin root override — test seam for loadRolePermissions. */
  pluginRootOverride?: string;
  /**
   * Test seam for the plugin version string. Uses `getPluginVersion()` when absent.
   * Named with `Override` suffix per project conventions (cf. `pluginRootOverride`).
   */
  pluginVersionOverride?: string;
  /**
   * When provided, use this body verbatim as the PR review summary instead of
   * composing from `composeSummaryBody`. All other behaviour (locked-marker grep,
   * edit-in-place idempotency) is unchanged. Used by `recordAgentInvoke` in the
   * 8-min reviewer hard-cap substitution path (AC3). Story 4.12 Task 4.
   */
  verdictBodyOverride?: string;
  /**
   * When provided, the emitted `reviewer.verdict` telemetry event carries this value
   * as its `verdict` field and `timed_out: true`. When absent, the verdict comes from
   * `resultFile.recommendedVerdict` and `timed_out: false`.
   * Only `"reviewer-failure"` is valid in v1. Story 4.12 Task 4.
   */
  reviewerVerdictOverride?: "reviewer-failure";
}

interface InlineComment {
  path: string;
  line: number;
  body: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Escape special regex characters in a string so it can be used as a literal
 * match in a `new RegExp(...)` constructor.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Manifest stamp helper (Story 4.9b Task 9 — AC3 unpacked 3g)
// ---------------------------------------------------------------------------

/**
 * Stamp `risk_tier` and `risk_tier_evidence` onto the in-progress manifest
 * after a successful POST/PATCH. Best-effort: stamp failures MUST NOT roll
 * back a comment that is already on GitHub. On failure, logs and returns.
 *
 * @param targetRepoRoot - Absolute path to the target repository root.
 * @param ref - Story reference (used to locate the manifest file).
 * @param riskTier - The risk-tier block from the result file. No-op when undefined.
 */
async function stampRiskTierOnManifest(
  targetRepoRoot: string,
  ref: string,
  riskTier: RiskTierBlock | undefined,
): Promise<void> {
  if (riskTier === undefined) {
    return; // Backward compat — no block to stamp (3h)
  }

  // The in-progress manifest lives at .flow/state/in-progress/<ref>.yaml.
  // Refs may contain colons (e.g. "native:01HZ...") — use the full ref as
  // the filename, matching the convention from claimStory.
  const manifestPath = path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "in-progress",
    `${ref}.yaml`,
  );

  try {
    const manifest = await readManifest(manifestPath);
    const updated = {
      ...manifest,
      risk_tier: riskTier.tier,
      risk_tier_evidence: {
        matched_rule: riskTier.matched_rule,
        paths: riskTier.evidence.paths,
        change_types: riskTier.evidence.change_types,
        diff_size: riskTier.evidence.diff_size,
      },
    };
    await writeManifest(manifestPath, updated);
  } catch {
    // Stamp failure must not roll back the verdict comment (AC3g).
    // The next reviewer run (PATCH path) will re-stamp.
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Post the reviewer's verdict as a PR review with inline comments and a
 * summary body. Reads `reviewer-result.json` and composes everything
 * deterministically — no LLM step in the composition path.
 *
 * On rerun: GETs existing reviews, searches for a prior verdict footer marker,
 * and PATCH-edits the prior review body in place instead of posting a duplicate.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.sessionUlid - ULID of the calling reviewer session.
 * @param opts.role - Role name for gh permission lookup (default: "generalist-reviewer").
 * @param opts.execaImpl - Test seam for execa.
 * @param opts.pluginRootOverride - Test seam for plugin root path.
 * @param opts.pluginVersionOverride - Test seam for plugin version string.
 */
export async function postReviewerComments(
  opts: PostReviewerCommentsOptions,
): Promise<PostReviewerCommentsResult> {
  const role = opts.role ?? "generalist-reviewer";
  const pluginRoot = opts.pluginRootOverride ?? getPluginRoot();
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const pluginVersion = opts.pluginVersionOverride ?? getPluginVersion();

  // Step 1: Read the persisted reviewer-result.json file (Story 8.15: per-ref path).
  const resultFile = await readReviewerResultFile(opts.targetRepoRoot, opts.sessionUlid, opts.ref);

  if (resultFile === null) {
    // File absent — skip silently. processReviewerTranscript surfaces the loud blocker.
    return { next: "skipped-no-session-result", postedReviewId: null };
  }

  const permissions = await loadRolePermissions({ role, pluginRoot });

  // Step 2: Fetch the PR diff (re-read — not persisted per Story 4.6 §3g).
  const diffResult = await gh({
    role,
    permissions,
    subcommand: "pr-diff",
    args: [String(resultFile.prNumber)],
    execaImpl,
    pluginRootOverride: pluginRoot,
  });
  const diff = diffResult.stdout;

  // Step 3: Resolve {owner} and {repo} via `gh repo view --json owner,name`.
  const repoViewResult = await gh({
    role,
    permissions,
    subcommand: "repo-view",
    args: ["--json", "owner,name"],
    execaImpl,
    pluginRootOverride: pluginRoot,
  });

  let owner: string;
  let repo: string;
  try {
    const repoViewJson = JSON.parse(repoViewResult.stdout) as {
      name?: string;
      owner?: { login?: string };
    };
    owner = repoViewJson.owner?.login ?? "";
    repo = repoViewJson.name ?? "";
    if (!owner || !repo) {
      throw new Error("missing owner or repo in repo-view shape");
    }
  } catch (cause) {
    throw new GhApiResponseShapeError({ subcommand: "repo-view", cause });
  }

  const reviewsApiUrl = `/repos/${owner}/${repo}/pulls/${resultFile.prNumber}/reviews`;

  // Step 4a: GET existing reviews and search for a prior verdict footer marker.
  const getReviewsResult = await gh({
    role,
    permissions,
    subcommand: "api",
    args: [reviewsApiUrl, "--method", "GET"],
    execaImpl,
    pluginRootOverride: pluginRoot,
  });

  let priorReviewId: number | null = null;
  try {
    const reviewsRaw = JSON.parse(getReviewsResult.stdout) as unknown;
    if (!Array.isArray(reviewsRaw)) {
      throw new Error(`expected array, got ${typeof reviewsRaw}`);
    }
    // Search for the first review whose body is a non-null string and matches the footer marker.
    // Reviews with body === null (Copilot, plain approvals) are skipped — not errors.
    const footerPattern = new RegExp(
      "<!-- crew:verdict:[^:]+:" + escapeRegex(resultFile.ref) + " -->",
    );
    for (const review of reviewsRaw as Array<{ id: unknown; body: unknown }>) {
      if (typeof review.body !== "string" || review.body === null) {
        continue; // skip null-bodied reviews
      }
      if (footerPattern.test(review.body)) {
        if (typeof review.id !== "number") {
          throw new Error(`review.id is not a number: ${JSON.stringify(review.id)}`);
        }
        priorReviewId = review.id;
        break;
      }
    }
  } catch (cause) {
    throw new GhApiResponseShapeError({ subcommand: "api", url: reviewsApiUrl, cause });
  }

  // Step 5: Generate inline comments for failing runnable-artifact-check ACs.
  const inlineComments: InlineComment[] = [];

  const acEntries = Object.entries(resultFile.acResults)
    .map(([key, ac]) => ({ index: Number(key), ac }))
    .sort((a, b) => a.index - b.index);

  for (const { index, ac } of acEntries) {
    if (ac.applicability === "runnable-artifact-check" && ac.status === "fail") {
      const hunkLine = findHunkLineForPath(diff, ac.artifactPath);
      if (hunkLine !== null) {
        inlineComments.push({
          path: ac.artifactPath,
          line: hunkLine,
          body:
            `**AC${index} FAIL** — ${ac.reason}\n\n` +
            `The AC declared \`artifact: ${ac.artifactPath}\` but the file does not exist on disk at the dev's branch HEAD. ` +
            `The dev claimed it was created; \`fs.access\` returned ENOENT.`,
        });
      }
    }
  }

  // Step 5.5: Validate standardsVersion before emitting telemetry (Story 4.12 Task 3.3).
  // Guard only when we'll actually emit a verdict event (i.e. not when the file is absent).
  // This is structurally impossible post-4.7 but pinned as a hard guard.
  if (!resultFile.standardsVersion) {
    throw new ReviewerResultMissingStandardsVersionError({ sessionUlid: opts.sessionUlid });
  }

  // Step 6: Compose the summary body with version block and footer marker.
  // When `verdictBodyOverride` is provided (AC3 substitution path), use it verbatim.
  const summaryBody =
    opts.verdictBodyOverride !== undefined
      ? opts.verdictBodyOverride
      : composeSummaryBody(resultFile, {
          standardsVersion: resultFile.standardsVersion,
          pluginVersion,
        });

  // Extract the verdict line (find the line matching the verdict sentinel pattern).
  const bodyLines = summaryBody.split("\n");
  const verdictLine =
    bodyLines.find((l) => l.startsWith("**Verdict:")) ?? "";

  // Helper: emit `reviewer.verdict` telemetry after POST/PATCH success.
  // Wrapped in try/catch per AC2 unpacked (2a): telemetry failures MUST NOT
  // roll back a comment that is already on GitHub.
  const emitVerdictTelemetry = async (): Promise<void> => {
    try {
      const timedOut = opts.reviewerVerdictOverride === "reviewer-failure";
      const verdict = timedOut
        ? ("reviewer-failure" as const)
        : (resultFile.recommendedVerdict as "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED");
      await logTelemetryEvent({
        targetRepoRoot: opts.targetRepoRoot,
        event: {
          type: "reviewer.verdict",
          session_id: opts.sessionUlid,
          agent: "generalist-reviewer",
          story_id: resultFile.ref || undefined,
          data: {
            pr_number: resultFile.prNumber,
            verdict,
            standards_version: resultFile.standardsVersion,
            plugin_version: pluginVersion,
            timed_out: timedOut,
          },
        },
      });
    } catch {
      // Telemetry-write failures must not roll back the verdict POST.
      // The comment is already on GitHub; the next reviewer run will produce a fresh event.
    }
  };

  // Step 7: PATCH existing review or POST a new one.
  if (priorReviewId !== null) {
    // PATCH path — edit prior verdict in place (no inline comments on PATCH).
    const patchUrl = `${reviewsApiUrl}/${priorReviewId}`;
    const patchPayloadJson = JSON.stringify({ body: summaryBody });

    const patchResult = await gh({
      role,
      permissions,
      subcommand: "api",
      args: [patchUrl, "--method", "PATCH", "--input", "-"],
      execaImpl,
      pluginRootOverride: pluginRoot,
      input: patchPayloadJson,
    });

    let patchedId: number;
    try {
      const parsed = JSON.parse(patchResult.stdout) as { id?: unknown };
      if (typeof parsed.id !== "number") {
        throw new Error(`response.id is not a number: ${JSON.stringify(parsed.id)}`);
      }
      patchedId = parsed.id;
    } catch (cause) {
      throw new GhApiResponseShapeError({ subcommand: "api", url: patchUrl, cause });
    }

    // Emit telemetry AFTER successful PATCH (Story 4.12 Task 3.1).
    await emitVerdictTelemetry();

    // Stamp risk_tier on the manifest after telemetry (Story 4.9b Task 9 — AC3g).
    await stampRiskTierOnManifest(opts.targetRepoRoot, resultFile.ref, resultFile.riskTier);

    return {
      next: "posted",
      postedReviewId: patchedId,
      inlineCommentCount: null, // PATCH does not update inline comments
      verdictLine,
      wasEdit: true,
      priorReviewId,
    };
  }

  // POST path — first run, no prior verdict found.
  const reviewPayload = {
    event: "COMMENT",
    body: summaryBody,
    comments: inlineComments,
  };

  const reviewPayloadJson = JSON.stringify(reviewPayload);

  const apiResult = await gh({
    role,
    permissions,
    subcommand: "api",
    args: [reviewsApiUrl, "--method", "POST", "--input", "-"],
    execaImpl,
    pluginRootOverride: pluginRoot,
    input: reviewPayloadJson,
  });

  let postedReviewId: number;
  try {
    const parsed = JSON.parse(apiResult.stdout) as { id?: unknown };
    if (typeof parsed.id !== "number") {
      throw new Error(`response.id is not a number: ${JSON.stringify(parsed.id)}`);
    }
    postedReviewId = parsed.id;
  } catch (cause) {
    throw new GhApiResponseShapeError({ subcommand: "api", url: reviewsApiUrl, cause });
  }

  // Emit telemetry AFTER successful POST (Story 4.12 Task 3.1).
  await emitVerdictTelemetry();

  // Stamp risk_tier on the manifest after telemetry (Story 4.9b Task 9 — AC3g).
  await stampRiskTierOnManifest(opts.targetRepoRoot, resultFile.ref, resultFile.riskTier);

  return {
    next: "posted",
    postedReviewId,
    inlineCommentCount: inlineComments.length,
    verdictLine,
    wasEdit: false,
    priorReviewId: null,
  };
}
