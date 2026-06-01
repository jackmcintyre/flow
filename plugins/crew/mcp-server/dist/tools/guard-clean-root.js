/**
 * `guardCleanRoot` tool — Epic 10 drain fix-plan, Fix 2b (clean-root guard).
 *
 * The drain isolates each dev's edits by cutting a per-story git worktree
 * (`isolation: 'worktree'`, Story 8.20). In a BACKGROUND job the repo's
 * `worktree.bgIsolation: "none"` setting can suppress that, pinning the dev's
 * edits to the SHARED root checkout instead of its own worktree (Epic 10 drain
 * retro, Issue B). The leak recurred 0/5 across the 10.1→10.5 batch, so it is a
 * real failure mode of unconfirmed frequency — not yet worth a durable fix, but
 * worth a cheap, protective guard.
 *
 * This tool is that guard. The drain calls it AFTER each story settles: it asks
 * `listDirtyPaths` whether the orchestrating root checkout carries any tracked
 * working-tree changes (operational `.crew/**` state is gitignored and dropped,
 * so only a genuine source leak shows), and if so it stashes exactly those paths
 * (non-destructively, recoverable via `git stash`) so the NEXT story's worktree is
 * still cut from a clean base. It turns a silent leak into a VISIBLE, SAFE one:
 * the caller logs a loud warning from the returned `dirty`/`paths`, and no work is
 * discarded.
 *
 * Pure orchestration over the two sanctioned git-spawn helpers in `lib/git.ts`
 * (`listDirtyPaths` + `stashWorkingTree`). Best-effort by construction — it never
 * throws on a degraded git state, so a guard call can never break the drain.
 *
 * Idempotent: a second call after a successful stash finds the root clean and
 * returns `{ dirty: false }` (so the drain's seam may safely retry a garbled relay).
 */
import * as path from "node:path";
import { z } from "zod";
import { listDirtyPaths, stashWorkingTree } from "../lib/git.js";
export const GuardCleanRootInputSchema = z.object({
    targetRepoRoot: z.string().min(1),
    /** Optional story ref for a more legible stash message / log line. */
    ref: z.string().min(1).optional(),
});
export async function guardCleanRoot(rawInput) {
    const input = GuardCleanRootInputSchema.parse(rawInput);
    const cwd = path.resolve(input.targetRepoRoot);
    const paths = await listDirtyPaths({ cwd });
    if (paths.length === 0) {
        return { dirty: false, stashed: false, paths: [] };
    }
    const stashMessage = `crew-drain clean-root guard${input.ref ? `: ${input.ref}` : ""}`;
    const { stashed } = await stashWorkingTree({ cwd, paths, message: stashMessage });
    return { dirty: true, stashed, paths, stashMessage };
}
