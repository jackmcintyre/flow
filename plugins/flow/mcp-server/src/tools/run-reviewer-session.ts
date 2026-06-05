/**
 * `runReviewerSession` composite MCP tool — Story 4.6.
 *
 * Behavioural contract source:
 *   _bmad-output/implementation-artifacts/4-6-reviewer-subagent-read-sources-and-run-acs.md
 *
 * Performs the three mandatory reads (source story via active adapter, PR diff
 * via `gh pr diff`, standards doc via `lookupStandards`) in fixed sequential
 * order BEFORE returning any data to the persona prose. Then executes every AC
 * extracted from the source spec against the applicability classifier and returns
 * structured `acResults` keyed by AC index.
 *
 * **Revision 2 (deterministic-verdict-transport):** Before returning, this tool
 * derives `recommendedVerdict` deterministically from `acResults` per the
 * closed algorithm in spec §3f, then persists the result to
 * `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/reviewer-result.json`
 * via `atomicWriteFile`. The verdict transport is the file, not the reviewer's
 * chat output. `processReviewerTranscript` reads the file and switches on
 * `recommendedVerdict` — the reviewer's chat is informational only.
 *
 * Same pattern as Story 4.3c's `completeStory` call inside
 * `processReviewerTranscript`: load-bearing decisions live in the tool layer.
 *
 * The tool MUST NOT:
 *   - Spawn subagents (that is the SKILL.md prose layer's responsibility).
 *   - Mutate any manifest (only the sessions/reviewer-result.json file is written).
 *   - Swallow typed errors — all read/execution errors propagate uncaught.
 *
 * Telemetry wiring: `agent.invoke` is recorded by the dev session's SKILL.md caller
 * via `recordAgentInvoke` (Story 4.12); `reviewer.verdict` is emitted by
 * `postReviewerComments` on POST success (Story 4.12 Task 3).
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { accessSync } from "node:fs";
import { execa as defaultExeca } from "execa";
import { resolveWorkspace } from "../state/workspace-resolver.js";
import { lookupStandards } from "../state/lookup-standards.js";
import { loadRolePermissions } from "../state/load-role-permissions.js";
import { gh } from "../lib/gh.js";
import { extractAcsFromSpec } from "../lib/extract-acs-from-spec.js";
import { slugifyStandardsCriterion } from "../lib/slugify-standards-criterion.js";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { reviewerResultFilePath } from "../lib/read-reviewer-result-file.js";
import { DuplicateStandardsCriterionIdError } from "../errors.js";
import { getPluginRoot } from "../lib/plugin-root.js";
import { materialisePrBranchWorktree } from "../lib/materialise-pr-branch-worktree.js";
import { classifyRiskTier } from "./classify-risk-tier.js";
import { emitFriction } from "../lib/emit-friction.js";
import type { SourceStory } from "../adapters/adapter.js";
import type { Criterion, StandardsDoc } from "../schemas/standards-doc.js";
import type { RiskTierBlock } from "./classify-risk-tier.js";
import type { Lesson } from "../schemas/story-retro.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcResult =
  | {
      index: number;
      tag: string | null;
      applicability: "runnable-artifact-check";
      artifactPath: string;
      status: "pass" | "fail";
      reason: string;
    }
  | {
      index: number;
      tag: string | null;
      applicability: "runnable-vitest";
      testNameFilter: string;
      status: "pass" | "fail";
      reason: string;
      stdout: string;
      stderr: string;
      exitCode: number;
    }
  | {
      index: number;
      tag: string | null;
      applicability: "manual-check-required";
      reason: string;
    };

/** The three recognized verdict literals — deterministically derived by the tool. */
export type RecommendedVerdict = "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED";

export interface ReviewerSessionResult {
  /** ULID of the calling session — carried on the result for the persisted file. */
  sessionUlid: string;
  /** Story ref (e.g. "native:01HZ...") — carried on the result for the persisted file. */
  ref: string;
  /** PR number passed to runReviewerSession — carried for the persisted file. */
  prNumber: number;
  sourceStory: SourceStory;
  /** Convenience copy of sourceStory.ref for the persisted file. */
  sourceStoryRef: string;
  prDiff: string;
  standards: StandardsDoc;
  standardsByCriterionId: Record<string, Criterion>;
  acResults: Record<number, AcResult>;
  /**
   * Deterministically derived from `acResults` per spec §3f:
   *  1. any-fail → "NEEDS CHANGES"
   *  2. empty OR any-manual-check-required → "BLOCKED"
   *  3. else → "READY FOR MERGE"
   *
   * The LLM does not decide this value — the tool does.
   * This field is persisted to `reviewer-result.json` and read by
   * `processReviewerTranscript` as the authoritative verdict transport.
   */
  recommendedVerdict: RecommendedVerdict;
}

/**
 * The persisted-file projection shape written to
 * `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/reviewer-result.json`.
 *
 * Heavy in-memory fields (`sourceStory`, `prDiff`) are NOT persisted —
 * only the verdict-relevant data needed by `processReviewerTranscript`.
 */
export interface ReviewerResultFileShape {
  sessionUlid: string;
  ref: string;
  recommendedVerdict: RecommendedVerdict;
  acResults: Record<number, AcResult>;
  standardsByCriterionId: Record<string, Criterion>;
  sourceStoryRef: string;
  prNumber: number;
  /** Semver version of the standards doc used to produce this verdict (Story 4.7). */
  standardsVersion: string;
  /**
   * Risk-tier classification result (Story 4.9b — FR40a, Pattern §11).
   * Optional for backward compatibility with pre-4.9b session result files.
   * Written by `runReviewerSession` after the AC-walk. Read by `postReviewerComments`
   * to render the evidence block and stamp the manifest.
   */
  riskTier?: RiskTierBlock;
  /**
   * One reusable retro lesson the reviewer surfaced during review
   * (Story native:01KT6GSV8KTTKKHPRGEJWJAGZV — learning-loop producer).
   *
   * Clean additive optional field. `runReviewerSession` NEVER writes it — it is
   * merged in afterwards, only by `recordReviewerLesson`, which the reviewer
   * calls at most once when (and only when) the review taught a reusable lesson.
   * The drain then forwards this lesson onto the done manifest via
   * `recordStoryRetro` before the merge gate runs. Typed from `LessonSchema`'s
   * inferred type (the existing shape — no new lesson type is defined here).
   */
  lesson?: Lesson;
}

export interface RunReviewerSessionOptions {
  targetRepoRoot: string;
  sessionUlid: string;
  ref: string;
  prNumber: number;
  role?: string;
  /** Test seam — production callers do not pass this. */
  execaImpl?: typeof defaultExeca;
  /** Plugin root override — test seam for loadRolePermissions. */
  pluginRootOverride?: string;
}

// ---------------------------------------------------------------------------
// Applicability classifiers
// ---------------------------------------------------------------------------

const ARTIFACT_RE = /^artifact:\s*(\S+)$/m;
const VITEST_RE = /^vitest:\s*(.+)$/m;

function classifyAc(bodyLines: string[]): {
  applicability: "runnable-artifact-check" | "runnable-vitest" | "manual-check-required";
  artifactPath?: string;
  testNameFilter?: string;
  /** Story 5.27: raw path from the vitest: marker — same value as testNameFilter today,
   *  kept separate so a future refactor can split the filter from the file path. */
  testFilePath?: string;
} {
  const bodyText = bodyLines.join("\n");

  // artifact: wins over vitest: when both present (spec §2b)
  const artifactMatch = ARTIFACT_RE.exec(bodyText);
  if (artifactMatch) {
    return { applicability: "runnable-artifact-check", artifactPath: artifactMatch[1]! };
  }

  const vitestMatch = VITEST_RE.exec(bodyText);
  if (vitestMatch) {
    const captured = vitestMatch[1]!.trim();
    return {
      applicability: "runnable-vitest",
      testNameFilter: captured,
      testFilePath: captured,
    };
  }

  return { applicability: "manual-check-required" };
}

// ---------------------------------------------------------------------------
// AC runners
// ---------------------------------------------------------------------------

async function runArtifactCheck(
  index: number,
  tag: string | null,
  artifactPath: string,
  checkRoot: string,
): Promise<AcResult> {
  const resolved = path.resolve(checkRoot, artifactPath);
  try {
    await fs.access(resolved);
    return {
      index,
      tag,
      applicability: "runnable-artifact-check",
      artifactPath,
      status: "pass",
      reason: `artifact present at ${resolved}`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        index,
        tag,
        applicability: "runnable-artifact-check",
        artifactPath,
        status: "fail",
        reason: `artifact missing at ${resolved} (ENOENT)`,
      };
    }
    // Any other error (e.g. EACCES) propagates uncaught per spec §2c.
    throw err;
  }
}

const VITEST_TIMEOUT_MS = 90_000;
const STDOUT_STDERR_CAP = 4000;
const TRUNCATION_MARKER = "\n...[truncated]";

function capString(s: string): string {
  if (s.length <= STDOUT_STDERR_CAP) return s;
  return s.slice(0, STDOUT_STDERR_CAP) + TRUNCATION_MARKER;
}

/**
 * Walk up from `testFilePathAbs` to find the nearest enclosing `package.json`.
 *
 * Starts at `path.dirname(testFilePathAbs)` and walks toward the filesystem
 * root, stopping (inclusively) at `checkRoot`. Returns `{ ok: true, packageRoot }`
 * if found, `{ ok: false }` if the walk exhausts `checkRoot` without finding one.
 *
 * Guard: `d === checkRootAbs || d.startsWith(checkRootAbs + path.sep)` prevents
 * false-positive prefix matches on sibling paths (e.g. `/tmp/checker` when
 * checkRoot is `/tmp/check`). ESM — uses `accessSync` from "node:fs" (top-level
 * import), NOT `require(...)`.
 *
 * Story 5.27 — AC1, AC2.
 */
export function findPackageRoot(opts: {
  testFilePathAbs: string;
  checkRoot: string;
}): { ok: true; packageRoot: string } | { ok: false } {
  const checkRootAbs = path.resolve(opts.checkRoot);
  let dir = path.dirname(opts.testFilePathAbs);

  const isWithinCheckRoot = (d: string): boolean =>
    d === checkRootAbs || d.startsWith(checkRootAbs + path.sep);

  while (isWithinCheckRoot(dir)) {
    try {
      accessSync(path.join(dir, "package.json"));
      return { ok: true, packageRoot: dir };
    } catch {
      // package.json not present here — walk up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root reached
    dir = parent;
  }
  return { ok: false };
}

async function runVitestCheck(
  index: number,
  tag: string | null,
  testNameFilter: string,
  testFilePath: string,
  checkRoot: string,
  execaImpl: typeof defaultExeca,
): Promise<AcResult> {
  // Story 5.27: resolve the package root by walking up from the test file.
  const testFilePathAbs = path.resolve(checkRoot, testFilePath);
  const pkgRoot = findPackageRoot({ testFilePathAbs, checkRoot });

  if (!pkgRoot.ok) {
    return {
      index,
      tag,
      applicability: "runnable-vitest",
      testNameFilter,
      status: "fail",
      reason: `no package.json found between test file '${testFilePath}' and checkRoot '${checkRoot}' — vitest cannot run without a manifest`,
      stdout: "",
      stderr: "",
      exitCode: -1,
    };
  }

  const result = await execaImpl("pnpm", ["vitest", "--run", "-t", testNameFilter], {
    cwd: pkgRoot.packageRoot,
    reject: false,
    timeout: VITEST_TIMEOUT_MS,
  });

  const rawStdout = typeof result.stdout === "string" ? result.stdout : "";
  const rawStderr = typeof result.stderr === "string" ? result.stderr : "";
  const exitCode =
    typeof result.exitCode === "number"
      ? result.exitCode
      : result.timedOut
        ? -1
        : 1;

  if (result.timedOut) {
    return {
      index,
      tag,
      applicability: "runnable-vitest",
      testNameFilter,
      status: "fail",
      reason: `vitest filter '${testNameFilter}' timed out after 90s`,
      stdout: capString(rawStdout),
      stderr: capString(rawStderr),
      exitCode,
    };
  }

  const status = exitCode === 0 ? "pass" : "fail";
  const reason =
    exitCode === 0
      ? `vitest filter '${testNameFilter}' passed`
      : `vitest filter '${testNameFilter}' failed (exit ${exitCode})`;

  return {
    index,
    tag,
    applicability: "runnable-vitest",
    testNameFilter,
    status,
    reason,
    stdout: capString(rawStdout),
    stderr: capString(rawStderr),
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Composite reviewer-session tool.
 *
 * Performs the three reads in fixed sequential order (source story →
 * PR diff → standards doc), builds `standardsByCriterionId`, runs every
 * AC via the applicability classifier, and returns `ReviewerSessionResult`.
 *
 * All errors from reads propagate uncaught — the tool does not retry or
 * swallow. The SKILL.md prose surfaces the error and exits the inner cycle.
 */
/**
 * Derive `recommendedVerdict` deterministically from `acResults` per spec §3f.
 *
 * Algorithm (closed set — the tool decides, the LLM does not):
 *  1. If any acResult has `status === "fail"` → "NEEDS CHANGES"
 *  2. Else if `acResults` is empty OR any acResult has `applicability === "manual-check-required"` → "BLOCKED"
 *  3. Else → "READY FOR MERGE"
 */
function deriveRecommendedVerdict(acResults: Record<number, AcResult>): RecommendedVerdict {
  const values = Object.values(acResults);

  // Rule 1: any fail → NEEDS CHANGES
  if (values.some((r) => (r as { status?: string }).status === "fail")) {
    return "NEEDS CHANGES";
  }

  // Rule 2: empty OR any manual-check-required → BLOCKED
  if (values.length === 0 || values.some((r) => r.applicability === "manual-check-required")) {
    return "BLOCKED";
  }

  // Rule 3: all runnable and all pass → READY FOR MERGE
  return "READY FOR MERGE";
}

// ---------------------------------------------------------------------------
// Diff analysis helpers (Story 4.9b Task 7)
// ---------------------------------------------------------------------------

/**
 * Extract POSIX-style changed file paths from a unified diff string.
 * Looks for `+++ b/<path>` lines (new-file headers in unified diff format).
 * Paths are deduplicated and returned in appearance order.
 *
 * @internal
 */
function collectChangedPathsFromDiff(diff: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const p = line.slice(6).trim();
      if (p && !seen.has(p)) {
        seen.add(p);
        result.push(p);
      }
    }
  }
  return result;
}

/**
 * A path is "generated" — its line count reflects compiled/locked output, not
 * authored source, so it must not inflate the risk-tier diff-size measurement.
 * Covers committed build output under any `dist/` directory and the common
 * dependency lockfiles.
 *
 * @internal — exported for unit tests.
 */
export function isGeneratedDiffPath(p: string): boolean {
  if (/(^|\/)dist\//.test(p)) return true;
  const base = p.split("/").pop() ?? "";
  return base === "pnpm-lock.yaml" || base === "package-lock.json" || base === "yarn.lock";
}

/**
 * Count the lines added + removed in a unified diff (excludes +++ / --- file
 * headers), attributing each line to its file and SKIPPING generated files
 * (see `isGeneratedDiffPath`). flow commits compiled `dist/`, which would
 * otherwise ~double a source change's line count and defeat the risk-tier
 * diff-size cap — this measures authored-source risk, not build output.
 *
 * @internal — exported for unit tests.
 */
export function computeDiffSize(diff: string): number {
  let count = 0;
  let excluded = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // New file section. Derive the path from the `b/<path>` token (falls back
      // to `a/<path>` for deletions) and decide whether to skip its lines.
      const m = /\sb\/(.+)$/.exec(line) ?? /\sa\/(.+?)\s+b\//.exec(line);
      excluded = m ? isGeneratedDiffPath(m[1]!.trim()) : false;
      continue;
    }
    if (excluded) continue;
    if ((line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---"))) {
      count++;
    }
  }
  return count;
}

/**
 * True iff a unified diff is additive-only: every changed file is a brand-new
 * file addition. Modified, deleted, and renamed files are all non-additive.
 *
 * Each file section in `git diff` starts with `diff --git ...`; an added file
 * declares `new file mode ...`. A section without that marker is a modify
 * (or a delete/rename, which carry their own markers) — any such section makes
 * the whole diff non-additive. An empty/unparseable diff is conservatively
 * non-additive (returns `false`).
 *
 * Stage-2 part C — feeds the `additive_only` risk-tier signal.
 *
 * @internal
 */
function isAdditiveOnlyDiff(diff: string): boolean {
  const sections = diff.split(/^diff --git /m).slice(1);
  if (sections.length === 0) return false;
  return sections.every((section) => /^new file mode /m.test(section));
}

export async function runReviewerSession(
  opts: RunReviewerSessionOptions,
): Promise<ReviewerSessionResult> {
  const {
    targetRepoRoot,
    sessionUlid,
    ref,
    prNumber,
    role = "generalist-reviewer",
    pluginRootOverride,
  } = opts;
  const execaImpl = opts.execaImpl ?? defaultExeca;

  // -------------------------------------------------------------------------
  // Read 1: source story via active adapter (sequentially — per spec §1e)
  // -------------------------------------------------------------------------
  const workspace = await resolveWorkspace({ targetRepoRoot });
  const sourceStory = await workspace.activeAdapter.readSourceStory(ref);

  // -------------------------------------------------------------------------
  // Read 2: PR diff via gh wrapper
  // -------------------------------------------------------------------------
  const pluginRoot = pluginRootOverride ?? getPluginRoot();
  const permissions = await loadRolePermissions({ role, pluginRoot });
  const diffResult = await gh({
    role,
    permissions,
    subcommand: "pr-diff",
    args: [String(prNumber)],
    execaImpl,
    pluginRootOverride,
  });
  const prDiff = diffResult.stdout;

  // -------------------------------------------------------------------------
  // Read 3: standards doc
  // -------------------------------------------------------------------------
  const standards = await lookupStandards(targetRepoRoot);

  // -------------------------------------------------------------------------
  // Build standardsByCriterionId (spec §3a–3c)
  // -------------------------------------------------------------------------
  const standardsByCriterionId: Record<string, Criterion> = {};
  for (const criterion of standards.criteria) {
    const id = slugifyStandardsCriterion(criterion.name);
    if (id in standardsByCriterionId) {
      // Duplicate-id guard: collect both offending names and raise (spec §3c)
      const existingName = standardsByCriterionId[id]!.name;
      throw new DuplicateStandardsCriterionIdError({
        criterionId: id,
        names: [existingName, criterion.name],
      });
    }
    standardsByCriterionId[id] = criterion;
  }

  // -------------------------------------------------------------------------
  // AC execution (spec §2a–2h)
  //
  // Story 5.26: Before running any per-AC check, materialise the PR's head
  // ref into a temporary git worktree. All artifact and vitest checks run
  // against the worktree path (checkRoot), NOT targetRepoRoot. The worktree
  // is torn down unconditionally in the finally block (AC5).
  // -------------------------------------------------------------------------
  // The spec says to use sourceStory.specPath, but the SourceStory type has
  // raw_path which is the absolute path to the on-disk spec file.
  const specPath = sourceStory.raw_path;
  const acEntries = await extractAcsFromSpec(specPath);

  // Materialise the PR branch worktree (AC1). Throws ReviewerPrBranchFetchError
  // on any gh or git failure — do NOT catch here (AC4 requires propagation).
  const { worktreePath, cleanup } = await materialisePrBranchWorktree({
    targetRepoRoot,
    sessionUlid,
    prNumber,
    role,
    execaImpl,
    pluginRootOverride: pluginRoot,
    permissionsOverride: permissions,
  });

  // Execute serially in numeric-index order (spec §2f), wrapped in try/finally
  // so the worktree is always removed (AC5).
  // setupLog is available for diagnostics but not persisted here — the log
  // entries are internal to materialisePrBranchWorktree (stale-reap notices etc.).
  const acResults: Record<number, AcResult> = {};
  let riskTierBlock: RiskTierBlock | undefined;

  try {
    for (const ac of acEntries) {
      const classification = classifyAc(ac.body);

      if (classification.applicability === "runnable-artifact-check") {
        const artifactResult = await runArtifactCheck(
          ac.index,
          ac.tag,
          classification.artifactPath!,
          worktreePath,  // checkRoot — AC2
        );
        acResults[ac.index] = artifactResult;
        // Emit missing-cited-source friction when the artifact is absent (ENOENT).
        // Fail-soft: the verdict is unchanged whether or not telemetry succeeds.
        if (artifactResult.applicability === "runnable-artifact-check" && artifactResult.status === "fail" && artifactResult.reason.includes("ENOENT")) {
          await emitFriction({
            targetRepoRoot,
            kind: "missing-cited-source",
            role,
            session_id: sessionUlid,
            story_id: ref,
            expected: `artifact present at ${classification.artifactPath}`,
            observed: `artifact missing (ENOENT): ${classification.artifactPath}`,
          });
        }
      } else if (classification.applicability === "runnable-vitest") {
        acResults[ac.index] = await runVitestCheck(
          ac.index,
          ac.tag,
          classification.testNameFilter!,
          classification.testFilePath!,  // Story 5.27: explicit file path for cwd walk
          worktreePath,                   // checkRoot — AC2 (Story 5.26 worktree path)
          execaImpl,
        );
      } else {
        // manual-check-required (spec §2c)
        acResults[ac.index] = {
          index: ac.index,
          tag: ac.tag,
          applicability: "manual-check-required",
          reason: "AC body has no `artifact:` or `vitest:` marker — manual check required before merge",
        };
      }
    }

    // -----------------------------------------------------------------------
    // Risk-tier classification (Story 4.9b — FR40a, Pattern §11)
    //
    // Runs AFTER the AC-walk and BEFORE writing reviewer-result.json.
    // Still uses targetRepoRoot for spec lookups (planning-artifacts/ live on
    // dev, not on the PR branch). Wrapped in try/catch: a malformed spec or
    // missing default must not break the reviewer pass.
    // -----------------------------------------------------------------------
    try {
      // Collect changed paths from the diff (lines starting with "+++ b/" or "--- a/" are headers)
      const changedPaths = collectChangedPathsFromDiff(prDiff);

      // Collect commit messages via `gh pr view --json commits`
      const commitsResult = await gh({
        role,
        permissions,
        subcommand: "pr-view",
        args: [String(prNumber), "--json", "commits", "--jq", "[.commits[].messageHeadline]"],
        execaImpl,
        pluginRootOverride: pluginRoot,
      });
      let commitMessages: string[] = [];
      try {
        const parsed = JSON.parse(commitsResult.stdout) as unknown;
        if (Array.isArray(parsed)) {
          commitMessages = parsed.filter((m): m is string => typeof m === "string");
        }
      } catch {
        // Failed to parse commits — use empty array (classifier still runs)
      }

      // Compute diffSize: count lines starting with + or - (excluding +++ and --- headers)
      const diffSize = computeDiffSize(prDiff);

      const classificationResult = await classifyRiskTier({
        targetRepoRoot,
        pluginRoot,
        storyId: ref,
        changedPaths,
        commitMessages,
        diffSize,
        additiveOnly: isAdditiveOnlyDiff(prDiff),
      });

      // Attach to result file as riskTier block (drop story_id — file already has ref)
      const { story_id: _dropped, ...block } = classificationResult;
      riskTierBlock = block;
    } catch {
      // Malformed spec, missing default, or unexpected error — continue without classification.
      // postReviewerComments handles absent riskTier gracefully (no evidence block, no stamp).
    }
  } finally {
    // Unconditional cleanup per AC5. Cleanup failures are NOT fatal — they produce
    // warnings returned from cleanup() which are surfaced in the returned result's
    // chatLog (not persisted to disk here to stay within the fs-write guard). The
    // worktree lives under <sessionDir>/ which is operator-collectable garbage.
    await cleanup();
  }

  // -------------------------------------------------------------------------
  // Derive recommendedVerdict deterministically (spec §3f — revision 2)
  // -------------------------------------------------------------------------
  const recommendedVerdict = deriveRecommendedVerdict(acResults);

  // Emit empty-input friction when no AC markers were found (Rule-2 empty branch).
  // This is the known AC-marker-gap blind spot where the reviewer silently verifies
  // nothing. Fail-soft: the verdict is unchanged whether or not telemetry succeeds.
  if (Object.keys(acResults).length === 0) {
    await emitFriction({
      targetRepoRoot,
      kind: "empty-input",
      role,
      session_id: sessionUlid,
      story_id: ref,
      expected: "at least one AC marker (artifact: or vitest:) extracted from the story spec",
      observed: "no AC markers found — extractAcsFromSpec returned empty; reviewer verified nothing",
    });
  }

  // -------------------------------------------------------------------------
  // Persist reviewer-result.json (spec §3g — revision 2)
  //
  // Only the verdict-relevant projection is persisted — heavy fields
  // (sourceStory, prDiff) stay in-memory only.
  // The parent directory is created if absent.
  //
  // Story 8.15: the result is namespaced per story ref within the session dir
  // (`<sessionUlid>/<sanitised-ref>/reviewer-result.json`) so a multi-story
  // drain — which shares one session ULID across stories — cannot have a later
  // story overwrite an earlier story's verdict. The path is derived via the
  // shared `reviewerResultFilePath` helper, the same derivation every reader
  // uses, so writer and readers always agree.
  // -------------------------------------------------------------------------
  const resultFilePath = reviewerResultFilePath(targetRepoRoot, sessionUlid, ref);
  await fs.mkdir(path.dirname(resultFilePath), { recursive: true });
  const fileProjection: ReviewerResultFileShape = {
    sessionUlid,
    ref,
    recommendedVerdict,
    acResults,
    standardsByCriterionId,
    sourceStoryRef: sourceStory.ref,
    prNumber,
    standardsVersion: standards.version,
    ...(riskTierBlock !== undefined ? { riskTier: riskTierBlock } : {}),
  };
  await atomicWriteFile(resultFilePath, JSON.stringify(fileProjection, null, 2));

  return {
    sessionUlid,
    ref,
    prNumber,
    sourceStory,
    sourceStoryRef: sourceStory.ref,
    prDiff,
    standards,
    standardsByCriterionId,
    acResults,
    recommendedVerdict,
  };
}
