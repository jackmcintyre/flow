/**
 * `runProjectBuild` / `runProjectTests` / `runProjectBloatCheck` — the dev-side
 * pre-PR gates' runners. `runDevTerminalAction` calls these AFTER the dev's
 * commit but BEFORE `gh pr create`, so a red build/test/bloat result blocks the
 * PR from ever being opened (the #211 failure class — a story broke an untouched
 * sibling file, its story-scoped vitest passed in isolation, and a red PR was
 * opened).
 *
 * Story native:01KVTB3Z — the command + cwd are no longer HARDCODED to a pnpm
 * monorepo rooted at `plugins/flow`. They are DERIVED from `resolveProjectToolchain`
 * (see `resolve-project-toolchain.ts`), which discovers the target repo's OWN
 * toolchain structurally:
 *   - For the Flow repo (the dogfood path): structural detection of the
 *     `plugins/flow` pnpm-workspace + build script yields packageManager=pnpm and
 *     cwd=plugins/flow PURELY from on-disk structure — NO `.flow/config.yaml`
 *     needed (it is gitignored and absent from a clean worktree).
 *   - For an external npm repo (root package.json with build+test, package-lock.
 *     json, no plugins/ dir): the build/test run `npm run build` / `npm test` at
 *     the REPO ROOT and the bloat gate is SKIPPED (no knip).
 * The SAME resolver backs the reviewer's vitest runner, so the dev gate and the
 * reviewer always agree on where + how a target repo builds and tests.
 *
 * The build is spawned through the SAME `execa` injection seam the rest of
 * `runDevTerminalAction` already uses (no second spawn mechanism), so the vitest
 * can stub it to simulate a passing / failing build without spawning a real one.
 *
 * Story native:01KTN5E6T75XKDX8A0SGBVPRYS — time budget: a hung or crawling build
 * can silently stall for an hour without this guard. Both `runProjectBuild` and
 * `runProjectTests` accept an optional `timeoutMs`; when omitted,
 * `DEFAULT_BUILD_TEST_TIMEOUT_MS` applies. A timeout terminates the subprocess and
 * sets `timedOut: true` so `runDevTerminalAction` can surface a clear "timed out"
 * reason through the same `PrePrBuildFailedError` channel.
 */

import { execa as defaultExeca } from "execa";
import {
  resolveProjectToolchain,
  type ResolvedToolchain,
} from "./resolve-project-toolchain.js";

/**
 * Default time budget (in milliseconds) for both the build and test gates.
 *
 * Set to 20 minutes — comfortably above the observed normal full-run duration
 * (~10 min) and well below the 65-minute pathological hang that motivated
 * Story native:01KTN5E6T75XKDX8A0SGBVPRYS. Callers can override per-run via
 * the `timeoutMs` parameter on `runProjectBuild` / `runProjectTests`, or via
 * the `buildTestTimeoutMs` parameter on `runDevTerminalAction`.
 */
export const DEFAULT_BUILD_TEST_TIMEOUT_MS: number = 20 * 60 * 1000;

/**
 * The Flow-repo build/test/bloat command shape. RETAINED as named exports
 * because the pre-PR gate tests assert the gate runs the project's full build —
 * these constants describe the toolchain the structural resolver yields for the
 * Flow repo itself (a pnpm workspace whose `build`/`test`/`knip` scripts run
 * `pnpm -r build` / `pnpm -r test` / `knip`). They are NO LONGER the hardcoded
 * source of truth — `resolveProjectToolchain` is — but they remain the asserted
 * shape for the dogfood case. (Story native:01KVTB3Z.)
 */
export const PROJECT_BUILD_COMMAND = "pnpm" as const;
export const PROJECT_BUILD_ARGS: readonly string[] = ["build"] as const;
export const PROJECT_TEST_COMMAND = "pnpm" as const;
export const PROJECT_TEST_ARGS: readonly string[] = ["test"] as const;
export const PROJECT_BLOAT_COMMAND = "pnpm" as const;
export const PROJECT_BLOAT_ARGS: readonly string[] = ["knip"] as const;

/**
 * Resolve the toolchain for the dev's working directory. `devWorkingDir` IS the
 * target repo root from the resolver's perspective (the worktree when Story 8.16
 * isolation is on, else `targetRepoRoot`). The resolved cwd is the structural
 * build home (e.g. `plugins/flow` for the Flow repo, or the repo root for an
 * external npm repo). Exported so callers and tests can inspect the derivation.
 */
export function resolveBuildToolchain(devWorkingDir: string): ResolvedToolchain {
  return resolveProjectToolchain({ targetRepoRoot: devWorkingDir });
}

/**
 * Derive the absolute working directory the full build runs in from the dev's
 * working directory, via the structural toolchain resolver. Exported so callers
 * (and tests) can assert the derivation directly. For the Flow repo this lands
 * on `<devWorkingDir>/plugins/flow` purely from structure; for an external npm
 * repo it lands on the repo root.
 *
 * (Story native:01KVTB3Z replaces the old hardcoded `path.join(devWorkingDir,
 * "plugins", "flow")` with structural resolution.)
 */
export function deriveProjectBuildCwd(devWorkingDir: string): string {
  return resolveBuildToolchain(devWorkingDir).cwd;
}

export interface ProjectBuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The absolute working directory the build ran in (the resolved build home). */
  cwd: string;
  /** The human-readable command line, for diagnostics (e.g. `pnpm build`). */
  commandLine: string;
  /**
   * `true` when the subprocess was terminated because it exceeded `timeoutMs`.
   * The caller surfaces this as a `PrePrBuildFailedError` with a clear timed-out
   * reason. (Story native:01KTN5E6T75XKDX8A0SGBVPRYS)
   */
  timedOut: boolean;
  /** The time budget that was applied (milliseconds). */
  timeoutMs: number;
}

function normaliseTimedOutExit(result: {
  exitCode?: unknown;
  timedOut?: unknown;
}): { exitCode: number; timedOut: boolean } {
  const timedOut =
    "timedOut" in result && typeof result.timedOut === "boolean" ? result.timedOut : false;
  const rawExit = typeof result.exitCode === "number" ? result.exitCode : 1;
  const exitCode = timedOut ? (rawExit !== 0 ? rawExit : 1) : rawExit;
  return { exitCode, timedOut };
}

/**
 * Run the target repo's full build in its resolved build home and return a
 * structured result (never throws on a non-zero build — the caller decides how
 * to surface a failure). `reject: false` mirrors the `gitPush` precedent.
 *
 * @param opts.devWorkingDir  The dev's working directory (worktree or targetRepoRoot).
 * @param opts.timeoutMs      Time budget in milliseconds. Defaults to
 *                            `DEFAULT_BUILD_TEST_TIMEOUT_MS`. Set to `0` to disable.
 * @param opts.execaImpl      Test seam — production callers omit this.
 */
export async function runProjectBuild(opts: {
  devWorkingDir: string;
  timeoutMs?: number;
  execaImpl?: typeof defaultExeca;
}): Promise<ProjectBuildResult> {
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const toolchain = resolveBuildToolchain(opts.devWorkingDir);
  const cwd = toolchain.cwd;
  const [command, ...args] = toolchain.buildCmd;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BUILD_TEST_TIMEOUT_MS;

  const result = await execaImpl(command!, args, {
    cwd,
    reject: false,
    ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });

  const { exitCode, timedOut } = normaliseTimedOutExit(result);

  return {
    exitCode,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    cwd,
    commandLine: toolchain.buildCmd.join(" "),
    timedOut,
    timeoutMs,
  };
}

export interface ProjectTestResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The absolute working directory the tests ran in (the resolved build home). */
  cwd: string;
  /** The human-readable command line, for diagnostics (e.g. `pnpm test`). */
  commandLine: string;
  /** `true` when the subprocess was terminated because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** The time budget that was applied (milliseconds). */
  timeoutMs: number;
}

/**
 * Run the target repo's full test suite in its resolved build home and return a
 * structured result (never throws on a non-zero exit — the caller decides how to
 * surface a failure). The cwd is the same as the build (the resolved build home).
 *
 * @param opts.devWorkingDir  The dev's working directory (worktree or targetRepoRoot).
 * @param opts.timeoutMs      Time budget in milliseconds. Defaults to
 *                            `DEFAULT_BUILD_TEST_TIMEOUT_MS`. Set to `0` to disable.
 * @param opts.execaImpl      Test seam — production callers omit this.
 *
 * (Story native:01KT3ER5E9ACCERHAEJ5NM94TH)
 */
export async function runProjectTests(opts: {
  devWorkingDir: string;
  timeoutMs?: number;
  execaImpl?: typeof defaultExeca;
}): Promise<ProjectTestResult> {
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const toolchain = resolveBuildToolchain(opts.devWorkingDir);
  const cwd = toolchain.cwd;
  const [command, ...args] = toolchain.testCmd;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BUILD_TEST_TIMEOUT_MS;

  const result = await execaImpl(command!, args, {
    cwd,
    reject: false,
    ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });

  const { exitCode, timedOut } = normaliseTimedOutExit(result);

  return {
    exitCode,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    cwd,
    commandLine: toolchain.testCmd.join(" "),
    timedOut,
    timeoutMs,
  };
}

export interface ProjectBloatResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The absolute working directory the check ran in (the resolved build home). */
  cwd: string;
  /** The human-readable command line, for diagnostics (e.g. `pnpm knip`). */
  commandLine: string;
  /**
   * `true` when the bloat gate was SKIPPED because the resolved toolchain has no
   * dead-code check (`knipCmd: null` — e.g. an external repo with no knip). A
   * skipped gate is a success: `exitCode: 0`, no subprocess spawned.
   * (Story native:01KVTB3Z)
   */
  skipped: boolean;
}

/**
 * Run the target repo's dead-code (knip) check in its resolved build home and
 * return a structured result (never throws on a non-zero exit — the caller decides
 * how to surface a failure).
 *
 * Story native:01KVTB3Z: when the resolved toolchain returns `knipCmd: null`
 * (no `knip` script, no knip config, no config override), there is NO dead-code
 * check to run — this becomes a NO-OP that returns a success result with
 * `skipped: true`. An external repo without knip therefore opens its PR without
 * a fabricated bloat gate failure.
 *
 * @param opts.devWorkingDir  The dev's working directory (worktree or targetRepoRoot).
 * @param opts.execaImpl      Test seam — production callers omit this.
 *
 * (Story native:01KV7NJ6T3T1H67MZJ3DQBYFZT; skip behaviour: Story native:01KVTB3Z)
 */
export async function runProjectBloatCheck(opts: {
  devWorkingDir: string;
  execaImpl?: typeof defaultExeca;
}): Promise<ProjectBloatResult> {
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const toolchain = resolveBuildToolchain(opts.devWorkingDir);
  const cwd = toolchain.cwd;

  // No dead-code check applies to this target — the bloat gate is a no-op.
  if (toolchain.knipCmd === null) {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      cwd,
      commandLine: "(no dead-code check — bloat gate skipped)",
      skipped: true,
    };
  }

  const [command, ...args] = toolchain.knipCmd;
  const result = await execaImpl(command!, args, {
    cwd,
    reject: false,
  });

  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    cwd,
    commandLine: toolchain.knipCmd.join(" "),
    skipped: false,
  };
}
