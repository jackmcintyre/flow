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
 * `.crew/state` artefact or any unexpected file is never swept into the story
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
 *   whole-project type-check CI runs (`pnpm build` at `plugins/crew`) — in the
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
import { ConventionalCommitTypeUnknownError, GhPrCreateFailedError, PrePrBuildFailedError, PrePrTestFailedError, } from "../errors.js";
import { extractAcsFromSpec } from "../lib/extract-acs-from-spec.js";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { gh } from "../lib/gh.js";
import { gitCommit, gitCreateBranch, gitPush, listDirtyPaths, resolveSessionLedgerRoot, CONVENTIONAL_COMMIT_TYPES, } from "../lib/git.js";
import { buildBranchSlug, composeCommitSubject, composePrBody, wrapCommitBody, } from "../lib/pr-body.js";
import { readManifest } from "../lib/manifest-io.js";
import { loadRolePermissions } from "../state/load-role-permissions.js";
import { getPluginRoot } from "../lib/plugin-root.js";
import { runProjectBuild, runProjectTests } from "../lib/run-project-build.js";
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
 *                             default branch and crew's trunk (post 2026-05-31
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
 *                             and `.crew/state/**` is never swept in. Pass
 *                             `false` to commit in `targetRepoRoot` with
 *                             `git add .` (legacy Story 4.4 path; used by that
 *                             story's integration tests).
 * @param opts.execaImpl       Optional test seam (production callers omit this).
 */
export async function runDevTerminalAction(opts) {
    const { targetRepoRoot, ref, title, type, body, summary, manifestPath, sessionUlid, } = opts;
    const base = opts.base ?? "main";
    const useWorktree = opts.worktree !== false;
    const execaImpl = opts.execaImpl;
    // (i) Validate conventional-commits type BEFORE any subprocess spawn.
    if (!CONVENTIONAL_COMMIT_TYPES.includes(type)) {
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
    // `.crew/state/**` artefact. In legacy mode (`worktree: false`) we commit
    // `targetRepoRoot` with `git add .` (Story 4.4 behaviour).
    //
    // There is no second worktree to create or tear down here: the editing surface
    // IS the worktree the runtime handed the dev, so the 8.16 transplant /
    // orchestrating-checkout-restore machinery is gone. A failed flow therefore
    // cannot revert a sibling flow's in-flight work (8.20 AC4).
    const gitRoot = targetRepoRoot;
    let committedPaths = ["."];
    if (useWorktree) {
        const dirty = await listDirtyPaths({
            cwd: gitRoot,
            ...(execaImpl ? { execaImpl } : {}),
        });
        // An empty dirty set means the dev handed off with no changes — itself a
        // defect. We do NOT fall back to `["."]` (that would re-introduce the
        // git-add-everything hazard); the empty-commit guard in gitCommit surfaces it.
        committedPaths = dirty;
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
        // (viii) Full-build gate (Story 8.17). Run the project's full build — the
        // same whole-project type-check CI runs (`pnpm build` at `plugins/crew`) — in
        // the dev's working directory (`gitRoot`: the worktree when isolation is on,
        // else `targetRepoRoot`). This is the deterministic tool-layer seam that
        // replaces the prose-only "run the build green first" mandate: a red build
        // raises PrePrBuildFailedError carrying the exit code + captured output, so NO
        // PR is opened (the #211 failure class — a story broke an untouched sibling
        // file and a red PR was opened). It runs AFTER the commit and BEFORE the push
        // / PR-create, so a failing build never even reaches origin.
        const buildResult = await runProjectBuild({
            devWorkingDir: gitRoot,
            ...(execaImpl ? { execaImpl } : {}),
        });
        if (buildResult.exitCode !== 0) {
            throw new PrePrBuildFailedError({
                exitCode: buildResult.exitCode,
                buildCommand: buildResult.commandLine,
                buildCwd: buildResult.cwd,
                stdout: buildResult.stdout,
                stderr: buildResult.stderr,
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
            ...(execaImpl ? { execaImpl } : {}),
        });
        if (testResult.exitCode !== 0) {
            throw new PrePrTestFailedError({
                exitCode: testResult.exitCode,
                testCommand: testResult.commandLine,
                testCwd: testResult.cwd,
                stdout: testResult.stdout,
                stderr: testResult.stderr,
            });
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
        const prBody = composePrBody({
            ref,
            specPath: specPathForPr,
            acs,
            summary,
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
        const prNumber = parseInt(prNumberMatch[1], 10);
        // (xiii) Atomically write dev-outcome.json to the session directory under the
        // ORCHESTRATING CHECKOUT — not the worktree. processDevTranscript reads
        // `<orchestrating-checkout>/.crew/state/sessions/<sessionUlid>/dev-outcome.json`,
        // but in worktree mode the dev's cwd (`gitRoot`/`targetRepoRoot`) is the
        // worktree, whose separate (gitignored) `.crew/state` the orchestrating
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
        const devOutcomePath = path.resolve(ledgerRoot, ".crew", "state", "sessions", sessionUlid, "dev-outcome.json");
        await atomicWriteFile(devOutcomePath, JSON.stringify({ prUrl, prNumber, branch, commitSha: commitResult.commitSha }, null, 2));
        // (xiv) Return success. The dev's worktree is owned by the runtime's
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
