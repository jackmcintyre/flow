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
 * This tool is that guard. The run calls it AFTER each story settles: it classifies
 * the dirty set into two buckets:
 *
 *   1. **Operator config edits** — tracked changes (X or Y ≠ `?`) to paths under
 *      `team/**` or `docs/**`. These are deliberate: the operator is holding an
 *      uncommitted persona or standards fix while the run is going. The guard does
 *      NOT silently stash these. Instead it emits `configEdits` (the paths) and
 *      `hasConfigEdits: true` so the caller can surface a loud, distinct warning:
 *      "your working-tree config fix will not persist across stories".
 *
 *   2. **Worktree-isolation leakage** — everything else (untracked files `??`, or
 *      tracked changes to non-config paths). These are the bgIsolation leak and are
 *      still stashed non-destructively (recoverable via `git stash`) so the NEXT
 *      story's worktree is cut from a clean base.
 *
 * Pure orchestration over the sanctioned git-spawn helpers in `lib/git.ts`
 * (`listDirtyPathsWithStatus` + `stashWorkingTree`). Best-effort by construction —
 * it never throws on a degraded git state, so a guard call can never break the run.
 *
 * Idempotent: a second call after a successful stash finds the root clean and
 * returns `{ dirty: false }` (so the run's seam may safely retry a garbled relay).
 */

import * as path from "node:path";
import { z } from "zod";
import { listDirtyPathsWithStatus, stashWorkingTree, restoreRootHead } from "../lib/git.js";

/**
 * Glob-style config path prefixes that identify deliberate operator edits.
 * A dirty path matching any of these prefixes (tracked status only) is treated
 * as an operator config edit rather than worktree-isolation leakage.
 */
const CONFIG_PATH_PREFIXES = ["team/", "docs/"];

const GuardCleanRootInputSchema = z.object({
  targetRepoRoot: z.string().min(1),
  /** Optional story ref for a more legible stash message / log line. */
  ref: z.string().min(1).optional(),
  /** Base branch the root should sit on. Defaults to `main` (flow's trunk). */
  baseBranch: z.string().min(1).optional(),
});

export interface GuardCleanRootResult {
  /** True when the root checkout carried ANY dirty working-tree changes. */
  dirty: boolean;
  /**
   * True when worktree-isolation leak paths were stashed onto the stack
   * (recoverable via `git stash list` / `git stash pop`).
   */
  stashed: boolean;
  /**
   * The leak paths that were stashed (untracked or tracked non-config paths).
   * Operational `.flow/**` is already excluded.
   */
  paths: string[];
  /** The stash message used (present only when a stash was attempted). */
  stashMessage?: string;
  /**
   * True when the root has uncommitted edits to tracked config paths
   * (`team/**` or `docs/**`). These are deliberate operator edits and were
   * NOT stashed — the caller must emit a loud, distinct run-summary warning.
   */
  hasConfigEdits: boolean;
  /**
   * The tracked config paths that carry uncommitted operator edits
   * (present when `hasConfigEdits` is true). Not stashed; the operator
   * must reconcile these before or after the run.
   */
  configEdits: string[];
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

  // Step 1: classify the dirty set.
  //
  // We use `listDirtyPathsWithStatus` so we can see the XY status code for each
  // path. A path is a TRACKED CONFIG EDIT when:
  //   (a) its XY code is NOT "??" (i.e. git already tracks the file), AND
  //   (b) it lives under a config-path prefix (team/ or docs/).
  //
  // Everything else — untracked files ("??") or tracked changes outside the
  // config prefixes — is a worktree-isolation LEAK and is stashed.
  const allDirty = await listDirtyPathsWithStatus({ cwd });

  const configEdits: string[] = [];
  const leakPaths: string[] = [];

  for (const { path: p, xy } of allDirty) {
    const isTracked = xy !== "??";
    const isConfigPath = CONFIG_PATH_PREFIXES.some((prefix) =>
      p.startsWith(prefix),
    );
    if (isTracked && isConfigPath) {
      configEdits.push(p);
    } else {
      leakPaths.push(p);
    }
  }

  // Step 2: stash only the leak paths (worktree-isolation leakage). Config edits
  // are deliberately left in the working tree — the operator holds them on purpose.
  let stashed = false;
  let stashMessage: string | undefined;
  if (leakPaths.length > 0) {
    stashMessage = `flow-run clean-root guard${input.ref ? `: ${input.ref}` : ""}`;
    ({ stashed } = await stashWorkingTree({
      cwd,
      paths: leakPaths,
      message: stashMessage,
    }));
  }

  // Step 3: restore root HEAD if it drifted (detached / story-branch). Runs even
  // when the tree was clean — HEAD can move without dirtying the tree, which is
  // exactly the observed leak (root left DETACHED at a story commit, tree clean).
  // Ordered AFTER the stash so the working tree is clean and the checkout is safe.
  const head = await restoreRootHead({
    cwd,
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
  });

  const dirty = allDirty.length > 0;
  return {
    dirty,
    stashed,
    paths: leakPaths,
    ...(stashMessage ? { stashMessage } : {}),
    hasConfigEdits: configEdits.length > 0,
    configEdits,
    headMoved: head.headMoved,
    ...(head.restoredFrom ? { restoredFrom: head.restoredFrom } : {}),
    ...(head.restoredTo ? { restoredTo: head.restoredTo } : {}),
    ...(head.note ? { headNote: head.note } : {}),
  };
}
