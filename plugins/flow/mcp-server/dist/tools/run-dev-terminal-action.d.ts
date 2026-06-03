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
import { execa as defaultExeca } from "execa";
export interface DevTerminalActionResult {
    ok: true;
    branch: string;
    commitSha: string;
    prUrl: string;
}
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
 * @param opts.execaImpl       Optional test seam (production callers omit this).
 */
export declare function runDevTerminalAction(opts: {
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
    execaImpl?: typeof defaultExeca;
}): Promise<DevTerminalActionResult>;
