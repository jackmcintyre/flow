import { describe, it, expect, afterEach } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * Story 5.28 — build:watch determinism test suite.
 *
 * Covers AC1(b) (zero-new-deps static check), AC2 (5 consecutive edit→settle
 * cycles), AC3 (byte-identical to one-shot build), and AC4 (Dev Notes grep).
 *
 * Isolation strategy (AC3/AC2):
 * - We create a completely self-contained scratch project in tmpdir (separate from
 *   the real src/ tree) with its own tsconfig.json and a minimal source file.
 * - The wrapper is invoked with WATCH_NORMALISE_TSCONFIG pointing to the scratch
 *   tsconfig and WATCH_NORMALISE_OUT_DIR / WATCH_NORMALISE_DIST_ROOT pointing to
 *   a scratch outDir. This means:
 *   (a) The real dist/ and src/ are never touched.
 *   (b) Parallel vitest workers running tsc against the real tsconfig/src/ see no
 *       interference from this test.
 * - All scratch dirs are cleaned up unconditionally in afterEach.
 *
 * Orphan-process discipline:
 * - detached: false (default) so the wrapper is in our process group.
 * - Teardown: SIGTERM → 2s wait → SIGKILL escalation.
 * - afterEach safety net in case the test body throws early.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_ROOT = resolve(HERE, "..");

// Story spec path — used for AC4 Dev Notes grep assertions.
const STORY_SPEC_PATH = resolve(
  MCP_SERVER_ROOT,
  "..",
  "..",
  "..",
  "_bmad-output",
  "implementation-artifacts",
  "5-28-build-watch-normaliser-chaining.md",
);
const WRAPPER_SCRIPT = resolve(MCP_SERVER_ROOT, "scripts", "watch-and-normalise.mjs");
const TSCONFIG = resolve(MCP_SERVER_ROOT, "tsconfig.json");
const NORMALISER = resolve(MCP_SERVER_ROOT, "scripts", "normalise-dist.mjs");

// tsc --watch success sentinel line (English locale)
const SENTINEL_RE = /Found 0 errors\. Watching for file changes\./;

// Track spawned watcher and temp dirs for afterEach cleanup.
let activeWatcher: ChildProcessWithoutNullStreams | null = null;
let activeTmpDirs: string[] = [];

afterEach(async () => {
  if (activeWatcher) {
    await killProcess(activeWatcher);
    activeWatcher = null;
  }
  for (const d of activeTmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  activeTmpDirs = [];
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Terminate a process: SIGTERM first, escalate to SIGKILL after ~2s.
 */
async function killProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  });
}

/**
 * Generic event-driven line-counter: attaches a `data` listener to a process's
 * stdout immediately after spawn (so no events are dropped), counts every
 * occurrence of `pattern` across all received chunks, and resolves `waitFor(n)`
 * as soon as the running count reaches `n` — or resolves `false` after
 * `timeoutMs` if the count never reaches `n`.
 *
 * Used for both the tsc success-sentinel and the normaliser-done signal so the
 * two waiters share identical retry / timeout mechanics with different patterns.
 */
function createPatternWaiter(child: ChildProcessWithoutNullStreams, pattern: RegExp) {
  // Ensure the regex has the global flag so match() returns all occurrences in a chunk.
  const globalRe = pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  let count = 0;
  type Waiter = { target: number; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> };
  const waiters: Waiter[] = [];

  child.stdout.on("data", (buf: Buffer) => {
    const s = buf.toString("utf8");
    const matches = s.match(globalRe);
    if (matches) {
      count += matches.length;
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (count >= w.target) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(true);
        }
      }
    }
  });

  return {
    waitFor(target: number, timeoutMs: number): Promise<boolean> {
      if (count >= target) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const w: Waiter = {
          target,
          resolve,
          timer: setTimeout(() => {
            const idx = waiters.indexOf(w);
            if (idx >= 0) waiters.splice(idx, 1);
            resolve(false);
          }, timeoutMs),
        };
        waiters.push(w);
      });
    },
    getCount() { return count; },
  };
}

/**
 * Wait until the tsc success-sentinel counter reaches `targetCount`, up to `timeoutMs`.
 * Attach this listener right after spawning — no events are dropped.
 */
function createSentinelWaiter(child: ChildProcessWithoutNullStreams) {
  return createPatternWaiter(child, SENTINEL_RE);
}

/**
 * Wait until the normaliser-done counter reaches `targetCount`, up to `timeoutMs`.
 *
 * The watch-and-normalise.mjs wrapper emits "normalise-dist: done\n" to stdout
 * after every normaliseDistTree() call (both success and error paths). This lets
 * the test wait for a deterministic completion event instead of a fixed wall-clock
 * delay — eliminating the source of false failures under machine load.
 *
 * Attach this listener immediately after spawning (same pattern as createSentinelWaiter)
 * so no events are dropped between spawn and the first await.
 */
function createNormaliserWaiter(child: ChildProcessWithoutNullStreams) {
  return createPatternWaiter(child, /normalise-dist: done/);
}

/**
 * Walk a directory recursively, returning a sorted list of relative file paths.
 */
function listAllFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  }
  walk(root);
  return out.sort();
}

/**
 * Build a manifest of `{ relativePath: sha256(contents) }` for .d.ts files under `root`.
 */
function hashDtsTree(root: string): Record<string, string> {
  const files = listAllFiles(root).filter((f) => f.endsWith(".d.ts"));
  const manifest: Record<string, string> = {};
  for (const rel of files) {
    const buf = readFileSync(join(root, rel));
    manifest[rel] = createHash("sha256").update(buf).digest("hex");
  }
  return manifest;
}

/**
 * Create a minimal isolated TypeScript project in `projectDir` with its own
 * tsconfig.json, a `src/` subdir, and a source file that imports zod and exports
 * a z.enum with unsorted keys (so the normaliser must actually reorder them).
 *
 * The tsconfig points to the mcp-server's node_modules so `import { z } from "zod"`
 * resolves without a separate install.
 *
 * Returns the path to the initial source file.
 */
function createScratchProject(projectDir: string, outDir: string): {
  tsconfig: string;
  srcFile: string;
  initialContent: string;
} {
  const srcDir = join(projectDir, "src");
  mkdirSync(srcDir, { recursive: true });

  const tsconfig = join(projectDir, "tsconfig.json");
  const tsconfigJson = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022"],
      strict: true,
      declaration: true,
      skipLibCheck: true,
      esModuleInterop: true,
      outDir,
      rootDir: srcDir,
    },
    include: [join(srcDir, "**", "*.ts")],
  };
  writeFileSync(tsconfig, JSON.stringify(tsconfigJson, null, 2));

  // Source file with unsorted z.enum keys — the normaliser must sort them.
  // We also need zod's types available: tsc resolves node_modules relative to
  // each source file, then walks up to find node_modules/zod. Since srcDir is in
  // tmpdir, we symlink node_modules at the project root level.
  const nodeModulesLink = join(projectDir, "node_modules");
  try {
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync(resolve(MCP_SERVER_ROOT, "node_modules"), nodeModulesLink);
  } catch {
    // Already exists or permission error — skip.
  }

  const srcFile = join(srcDir, "scratch-enum.ts");
  // NOTE: Use keys that are NOT in alphabetical order so the normaliser is exercised.
  const initialContent = [
    "// auto-generated by build-watch-determinism.test.ts — do not commit",
    'import { z } from "zod";',
    'export const ScratchEnum = z.enum(["gamma", "alpha", "beta"]);',
  ].join("\n") + "\n";
  writeFileSync(srcFile, initialContent);
  const t = new Date();
  utimesSync(srcFile, t, t);

  return { tsconfig, srcFile, initialContent };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// ─── AC1(b): Zero-new-dependencies check ─────────────────────────────────────

describe("Story 5.28 — AC1: zero-new-deps static check", () => {
  /**
   * The pre-story `dependencies` and `devDependencies` blocks (from origin/dev
   * before the first 5.28 commit) are inlined here as the canonical reference.
   * If anyone adds a dep this assertion catches the drift immediately.
   *
   * De-cruft 2026-05-30: `pino` removed — it was declared speculatively for a
   * future SonicBoom logger swap that never landed (the logger uses
   * `fs.appendFile`). Reference updated to match.
   *
   * Bundle-the-server change: `esbuild` (devDependency only) added — it bundles
   * the MCP server + CLI into self-contained dist entrypoints so the plugin
   * installs from a GitHub marketplace / clean machine without node_modules.
   * Build-time only; ships no new runtime dependency. Reference updated to match.
   */
  const PRE_STORY_DEPENDENCIES: Record<string, string> = {
    "@modelcontextprotocol/sdk": "1.29.0",
    "execa": "^9.6.1",
    "picomatch": "^4.0.4",
    "ulid": "3.0.2",
    "yaml": "^2.9.0",
    "zod": "^4.4.3",
  };

  const PRE_STORY_DEV_DEPENDENCIES: Record<string, string> = {
    "@types/node": "^22.10.0",
    "@types/picomatch": "^4.0.3",
    "@vitest/coverage-v8": "2.1.9",
    "esbuild": "^0.28.0",
    "oxlint": "^1.68.0",
    "remark-parse": "11.0.0",
    "typescript": "^5.7.0",
    "unified": "11.0.5",
    "vitest": "^2.1.0",
  };

  it("package.json dependencies block is byte-identical to pre-story state", () => {
    const pkg = JSON.parse(
      readFileSync(join(MCP_SERVER_ROOT, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

    // Sort keys for a stable comparison (package.json key order may vary).
    const sortKeys = (obj: Record<string, string>) =>
      Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

    expect(sortKeys(pkg.dependencies)).toStrictEqual(sortKeys(PRE_STORY_DEPENDENCIES));
  });

  it("package.json devDependencies block is byte-identical to pre-story state", () => {
    const pkg = JSON.parse(
      readFileSync(join(MCP_SERVER_ROOT, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

    const sortKeys = (obj: Record<string, string>) =>
      Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

    expect(sortKeys(pkg.devDependencies)).toStrictEqual(sortKeys(PRE_STORY_DEV_DEPENDENCIES));
  });
});

// ─── AC4: Dev Notes documentation checks ─────────────────────────────────────

describe("Story 5.28 — AC4: Dev Notes documentation", () => {
  it("Dev Notes explains why bare tsc --watch bypassed the 5.24 fix (subject a)", () => {
    const spec = readFileSync(STORY_SPEC_PATH, "utf8");
    // Subject (a): why the bare `tsc --watch` path bypassed the 5.24 fix.
    // The note should mention that the watch path is long-running and tsc never exits,
    // so there is no natural point to chain a follow-up command.
    expect(spec).toMatch(/tsc.*--watch.*path/i);
    expect(spec).toMatch(/never exits|long-running|never exit|single-shot|long running/i);
  });

  it("Dev Notes names the chosen seam and explains the choice (subject b)", () => {
    const spec = readFileSync(STORY_SPEC_PATH, "utf8");
    // Subject (b): why the chosen seam (wrapper script / stdout-marker) was picked.
    expect(spec).toMatch(/stdout.*marker|stdout-marker|sentinel.*line|sentinel.*approach/i);
    // Must explain the choice — either explicitly name "wrapper script" or the approach name.
    expect(spec).toMatch(/wrapper|watch-and-normalise/i);
    // Must contrast with alternatives considered/rejected.
    expect(spec).toMatch(/alternative|rejected|considered/i);
  });

  it("Dev Notes discusses edge cases (subject c)", () => {
    const spec = readFileSync(STORY_SPEC_PATH, "utf8");
    // Subject (c): edge cases — orphan child processes, debouncing, normaliser concurrency.
    expect(spec).toMatch(/orphan|SIGTERM|SIGINT/i);
    expect(spec).toMatch(/debounce|rapid|pending.*running|running.*pending/i);
    expect(spec).toMatch(/concurrency|race|mid-emit|mid.?emit/i);
  });
});

// ─── AC3: end-to-end build:watch normaliser chaining ─────────────────────────

describe("Story 5.28 — build:watch normaliser chaining (AC3)", () => {
  it("wrapper script exists and is a regular file", () => {
    const stat = statSync(WRAPPER_SCRIPT);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("wrapper script imports normaliseDistTree from normalise-dist.mjs (content check)", () => {
    const src = readFileSync(WRAPPER_SCRIPT, "utf8");
    expect(src).toMatch(/from\s+["']\.\/normalise-dist\.mjs["']/);
    expect(src).toMatch(/normaliseDistTree/);
  });

  it("package.json build:watch script points to wrapper, not bare tsc", () => {
    const pkg = JSON.parse(readFileSync(join(MCP_SERVER_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["build:watch"]).toBe("node scripts/watch-and-normalise.mjs");
    // build (one-shot) must remain unchanged
    expect(pkg.scripts["build"]).toMatch(/tsc.*&&.*normalise-dist/);
  });

  it(
    "build:watch normalises dist/ after a source touch (byte-identical to one-shot build)",
    async () => {
      // ── Phase 0: create fully-isolated scratch project and output dirs ──
      const scratchProjectDir = mkdtempSync(join(tmpdir(), "flow-watch-proj-"));
      const watchOutDir = mkdtempSync(join(tmpdir(), "flow-watch-out-"));
      const refOutDir = mkdtempSync(join(tmpdir(), "flow-ref-out-"));
      activeTmpDirs = [scratchProjectDir, watchOutDir, refOutDir];

      const { tsconfig: scratchTsconfig, srcFile, initialContent } = createScratchProject(
        scratchProjectDir,
        watchOutDir,
      );

      // ── Phase 1: spawn the wrapper, directed to scratch project + watchOutDir ──
      const watcher = spawn("node", [WRAPPER_SCRIPT], {
        cwd: MCP_SERVER_ROOT,
        stdio: ["inherit", "pipe", "inherit"],
        detached: false,
        env: {
          ...process.env,
          WATCH_NORMALISE_TSCONFIG: scratchTsconfig,
          WATCH_NORMALISE_OUT_DIR: watchOutDir,
          WATCH_NORMALISE_DIST_ROOT: watchOutDir,
        },
      }) as ChildProcessWithoutNullStreams;
      activeWatcher = watcher;

      // Attach both waiters immediately (before any await) so no events are dropped.
      const sentinel = createSentinelWaiter(watcher);
      const normaliser = createNormaliserWaiter(watcher);

      // Wait for first successful compile.
      // De-flake: the pre-PR gate runs this test inside the FULL vitest suite (all
      // workers), which saturates the box and starves `tsc --watch`, so a real
      // recompile can arrive well after a tight wall-clock budget. The per-wait
      // ceilings here are deliberately generous (the watcher is event-driven, so a
      // fast machine resolves instantly); the `it()` timeout below is the real
      // backstop for a genuinely hung watcher.
      const ready = await sentinel.waitFor(1, 60_000);
      expect(ready, "tsc --watch never reached steady-state within 60s").toBe(true);

      // Wait for the normaliser to finish its first run before proceeding.
      // This is a deterministic event-driven wait — no fixed wall-clock delay.
      const normReady = await normaliser.waitFor(1, 30_000);
      expect(normReady, "normaliser did not emit done signal after initial compile").toBe(true);

      // ── Phase 2: mutate the scratch source file to force a recompile ──
      const v2Content = initialContent.trimEnd() + "\n// touch\n";
      const t1 = new Date();
      writeFileSync(srcFile, v2Content);
      utimesSync(srcFile, t1, t1);

      // ── Phase 3: wait for second sentinel (recompile done) then for normaliser ──
      const recompiled = await sentinel.waitFor(2, 60_000);
      // Restore original content immediately (before expect) so the reference build
      // sees the same source state.
      const t2 = new Date();
      writeFileSync(srcFile, initialContent);
      utimesSync(srcFile, t2, t2);

      expect(recompiled, "tsc --watch did not emit a second success sentinel within 60s after source touch").toBe(true);

      // Wait for the normaliser to complete its second run — event-driven, not a fixed delay.
      const normDone = await normaliser.waitFor(2, 30_000);
      expect(normDone, "normaliser did not emit done signal after recompile").toBe(true);

      // Kill the watcher BEFORE the reference build to prevent concurrent writes.
      await killProcess(watcher);
      activeWatcher = null;

      const hashAfterWatch = hashDtsTree(watchOutDir);

      // ── Phase 4: one-shot reference build into refOutDir ──
      // Source is restored, so both builds see the same state.
      const tsc = resolve(MCP_SERVER_ROOT, "node_modules", ".bin", "tsc");
      execFileSync(tsc, ["-p", scratchTsconfig, "--outDir", refOutDir], {
        cwd: MCP_SERVER_ROOT,
        stdio: "pipe",
      });
      const normMod = (await import(NORMALISER)) as {
        normaliseDistTree: (root: string) => Promise<string[]>;
      };
      await normMod.normaliseDistTree(refOutDir);
      const hashOneShot = hashDtsTree(refOutDir);

      // ── Phase 5: compare the scratch enum's .d.ts specifically ──
      // We look for the scratch-enum.d.ts file in both trees.
      const scratchDts = "scratch-enum.d.ts";
      expect(hashAfterWatch[scratchDts], `watch build missing ${scratchDts}`).toBeDefined();
      expect(hashOneShot[scratchDts], `one-shot build missing ${scratchDts}`).toBeDefined();
      expect(
        hashAfterWatch[scratchDts],
        `build:watch .d.ts for ${scratchDts} differs from one-shot build — normaliser may not have run`,
      ).toBe(hashOneShot[scratchDts]);

      // Also verify the .d.ts actually has sorted ZodEnum keys
      // (confirms the normaliser ran — without it, gamma/alpha/beta would be unsorted).
      const watchedDts = readFileSync(join(watchOutDir, scratchDts), "utf8");
      const alphaIdx = watchedDts.indexOf('"alpha"');
      const betaIdx = watchedDts.indexOf('"beta"');
      const gammaIdx = watchedDts.indexOf('"gamma"');
      if (alphaIdx >= 0 && betaIdx >= 0 && gammaIdx >= 0) {
        // Only assert ordering if the type actually appears in the output
        // (older zod versions may inline differently).
        expect(alphaIdx, "normaliser should have sorted enum keys: alpha < beta").toBeLessThan(betaIdx);
        expect(betaIdx, "normaliser should have sorted enum keys: beta < gamma").toBeLessThan(gammaIdx);
      }
    },
    // Two tsc runs against the scratch project + overhead. Budget is the real
    // hang-backstop and must exceed the sum of the (generous) per-wait ceilings
    // above (60s initial + 60s recompile) under a saturated gate box.
    180_000,
  );

  /**
   * AC2: 5 consecutive edit→settle cycles — zero drift on any pair.
   *
   * We drive the wrapper through 5 back-to-back source edits and verify that
   * after each recompile the .d.ts output hash is identical to the previous cycle's
   * output hash (idempotent normalisation = no drift across cycles).
   *
   * Implementation note: each cycle increments the sentinel counter by one; we
   * wait for sentinel count N, capture a snapshot, then proceed to N+1.
   * The watcher starts at sentinel 1 (initial compile), so cycles 2–6 cover the
   * five consecutive edit→settle pairs.
   */
  it(
    "AC2: 5 consecutive edit→settle cycles produce zero drift (idempotent normalisation)",
    async () => {
      const CYCLES = 5;

      // ── Setup isolated scratch project ──
      const scratchProjectDir = mkdtempSync(join(tmpdir(), "flow-watch-ac2-proj-"));
      const watchOutDir = mkdtempSync(join(tmpdir(), "flow-watch-ac2-out-"));
      activeTmpDirs = [scratchProjectDir, watchOutDir];

      const { tsconfig: scratchTsconfig, srcFile, initialContent } = createScratchProject(
        scratchProjectDir,
        watchOutDir,
      );

      // ── Spawn wrapper ──
      const watcher = spawn("node", [WRAPPER_SCRIPT], {
        cwd: MCP_SERVER_ROOT,
        stdio: ["inherit", "pipe", "inherit"],
        detached: false,
        env: {
          ...process.env,
          WATCH_NORMALISE_TSCONFIG: scratchTsconfig,
          WATCH_NORMALISE_OUT_DIR: watchOutDir,
          WATCH_NORMALISE_DIST_ROOT: watchOutDir,
        },
      }) as ChildProcessWithoutNullStreams;
      activeWatcher = watcher;

      // Attach both waiters immediately so no events are dropped.
      const sentinel = createSentinelWaiter(watcher);
      const normaliser = createNormaliserWaiter(watcher);

      // Wait for initial compile to settle.
      // De-flake: generous ceiling — see the AC1 note. Starvation under the full
      // gate suite, not a real hang, is what blew the old 30s budget.
      const initial = await sentinel.waitFor(1, 60_000);
      expect(initial, "tsc --watch initial compile never settled within 60s").toBe(true);
      // Wait for normaliser to finish initial run — event-driven, no fixed delay.
      const normInitial = await normaliser.waitFor(1, 30_000);
      expect(normInitial, "normaliser did not emit done signal after initial compile").toBe(true);

      const scratchDts = "scratch-enum.d.ts";

      // Capture hash after initial compile.
      const hashes: string[] = [hashDtsTree(watchOutDir)[scratchDts]];
      expect(hashes[0], "scratch-enum.d.ts missing after initial compile").toBeDefined();

      // Run CYCLES iterations of edit→settle.
      for (let i = 0; i < CYCLES; i++) {
        // Alternate between two content variants to guarantee a real file change each cycle.
        const variant = i % 2 === 0
          ? initialContent.trimEnd() + `\n// cycle-${i + 1}\n`
          : initialContent;
        const t = new Date();
        writeFileSync(srcFile, variant);
        utimesSync(srcFile, t, t);

        // Wait for the next sentinel (sentinel count = i + 2 because we started at 1).
        const settled = await sentinel.waitFor(i + 2, 45_000);
        expect(
          settled,
          `cycle ${i + 1}: tsc --watch did not emit success sentinel within 45s`,
        ).toBe(true);

        // Wait for the normaliser to complete — event-driven, not a fixed delay.
        // normaliser count = i + 2 because initial compile produced count 1.
        const normSettled = await normaliser.waitFor(i + 2, 30_000);
        expect(
          normSettled,
          `cycle ${i + 1}: normaliser did not emit done signal within 30s`,
        ).toBe(true);

        const h = hashDtsTree(watchOutDir)[scratchDts];
        expect(h, `cycle ${i + 1}: scratch-enum.d.ts disappeared after recompile`).toBeDefined();

        // The key invariant: after normalisation, the hash must equal the very first
        // normalised hash (regardless of which content variant tsc compiled).
        // We compare against the hash from the previous cycle that used the SAME content
        // variant, or against the initial hash for the first cycle.
        // A simpler invariant: consecutive same-content cycles must produce the same hash.
        if (i >= 1) {
          // Cycle i and cycle i-2 (or cycle 0 for i=2) used the same content variant.
          // The most important property: no hash must differ from the initial hash,
          // because after normalisation all outputs of the same source are equivalent.
          // We allow the actual hash to differ between content variants (that's expected —
          // we added a comment), but for same-content variants they must match.
          const prevSameVariant = hashes[hashes.length - 2]; // two cycles back = same variant
          if (prevSameVariant !== undefined) {
            expect(
              h,
              `cycle ${i + 1}: hash drifted vs two cycles back (same-content variant) — normaliser not idempotent`,
            ).toBe(prevSameVariant);
          }
        }
        hashes.push(h);
      }

      // Final strong assertion: all hashes for even cycles (0, 2, 4) must match each other,
      // and all hashes for odd cycles (1, 3) must match each other. This validates that
      // the normaliser is idempotent and introduces no drift within a variant.
      const evenHashes = hashes.filter((_, idx) => idx % 2 === 0);
      const oddHashes  = hashes.filter((_, idx) => idx % 2 === 1);

      for (let j = 1; j < evenHashes.length; j++) {
        expect(
          evenHashes[j],
          `even-cycle hash[${j}] drifted from hash[0] — normaliser introduced drift`,
        ).toBe(evenHashes[0]);
      }
      for (let j = 1; j < oddHashes.length; j++) {
        expect(
          oddHashes[j],
          `odd-cycle hash[${j}] drifted from hash[1] — normaliser introduced drift`,
        ).toBe(oddHashes[1]);
      }
    },
    // Budget is the real hang-backstop: it must exceed 60s initial + 5 × 45s
    // recompile ceilings + normaliser/hash overhead under a saturated gate box.
    420_000,
  );
});
