#!/usr/bin/env node
// @ts-check
/**
 * Story 5.28 — `build:watch` wrapper that chains `normalise-dist.mjs` after each
 * successful tsc recompile cycle.
 *
 * Why this exists
 * ---------------
 * Story 5.24 wired `normalise-dist.mjs` into `pnpm build` (one-shot) so that the
 * committed `dist/` stays deterministic across machines. The long-running
 * `pnpm build:watch` path was left bare — operators running the dev loop described
 * in CLAUDE.md ("Dev loop: --plugin-dir + build:watch, never /plugin install")
 * would accumulate `.d.ts` drift with each incremental recompile, tripping the
 * working-tree-clean invariant every `/ship-story` preflight depends on.
 *
 * Design seam (stdout-marker approach)
 * -------------------------------------
 * We spawn `tsc --watch` as a child process and pipe its stdout through to the
 * parent terminal (so operators still see "File change detected. Starting
 * incremental compilation..." / "Found N errors."). We subscribe to the stdout
 * stream and trigger the normaliser whenever tsc prints the stable success sentinel
 * "Found 0 errors. Watching for file changes." — that line is only emitted AFTER
 * tsc has finished writing all emitted files, which avoids the race where the
 * normaliser reads a partially-written `.d.ts`.
 *
 * Alternative seams considered:
 *  - `fs.watch` on `dist/**\/*.d.ts` — simpler, but fires mid-emit (tsc writes files
 *    individually; a watch handler may fire before all files are written for this
 *    compilation cycle). Race condition risk, and harder to debounce correctly.
 *  - tsc programmatic API (`ts.createWatchProgram`) — semantically cleanest, but
 *    locks to the TS compiler API surface (breaks on compiler major version bumps)
 *    and requires importing `typescript` as a runtime dep. Higher maintenance cost.
 *
 * Edge cases handled:
 *  - Rapid edits: a `pending`/`running` flag pair ensures at most one normaliser
 *    run is in flight, with exactly one re-run queued if another sentinel fires
 *    mid-run. No busy loop.
 *  - Orphan tsc processes: SIGINT/SIGTERM/SIGHUP are forwarded to the tsc child;
 *    the wrapper re-exits with tsc's exit code so the operator's shell knows
 *    whether tsc succeeded or failed.
 *  - Operator visibility: stdout is piped (not inherited) so we can parse it, but
 *    every byte is forwarded via `process.stdout.write(buf)` immediately.
 *  - Locale-sensitive sentinel: the "Found 0 errors. Watching for file changes."
 *    string is English-only. Acceptable for v1 (the project is English-only). A
 *    future follow-up could switch to `--listEmittedFiles` + parsing
 *    "Successfully created" lines for locale resilience.
 *  - Normaliser concurrency with mid-emit tsc writes: the stdout-marker approach
 *    guarantees the normaliser only starts after tsc reports a *complete* emit cycle.
 *  - Vitest interaction: if `pnpm test` runs while `pnpm build:watch` is active they
 *    may compete for `dist/` — same surface as 5.24 for one-shot builds; not a
 *    regression introduced by this story.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseDistTree } from "./normalise-dist.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// WATCH_NORMALISE_DIST_ROOT can be overridden by tests to point to a scratch outDir,
// keeping the integration test isolated from the real dist/.
const DIST_ROOT = process.env["WATCH_NORMALISE_DIST_ROOT"] ?? path.resolve(__dirname, "..", "dist");

// Locate tsc in node_modules so we don't require a global TypeScript install.
// This mirrors what `pnpm build` does via the `scripts` field.
const TSC = path.resolve(__dirname, "..", "node_modules", ".bin", "tsc");

// WATCH_NORMALISE_TSCONFIG and WATCH_NORMALISE_OUT_DIR can be overridden by
// tests to compile into a scratch directory without touching the real dist/.
const TSCONFIG_ARG = process.env["WATCH_NORMALISE_TSCONFIG"] ?? "tsconfig.json";
const OUT_DIR_ARG = process.env["WATCH_NORMALISE_OUT_DIR"];
const tscArgs = ["-p", TSCONFIG_ARG, "--watch"];
if (OUT_DIR_ARG) tscArgs.push("--outDir", OUT_DIR_ARG);

const tsc = spawn(TSC, tscArgs, {
  // pipe stdout so we can parse for the success sentinel;
  // inherit stderr + stdin so CTRL-C and tsc error output reach the terminal.
  stdio: ["inherit", "pipe", "inherit"],
  // do NOT detach — when the wrapper dies (Ctrl-C, parent kill), tsc must die too.
  detached: false,
});

/** @type {boolean} */
let running = false;
/** @type {boolean} */
let pending = false;

async function maybeRun() {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    const changed = await normaliseDistTree(DIST_ROOT);
    if (changed.length > 0) {
      console.log(`normalise-dist: rewrote ${changed.length} file(s) for deterministic enum key ordering.`);
    }
  } catch (err) {
    console.error("normalise-dist: error during normalisation:", err);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      // Use queueMicrotask so we don't recurse synchronously on the stack.
      queueMicrotask(maybeRun);
    }
  }
}

// tsc's success sentinel (emitted once per completed incremental compile with 0 errors).
// Only match 0 errors — normalising after a failed compile is wasteful and may touch stale .d.ts.
const SUCCESS_RE = /Found 0 errors\. Watching for file changes\./;

tsc.stdout.on("data", (/** @type {Buffer} */ buf) => {
  // Always forward to operator's terminal — visibility is a hard requirement (AC1).
  process.stdout.write(buf);
  if (SUCCESS_RE.test(buf.toString("utf8"))) {
    maybeRun();
  }
});

tsc.on("exit", (code, signal) => {
  // Mirror tsc's exit so callers (pnpm, CI scripts) see the right exit code.
  process.exit(code ?? (signal ? 1 : 0));
});

// Forward signals so tsc is not orphaned when the wrapper is killed.
for (const sig of /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  process.on(sig, () => {
    tsc.kill(sig);
  });
}
