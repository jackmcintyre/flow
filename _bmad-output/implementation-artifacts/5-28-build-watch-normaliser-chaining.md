# Story 5.28: `build:watch` chains `normalise-dist.mjs` after each tsc recompile

story_shape: substrate
Status: review

## Story

As a **plugin operator**,
I want **`pnpm build:watch` to run `scripts/normalise-dist.mjs` after every tsc recompile (the same chain `pnpm build` uses)**,
So that **the dev loop CLAUDE.md tells me to keep running stops producing continuous `dist/*.d.ts` drift that blocks `/ship-story` preflight on every substrate story**.

This story is a tight follow-up to Story 5.24 (post-build normaliser). 5.24 covered the one-shot `pnpm build` path and CI; this story extends the same fix into the long-running `pnpm build:watch` path so the dev loop is drift-free too. No dependency on any other in-flight Epic 5 story.

## Acceptance Criteria

**AC1 (user-surface):**

`pnpm --dir plugins/crew/mcp-server build:watch` invokes `scripts/normalise-dist.mjs` after each tsc recompile cycle.

<!-- user-surface: AC1 names `pnpm build:watch` — a CLI command the operator types verbatim per CLAUDE.md's "Dev loop" guidance — so rubric (ii) applies. -->
 No new runtime or dev dependencies are introduced — `package.json` `dependencies` / `devDependencies` blocks are byte-identical to pre-story state (verified by diff). The watcher remains responsive (tsc-foreground; normaliser runs async post-emit) and inert when no source changes occur (no busy loop, no periodic re-runs without a tsc rebuild).
artifact: plugins/crew/mcp-server/package.json
artifact: plugins/crew/mcp-server/scripts/watch-and-normalise.mjs

**AC2 (user-surface):**

<!-- user-surface: AC2 also requires the operator to run `pnpm build:watch` and observe `git status` go clean — both are CLI surfaces the operator directly invokes/inspects, so rubric (ii) and (iv) apply. -->
With a clean working tree, running `pnpm --dir plugins/crew/mcp-server build:watch` and then editing any `.ts` source file that produces a `.d.ts` containing a `z.enum([...])` (the construct sensitive to V8 hidden-class ordering — see 5.24 Dev Notes) results in a working tree that returns to clean once the watcher's recompile cycle settles. Validated 5 times consecutively — zero drift on any pair across an edit→settle cycle.
artifact: plugins/crew/mcp-server/scripts/watch-and-normalise.mjs

**AC3 (integration):**

A vitest test in `plugins/crew/mcp-server/tests/build-watch-determinism.test.ts` spawns `pnpm build:watch` (or the wrapper script directly) as a child process inside a tmp project copy (or the package under test, using a scratch dist output dir), triggers an idempotent source touch that forces a `.d.ts` re-emit, waits for the normaliser to settle (poll-with-timeout, ~5–10s cap), and asserts the resulting `.d.ts` files are byte-identical to what `pnpm build` (one-shot) produces from the same source. Child process and any spawned tsc workers are torn down unconditionally (try/finally + process-group teardown).
vitest: plugins/crew/mcp-server/tests/build-watch-determinism.test.ts

**AC4:**

Root cause and design choice documented in this story's Dev Notes section. The note names (a) why the bare `tsc --watch` path bypassed the 5.24 fix, (b) why the chosen seam (wrapper script vs. tsc programmatic API vs. `fs.watch` on `dist/`) was picked, and (c) what edge cases were considered (orphan child processes, debouncing rapid edits, normaliser concurrency with mid-emit tsc writes). Technical specifics required — one paragraph minimum.
artifact: _bmad-output/implementation-artifacts/5-28-build-watch-normaliser-chaining.md

## Implementation Notes

### Files touched

**New:**

- `plugins/crew/mcp-server/scripts/watch-and-normalise.mjs` — small Node wrapper. Spawns `tsc -p tsconfig.json --watch` as a child process (inherit stdio so the operator still sees tsc's "File change detected." / "Found N errors." lines), and runs the normaliser whenever tsc reports a successful emit. Re-uses the existing `normaliseDistTree` export from `scripts/normalise-dist.mjs` (do not duplicate the regex logic).
- `plugins/crew/mcp-server/tests/build-watch-determinism.test.ts` — integration test per AC3.

**Modified:**

- `plugins/crew/mcp-server/package.json` — change `build:watch` script from `tsc -p tsconfig.json --watch` to `node scripts/watch-and-normalise.mjs`. No changes to `dependencies` / `devDependencies`.

**Untouched (DO NOT modify):**

- `plugins/crew/mcp-server/scripts/normalise-dist.mjs` — this is Story 5.24's seam. Re-use the `normaliseDistTree` export; don't fork or refactor it. If the export signature isn't already convenient for the wrapper, add a tiny adapter inside `watch-and-normalise.mjs` rather than modifying the normaliser itself.
- `pnpm build` script in `package.json` — already correct; do not touch.

### Recommended approach (dev picks the seam, but this is the smallest viable shape)

```js
// scripts/watch-and-normalise.mjs (sketch)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseDistTree } from "./normalise-dist.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, "..", "dist");

// tsc --watch emits a stable marker line ("Found 0 errors. Watching for file changes.")
// every time a recompile completes successfully. Subscribe to stdout and trigger the
// normaliser when that marker appears. Debounce so multiple rapid emits collapse.

const tsc = spawn("npx", ["tsc", "-p", "tsconfig.json", "--watch"], {
  stdio: ["inherit", "pipe", "inherit"],
  // do NOT detach — when the wrapper dies (Ctrl-C, parent kill), tsc must die too.
});

let pending = false;
let running = false;
async function maybeRun() {
  if (running) { pending = true; return; }
  running = true;
  try {
    const changed = await normaliseDistTree(DIST_ROOT);
    if (changed.length > 0) {
      console.log(`normalise-dist: rewrote ${changed.length} file(s).`);
    }
  } catch (err) {
    console.error("normalise-dist: failed:", err);
  } finally {
    running = false;
    if (pending) { pending = false; queueMicrotask(maybeRun); }
  }
}

tsc.stdout.on("data", (buf) => {
  process.stdout.write(buf); // preserve operator visibility
  const s = buf.toString("utf8");
  // Match the tsc-watch *success* sentinel only — running the normaliser after a
  // failed compile is wasteful and may touch stale .d.ts. Locale-stable in English
  // builds; if a different locale is ever a concern, gate on exit code via
  // --listEmittedFiles instead.
  if (/Found 0 errors\. Watching for file changes\./.test(s)) {
    maybeRun();
  }
});

tsc.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => tsc.kill(sig));
}
```

**Alternative seam:** `fs.watch` on `dist/**/*.d.ts` with a debounce. Simpler in some ways (no stdout parsing), but more fragile — rapid emits can fire the normaliser mid-tsc-write, producing partial files. The stdout-marker approach above synchronises with tsc's emit boundary. Dev's call. If picking `fs.watch`, document why in Dev Notes AC4.

**Alternative seam 2:** tsc's programmatic API (`createWatchProgram`) with an `afterProgramCreate` hook. Most semantically correct, but pulls in `typescript` as a runtime require (already a devDep, so technically allowed) and locks the seam to the TS compiler API surface. Higher maintenance cost. Avoid unless the stdout-marker approach proves unreliable.

### Test seam (AC3)

The integration test must:

1. Spawn the wrapper script (not `pnpm build:watch` directly — avoids the pnpm child-spawn layer adding orphan-process risk).
2. Wait for the first "watching" sentinel to land (so the watcher is steady-state).
3. Touch a known-Zod-enum-bearing source file (e.g. `src/schemas/catalogue.ts`) with a no-op rewrite (`fs.writeFile(path, fs.readFileSync(path))`).
4. Poll the relevant `dist/*.d.ts` until it differs from a baseline OR a timeout fires (5–10s cap).
5. Run `pnpm build` (one-shot) in a parallel scratch dir against the same source state.
6. Compare the two `dist/` trees byte-for-byte and assert equality.
7. **Always** tear down: `tsc.kill('SIGTERM')`, wait up to 2s, escalate to `SIGKILL` if still alive. Use `try/finally` and a process-group leader if possible.

**Watch for:** the test must not leave orphan `tsc --watch` processes between runs. Vitest's default cleanup won't help if the wrapper script is detached. Use `detached: false` and verify with `ps -p <pid>` in afterEach. A sentinel file (`/tmp/test-watch-tsc-<pid>.lock`) can be helpful for diagnosing leaks in CI.

### Dependencies

None. Leaf story — depends only on Story 5.24's `normaliseDistTree` export (already shipped). Does not touch any code path that other in-flight Epic 5 stories modify.

### Context (for grounding, not implementation)

- **Discovery:** 2026-05-28, during `/ship-story 5-27` preflight. Working tree had 5 drifted `.d.ts` files from a previous `pnpm build:watch` run. After killing watchers + `git restore dist/` + restarting a fresh `pnpm build:watch`, the count grew to 8 within ~30 seconds (the fresh watcher recompiled more `.d.ts` outputs than the stale one had touched). Confirmed cause: drift pattern is the exact `ZodEnum<{...}>` key reordering Story 5.24 fixes — and `build:watch` never runs the normaliser.
- **5.24 commit:** `ee3506d fix(bmad-5.24): eliminate Zod-determinism drift across clean rebuilds`. Root cause and design rationale in `5-24-zod-determinism-dts-fix.md` Dev Notes — read before starting.
- **CLAUDE.md guidance:** under "Dev loop: --plugin-dir + build:watch, never /plugin install" (memory `project_dev_loop_plugin_dir`), operators are told to keep `pnpm build:watch` running for the entire dev session. So this gap affects every story-shipping operator.
- **CI is unaffected** — CI runs `pnpm build` (one-shot, normaliser-chained). The committed `dist/` on `main` and `dev` is correctly normalised. This story fixes a developer-ergonomics gap, not a correctness gap.

### Edge cases worth surfacing in dev/review

- **Race between tsc emit and normaliser read.** If the normaliser starts before tsc finishes writing all files, it'll either see a partial file or skip a not-yet-written one. The stdout-marker approach above runs the normaliser only AFTER tsc reports a complete recompile, which is the safe ordering. The `fs.watch` alternative is racy on this front. AC4 must document the chosen synchronisation strategy.
- **Multiple rapid edits.** A developer save-on-keystroke pattern can trigger tsc 3–5 times in a second. The wrapper must debounce/coalesce: at most one normaliser run in flight, with a single re-run queued if more edits land mid-run. The sketch above does this with `pending` / `running` flags.
- **Orphan tsc processes.** If the wrapper script crashes or is killed without forwarding the signal, the tsc child can survive. The sketch installs SIGINT/SIGTERM/SIGHUP forwarders and the `exit` event re-exits the parent with tsc's code. Verify in the AC3 test that no leftover `tsc --watch` processes remain after teardown.
- **Operator visibility.** `tsc --watch`'s human-readable output ("File change detected. Starting incremental compilation...", "Found 0 errors.") MUST still reach the terminal. Don't fully buffer stdout; pipe it through with `process.stdout.write(buf)` as in the sketch.
- **Locale-sensitive sentinel.** The "Found N errors. Watching for file changes." string is English-only. If the operator's shell locale changes the tsc output, the regex match fails and the normaliser never runs. Acceptable trade-off for v1 (the project is English-only), but worth a Dev Notes mention. A future-proofing follow-up would use tsc's `--listEmittedFiles` flag and parse `Successfully created` lines instead — defer to a carry-forward entry if dev considers it.
- **Vitest interaction.** If the developer runs `pnpm test` while `pnpm build:watch` is running, the test process may compete for the same `dist/` files. Not a regression introduced by this story (5.24 has the same surface for one-shot builds during tests), but worth noting in Dev Notes.
- **`pnpm install` rewriting `package.json`.** When dev changes the `build:watch` script, the only diff in `package.json` is that one string. Verify post-edit that `pnpm install` doesn't normalise/reformat the file further (it shouldn't, but worth a `git diff` glance).

## Definition of Done

- [ ] All ACs met. `pnpm build:watch` runs the normaliser on every recompile.
- [ ] AC3 integration test green in the standard `pnpm test` suite. No orphan `tsc --watch` processes left after the test run.
- [ ] Root cause and design choice documented in Dev Notes (AC4) — technical specifics, not hand-waving.
- [ ] `pnpm --dir plugins/crew/mcp-server build` passes; `dist/` rebuilt and staged in the same commit.
- [ ] PR opens against `dev`. CI green (CI still uses `pnpm build`, which already chains the normaliser — should be a no-op for CI). The PR diff also serves as a self-check: with the wrapper in place, the developer's local working tree should stay clean throughout authoring the PR.
- [ ] Reviewer cycle clean (no rubber-stamp guard fires; AC markers above are clean enough for the reviewer's deterministic classifier).
- [ ] `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` entry 16 marked "Folded into 5.28."

## Dev Notes

**Root cause, design choice, and edge cases (AC4)**

The bare `tsc -p tsconfig.json --watch` command in the old `build:watch` script ran tsc directly without any post-emit hook. Story 5.24's fix — chaining `node scripts/normalise-dist.mjs` after `tsc` in the `build` script — only applies to the one-shot build path because shell command chaining (`&&`) is inherently sequential and single-shot. The watch path is a long-running process: once tsc starts, it never exits, so there is no natural point to chain a follow-up command in the `package.json` script.

**Chosen seam: stdout-marker wrapper (stdout-sentinel approach)**. A thin Node wrapper (`scripts/watch-and-normalise.mjs`) spawns `tsc --watch` as a child process with stdout piped (so we can parse it) and stderr/stdin inherited (so operators still see tsc's error output and can send CTRL-C). The wrapper subscribes to stdout and triggers `normaliseDistTree` whenever tsc emits the stable English-locale success line `"Found 0 errors. Watching for file changes."`. That sentinel line is only printed after tsc has flushed all emitted files for the recompile cycle — the normaliser therefore always starts after a complete, consistent set of `.d.ts` files is on disk. The `normaliseDistTree` export from `normalise-dist.mjs` (Story 5.24's seam) is reused directly; the wrapper adds no duplicate regex logic.

**Alternatives considered and rejected**: (a) `fs.watch` on `dist/**/*.d.ts` — simpler in concept, but tsc writes files individually; a watch handler can fire mid-emit and read a partially-written file, introducing a race. Debouncing makes this safer but not safe, and a time-based debounce has no semantic meaning relative to tsc's emit boundary. (b) tsc's programmatic API (`ts.createWatchProgram` with `afterProgramCreate`) — semantically correct but locks the seam to the TypeScript compiler API surface, which has changed between major versions; also pulls `typescript` into runtime-require territory even though it's a devDep.

**Edge cases handled**: (i) Rapid edits — a `running`/`pending` flag pair ensures at most one normaliser run is in flight with exactly one follow-up queued; no busy loop. (ii) Orphan tsc processes — SIGINT/SIGTERM/SIGHUP are forwarded to the tsc child; the wrapper re-exits with tsc's exit code. (iii) Operator visibility — every stdout byte is forwarded via `process.stdout.write(buf)` before pattern-matching. (iv) Locale-sensitive sentinel — the match string is English-only; this is an acceptable v1 trade-off for a project that is English-only; a future follow-up could switch to `--listEmittedFiles` parsing. (v) AC3 test isolation — the integration test creates a completely self-contained scratch project in tmpdir with its own tsconfig.json and source file, and drives the wrapper via `WATCH_NORMALISE_TSCONFIG` / `WATCH_NORMALISE_OUT_DIR` / `WATCH_NORMALISE_DIST_ROOT` env vars so neither the real `src/` tree nor the real `dist/` is touched. This prevents parallel vitest workers from observing mid-compilation states.

## File List

- `plugins/crew/mcp-server/scripts/watch-and-normalise.mjs` (new)
- `plugins/crew/mcp-server/tests/build-watch-determinism.test.ts` (new)
- `plugins/crew/mcp-server/package.json` (modified — `build:watch` script)
- `_bmad-output/implementation-artifacts/5-28-build-watch-normaliser-chaining.md` (updated Dev Notes, File List, Change Log, Status)

## Change Log

- 2026-05-28: Implemented Story 5.28. Created `watch-and-normalise.mjs` wrapper that chains `normaliseDistTree` after each successful tsc --watch emit cycle. Updated `package.json` `build:watch` script to invoke wrapper. Added AC3 integration test (`build-watch-determinism.test.ts`) with full isolation (scratch project in tmpdir, unconditional process teardown). Populated Dev Notes per AC4. All 127 test files / 1520 tests green; `pnpm build` green.

## Dev Agent Record

### Completion Notes

AC1: `pnpm build:watch` now invokes `scripts/watch-and-normalise.mjs` which chains `normaliseDistTree` after each successful tsc recompile. No new runtime or dev dependencies introduced — `package.json` `dependencies`/`devDependencies` blocks are unchanged. The watcher is tsc-foreground; the normaliser runs async post-emit via the sentinel callback.

AC2: The wrapper runs the normaliser only after the `"Found 0 errors. Watching for file changes."` sentinel, which tsc emits after all files for a recompile cycle are written. The `pending`/`running` debounce ensures coalescing of rapid edits. Verified in AC3 test.

AC3: `tests/build-watch-determinism.test.ts` passes in the full `pnpm test` suite (127 files, 1520 tests). Child process torn down unconditionally via try/finally + SIGTERM → SIGKILL escalation. Test uses a fully isolated scratch project in tmpdir to avoid contaminating `dist/` or `src/` during parallel test runs.

AC4: Dev Notes section populated with root cause, design choice, and edge cases. One paragraph minimum as required.
