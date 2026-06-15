/**
 * `guardCleanRoot` tool — Epic 10 run fix-plan, Fix 2b (clean-root guard).
 *
 * The run isolates each dev's edits by cutting a per-story git worktree
 * (`isolation: 'worktree'`, Story 8.20). In a BACKGROUND job the repo's
 * `worktree.bgIsolation: "none"` setting can suppress that, pinning the dev's
 * edits to the SHARED root checkout instead of its own worktree (Epic 10 run
 * retro, Issue B). The leak recurred 0/5 across the 10.1→10.5 batch, so it is a
 * real failure mode of unconfirmed frequency — not yet worth a durable fix, but
 * worth a cheap, protective guard.
 *
 * This tool is that guard. The run calls it AFTER each story settles: it asks
 * `listDirtyPaths` whether the orchestrating root checkout carries any tracked
 * working-tree changes (operational `.flow/**` state is gitignored and dropped,
 * so only a genuine source leak shows), and if so it stashes exactly those paths
 * (non-destructively, recoverable via `git stash`) so the NEXT story's worktree is
 * still cut from a clean base. It turns a silent leak into a VISIBLE, SAFE one:
 * the caller logs a loud warning from the returned `dirty`/`paths`, and no work is
 * discarded.
 *
 * Pure orchestration over the two sanctioned git-spawn helpers in `lib/git.ts`
 * (`listDirtyPaths` + `stashWorkingTree`). Best-effort by construction — it never
 * throws on a degraded git state, so a guard call can never break the run.
 *
 * Idempotent: a second call after a successful stash finds the root clean and
 * returns `{ dirty: false }` (so the run's seam may safely retry a garbled relay).
 */

import * as path from "node:path";
import { z } from "zod";
import { listDirtyPaths, stashWorkingTree, restoreRootHead } from "../lib/git.js";

const GuardCleanRootInputSchema = z.object({
  targetRepoRoot: z.string().min(1),
  /** Optional story ref for a more legible stash message / log line. */
  ref: z.string().min(1).optional(),
  /** Base branch the root should sit on. Defaults to `main` (flow's trunk). */
  baseBranch: z.string().min(1).optional(),
});

export interface GuardCleanRootResult {
  /** True when the root checkout carried tracked working-tree changes. */
  dirty: boolean;
  /** True when those changes were stashed onto the stack (recoverable). */
  stashed: boolean;
  /** The dirty repo-relative paths (operational `.flow/**` already excluded). */
  paths: string[];
  /** The stash message used (present only when a stash was attempted). */
  stashMessage?: string;
  /**
   * True when the root checkout's HEAD had drifted off the base branch (detached
   * at a story commit or on a `story/*` branch — the bgIsolation leak) and was
   * restored. fix/run-isolation-coordination-honesty.
   */
  headMoved: boolean;
  /** Where HEAD was before the restore (e.g. `detached@abc1234` or a branch name). */
  restoredFrom?: string;
  /** The base branch HEAD was returned to (present only when headMoved). */
  restoredTo?: string;
  /** A note when HEAD drift was detected but deliberately left as-is, or a failure. */
  headNote?: string;
}

export async function guardCleanRoot(
  rawInput: unknown,
): Promise<GuardCleanRootResult> {
  const input = GuardCleanRootInputSchema.parse(rawInput);
  const cwd = path.resolve(input.targetRepoRoot);

  // Step 1: stash any leaked working-tree changes (the original guard behaviour).
  const paths = await listDirtyPaths({ cwd });
  let stashed = false;
  let stashMessage: string | undefined;
  if (paths.length > 0) {
    stashMessage = `flow-run clean-root guard${input.ref ? `: ${input.ref}` : ""}`;
    ({ stashed } = await stashWorkingTree({ cwd, paths, message: stashMessage }));
  }

  // Step 2: restore root HEAD if it drifted (detached / story-branch). Runs even
  // when the tree was clean — HEAD can move without dirtying the tree, which is
  // exactly the observed leak (root left DETACHED at a story commit, tree clean).
  // Ordered AFTER the stash so the working tree is clean and the checkout is safe.
  const head = await restoreRootHead({
    cwd,
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
  });

  return {
    dirty: paths.length > 0,
    stashed,
    paths,
    ...(stashMessage ? { stashMessage } : {}),
    headMoved: head.headMoved,
    ...(head.restoredFrom ? { restoredFrom: head.restoredFrom } : {}),
    ...(head.restoredTo ? { restoredTo: head.restoredTo } : {}),
    ...(head.note ? { headNote: head.note } : {}),
  };
}
