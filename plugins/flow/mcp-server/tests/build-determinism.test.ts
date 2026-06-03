import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { normaliseDts } from "../scripts/normalise-dist.mjs";

/**
 * Story 5.24 — AC3 build determinism integration test.
 *
 * Asserts that two consecutive clean builds (tsc + normalise-dist) produce
 * byte-identical `dist/` trees. Catches future regression of the
 * `.d.ts` Zod-enum key-ordering drift documented in
 * `_bmad-output/implementation-artifacts/5-24-zod-determinism-dts-fix.md`.
 *
 * Strategy: build into two separate temp `--outDir`s (so we don't disturb the
 * real `dist/` that other tests in this suite import from). Hash every
 * emitted file's contents and compare the two manifests.
 *
 * Runtime: ~10-20s on a modern machine (two `tsc` runs). Acceptable cost given
 * the recurring-drift history (5+ workaround invocations through May 2026).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_ROOT = resolve(HERE, "..");
const TSCONFIG = resolve(MCP_SERVER_ROOT, "tsconfig.json");
const NORMALISER = resolve(MCP_SERVER_ROOT, "scripts", "normalise-dist.mjs");

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
 * Build a manifest of `{ relativePath: sha256(contents) }` for every file under `root`.
 */
function hashTree(root: string): Record<string, string> {
  const files = listAllFiles(root);
  const manifest: Record<string, string> = {};
  for (const rel of files) {
    const buf = readFileSync(join(root, rel));
    manifest[rel] = createHash("sha256").update(buf).digest("hex");
  }
  return manifest;
}

/**
 * Build into `outDir`. Mirrors the `pnpm build` script: `tsc -p tsconfig.json --outDir <outDir>`
 * then `node scripts/normalise-dist.mjs` pointed at the same dir. We invoke `tsc` via
 * `node_modules/.bin/tsc` to keep the test self-contained (no `pnpm` shell needed).
 *
 * The normaliser script defaults to `<scripts>/../dist` — we override by passing the
 * target as an env var that the script honours, but the published script always normalises
 * its compiled-in `DIST_ROOT`. Easier: import the exported `normaliseDistTree` function
 * directly and call it on the temp dir.
 */
async function buildInto(outDir: string): Promise<void> {
  const tsc = resolve(MCP_SERVER_ROOT, "node_modules", ".bin", "tsc");
  execFileSync(tsc, ["-p", TSCONFIG, "--outDir", outDir], {
    cwd: MCP_SERVER_ROOT,
    stdio: "pipe",
  });
  // Import the normaliser's tree-walker dynamically so the test mirrors the script's behaviour
  // without coupling to its CLI-entry guard.
  const mod = (await import(NORMALISER)) as {
    normaliseDistTree: (root: string) => Promise<string[]>;
  };
  await mod.normaliseDistTree(outDir);
}

describe("Story 5.24 — build determinism (AC3)", () => {
  it("normaliseDts is idempotent on already-sorted input", () => {
    const sorted = [
      "z.ZodEnum<{",
      '    high: "high";',
      '    low: "low";',
      '    medium: "medium";',
      "}>",
    ].join("\n");
    expect(normaliseDts(sorted)).toBe(sorted);
  });

  it("normaliseDts sorts unsorted enum keys alphabetically", () => {
    const unsorted = [
      "z.ZodEnum<{",
      '    medium: "medium";',
      '    low: "low";',
      '    high: "high";',
      "}>",
    ].join("\n");
    const expected = [
      "z.ZodEnum<{",
      '    high: "high";',
      '    low: "low";',
      '    medium: "medium";',
      "}>",
    ].join("\n");
    expect(normaliseDts(unsorted)).toBe(expected);
  });

  it("normaliseDts leaves non-ZodEnum object types untouched", () => {
    // A regular interface — key order may be semantically meaningful (e.g. for tsc
    // doc-comment grouping). We must not touch these.
    const src = [
      "interface Foo {",
      "    z_last: string;",
      "    a_first: number;",
      "}",
    ].join("\n");
    expect(normaliseDts(src)).toBe(src);
  });

  it(
    "two clean builds produce byte-identical dist/ trees",
    async () => {
      const tmpA = mkdtempSync(join(tmpdir(), "flow-build-determinism-A-"));
      const tmpB = mkdtempSync(join(tmpdir(), "flow-build-determinism-B-"));
      try {
        await buildInto(tmpA);
        await buildInto(tmpB);

        const filesA = listAllFiles(tmpA);
        const filesB = listAllFiles(tmpB);
        expect(filesB).toEqual(filesA);

        const hashA = hashTree(tmpA);
        const hashB = hashTree(tmpB);

        // Report which files differ (if any) — far more actionable than a bare diff.
        const drift: string[] = [];
        for (const rel of filesA) {
          if (hashA[rel] !== hashB[rel]) drift.push(rel);
        }
        expect(drift, `expected zero drift; mismatched files: ${drift.join(", ")}`).toEqual([]);
      } finally {
        rmSync(tmpA, { recursive: true, force: true });
        rmSync(tmpB, { recursive: true, force: true });
      }
    },
    // Two tsc runs. Generous timeout for slower CI.
    120_000,
  );

  it("normaliser exists and is executable as a script", () => {
    const stat = statSync(NORMALISER);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  });
});
