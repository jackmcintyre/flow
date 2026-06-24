/**
 * `prepare-review-worktree` — Story native:01KVWMCK.
 *
 * Installs a materialised PR-review worktree's dependencies ONCE, before the
 * reviewer's AC walk runs any test, so a dependency-importing vitest suite can
 * resolve its imports.
 *
 * WHY THIS EXISTS — the reviewer-no-deps-install hole:
 *   `runReviewerSession` materialises the PR head into a fresh `git worktree`
 *   (see `materialise-pr-branch-worktree.ts`) and then runs each `vitest:` AC
 *   against it. A fresh worktree carries NO `node_modules` (git never copies it),
 *   and nothing on the reviewer path installed dependencies. So vitest ran against
 *   an un-installed tree, failed on UNRESOLVED_IMPORT (e.g. `vitest/config` from a
 *   `vitest.config.ts`), and the reviewer mislabelled a genuinely-green PR as
 *   NEEDS CHANGES — bouncing the story until it blocked `rework-exhausted` with a
 *   green PR sitting on the branch. The dev side never hit this because the dev is
 *   an agent that installs as it codes; the reviewer is a pure tool seam.
 *
 * DESIGN:
 *   - Reuse the SAME structural resolver the dev pre-PR gate uses
 *     (`resolveProjectToolchain`) so the reviewer and the dev gate agree on the
 *     target repo's package manager.
 *   - Run the install at the LOCKFILE'S workspace root, which on a workspace /
 *     monorepo target may NOT be the resolver's build-home `cwd`. We walk UP from
 *     the resolved build home to the worktree root and install at the first
 *     directory that owns a lockfile. (For the Flow repo the build home is
 *     `plugins/flow`, which is also where `pnpm-lock.yaml` + `pnpm-workspace.yaml`
 *     live, so they coincide; for a monorepo whose lockfile sits at the repo root
 *     while the build home is a sub-package, the walk finds the root.)
 *   - Do a CLEAN FROZEN install (npm ci / pnpm install --frozen-lockfile / yarn
 *     install --immutable / bun install --frozen-lockfile), gated on lockfile
 *     presence, prefer-offline where the manager supports it — fast and free of
 *     drift versus the PR's committed lockfile.
 *   - GATE on lockfile presence: when no lockfile is found between the build home
 *     and the worktree root, there is nothing to install (a non-JS or lockfile-less
 *     target) — return `ran: false, ok: true` and let the review proceed unchanged.
 *
 * The install spawns through the SAME `execa` injection seam the rest of the
 * reviewer uses, and NEVER throws on a non-zero exit — it returns a structured
 * result and lets the caller decide. (`runReviewerSession` turns a failed install
 * into a `setup-error` result, never a quality verdict.)
 */

import * as path from "node:path";
import { existsSync } from "node:fs";
import { execa as defaultExeca } from "execa";
import {
  resolveProjectToolchain,
  LOCKFILE_TO_PACKAGE_MANAGER,
  type PackageManager,
} from "./resolve-project-toolchain.js";

/**
 * Default time budget for the dependency install (10 minutes). A frozen,
 * prefer-offline install is normally far faster; the budget is a backstop against
 * a hung install silently stalling the review. Set to `0` to disable.
 */
const DEFAULT_INSTALL_TIMEOUT_MS: number = 10 * 60 * 1000;

export interface WorktreeInstallPlan {
  /** Absolute directory the frozen install runs in (the lockfile's workspace root). */
  installRoot: string;
  /** Package manager detected from the lockfile at `installRoot`. */
  packageManager: PackageManager;
  /** The install executable (e.g. `pnpm`). */
  command: string;
  /** Full argv after `command` (e.g. `["install", "--frozen-lockfile", "--prefer-offline"]`). */
  args: string[];
}

/**
 * The clean, frozen, drift-free install invocation for a package manager. Mirrors
 * what each manager's `--frozen`/`--immutable`/`ci` mode does: install exactly the
 * lockfile, never mutate it, fail loudly if the lockfile is out of sync.
 */
function frozenInstallInvocation(pm: PackageManager): { command: string; args: string[] } {
  switch (pm) {
    case "npm":
      return { command: "npm", args: ["ci", "--prefer-offline"] };
    case "yarn":
      return { command: "yarn", args: ["install", "--immutable"] };
    case "bun":
      return { command: "bun", args: ["install", "--frozen-lockfile"] };
    case "pnpm":
    default:
      return { command: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"] };
  }
}

/**
 * Resolve where + how to install dependencies for a materialised worktree.
 *
 * Walks UP from the structural build home (`resolveProjectToolchain(...).cwd`) to
 * the worktree root (inclusive), returning the first directory that owns a known
 * lockfile, the package manager that lockfile implies, and the frozen-install
 * argv. Returns `null` when no lockfile is present anywhere in that range — there
 * is nothing to install and the review proceeds unchanged.
 *
 * The walk is bounded to the worktree subtree so it can never reach a lockfile
 * outside the checkout (e.g. the operator's real project root).
 */
export function resolveWorktreeInstallPlan(worktreeRoot: string): WorktreeInstallPlan | null {
  const stop = path.resolve(worktreeRoot);
  const toolchain = resolveProjectToolchain({ targetRepoRoot: stop });

  let dir = path.resolve(toolchain.cwd);
  // Guard: the resolved build home should sit inside the worktree; if it somehow
  // does not, start the walk at the worktree root so we never escape the subtree.
  if (!(dir === stop || dir.startsWith(stop + path.sep))) {
    dir = stop;
  }

  while (dir === stop || dir.startsWith(stop + path.sep)) {
    for (const [lockfile, pm] of LOCKFILE_TO_PACKAGE_MANAGER) {
      if (existsSync(path.join(dir, lockfile))) {
        const { command, args } = frozenInstallInvocation(pm);
        return { installRoot: dir, packageManager: pm, command, args };
      }
    }
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface WorktreeInstallResult {
  /** `false` when the install was SKIPPED because no lockfile was found. */
  ran: boolean;
  /** `true` when the environment is ready: the install succeeded, OR it was skipped (nothing to install). */
  ok: boolean;
  installRoot?: string;
  packageManager?: PackageManager;
  /** Human-readable command line, for diagnostics (e.g. `pnpm install --frozen-lockfile`). */
  commandLine?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  /** Present when `ran === false` — why no install ran. */
  skippedReason?: string;
}

/**
 * Install the materialised worktree's dependencies once.
 *
 * Never throws on a non-zero exit — returns `{ ran: true, ok: false, ... }` so the
 * caller can route a failed install to a setup-error rather than a quality verdict.
 * Skips (returns `{ ran: false, ok: true, skippedReason }`) when there is no
 * lockfile to install from.
 */
export async function installWorktreeDependencies(opts: {
  worktreeRoot: string;
  execaImpl?: typeof defaultExeca;
  timeoutMs?: number;
}): Promise<WorktreeInstallResult> {
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;

  const plan = resolveWorktreeInstallPlan(opts.worktreeRoot);
  if (plan === null) {
    return {
      ran: false,
      ok: true,
      skippedReason:
        "no lockfile found between the build home and the worktree root — nothing to install",
    };
  }

  const result = await execaImpl(plan.command, plan.args, {
    cwd: plan.installRoot,
    reject: false,
    ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });

  const timedOut =
    "timedOut" in result && typeof result.timedOut === "boolean" ? result.timedOut : false;
  const exitCode =
    typeof result.exitCode === "number" ? result.exitCode : timedOut ? -1 : 1;

  return {
    ran: true,
    ok: exitCode === 0 && !timedOut,
    installRoot: plan.installRoot,
    packageManager: plan.packageManager,
    commandLine: [plan.command, ...plan.args].join(" "),
    exitCode,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    timedOut,
  };
}
