/**
 * `runProjectBuild` — Story 8.17.
 *
 * The pre-PR build gate's runner. `runDevTerminalAction` calls this AFTER the
 * dev's commit but BEFORE `gh pr create`, so a red build blocks the PR from ever
 * being opened (the #211 failure class — a story broke an untouched sibling file,
 * its story-scoped vitest passed in isolation, and a red PR was opened).
 *
 * The command and its working directory are DERIVED here, in one place, so the
 * derivation is assertable in a test and a future refactor cannot silently narrow
 * the gate to a partial / story-scoped build:
 *
 *   - command: `pnpm build` — the project's full build, i.e. the same command CI
 *     runs (.github/workflows/ci.yml `- run: pnpm build`, which fans out to
 *     `pnpm -r build` → `tsc -p tsconfig.json && node scripts/normalise-dist.mjs`
 *     for the mcp-server). This is a WHOLE-PROJECT type-check, not a subset, so it
 *     catches breakage in files the story did not touch.
 *   - cwd: `<devWorkingDir>/plugins/flow` — derived from the dev's working
 *     directory (the worktree when Story 8.16 isolation is on, else
 *     `targetRepoRoot`), matching CI's `working-directory: plugins/flow`. Pinning
 *     it to the dev's working directory is what makes the gate catch cross-file
 *     breakage the dev introduced, and lets this story compose with 8.16 in either
 *     order.
 *
 * The build is spawned through the SAME `execa` injection seam the rest of
 * `runDevTerminalAction` already uses (no second spawn mechanism), so the vitest
 * can stub it to simulate a passing / failing build without spawning a real one.
 *
 * Story native:01KTN5E6T75XKDX8A0SGBVPRYS — time budget:
 *
 *   A hung or crawling build can silently stall for an hour without this guard.
 *   Both `runProjectBuild` and `runProjectTests` accept an optional `timeoutMs`
 *   parameter; when omitted, `DEFAULT_BUILD_TEST_TIMEOUT_MS` applies. A timeout
 *   terminates the subprocess and sets `timedOut: true` on the result so
 *   `runDevTerminalAction` can surface a clear "timed out after X s" reason
 *   through the same `PrePrBuildFailedError` channel as any other build failure.
 *   The default is set comfortably above the observed normal full-run duration
 *   (~10 min) to avoid spuriously aborting healthy builds, while well below the
 *   65-minute pathological hang that motivated this story.
 */

import * as path from "node:path";
import { execa as defaultExeca } from "execa";

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
 * The full-build command + args. Mirrors CI's `- run: pnpm build` step verbatim
 * (the `build` script in `plugins/flow/package.json` is `pnpm -r build`). Kept as
 * a named export so the test can assert the gate runs the project's full build
 * and not a story-scoped subset.
 */
export const PROJECT_BUILD_COMMAND = "pnpm" as const;
export const PROJECT_BUILD_ARGS: readonly string[] = ["build"] as const;

export interface ProjectBuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The absolute working directory the build ran in (`<devWorkingDir>/plugins/flow`). */
  cwd: string;
  /** The human-readable command line, for diagnostics (`pnpm build`). */
  commandLine: string;
  /**
   * `true` when the subprocess was terminated because it exceeded `timeoutMs`.
   * The caller surfaces this as a `PrePrBuildFailedError` with a clear timed-out
   * reason so the operator knows to investigate a hung build rather than a
   * compile error. (Story native:01KTN5E6T75XKDX8A0SGBVPRYS)
   */
  timedOut: boolean;
  /** The time budget that was applied (milliseconds). */
  timeoutMs: number;
}

/**
 * Derive the absolute working directory the full build runs in from the dev's
 * working directory. Exported so the test can assert the derivation directly
 * (AC3 — a future refactor must not silently narrow or relocate the gate).
 */
export function deriveProjectBuildCwd(devWorkingDir: string): string {
  return path.join(devWorkingDir, "plugins", "flow");
}

/**
 * Run the project's full build in the dev's working directory and return a
 * structured result (never throws on a non-zero build — the caller decides how
 * to surface a failure). `reject: false` mirrors the `gitPush` precedent so a
 * failing build comes back as a non-zero `exitCode` rather than an execa throw.
 *
 * @param opts.devWorkingDir  The dev's working directory (worktree or targetRepoRoot).
 * @param opts.timeoutMs      Time budget in milliseconds. Defaults to
 *                            `DEFAULT_BUILD_TEST_TIMEOUT_MS`. Set to `0` to
 *                            disable the budget (not recommended for production).
 * @param opts.execaImpl      Test seam — production callers omit this.
 */
export async function runProjectBuild(opts: {
  devWorkingDir: string;
  timeoutMs?: number;
  execaImpl?: typeof defaultExeca;
}): Promise<ProjectBuildResult> {
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const cwd = deriveProjectBuildCwd(opts.devWorkingDir);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BUILD_TEST_TIMEOUT_MS;

  const result = await execaImpl(PROJECT_BUILD_COMMAND, [...PROJECT_BUILD_ARGS], {
    cwd,
    reject: false,
    ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });

  const timedOut =
    "timedOut" in result && typeof result.timedOut === "boolean"
      ? result.timedOut
      : false;

  return {
    exitCode: timedOut ? (typeof result.exitCode === "number" && result.exitCode !== 0 ? result.exitCode : 1) : (typeof result.exitCode === "number" ? result.exitCode : 1),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    cwd,
    commandLine: `${PROJECT_BUILD_COMMAND} ${PROJECT_BUILD_ARGS.join(" ")}`,
    timedOut,
    timeoutMs,
  };
}

/**
 * The full-test command + args. Mirrors CI's `- run: pnpm test` step verbatim
 * (the `test` script in `plugins/flow/package.json` is
 * `NODE_OPTIONS=--max-old-space-size=8192 vitest run`). Kept as a named export
 * so the test can assert the gate runs the project's full test suite and not a
 * story-scoped subset.
 *
 * Story native:01KT3ER5E9ACCERHAEJ5NM94TH: test gate added after build gate.
 */
export const PROJECT_TEST_COMMAND = "pnpm" as const;
export const PROJECT_TEST_ARGS: readonly string[] = ["test"] as const;

export interface ProjectTestResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The absolute working directory the tests ran in (`<devWorkingDir>/plugins/flow`). */
  cwd: string;
  /** The human-readable command line, for diagnostics (`pnpm test`). */
  commandLine: string;
  /**
   * `true` when the subprocess was terminated because it exceeded `timeoutMs`.
   * Mirrors `ProjectBuildResult.timedOut`.
   * (Story native:01KTN5E6T75XKDX8A0SGBVPRYS)
   */
  timedOut: boolean;
  /** The time budget that was applied (milliseconds). */
  timeoutMs: number;
}

/**
 * Run the project's full test suite in the dev's working directory and return a
 * structured result (never throws on a non-zero exit — the caller decides how
 * to surface a failure). The cwd is the same as the build: `<devWorkingDir>/plugins/flow`,
 * matching CI's `working-directory: plugins/flow`.
 *
 * @param opts.devWorkingDir  The dev's working directory (worktree or targetRepoRoot).
 * @param opts.timeoutMs      Time budget in milliseconds. Defaults to
 *                            `DEFAULT_BUILD_TEST_TIMEOUT_MS`. Set to `0` to
 *                            disable the budget (not recommended for production).
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
  const cwd = deriveProjectBuildCwd(opts.devWorkingDir);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BUILD_TEST_TIMEOUT_MS;

  const result = await execaImpl(PROJECT_TEST_COMMAND, [...PROJECT_TEST_ARGS], {
    cwd,
    reject: false,
    ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });

  const timedOut =
    "timedOut" in result && typeof result.timedOut === "boolean"
      ? result.timedOut
      : false;

  return {
    exitCode: timedOut ? (typeof result.exitCode === "number" && result.exitCode !== 0 ? result.exitCode : 1) : (typeof result.exitCode === "number" ? result.exitCode : 1),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    cwd,
    commandLine: `${PROJECT_TEST_COMMAND} ${PROJECT_TEST_ARGS.join(" ")}`,
    timedOut,
    timeoutMs,
  };
}
