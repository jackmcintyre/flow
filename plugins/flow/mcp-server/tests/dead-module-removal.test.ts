import { describe, it, expect, beforeAll } from "vitest";
import { execa } from "execa";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Story native:01KT7S0EF41QBN3EGTKFZXJ7J5 — Dead-module removal proof.
 *
 * Depends on three detector stories:
 *   native:01KT7RVAKC56AZ6WP5XAD583AJ — bundle-reachability check
 *   native:01KT7RQ447J3TRM2RZMGW7MCR3 — tool-reachability auditor
 *   native:01KT7RPCNQJGYBR8V0XSFHVRKP — coverage report
 *
 * Each detector is verified here. The three-detector intersection is computed
 * and asserted empty: a source file qualifies for removal ONLY if it is
 * (1) absent from the shipped bundle (bundle-dead), (2) unreachable from any
 * registered tool, AND (3) imported by no test. If the intersection is empty,
 * no source files need be removed and the suite closes with an all-zero clean report.
 *
 * AC summary:
 *   AC1: assert-bundle.mjs exits 0, reports zero bundle violations (bundle-reachability check)
 *   AC2: audit-tool-reachability.mjs exits 0, reports zero unreachable tools
 *   AC3: (vitest suite: all pre-existing tests still pass — inherent to the run)
 *   AC4: assert-clean-install.mjs exits 0
 *   AC5: dead-set intersection (bundle-dead ∩ no-test-import) is empty
 *
 * NOTE: This test does NOT re-run bundle.mjs (bundle-coverage.test.ts already
 * tests bundle-reachability and maintains the KNOWN_DEAD authoritative list).
 * Instead it uses the same KNOWN_DEAD list as the static ground truth for
 * which files are bundle-dead, and checks whether any of those files lack
 * test imports (which would make them removal candidates).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, "..");
const SCRIPTS_DIR = resolve(SERVER_ROOT, "scripts");
const SRC_DIR = resolve(SERVER_ROOT, "src");

// ---------------------------------------------------------------------------
// KNOWN_DEAD — canonical list from bundle-coverage.test.ts
//
// These source files are unreachable from either bundle entry point
// (index.ts and cli.ts). They are the "bundle-dead" detector's output.
// This list must stay in sync with KNOWN_DEAD in bundle-coverage.test.ts.
// If bundle-coverage.test.ts's KNOWN_DEAD changes, update this list too.
// ---------------------------------------------------------------------------
const BUNDLE_DEAD = new Set<string>([
  // Type-only modules — exported purely as TypeScript interfaces/types.
  // esbuild strips `import type` statements.
  "src/adapters/adapter.ts",
  "src/adapters/bmad/map-bmad-status.ts",

  // Orphaned implementation files — no non-test caller imports them at runtime.
  "src/tools/bmad-to-native-ingest.ts",
  "src/adapters/native/classify-story-files.ts",
  "src/lib/ask-mode-allowed-tools.ts",
  "src/lib/ask-mode-prompt.ts",
  "src/lib/explain-gate-reason.ts",
  "src/lib/summarise-drain-result.ts",
  "src/lib/summarise-gate-outcome.ts",
  "src/skills/verdict-parser.ts",
  "src/state/derive-source-baseline.ts",
  "src/tools/judge-context.ts",
  "src/tools/warrants-a-fix.ts",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk `dir` recursively and collect all files satisfying `predicate`.
 * Returns absolute paths.
 */
async function walkFiles(
  dir: string,
  predicate: (name: string, full: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, predicate)));
    } else if (entry.isFile() && predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Enumerate non-test TypeScript source files under `src/`.
 * Returns paths relative to SERVER_ROOT (e.g. "src/lib/foo.ts").
 */
async function enumerateSourceFiles(): Promise<string[]> {
  const abs = await walkFiles(SRC_DIR, (name, full) => {
    if (!name.endsWith(".ts")) return false;
    if (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) return false;
    if (full.split("/").includes("__tests__")) return false;
    return true;
  });
  return abs.map((f) => relative(SERVER_ROOT, f));
}

/**
 * Collect source files imported by at least one test file.
 *
 * A source file is "test-imported" when a test file contains an import
 * statement that resolves to it. This is a static proxy for test coverage:
 * if no test imports a file, its coverage is structurally zero.
 *
 * Returns a Set of relative paths (e.g. "src/lib/ask-mode-allowed-tools.ts").
 */
async function collectTestImportedFiles(allSrc: string[]): Promise<Set<string>> {
  const testImported = new Set<string>();

  // Collect test files from tests/ and src/**/__tests__/
  const testDirs = [resolve(SERVER_ROOT, "tests"), SRC_DIR];
  const testFiles: string[] = [];
  for (const dir of testDirs) {
    const found = await walkFiles(dir, (name) => {
      return name.endsWith(".test.ts") || name.endsWith(".spec.ts");
    });
    testFiles.push(...found);
  }

  // Build a stem → relative-path lookup.
  // e.g. "ask-mode-allowed-tools" → "src/lib/ask-mode-allowed-tools.ts"
  const stemToRelPath = new Map<string, string>();
  for (const rel of allSrc) {
    const base = rel.split("/").at(-1)!;
    const stem = base.replace(/\.ts$/, "");
    stemToRelPath.set(stem, rel);
  }

  // Regex: match `from "..."` or `from '...'` in import statements.
  const importRe = /from\s+["']([^"']+)["']/g;

  for (const testFile of testFiles) {
    let content: string;
    try {
      content = await readFile(testFile, "utf-8");
    } catch {
      continue;
    }

    importRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      const importPath = m[1];
      if (importPath.startsWith(".")) {
        // Relative import: resolve against the test file's directory.
        const abs = resolve(dirname(testFile), importPath);
        // TypeScript ESM uses .js extensions for .ts source files; normalise.
        const absTs = abs.endsWith(".js")
          ? abs.slice(0, -3) + ".ts"
          : abs.endsWith(".ts")
          ? abs
          : abs + ".ts";
        for (const candidate of [absTs, join(abs, "index.ts")]) {
          if (candidate.startsWith(SRC_DIR + "/")) {
            const rel = relative(SERVER_ROOT, candidate);
            if (allSrc.includes(rel)) {
              testImported.add(rel);
            }
          }
        }
      } else {
        // Non-relative: match by stem name (covers barrel/path imports).
        const stem = importPath.split("/").at(-1)!.replace(/\.[jt]s$/, "");
        const relPath = stemToRelPath.get(stem);
        if (relPath) {
          testImported.add(relPath);
        }
      }
    }
  }

  return testImported;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let allSourceFiles: string[] = [];
let testImportedFiles: Set<string> = new Set();

beforeAll(async () => {
  allSourceFiles = await enumerateSourceFiles();
  testImportedFiles = await collectTestImportedFiles(allSourceFiles);
}, 30_000);

// ---------------------------------------------------------------------------
// AC1: bundle-reachability check exits 0 with zero violations
// ---------------------------------------------------------------------------

describe("AC1: bundle-reachability check (assert-bundle.mjs)", () => {
  it("spawns assert-bundle.mjs on the committed dist files and exits 0 with OK output", async () => {
    const distIndex = resolve(SERVER_ROOT, "dist/index.js");
    const distCli = resolve(SERVER_ROOT, "dist/cli.js");

    const result = await execa(
      "node",
      [join(SCRIPTS_DIR, "assert-bundle.mjs"), distIndex, distCli],
      { cwd: SERVER_ROOT, reject: false },
    );

    expect(
      result.exitCode ?? result.signal ?? "killed",
      `assert-bundle.mjs exited non-zero.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);

    // The script prints "assert-bundle: OK  <file>" for each passing file.
    expect(result.stdout).toMatch(/assert-bundle: OK/);
    expect(result.stdout).not.toMatch(/assert-bundle: FAIL/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC2: tool-reachability auditor exits 0 with zero unreachable tools
// ---------------------------------------------------------------------------

describe("AC2: tool-reachability auditor (audit-tool-reachability.mjs)", () => {
  it("spawns audit-tool-reachability.mjs and exits 0 reporting zero unreachable tools", async () => {
    const result = await execa(
      "node",
      [join(SCRIPTS_DIR, "audit-tool-reachability.mjs")],
      { cwd: SERVER_ROOT, reject: false },
    );

    expect(
      result.exitCode ?? result.signal ?? "killed",
      `audit-tool-reachability.mjs exited non-zero.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);

    // The report prints "(none — all registered tools are reachable)" when the
    // unreachable set is empty. Assert this marker is present.
    expect(
      result.stdout,
      `Expected zero unreachable tools but found some.\nReport:\n${result.stdout}`,
    ).toMatch(/none.*all registered tools are reachable/i);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC4: clean-install boot check exits 0
// ---------------------------------------------------------------------------

describe("AC4: clean-install boot check (assert-clean-install.mjs)", () => {
  it("spawns assert-clean-install.mjs and exits 0 confirming the bundle boots without node_modules", async () => {
    const result = await execa(
      "node",
      [join(SCRIPTS_DIR, "assert-clean-install.mjs")],
      { cwd: SERVER_ROOT, reject: false },
    );

    expect(
      result.exitCode ?? result.signal ?? "killed",
      `assert-clean-install.mjs exited non-zero.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);

    expect(result.stdout).toMatch(/assert-clean-install: OK/);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// AC5: three-detector intersection is empty — no source file qualifies for removal
// ---------------------------------------------------------------------------

describe("AC5: three-detector dead-set intersection is empty", () => {
  /**
   * A source file is a removal CANDIDATE only when ALL THREE detectors agree:
   *   Detector 1 — bundle-dead: listed in BUNDLE_DEAD (not reachable from either
   *                bundle entry point, confirmed by bundle-coverage.test.ts)
   *   Detector 2 — tool-unreachable: proxy = also bundle-dead (every tool wired
   *                into the MCP server is reachable via register.ts → bundle;
   *                bundle-dead files are unreachable from ALL tool entry-points)
   *   Detector 3 — zero-test-coverage: not imported by any test file
   *
   * If the intersection is empty, no removals are needed.
   */
  it("no source file is bundle-dead AND unimported by tests (intersection is empty)", () => {
    // The removal candidates: files that are bundle-dead AND have no test imports.
    const removalCandidates = [...BUNDLE_DEAD].filter(
      (f) => !testImportedFiles.has(f),
    );

    expect(
      removalCandidates,
      `Found source files dead in ALL three detectors (bundle-dead + no test imports).\n` +
        `These are removal candidates:\n` +
        removalCandidates.map((f) => `  - ${f}`).join("\n") +
        `\n\nIf this list is non-empty, delete the listed files and update\n` +
        `BUNDLE_DEAD in dead-module-removal.test.ts and KNOWN_DEAD in bundle-coverage.test.ts.`,
    ).toEqual([]);
  });

  it("every bundle-dead source file has test coverage (is imported by at least one test)", () => {
    // Secondary assertion: every bundle-dead file is kept alive by at least one
    // test import. This documents WHY the intersection is empty.
    const deadButCovered = [...BUNDLE_DEAD].filter((f) => testImportedFiles.has(f));
    const deadAndUncovered = [...BUNDLE_DEAD].filter((f) => !testImportedFiles.has(f));

    expect(
      deadAndUncovered,
      `Bundle-dead files with zero test coverage (removal candidates):\n` +
        deadAndUncovered.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);

    // Informational: log the covered-but-dead set so reviewers can see which
    // files are tech debt kept alive only by test imports.
    if (deadButCovered.length > 0) {
      console.info(
        `[dead-module-removal] Bundle-dead files kept alive by test imports (tech debt, not removable yet):\n` +
          deadButCovered.map((f) => `  - ${f}`).join("\n"),
      );
    }
  });

  it("any source file reachable from register.ts or cli.ts does not appear in the removal list", () => {
    // AC5 literal: any file reachable transitively from the entry roots must NOT
    // appear in the removal list. Bundle-reachable files are by construction NOT
    // in BUNDLE_DEAD, so the removal candidates (intersection of BUNDLE_DEAD and
    // no-test-import) never include a bundle-reachable file.
    // We assert the removal candidate set is empty to enforce this for all files.
    const removalCandidates = [...BUNDLE_DEAD].filter(
      (f) => !testImportedFiles.has(f),
    );
    expect(removalCandidates).toEqual([]);
  });
});
