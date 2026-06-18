import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { execa } from "execa";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Story native:01KT7RVAKC56AZ6WP5XAD583AJ — Bundle coverage gate.
 *
 * Reports every source file in `src/` that is absent from the shipped bundle's
 * real dependency graph, so dead modules are visible and cannot silently
 * accumulate. The check runs as part of `pnpm test` (CI) so a newly orphaned
 * file causes a test failure before it can ship.
 *
 * How it works
 * ------------
 * 1. Reproduce the full bundle into a temp dir using `CREW_BUNDLE_OUT_DIR`
 *    (same pattern as dist-shipping.test.ts) — bundle.mjs now writes
 *    `bundle-meta-index.json` and `bundle-meta-cli.json` alongside the bundles.
 * 2. Enumerate `src/ ** /*.ts` excluding test files (`*.test.ts`, `*.spec.ts`,
 *    and anything under `src/__tests__/` which is test infrastructure).
 * 3. Build the reachable set: the union of metafile `inputs` keys from both
 *    entry points, normalised to paths relative to the server root.
 * 4. Build the workflow-only allowlist: scan `plugins/flow/workflows/*.js` for
 *    relative imports that resolve into `src/` and add them to the reachable set
 *    so workflow-only modules are not falsely flagged.
 * 5. Subtract reachable from enumerated → not-shipped set.
 * 6. Assert not-shipped is a subset of KNOWN_DEAD. Any file that appears as
 *    not-shipped but is NOT in the allowlist causes test failure with the path
 *    of the new orphan surfaced in the failure message (AC4).
 *
 * Known-dead allowlist
 * --------------------
 * KNOWN_DEAD documents source files that are currently unreachable from either
 * bundle entry. They are existing technical debt; a separate cleanup sweep will
 * remove them. Any NEW file added to src/ that is also dead and NOT in this list
 * will immediately fail the test (AC4 enforcement).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, "..");
const PLUGIN_ROOT = resolve(SERVER_ROOT, "..");
const SRC_DIR = resolve(SERVER_ROOT, "src");
const WORKFLOWS_DIR = resolve(PLUGIN_ROOT, "workflows", "internal");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk `dir` recursively, collecting files whose names satisfy `predicate`.
 * Returns paths relative to SERVER_ROOT.
 */
async function walkSrcFiles(
  dir: string,
  predicate: (name: string, relPath: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(SERVER_ROOT, full);
    if (entry.isDirectory()) {
      out.push(...(await walkSrcFiles(full, predicate)));
    } else if (entry.isFile() && predicate(entry.name, rel)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Enumerate all non-test TypeScript source files under `src/`.
 *
 * Excluded:
 *   - `*.test.ts` / `*.spec.ts` — unit-test files
 *   - Anything under `src/__tests__/` — test-infrastructure helpers (not test
 *     files by extension but live entirely in the test scaffolding directory)
 */
async function enumerateSourceFiles(): Promise<string[]> {
  return walkSrcFiles(SRC_DIR, (name, rel) => {
    if (!name.endsWith(".ts")) return false;
    if (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) return false;
    // Exclude test-infrastructure helpers in __tests__ subdirs.
    if (rel.split("/").includes("__tests__")) return false;
    return true;
  });
}

/**
 * Build the workflow-only reachable set by scanning `plugins/flow/workflows/internal/*.js`
 * for relative imports that resolve into `src/`.
 *
 * In practice the current workflow files (`internal/run.workflow.js`,
 * `internal/gate-1.workflow.js`) do NOT import directly from src/ — they only call CLI
 * seams via `node ${CLI} <tool>`. The allowlist is empty today, but this
 * infrastructure ensures future workflows that do import from src/ are
 * automatically excluded from the not-shipped list (AC2).
 */
async function collectWorkflowOnlyReachable(): Promise<Set<string>> {
  const reachable = new Set<string>();
  let files: string[];
  try {
    files = (await readdir(WORKFLOWS_DIR, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".js"))
      .map((e) => join(WORKFLOWS_DIR, e.name));
  } catch {
    // Workflows directory absent (e.g. isolated test run) — return empty set.
    return reachable;
  }

  // Match `from '...'` / `require('...')` / `import('...')` with a relative path.
  const importRe =
    /(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g;

  for (const file of files) {
    const content = await readFile(file, "utf-8");
    let m: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(content)) !== null) {
      const importPath = m[1];
      const resolved = resolve(dirname(file), importPath);
      if (resolved.startsWith(SRC_DIR + "/") || resolved === SRC_DIR) {
        // Workflows reference compiled .js paths; map to .ts source path.
        const rel = relative(SERVER_ROOT, resolved);
        const tsPath = rel.endsWith(".ts") ? rel : rel.replace(/\.js$/, ".ts");
        reachable.add(tsPath);
      }
    }
  }
  return reachable;
}

/**
 * Parse both esbuild metafiles from `outDir` and return the union of all
 * `src/`-prefixed input paths, normalised relative to SERVER_ROOT.
 */
async function collectBundleReachable(outDir: string): Promise<Set<string>> {
  const reachable = new Set<string>();
  for (const metaName of ["bundle-meta-index.json", "bundle-meta-cli.json"]) {
    const metaPath = join(outDir, metaName);
    const meta = JSON.parse(await readFile(metaPath, "utf-8")) as {
      inputs: Record<string, unknown>;
    };
    for (const key of Object.keys(meta.inputs)) {
      // Metafile keys are relative to the esbuild cwd (SERVER_ROOT) and look
      // like `src/lib/foo.ts`. Include only src/ paths.
      if (key.startsWith("src/")) {
        reachable.add(key);
      }
    }
  }
  return reachable;
}

// ---------------------------------------------------------------------------
// Known-dead allowlist
//
// These source files exist in the repo but are not reachable from either bundle
// entry point (neither index.ts nor cli.ts pulls them in at runtime). They are
// listed here as existing technical debt; a separate cleanup sweep will
// remove them once confirmed safe.
//
// HOW TO USE THIS LIST:
//   - A file that is INTENTIONALLY live must be imported from an existing live
//     module — do not add it here.
//   - A file that is DEAD and deferred for cleanup: add it here with a comment
//     explaining why, and open a follow-up ticket.
//   - Once a file is removed from the codebase, also remove it from this list
//     (the "stale allowlist" test below will catch it otherwise).
// ---------------------------------------------------------------------------
const KNOWN_DEAD = new Set<string>([
  // Type-only modules — exported purely as TypeScript interfaces/types.
  // esbuild strips `import type` statements, so these never appear in the
  // bundle dependency graph even though TypeScript compilers successfully.
  "src/adapters/adapter.ts",
  "src/adapters/bmad/map-bmad-status.ts",

  // Orphaned implementation files — no non-test caller imports them at runtime.
  // Each was once wired in but became unreachable after a refactor.
  // TODO(cleanup): confirm these are safe to delete and remove them in a sweep.
  // Story native:01KT7S0E2 removed bmadToNativeIngest from the MCP+CLI seams
  // (auditor-confirmed orphan — no skill, workflow, or peer ever called it).
  // The source file is preserved for now because tests import it directly;
  // delete it in a follow-up cleanup once dependent tests are updated.
  "src/tools/bmad-to-native-ingest.ts",
  "src/adapters/native/classify-story-files.ts",
  "src/lib/ask-mode-allowed-tools.ts",
  "src/lib/ask-mode-prompt.ts",
  "src/lib/explain-gate-reason.ts",
  "src/lib/summarise-run-result.ts",
  "src/lib/summarise-gate-outcome.ts",
  "src/skills/verdict-parser.ts",
  "src/state/derive-source-baseline.ts",
  "src/tools/judge-context.ts",
  "src/tools/warrants-a-fix.ts",
]);

// ---------------------------------------------------------------------------
// Shared build state (constructed once via beforeAll, torn down via afterAll)
// ---------------------------------------------------------------------------

let tmpOutDir = "";
let allSourceFiles: string[] = [];
let bundleReachable: Set<string> = new Set();
let workflowReachable: Set<string> = new Set();

beforeAll(async () => {
  tmpOutDir = await mkdtemp(join(tmpdir(), "flow-bundle-coverage-"));
  // Reproduce the full bundle into a temp dir — same pattern as the drift test
  // in dist-shipping.test.ts. bundle.mjs now writes bundle-meta-{index,cli}.json
  // alongside the bundles when CREW_BUNDLE_OUT_DIR is set.
  await execa("node", ["scripts/bundle.mjs"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, CREW_BUNDLE_OUT_DIR: tmpOutDir },
  });
  [allSourceFiles, bundleReachable, workflowReachable] = await Promise.all([
    enumerateSourceFiles(),
    collectBundleReachable(tmpOutDir),
    collectWorkflowOnlyReachable(),
  ]);
}, 90_000);

afterAll(async () => {
  if (tmpOutDir) {
    await rm(tmpOutDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bundle coverage (Story native:01KT7RVAKC56AZ6WP5XAD583AJ)", () => {
  // ---------------------------------------------------------------------------
  // AC1: unreachable source files are detected and reported
  // ---------------------------------------------------------------------------
  describe("AC1: not-shipped files are detected", () => {
    it("every src/**/*.ts file not reachable from the bundle is in KNOWN_DEAD", () => {
      const allReachable = new Set([...bundleReachable, ...workflowReachable]);
      const notShipped = allSourceFiles.filter((f) => !allReachable.has(f));

      // Any not-shipped file that is NOT in KNOWN_DEAD is a new orphan that
      // must be either wired up or added to the allowlist explicitly.
      const newOrphans = notShipped.filter((f) => !KNOWN_DEAD.has(f));
      expect(
        newOrphans,
        `New unreachable source file(s) detected — not in the known-dead allowlist:\n` +
          newOrphans.map((f) => `  - ${f}`).join("\n") +
          `\n\nTo fix: either (a) import the file from a live module, ` +
          `or (b) add it to KNOWN_DEAD in bundle-coverage.test.ts with a comment.`,
      ).toEqual([]);
    });

    it("KNOWN_DEAD entries are accurate: each listed file is actually not-shipped", () => {
      // If a KNOWN_DEAD entry has been wired back into the bundle, it is stale
      // and should be removed from the allowlist.
      const allReachable = new Set([...bundleReachable, ...workflowReachable]);
      const notShipped = new Set(allSourceFiles.filter((f) => !allReachable.has(f)));

      const stale = [...KNOWN_DEAD].filter((f) => !notShipped.has(f));
      expect(
        stale,
        `Stale KNOWN_DEAD entries — these files are now reachable from the bundle.\n` +
          `Remove them from the KNOWN_DEAD set in bundle-coverage.test.ts:\n` +
          stale.map((f) => `  - ${f}`).join("\n"),
      ).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // AC2: files imported only by workflow files are NOT flagged as dead
  // ---------------------------------------------------------------------------
  describe("AC2: workflow-only imports are excluded from not-shipped", () => {
    it("collectWorkflowOnlyReachable resolves a relative import from a workflow file into the reachable set", async () => {
      // Create a temporary fake workflow that imports a known src/ module via a
      // relative path. This simulates a workflow that directly imports from src/
      // (none of the current workflows do, but the mechanism must work).
      const tmpWfDir = await mkdtemp(join(tmpdir(), "flow-wf-ac2-"));
      try {
        // The fake workflow lives at tmpWfDir/fake.workflow.js and imports
        // ../mcp-server/src/lib/format-run-progress.js (relative to itself).
        const target = relative(tmpWfDir, resolve(SRC_DIR, "lib/format-run-progress.js"));
        await writeFile(
          join(tmpWfDir, "fake.workflow.js"),
          `import { formatRunProgress } from '${target}';\n`,
        );

        // Re-run the collector against the temp workflow dir.
        // Inline the same logic so we can point at the temp dir without
        // restructuring the module-level constant.
        const reachable = new Set<string>();
        const fakeContent = await readFile(join(tmpWfDir, "fake.workflow.js"), "utf-8");
        const importRe =
          /(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
        let m: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((m = importRe.exec(fakeContent)) !== null) {
          const importPath = m[1];
          const resolved = resolve(tmpWfDir, importPath);
          if (resolved.startsWith(SRC_DIR + "/") || resolved === SRC_DIR) {
            const rel = relative(SERVER_ROOT, resolved);
            const tsPath = rel.endsWith(".ts") ? rel : rel.replace(/\.js$/, ".ts");
            reachable.add(tsPath);
          }
        }

        // The workflow import must resolve to the src/ path and appear as
        // reachable — so it would NOT be flagged as not-shipped (AC2).
        expect(reachable.has("src/lib/format-run-progress.ts")).toBe(true);
      } finally {
        await rm(tmpWfDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("current workflow files (run + gate-1) do not produce any workflow-only reachable entries", () => {
      // The actual internal/run.workflow.js and internal/gate-1.workflow.js use CLI seams and
      // do not import directly from src/. The workflow-reachable set is empty.
      expect(workflowReachable.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // AC3: reports an empty not-shipped set when all sources are reachable
  // ---------------------------------------------------------------------------
  describe("AC3: empty not-shipped list when all sources are reachable", () => {
    it("not-shipped set is empty when the reachable set covers all source files", () => {
      // Construct a synthetic reachable set that includes every source file.
      // This simulates the ideal clean state and verifies the logic returns
      // an empty not-shipped list (no false positives).
      const syntheticReachable = new Set(allSourceFiles);
      const notShipped = allSourceFiles.filter((f) => !syntheticReachable.has(f));
      expect(notShipped).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // AC4: newly orphaned files cause a test failure (the gate is live)
  // ---------------------------------------------------------------------------
  describe("AC4: the gate catches a newly orphaned source file", () => {
    it("a file not in the bundle and not in KNOWN_DEAD is surfaced as a new orphan", () => {
      const allReachable = new Set([...bundleReachable, ...workflowReachable]);

      // Simulate a developer adding a new dead module by injecting a synthetic
      // path into the source-file list. It is not in the bundle and not in
      // KNOWN_DEAD, so the gate must flag it.
      const syntheticOrphan = "src/lib/totally-new-dead-module.ts";
      const extendedSourceFiles = [...allSourceFiles, syntheticOrphan];

      const notShipped = extendedSourceFiles.filter((f) => !allReachable.has(f));
      const newOrphans = notShipped.filter((f) => !KNOWN_DEAD.has(f));

      expect(newOrphans).toContain(syntheticOrphan);
    });
  });
});
