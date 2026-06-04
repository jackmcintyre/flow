/**
 * Dependency-merge check — the build-blind fix.
 *
 * A story is moved to `done/` the moment its PR is *approved* (the reviewer
 * verdict `READY FOR MERGE` → `completeStory`), which happens BEFORE the
 * auto-merge gate runs and well before a medium/high-risk PR is actually
 * merged by a human. The dependency-readiness check in `listClaimableTodos`
 * historically only asked "is the dependency's manifest in `done/`?" — so a
 * dependent story became claimable as soon as its prerequisite was *approved*,
 * and its dev worktree was cut from `origin/main` (which does NOT yet contain
 * the unmerged prerequisite). The dependent was therefore built BLIND to the
 * very change it declared a dependency on.
 *
 * This helper closes that gap: a dependency only counts as satisfied once its
 * PR is genuinely **merged** into the trunk. "Merged" is read from GitHub —
 * the single source of truth that is correct for both auto-merged (low-risk)
 * and human-merged (medium/high-risk) PRs, and is independent of the merge
 * method (squash / rebase / merge-commit all report the PR as MERGED).
 *
 * The PR is located deterministically: the dev's branch name is a pure
 * function of `{ref, title}` via `buildBranchSlug`, and the dependency's
 * `done/` manifest carries both, so we reproduce the exact head branch and ask
 * `gh pr list --head <branch> --state merged`.
 *
 * **Fail-safe:** any failure to *prove* a dependency merged — an un-renderable
 * slug, a `gh` error (missing CLI, auth, network), or unparseable output —
 * returns `false`. The conservative direction is "not merged → do not claim",
 * because building a dependent blind is the exact failure this guards against.
 * A transient `gh` outage at worst stalls a chain (the operator notices a
 * dependent that will not claim); it never lets a blind build proceed.
 */
import { execa as defaultExeca } from "execa";
/**
 * True iff the dependency's PR is merged into the trunk on GitHub.
 *
 * Returns `false` (conservative) on any inability to prove the merge — see the
 * file-level fail-safe note.
 */
export declare function isDependencyPrMerged(opts: {
    /** Absolute path to the target repo root — `gh` resolves the repo from this cwd. */
    targetRepoRoot: string;
    /** The dependency's story ref (from its `done/` manifest). */
    ref: string;
    /** The dependency's title (from its `done/` manifest) — needed to reproduce the branch slug. */
    title: string;
    /** Test seam — production callers omit it and the real `execa` is used. */
    execaImpl?: typeof defaultExeca;
}): Promise<boolean>;
/**
 * Single-dependency merge probe: given a dependency ref already present in
 * `done/`, read its manifest (for the title needed to reproduce the branch
 * slug) and ask whether its PR is merged. Injectable via `isMerged` for tests.
 */
export type SingleDependencyMergedCheck = (opts: {
    targetRepoRoot: string;
    ref: string;
    title: string;
}) => Promise<boolean>;
/**
 * True iff EVERY dependency ref is merged into the trunk.
 *
 * Pre-condition (enforced by the caller, `claimNextStory`): each ref is already
 * known to be in `done/` (it passed the `depsReady` filter). This reads each
 * dep's `done/` manifest to recover the `title` required to reproduce its
 * branch slug, then defers the merge decision to `isMerged` (the real
 * GitHub-backed {@link isDependencyPrMerged} in production).
 *
 * **Fail-safe:** a missing/unreadable/malformed `done/` manifest, or any
 * dependency that is not proven merged, yields `false` — the conservative
 * "do not claim" direction. An empty `deps` list is trivially `true`.
 */
export declare function areDependenciesMerged(opts: {
    targetRepoRoot: string;
    deps: readonly string[];
    isMerged?: SingleDependencyMergedCheck;
}): Promise<boolean>;
