/**
 * Unit tests for `lib/gh-error-map.ts`.
 *
 * Covers:
 *   (a) Parser happy path — shipped v1 rows (AC1f)
 *   (b) Each malformed case from AC3h:
 *       - unknown top-level key (AC1e)
 *       - unknown per-entry key (AC1e)
 *       - `class` not in the literal set (AC1b)
 *       - `stderr_regex` that fails to compile (AC1c)
 *       - `exit_code` missing (AC1b)
 *   (c) `classifyGhError` returns first match in order (AC3f / AC1d)
 *   (d) `classifyGhError` matches on exit_code alone when no regex (AC3g)
 *   (e) `classifyGhError` returns `null` on unmapped result (AC3e)
 *   (f) Cache memoisation — two calls → one parse (AC1h)
 *   (g) `__resetGhErrorMapCacheForTests` resets (AC1h / AC3i)
 *   (h) Spot-check: shipped `gh-error-map.yaml` parses cleanly (Task 2.2)
 *
 * Story 4.5 Task 1.4
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseGhErrorMap,
  loadGhErrorMap,
  classifyGhError,
  __resetGhErrorMapCacheForTests,
} from "../gh-error-map.js";
import { MalformedGhErrorMapError } from "../../errors.js";
import { atomicWriteFile } from "../managed-fs.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gh-error-map-test-"));
  __resetGhErrorMapCacheForTests();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  __resetGhErrorMapCacheForTests();
});

async function writeMap(content: string): Promise<string> {
  const filePath = path.join(tmpDir, "gh-error-map.yaml");
  await atomicWriteFile(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// (a) Parser happy path — shipped v1 rows
// ---------------------------------------------------------------------------

describe("(a) parseGhErrorMap — happy path with v1 rows", () => {
  it("parses the three v1 rows with compiled regex instances", async () => {
    const filePath = await writeMap(`
entries:
  - exit_code: 4
    stderr_regex: "requires authentication|gh auth login"
    class: needs-human
  - exit_code: 4
    stderr_regex: "API rate limit exceeded|secondary rate limit"
    class: defer
  - exit_code: 1
    stderr_regex: "dial tcp|connection reset|could not resolve host|i/o timeout|network is unreachable"
    class: retry
`);
    const result = await parseGhErrorMap(filePath);
    expect(result.entries).toHaveLength(3);

    const authEntry = result.entries[0]!;
    const rateEntry = result.entries[1]!;
    const networkEntry = result.entries[2]!;

    // Auth entry
    expect(authEntry.exit_code).toBe(4);
    expect(authEntry.class).toBe("needs-human");
    expect(authEntry.stderr_regex).toBeInstanceOf(RegExp);
    expect(authEntry.stderr_regex!.test("requires authentication")).toBe(true);
    expect(authEntry.stderr_regex!.test("API rate limit exceeded")).toBe(false);

    // Rate limit entry
    expect(rateEntry.exit_code).toBe(4);
    expect(rateEntry.class).toBe("defer");
    expect(rateEntry.stderr_regex).toBeInstanceOf(RegExp);
    expect(rateEntry.stderr_regex!.test("API rate limit exceeded")).toBe(true);

    // Network entry
    expect(networkEntry.exit_code).toBe(1);
    expect(networkEntry.class).toBe("retry");
    expect(networkEntry.stderr_regex).toBeInstanceOf(RegExp);
    expect(networkEntry.stderr_regex!.test("dial tcp: lookup api.github.com: i/o timeout")).toBe(true);
  });

  it("parses an empty entries list without error", async () => {
    const filePath = await writeMap("entries: []\n");
    const result = await parseGhErrorMap(filePath);
    expect(result.entries).toHaveLength(0);
  });

  it("parses an entry without stderr_regex (exit_code-only match)", async () => {
    const filePath = await writeMap(`
entries:
  - exit_code: 99
    class: defer
`);
    const result = await parseGhErrorMap(filePath);
    expect(result.entries[0]!.stderr_regex).toBeUndefined();
    expect(result.entries[0]!.exit_code).toBe(99);
    expect(result.entries[0]!.class).toBe("defer");
  });
});

// ---------------------------------------------------------------------------
// (b) Malformed cases (AC3h)
// ---------------------------------------------------------------------------

describe("(b) parseGhErrorMap — malformed cases (AC3h)", () => {
  it("(i) unknown top-level key raises MalformedGhErrorMapError", async () => {
    const filePath = await writeMap(`
entries: []
unknown_key: true
`);
    await expect(parseGhErrorMap(filePath)).rejects.toBeInstanceOf(MalformedGhErrorMapError);
  });

  it("(ii) unknown per-entry key raises MalformedGhErrorMapError citing the row", async () => {
    const filePath = await writeMap(`
entries:
  - exit_code: 4
    class: defer
    unknown_entry_key: foo
`);
    const err = await parseGhErrorMap(filePath).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedGhErrorMapError);
    // rowIndex should be 1 (first entry)
    expect((err as MalformedGhErrorMapError).rowIndex).toBe(1);
  });

  it("(iii) class not in literal set raises MalformedGhErrorMapError", async () => {
    const filePath = await writeMap(`
entries:
  - exit_code: 4
    class: invalid-class
`);
    const err = await parseGhErrorMap(filePath).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedGhErrorMapError);
    expect((err as MalformedGhErrorMapError).rowIndex).toBe(1);
    expect((err as MalformedGhErrorMapError).offendingKey).toBe("class");
  });

  it("(iv) stderr_regex that fails to compile raises MalformedGhErrorMapError", async () => {
    const filePath = await writeMap(`
entries:
  - exit_code: 4
    class: defer
    stderr_regex: "["
`);
    const err = await parseGhErrorMap(filePath).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedGhErrorMapError);
    expect((err as MalformedGhErrorMapError).reason).toBe("stderr_regex did not compile");
    expect((err as MalformedGhErrorMapError).rowIndex).toBe(1);
  });

  it("(v) exit_code missing raises MalformedGhErrorMapError", async () => {
    const filePath = await writeMap(`
entries:
  - class: defer
`);
    const err = await parseGhErrorMap(filePath).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedGhErrorMapError);
  });
});

// ---------------------------------------------------------------------------
// (c) classifyGhError — first match in order (AC3f / AC1d)
// ---------------------------------------------------------------------------

describe("(c) classifyGhError — first match wins (AC3f)", () => {
  it("with needs-human auth row before defer rate-limit row, exit=4 stderr=requires auth → needs-human", async () => {
    const filePath = await writeMap(`
entries:
  - exit_code: 4
    stderr_regex: "requires authentication|gh auth login"
    class: needs-human
  - exit_code: 4
    stderr_regex: "API rate limit exceeded|secondary rate limit"
    class: defer
`);
    const map = await parseGhErrorMap(filePath);

    const r1 = classifyGhError({ exitCode: 4, stderr: "requires authentication" }, map);
    expect(r1).toBe("needs-human");

    const r2 = classifyGhError({ exitCode: 4, stderr: "API rate limit exceeded" }, map);
    expect(r2).toBe("defer");
  });

  it("returns the first matching class even if later rows also match", async () => {
    const filePath = await writeMap(`
entries:
  - exit_code: 4
    class: defer
  - exit_code: 4
    class: needs-human
`);
    const map = await parseGhErrorMap(filePath);
    // First catch-all exit_code:4 row should win
    expect(classifyGhError({ exitCode: 4, stderr: "anything" }, map)).toBe("defer");
  });
});

// ---------------------------------------------------------------------------
// (d) classifyGhError — exit_code only (AC3g)
// ---------------------------------------------------------------------------

describe("(d) classifyGhError — exit_code-only match (AC3g)", () => {
  it("matches any stderr when no regex is present", async () => {
    const filePath = await writeMap(`
entries:
  - exit_code: 99
    class: defer
`);
    const map = await parseGhErrorMap(filePath);
    expect(classifyGhError({ exitCode: 99, stderr: "" }, map)).toBe("defer");
    expect(classifyGhError({ exitCode: 99, stderr: "anything at all" }, map)).toBe("defer");
  });
});

// ---------------------------------------------------------------------------
// (e) classifyGhError — null on unmapped result (AC3e)
// ---------------------------------------------------------------------------

describe("(e) classifyGhError — null on unmapped (AC3e)", () => {
  it("returns null when no entry matches", async () => {
    const filePath = await writeMap(`
entries:
  - exit_code: 4
    stderr_regex: "requires authentication"
    class: needs-human
`);
    const map = await parseGhErrorMap(filePath);

    // Wrong exit code
    expect(classifyGhError({ exitCode: 1, stderr: "requires authentication" }, map)).toBeNull();
    // Right exit code, wrong stderr
    expect(classifyGhError({ exitCode: 4, stderr: "pull request already exists for branch" }, map)).toBeNull();
    // No match at all
    expect(classifyGhError({ exitCode: 99, stderr: "random error" }, map)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (f) Cache memoisation — two calls → one parse (AC1h)
// ---------------------------------------------------------------------------

describe("(f) loadGhErrorMap — cache memoisation (AC1h)", () => {
  it("two calls to loadGhErrorMap return the same object identity (cached)", async () => {
    // Create a fake plugin root layout
    const fakePluginRoot = path.join(tmpDir, "plugin-root");
    await fs.mkdir(path.join(fakePluginRoot, "permissions"), { recursive: true });
    await atomicWriteFile(
      path.join(fakePluginRoot, "permissions", "gh-error-map.yaml"),
      `
entries:
  - exit_code: 4
    class: defer
`,
    );

    const r1 = await loadGhErrorMap(fakePluginRoot);
    const r2 = await loadGhErrorMap(fakePluginRoot);

    // Same object identity — the cache returned the same reference.
    expect(r1).toBe(r2);
    // Both have the same entries
    expect(r1.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (g) __resetGhErrorMapCacheForTests resets (AC1h / AC3i)
// ---------------------------------------------------------------------------

describe("(g) __resetGhErrorMapCacheForTests resets (AC3i)", () => {
  it("after reset, loadGhErrorMap re-reads from disk", async () => {
    const fakePluginRoot = path.join(tmpDir, "plugin-root-reset");
    await fs.mkdir(path.join(fakePluginRoot, "permissions"), { recursive: true });
    const mapPath = path.join(fakePluginRoot, "permissions", "gh-error-map.yaml");
    await atomicWriteFile(mapPath, "entries: []\n");

    const r1 = await loadGhErrorMap(fakePluginRoot);
    expect(r1.entries).toHaveLength(0);

    // Write a new version
    __resetGhErrorMapCacheForTests();
    await atomicWriteFile(mapPath, `
entries:
  - exit_code: 1
    class: retry
`);

    const r2 = await loadGhErrorMap(fakePluginRoot);
    expect(r2.entries).toHaveLength(1);
    expect(r2).not.toBe(r1);
  });
});

// ---------------------------------------------------------------------------
// (h) Spot-check: shipped gh-error-map.yaml parses cleanly (Task 2.2)
// ---------------------------------------------------------------------------

describe("(h) shipped gh-error-map.yaml parses cleanly (Task 2.2)", () => {
  it("parses the actual shipped file and returns the 3 v1 rows", async () => {
    // The shipped file lives at plugins/flow/permissions/gh-error-map.yaml.
    // This test file is at mcp-server/src/lib/__tests__/gh-error-map.test.ts.
    // Going up 4 directories from __tests__ → lib → src → mcp-server → plugins/flow.
    const shippedPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",    // lib
      "..",    // src
      "..",    // mcp-server
      "..",    // plugins/flow
      "permissions",
      "gh-error-map.yaml",
    );
    const result = await parseGhErrorMap(shippedPath);
    expect(result.entries).toHaveLength(3);
    // Spot-check classes
    const classes = result.entries.map((e) => e.class);
    expect(classes).toContain("needs-human");
    expect(classes).toContain("defer");
    expect(classes).toContain("retry");
  });
});
