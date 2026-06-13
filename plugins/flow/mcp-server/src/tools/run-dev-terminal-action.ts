/**
 * `runDevTerminalAction` MCP tool — Story 4.4.
 *
 * The dev subagent's terminal action: after completing implementation work,
 * the subagent calls this tool to (a) create a story branch, (b) commit in
 * conventional-commits format, (c) push to origin, and (d) open a PR via
 * `gh pr create` with a machine-readable body section (story link, ACs
 * checklist mirrored from the spec) followed by a free-form summary.
 *
 * @see _bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md § Behavioural contract
 *
 * Worktree isolation (Story 8.16, superseded by Story 8.20): by default the dev
 * edits, builds, commits, and opens the PR *inside its own git worktree*. The
 * drain workflow spawns the dev subagent with the runtime's per-agent
 * `isolation: 'worktree'` primitive, so the dev's working directory — the
 * `targetRepoRoot` it passes to this tool — *is* a worktree cut clean from the
 * base, distinct from the orchestrating session's checkout. Because that
 * worktree contains ONLY the dev's own work, this tool stages the worktree's own
 * dirty set (an explicit changed-paths stage — never `git add .`), so a
 * `.flow/state` artefact or any unexpected file is never swept into the story
 * commit. The orchestrating checkout is never the dev's editing surface and is
 * never touched, so two devs against the same repo cannot cross-contaminate.
 *
 * Story 8.20 removed 8.16's transplant machinery: the dev no longer edits in the
 * shared checkout, so there is no snapshot-dirty-paths baseline to subtract and
 * no current-minus-baseline transplant — the worktree IS the editing surface.
 *
 * Pass `worktree: false` to commit in `targetRepoRoot` directly with `git add .`
 * (the legacy Story 4.4 path, retained for that story's tests).
 *
 * Invariants (the validation invariants are enforced BEFORE any subprocess spawn):
 * - `type` MUST be in the conventional-commits set.
 * - Branch slug MUST be renderable from `ref` + `title`.
 * - Steps execute in strict order: validateType → branchSlug → readManifest →
 *   extractAcs → listDirtyPaths (worktree mode) → createBranch → commit →
 *   fullBuildGate → push → composePrBody → gh pr create.
 * - The full-build gate (Story 8.17) runs the project's full build — the same
 *   whole-project type-check CI runs (`pnpm build` at `plugins/flow`) — in the
 *   dev's working directory AFTER the commit and BEFORE `gh pr create`, so a red
 *   build raises `PrePrBuildFailedError` and NO PR is opened. This is a
 *   deterministic tool-layer seam: the dev agent cannot skip the build under load
 *   the way a prose mandate could (the #211 failure class).
 * - The commit stages an EXPLICIT path set (the dev's own changes), never an
 *   indiscriminate `git add .`.
 * - No flags are passed to push or gh pr create beyond the closed v1 signatures.
 * - The manifest is read-only.
 * - No telemetry emitted in v1.
 * - Returns `{ ok: true, branch, commitSha, prUrl }` on success; raises a
 *   typed error on failure.
 *
 * (Story 4.4 FR29 / Pattern §9 / NFR16; worktree isolation: Story 8.16)
 */

import * as path from "node:path";
import {
  ConventionalCommitTypeUnknownError,
  GhPrCreateFailedError,
  PrePrBuildFailedError,
  PrePrLeakDetectedError,
  PrePrStagedArtifactLeakError,
  PrePrTestFailedError,
} from "../errors.js";
import { emitFriction } from "../lib/emit-friction.js";
import { extractAcsFromSpec } from "../lib/extract-acs-from-spec.js";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { gh } from "../lib/gh.js";
import {
  checkSharedRootLeak,
  checkStagedArtifactLeakGate,
  gitCommit,
  gitCreateBranch,
  gitFetch,
  gitPush,
  gitRebaseOnto,
  listDirtyPaths,
  resolveSessionLedgerRoot,
  CONVENTIONAL_COMMIT_TYPES,
} from "../lib/git.js";
import {
  buildBranchSlug,
  composeCommitSubject,
  composePrBody,
  wrapCommitBody,
} from "../lib/pr-body.js";
import { readManifest, writeManifest } from "../lib/manifest-io.js";
import { devOutcomeFilePath } from "../lib/read-dev-outcome-file.js";
import { loadRolePermissions } from "../state/load-role-permissions.js";
import { getPluginRoot } from "../lib/plugin-root.js";
import { runProjectBuild, runProjectTests, DEFAULT_BUILD_TEST_TIMEOUT_MS } from "../lib/run-project-build.js";
import { execa as defaultExeca } from "execa";

export interface DevTerminalActionResult {
  ok: true;
  branch: string;
  commitSha: string;
  prUrl: string;
}

const ROLE = "generalist-dev";

/**
 * Run the dev subagent's terminal action end-to-end.
 *
 * @param opts.targetRepoRoot  Absolute path to the target repo.
 * @param opts.ref             Story reference (e.g. `4-4-dev-subagent-...`).
 * @param opts.title           Story title (human-readable).
 * @param opts.type            Conventional-commits type (`feat`, `fix`, etc.).
 * @param opts.body            Commit body (free-form; hard-wrapped at 72 here).
 * @param opts.summary         Free-form PR summary (appended after machine block).
 * @param opts.manifestPath    Absolute path to the in-progress manifest YAML.
 * @param opts.sessionUlid     ULID of the calling session (for context).
 * @param opts.base            PR base branch. Defaults to `main` — the repo's
 *                             default branch and flow's trunk (post 2026-05-31
 *                             move to trunk-based development on `main`). Callers
 *                             whose trunk is a differently-named default branch
 *                             must pass this explicitly (a follow-up will derive
 *                             it from the repo's default branch / adapter config).
 * @param opts.worktree        Worktree-aware staging (Story 8.16 / 8.20).
 *                             Defaults to ON: `targetRepoRoot` is treated as the
 *                             dev's own worktree (the runtime rooted the dev
 *                             there via per-agent `isolation: 'worktree'`), so
 *                             the commit stages the worktree's own dirty set — an
 *                             explicit changed-paths stage, never `git add .` —
 *                             and `.flow/state/**` is never swept in. Pass
 *                             `false` to commit in `targetRepoRoot` with
 *                             `git add .` (legacy Story 4.4 path; used by that
 *                             story's integration tests).
 * @param opts.buildTestTimeoutMs
 *                             Per-run time budget (milliseconds) for the
 *                             build/test gates. Defaults to
 *                             `DEFAULT_BUILD_TEST_TIMEOUT_MS` (20 min). A run
 *                             that exceeds this budget is terminated and reported
 *                             as a build failure with a clear timed-out reason.
 *                             Set to `0` to disable the budget (not recommended).
 *                             (Story native:01KTN5E6T75XKDX8A0SGBVPRYS)
 * @param opts.execaImpl       Optional test seam (production callers omit this).
 */
export async function runDevTerminalAction(opts: {
  targetRepoRoot: string;
  ref: string;
  title: string;
  type: string;
  body: string;
  summary: string;
  manifestPath: string;
  sessionUlid: string;
  base?: string;
  worktree?: boolean;
  /** Per-run time budget for build/test gates. Defaults to `DEFAULT_BUILD_TEST_TIMEOUT_MS`. */
  buildTestTimeoutMs?: number;
  execaImpl?: typeof defaultExeca;
}): Promise<DevTerminalActionResult> {
  const {
    targetRepoRoot,
    ref,
    title,
    type,
    body,
    summary,
    manifestPath,
    sessionUlid,
  } = opts;
  const base = opts.base ?? "main";
  const useWorktree = opts.worktree !== false;
  const buildTestTimeoutMs = opts.buildTestTimeoutMs ?? DEFAULT_BUILD_TEST_TIMEOUT_MS;
  const execaImpl = opts.execaImpl;

  // (i) Validate conventional-commits type BEFORE any subprocess spawn.
  if (!(CONVENTIONAL_COMMIT_TYPES as readonly string[]).includes(type)) {
    throw new ConventionalCommitTypeUnknownError({
      attempted_type: type,
      allowed_types: CONVENTIONAL_COMMIT_TYPES,
    });
  }

  // (i) Compose branch slug (raises BranchSlugUnrenderableError if un-renderable).
  const branch = buildBranchSlug({ ref, title });

  // (ii) Read manifest to derive spec path. Done BEFORE any worktree/branch work
  // so a malformed manifest fails fast with the orchestrating tree untouched.
  const manifest = await readManifest(manifestPath);
  // source_path is either repo-relative or absolute; resolve against targetRepoRoot.
  const specPath = path.isAbsolute(manifest.source_path)
    ? manifest.source_path
    : path.join(targetRepoRoot, manifest.source_path);

  // (iii) Extract ACs from the spec file.
  const acs = await extractAcsFromSpec(specPath);

  // (iv) Resolve the dev's git surface and the stage set (Story 8.16 / 8.20).
  // In worktree mode `targetRepoRoot` IS the dev's own worktree — the runtime
  // rooted the dev there via per-agent `isolation: 'worktree'`, so the dev
  // edited and built in it and it is distinct from the orchestrating checkout.
  // The worktree was cut clean from `base`, so its dirty set is EXACTLY the
  // dev's own work; we stage that explicit set (never `git add .`) and drop any
  // `.flow/state/**` artefact. In legacy mode (`worktree: false`) we commit
  // `targetRepoRoot` with `git add .` (Story 4.4 behaviour).
  //
  // There is no second worktree to create or tear down here: the editing surface
  // IS the worktree the runtime handed the dev, so the 8.16 transplant /
  // orchestrating-checkout-restore machinery is gone. A failed flow therefore
  // cannot revert a sibling flow's in-flight work (8.20 AC4).
  const gitRoot = targetRepoRoot;
  let committedPaths: readonly string[] = ["."];

  if (useWorktree) {
    const dirty = await listDirtyPaths({
      cwd: gitRoot,
      ...(execaImpl ? { execaImpl } : {}),
    });
    // An empty dirty set means the dev handed off with no changes — itself a
    // defect. We do NOT fall back to `["."]` (that would re-introduce the
    // git-add-everything hazard); the empty-commit guard in gitCommit surfaces it.
    committedPaths = dirty;

    // (iv-b) Staged-artifact leak gate (Story native:01KTN94QY1AQN98P0PG7GDRKXD).
    // Before committing, reject any staged path that is a symlink (node_modules
    // symlinks bypass the `node_modules/` gitignore directory rule), any path
    // under node_modules, or any build/dependency artefact carrying a
    // machine-specific absolute path. Fail LOUD with a plain-language reason so
    // no PR is ever opened with dependency-folder shortcuts or machine paths.
    const artifactGateResult = await checkStagedArtifactLeakGate({
      targetRepoRoot: gitRoot,
      stagedPaths: committedPaths,
    });
    if (!artifactGateResult.ok) {
      await emitFriction({
        targetRepoRoot,
        kind: "forced-fallback",
        role: ROLE,
        session_id: sessionUlid,
        story_id: ref,
        expected: "staged paths contain only ordinary source and test files (no symlinks, no node_modules, no machine-specific absolute paths in build artefacts)",
        observed: `pre-PR staged-artifact gate blocked: ${artifactGateResult.reason}`,
      });
      throw new PrePrStagedArtifactLeakError({
        offendingPath: artifactGateResult.offendingPath,
        reason: artifactGateResult.reason,
      });
    }
  }

  {
    // (v) Create the story branch inside the (worktree or main) repo root.
    await gitCreateBranch({
      targetRepoRoot: gitRoot,
      branchName: branch,
      ...(execaImpl ? { execaImpl } : {}),
    });

    // (vi) Compose commit subject and wrap body.
    const subject = composeCommitSubject({ type, ref, title });
    const wrappedBody = wrapCommitBody(body);

    // (vii) Commit — explicit path set, never an indiscriminate `git add .`.
    const commitResult = await gitCommit({
      targetRepoRoot: gitRoot,
      paths: committedPaths,
      message: subject,
      role: ROLE,
      messageShape: "conventional",
      body: wrappedBody || undefined,
      ...(execaImpl ? { execaImpl } : {}),
    });

    // (vii-b) Pre-PR sync gate (Story native:01KT40THFTS10F9PT37KCW9PF4). Fetch
    // origin and rebase the freshly-created story branch onto the latest
    // `origin/main` BEFORE the build/test gates and BEFORE the push. Rationale:
    // under a concurrent drain two stories cut their branches from the same base;
    // if one merges first and both touched a shared file, the second story's PR
    // would open with a merge conflict and fail to merge cleanly (the PR #264
    // registry-collision scar). Rebasing here opens the PR already-integrated and
    // conflict-free. Placing it BEFORE the build/test gates means those gates
    // validate the rebase-integrated tree — the exact state that will land on
    // main. It is structurally the same shape as the build gate (Story 8.17) and
    // the test gate (native:01KT3ER5E9ACCERHAEJ5NM94TH): on a GENUINE conflict
    // gitRebaseOnto aborts the rebase (working tree left clean) and throws
    // RebaseConflictError BEFORE the push, so NO branch reaches origin and NO PR
    // is opened — the story routes to blocked/paused with a readable reason. The
    // rebase is safe without a force-push precisely because the branch has not
    // been pushed yet (created just above, pushed once below): rebase-then-push
    // is a normal fast-forward from origin's view.
    await gitFetch({
      targetRepoRoot: gitRoot,
      role: ROLE,
      ...(execaImpl ? { execaImpl } : {}),
    });
    try {
      await gitRebaseOnto({
        targetRepoRoot: gitRoot,
        role: ROLE,
        onto: `origin/${base}`,
        ...(execaImpl ? { execaImpl } : {}),
      });
    } catch (rebaseErr) {
      // Emit forced-fallback friction before re-raising the rebase conflict.
      // Fail-soft: the original error propagates unchanged whether or not
      // the telemetry write succeeds.
      await emitFriction({
        targetRepoRoot,
        kind: "forced-fallback",
        role: ROLE,
        session_id: sessionUlid,
        story_id: ref,
        expected: `clean rebase onto origin/${base} (no conflicts)`,
        observed: `rebase conflict aborted — story branch cannot be rebased onto origin/${base} cleanly`,
      });
      throw rebaseErr;
    }

    // (viii) Full-build gate (Story 8.17). Run the project's full build — the
    // same whole-project type-check CI runs (`pnpm build` at `plugins/flow`) — in
    // the dev's working directory (`gitRoot`: the worktree when isolation is on,
    // else `targetRepoRoot`). This is the deterministic tool-layer seam that
    // replaces the prose-only "run the build green first" mandate: a red build
    // raises PrePrBuildFailedError carrying the exit code + captured output, so NO
    // PR is opened (the #211 failure class — a story broke an untouched sibling
    // file and a red PR was opened). It runs AFTER the commit and BEFORE the push
    // / PR-create, so a failing build never even reaches origin.
    const buildResult = await runProjectBuild({
      devWorkingDir: gitRoot,
      timeoutMs: buildTestTimeoutMs,
      ...(execaImpl ? { execaImpl } : {}),
    });
    if (buildResult.exitCode !== 0) {
      // Emit forced-fallback friction before re-raising the build failure.
      // Fail-soft: the original error propagates unchanged whether or not
      // the telemetry write succeeds.
      const buildObserved = buildResult.timedOut
        ? `pre-PR build gate timed out after ${Math.round(buildResult.timeoutMs / 1000)}s (budget exceeded)`
        : `pre-PR build gate failed (exit ${buildResult.exitCode})`;
      await emitFriction({
        targetRepoRoot,
        kind: "forced-fallback",
        role: ROLE,
        session_id: sessionUlid,
        story_id: ref,
        expected: "pnpm build exits 0 (no type errors)",
        observed: buildObserved,
      });
      throw new PrePrBuildFailedError({
        exitCode: buildResult.exitCode,
        buildCommand: buildResult.commandLine,
        buildCwd: buildResult.cwd,
        stdout: buildResult.stdout,
        stderr: buildResult.stderr,
        timedOut: buildResult.timedOut,
        timeoutMs: buildResult.timeoutMs,
      });
    }

    // (viii-b) Full-test gate (Story native:01KT3ER5E9ACCERHAEJ5NM94TH). Run the
    // project's full test suite — the same whole-project vitest CI runs — in the
    // dev's working directory AFTER the build and BEFORE `gh pr create`. This is
    // the deterministic seam that catches test regressions in files the story did
    // not touch (the class of failure PR #211 exposed). A failing test suite raises
    // PrePrTestFailedError and NO PR is opened.
    const testResult = await runProjectTests({
      devWorkingDir: gitRoot,
      timeoutMs: buildTestTimeoutMs,
      ...(execaImpl ? { execaImpl } : {}),
    });
    if (testResult.exitCode !== 0) {
      // Emit forced-fallback friction before re-raising the test failure.
      // Fail-soft: the original error propagates unchanged whether or not
      // the telemetry write succeeds.
      const testObserved = testResult.timedOut
        ? `pre-PR test gate timed out after ${Math.round(testResult.timeoutMs / 1000)}s (budget exceeded)`
        : `pre-PR test gate failed (exit ${testResult.exitCode})`;
      await emitFriction({
        targetRepoRoot,
        kind: "forced-fallback",
        role: ROLE,
        session_id: sessionUlid,
        story_id: ref,
        expected: "pnpm test exits 0 (no failing tests)",
        observed: testObserved,
      });
      throw new PrePrTestFailedError({
        exitCode: testResult.exitCode,
        testCommand: testResult.commandLine,
        testCwd: testResult.cwd,
        stdout: testResult.stdout,
        stderr: testResult.stderr,
        timedOut: testResult.timedOut,
        timeoutMs: testResult.timeoutMs,
      });
    }

    // (viii-c) Pre-PR leak gate (Story native:01KT47430Q4C73K5E3ZECBSE5R). In
    // worktree-isolated mode the dev's editing surface is its own worktree
    // (`gitRoot`). A builder that writes to an ABSOLUTE shared-copy path escapes
    // the worktree boundary and dirties the orchestrating root checkout instead;
    // relative paths stay inside the worktree (probe-proven 2026-06-02). This gate
    // runs AFTER the build/test gates and BEFORE the push: if the shared master copy
    // is dirty, the story stops here with a readable reason and NO PR is ever opened.
    // Structurally the same pre-PR throw as PrePrBuildFailedError (L267) /
    // PrePrTestFailedError (L287): because the throw is before push + pr-create,
    // neither the branch nor a PR ever reaches origin on a leaking story.
    // Non-worktree mode (worktree:false) returns leaked:false immediately (the dev
    // IS the shared root — no separate root to check).
    if (useWorktree) {
      const leakResult = await checkSharedRootLeak({
        worktreeCwd: gitRoot,
        committedPaths,
        ...(execaImpl ? { execaImpl } : {}),
      });
      if (leakResult.leaked) {
        // Emit forced-fallback friction before re-raising the leak detection.
        // Fail-soft: the original error propagates unchanged whether or not
        // the telemetry write succeeds.
        await emitFriction({
          targetRepoRoot,
          kind: "forced-fallback",
          role: ROLE,
          session_id: sessionUlid,
          story_id: ref,
          expected: "dev edits isolated to worktree (shared root checkout clean)",
          observed: `pre-PR leak gate detected ${leakResult.paths.length} path(s) escaped to shared root: ${leakResult.paths.slice(0, 3).join(", ")}`,
        });
        throw new PrePrLeakDetectedError({
          leakedPaths: leakResult.paths,
          sharedRootPath: leakResult.sharedRootPath,
        });
      }
    }

    // (ix) Push.
    await gitPush({
      targetRepoRoot: gitRoot,
      branchName: branch,
      role: ROLE,
      ...(execaImpl ? { execaImpl } : {}),
    });

    // (x) Compose PR body.
    // specPath for the PR body should be repo-relative if possible.
    const specPathForPr = path.isAbsolute(manifest.source_path)
      ? path.relative(targetRepoRoot, manifest.source_path)
      : manifest.source_path;

    // Merge per-AC covering checks from the manifest's acceptance_criteria
    // (which carry the structured `verification.target` field) into the AcEntry
    // array from extractAcsFromSpec. The manifest and spec are always in sync
    // for in-progress stories, so the merge is by numeric index (AC1, AC2…).
    const manifestAcsByIndex = new Map(
      (manifest.acceptance_criteria ?? []).map((ac, i) => [i + 1, ac]),
    );
    const acsWithCoveringCheck = acs.map((ac) => {
      const manifestAc = manifestAcsByIndex.get(ac.index);
      return {
        ...ac,
        coveringCheck: manifestAc?.verification?.target,
      };
    });

    const prBody = composePrBody({
      ref,
      specPath: specPathForPr,
      acs: acsWithCoveringCheck,
      summary,
      title: manifest.title,
      narrative: manifest.narrative,
      riskTier: manifest.risk_tier,
    });

    // (xi) gh pr create — cwd pinned to gitRoot so `gh` resolves the intended
    // repo when the dev operates in a worktree (the worktree shares the same
    // .git object store and `origin` remote as targetRepoRoot).
    const pluginRoot = getPluginRoot();
    const permissions = await loadRolePermissions({ role: ROLE, pluginRoot });

    const ghResult = await gh({
      role: ROLE,
      permissions,
      subcommand: "pr-create",
      args: ["--title", subject, "--body", prBody, "--base", base],
      cwd: gitRoot,
      ...(execaImpl ? { execaImpl } : {}),
    });

    if (ghResult.exitCode !== 0) {
      throw new GhPrCreateFailedError({
        stderr: ghResult.stderr,
        diagnostic: `gh pr create exited with code ${ghResult.exitCode}`,
      });
    }

    const prUrl = ghResult.stdout.trim();
    if (!prUrl || !prUrl.startsWith("https://github.com/")) {
      throw new GhPrCreateFailedError({
        stderr: ghResult.stderr,
        diagnostic: "stdout did not contain a PR URL",
      });
    }

    // (xii) Extract prNumber from the PR URL.
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    if (!prNumberMatch) {
      throw new GhPrCreateFailedError({
        stderr: ghResult.stderr,
        diagnostic: "PR URL stdout contained no /pull/<n> segment",
      });
    }
    const prNumber = parseInt(prNumberMatch[1]!, 10);

    // (xiii) Atomically write dev-outcome.json to the per-ref session directory
    // under the ORCHESTRATING CHECKOUT — not the worktree. processDevTranscript
    // reads `<orchestrating-checkout>/.flow/state/sessions/<sessionUlid>/<ref>/dev-outcome.json`,
    // but in worktree mode the dev's cwd (`gitRoot`/`targetRepoRoot`) is the
    // worktree, whose separate (gitignored) `.flow/state` the orchestrating
    // session cannot see. resolveSessionLedgerRoot maps a worktree cwd back to
    // its orchestrating checkout via `git --git-common-dir`; from the
    // orchestrating checkout itself it is a no-op. This must happen BEFORE return
    // so the machine-authoritative PR number reaches processDevTranscript without
    // relying on LLM-authored text.
    const ledgerRoot = useWorktree
      ? await resolveSessionLedgerRoot({
          cwd: gitRoot,
          ...(execaImpl ? { execaImpl } : {}),
        })
      : targetRepoRoot;
    // Story native:01KT3YDHM10FPQ77N22BTJP9AF: namespace the PR-pointer record
    // per story ref. A drain run shares one sessionUlid across every story, so a
    // run-shared dev-outcome.json let a later/concurrent story clobber an
    // earlier one's PR record — crash-recovery then resumed an unbuilt story
    // against a sibling's PR. devOutcomeFilePath derives the same per-ref path
    // the readers use.
    const devOutcomePath = devOutcomeFilePath(ledgerRoot, sessionUlid, ref);
    await atomicWriteFile(
      devOutcomePath,
      JSON.stringify({ prUrl, prNumber, branch, commitSha: commitResult.commitSha }, null, 2),
    );

    // (xiv) Record the real PR identifier onto the in-progress manifest
    // (Story native:01KTNJ6QVZWVF407QEJPZSDTZK). The merge-readiness check
    // in dep-merge-check.ts reads pr_number from the done/ manifest to verify
    // merge status via `gh pr view <prNumber>` — a probe that is correct even
    // when the real branch name differs from the current-title-derived slug
    // (title change, /ship-story manual ship with a different branch convention,
    // etc.). Writing it here (to in-progress/) means it survives the
    // completeStory field-spread into done/ automatically.
    //
    // Best-effort: a failure to stamp the manifest must never block the PR that
    // has already been created, so we swallow errors here. The slug-based
    // fallback probe in dep-merge-check.ts covers the case where this write
    // did not happen (legacy path, crash between PR-create and manifest update).
    try {
      const inProgressManifestPath = path.join(
        ledgerRoot,
        ".flow",
        "state",
        "in-progress",
        `${ref}.yaml`,
      );
      const currentManifest = await readManifest(inProgressManifestPath);
      const updatedManifest = { ...currentManifest, pr_number: prNumber, pr_branch: branch };
      await writeManifest(inProgressManifestPath, updatedManifest);
    } catch {
      // Best-effort — PR already opened; do not block the return.
    }

    // (xv) Return success. The dev's worktree is owned by the runtime's
    // per-agent `isolation: 'worktree'` primitive (or, in tests, by the caller),
    // so this tool does NOT tear it down — a failed flow can therefore never
    // revert a concurrently-running sibling flow's in-flight work (8.20 AC4).
    return {
      ok: true,
      branch,
      commitSha: commitResult.commitSha,
      prUrl,
    };
  }
}
