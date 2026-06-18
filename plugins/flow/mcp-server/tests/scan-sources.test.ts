/**
 * Integration tests for the `scanSources` tool (Story 3.2).
 *
 * Each `it` block gets its own scratch dir via `fs.mkdtemp` + `fs.cp` from
 * the committed fixture at `tests/fixtures/scan-sources-fixture/`.
 * Tests never mutate the committed fixture tree — all writes go into the
 * scratch dir.
 *
 * Mtime preservation (AC2): On macOS APFS the mtime resolution is 1 ns, so
 * a second `scanSources` call that writes nothing should leave the mtime
 * untouched. To make this assertion deterministic across CI runners
 * (Linux ext4/tmpfs may have 1 s resolution), we use `fs.utimes` to backdate
 * the mtimes before the second scan so any spurious write is detectable even
 * on 1 s granularity filesystems.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getPluginRoot } from "../src/lib/plugin-root.js";
import { parseExecutionManifest } from "../src/schemas/execution-manifest.js";
import { renderScanResult, scanSources } from "../src/tools/scan-sources.js";
import { atomicWriteFile } from "../src/lib/managed-fs.js";
import { parse as yamlParse } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "scan-sources-fixture");
const DISCIPLINE_FIXTURE_DIR = path.join(HERE, "fixtures", "scan-sources-discipline-fixture");

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-scan-"));
  await fs.cp(FIXTURE_DIR, scratch, { recursive: true });
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — first scan creates manifests for every source story
// ---------------------------------------------------------------------------

it("AC1 — first scan creates manifests for every source story", async () => {
  const result = await scanSources({ targetRepoRoot: scratch });

  expect(result.createdRefs).toHaveLength(2);
  expect(result.createdRefs).toContain("bmad:1.1");
  expect(result.createdRefs).toContain("bmad:1.2");
  expect(result.updatedRefs).toHaveLength(0);
  expect(result.unchangedRefs).toHaveLength(0);
  expect(result.skippedRefs).toHaveLength(0);

  // Verify the on-disk manifest for bmad:1.1 parses and has expected fields.
  const manifestPath11 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.1.yaml");
  const raw11 = await fs.readFile(manifestPath11, "utf8");
  const parsed11 = parseExecutionManifest(yamlParse(raw11), { absPath: manifestPath11 });

  expect(parsed11.status).toBe("to-do");
  expect(parsed11.adapter).toBe("bmad");
  expect(parsed11.ref).toBe("bmad:1.1");

  // Verify source_hash matches what we'd compute from the fixture file bytes.
  const storyBytesA = await fs.readFile(
    path.join(scratch, "_bmad-output", "planning-artifacts", "stories", "1-1-fixture-story-a.md"),
  );
  const expectedHashA = createHash("sha256").update(storyBytesA).digest("hex");
  expect(parsed11.source_hash).toBe(expectedHashA);

  // Verify bmad:1.2 manifest parses too.
  const manifestPath12 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.2.yaml");
  const raw12 = await fs.readFile(manifestPath12, "utf8");
  const parsed12 = parseExecutionManifest(yamlParse(raw12), { absPath: manifestPath12 });
  expect(parsed12.ref).toBe("bmad:1.2");
  expect(parsed12.status).toBe("to-do");
  // bmad:1.2 depends_on bmad:1.1 (from the ## Dependencies section in the fixture).
  expect(parsed12.depends_on).toContain("bmad:1.1");
});

// ---------------------------------------------------------------------------
// AC2 — second scan with no changes is a no-op (idempotent)
// ---------------------------------------------------------------------------

it("AC2 — second scan with no source changes is a no-op", async () => {
  // First scan — creates manifests.
  await scanSources({ targetRepoRoot: scratch });

  const path11 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.1.yaml");
  const path12 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.2.yaml");

  // Backdate mtimes by 5 seconds so any write is detectable even on 1 s granularity.
  // We use the past time as the deterministic baseline.
  const past = new Date(Date.now() - 5000);
  await fs.utimes(path11, past, past);
  await fs.utimes(path12, past, past);

  const mtimeBefore11 = (await fs.stat(path11)).mtimeMs;
  const mtimeBefore12 = (await fs.stat(path12)).mtimeMs;

  // Second scan — should not rewrite anything.
  const result2 = await scanSources({ targetRepoRoot: scratch });

  expect(result2.createdRefs).toHaveLength(0);
  expect(result2.updatedRefs).toHaveLength(0);
  expect(result2.unchangedRefs).toHaveLength(2);
  expect(result2.unchangedRefs).toContain("bmad:1.1");
  expect(result2.unchangedRefs).toContain("bmad:1.2");

  // Mtime must be unchanged — the load-bearing AC2 assertion.
  const mtimeAfter11 = (await fs.stat(path11)).mtimeMs;
  const mtimeAfter12 = (await fs.stat(path12)).mtimeMs;
  expect(mtimeAfter11).toBe(mtimeBefore11);
  expect(mtimeAfter12).toBe(mtimeBefore12);
});

// ---------------------------------------------------------------------------
// AC3 — source edit triggers hash refresh for to-do manifest
// ---------------------------------------------------------------------------

it("AC3 — source edit triggers hash refresh for to-do manifest", async () => {
  // First scan.
  await scanSources({ targetRepoRoot: scratch });

  const path11 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.1.yaml");
  const path12 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.2.yaml");

  // Record bmad:1.2's mtime for the unchanged-check below.
  const past = new Date(Date.now() - 5000);
  await fs.utimes(path12, past, past);
  const mtime12Before = (await fs.stat(path12)).mtimeMs;

  // Read the pre-edit hash of bmad:1.1.
  const rawBefore = await fs.readFile(path11, "utf8");
  const manifestBefore = parseExecutionManifest(yamlParse(rawBefore), { absPath: path11 });
  const hashBefore = manifestBefore.source_hash;

  // Edit the source for story 1.1 (append a newline — changes bytes but stays parseable).
  const storyAPath = path.join(
    scratch,
    "_bmad-output",
    "planning-artifacts",
    "stories",
    "1-1-fixture-story-a.md",
  );
  const originalContent = await fs.readFile(storyAPath, "utf8");
  await fs.writeFile(storyAPath, originalContent + "\n");

  // Compute the expected new hash.
  const newBytes = await fs.readFile(storyAPath);
  const newHash = createHash("sha256").update(newBytes).digest("hex");
  expect(newHash).not.toBe(hashBefore);

  // Second scan — should update bmad:1.1 only.
  const result2 = await scanSources({ targetRepoRoot: scratch });

  expect(result2.updatedRefs).toContain("bmad:1.1");
  expect(result2.updatedRefs).toHaveLength(1);
  expect(result2.unchangedRefs).toContain("bmad:1.2");

  // Verify the manifest now has the new hash.
  const rawAfter = await fs.readFile(path11, "utf8");
  const manifestAfter = parseExecutionManifest(yamlParse(rawAfter), { absPath: path11 });
  expect(manifestAfter.source_hash).toBe(newHash);

  // bmad:1.2 must be untouched (mtime preserved).
  const mtime12After = (await fs.stat(path12)).mtimeMs;
  expect(mtime12After).toBe(mtime12Before);
});

// ---------------------------------------------------------------------------
// AC3 negative — manifest in in-progress/ is NOT touched by re-scan
// ---------------------------------------------------------------------------

it("AC3 — manifest in in-progress/ is NOT touched by re-scan", async () => {
  // First scan — creates to-do/ manifests.
  await scanSources({ targetRepoRoot: scratch });

  const toDoPath11 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.1.yaml");
  const inProgressPath11 = path.join(scratch, ".flow", "state", "in-progress", "bmad:1.1.yaml");

  // Move bmad:1.1 to in-progress/ (simulate claim; bypass state machine in test setup).
  await fs.mkdir(path.dirname(inProgressPath11), { recursive: true });
  await fs.rename(toDoPath11, inProgressPath11);

  // Record the in-progress manifest contents before re-scan.
  const contentsBefore = await fs.readFile(inProgressPath11, "utf8");

  // Edit the source story so a hash-refresh would occur if scan touched it.
  const storyAPath = path.join(
    scratch,
    "_bmad-output",
    "planning-artifacts",
    "stories",
    "1-1-fixture-story-a.md",
  );
  const orig = await fs.readFile(storyAPath, "utf8");
  await fs.writeFile(storyAPath, orig + "\n");

  // Second scan.
  const result2 = await scanSources({ targetRepoRoot: scratch });

  // bmad:1.1 must be in skippedRefs with reason: "not-in-to-do".
  const skippedEntry = result2.skippedRefs.find((s) => s.ref === "bmad:1.1");
  expect(skippedEntry).toBeDefined();
  expect(skippedEntry?.reason).toBe("not-in-to-do");
  expect(result2.updatedRefs).toHaveLength(0);

  // The in-progress manifest must be byte-identical to before the scan.
  const contentsAfter = await fs.readFile(inProgressPath11, "utf8");
  expect(contentsAfter).toBe(contentsBefore);
});

// ---------------------------------------------------------------------------
// AC5 — malformed manifest in to-do/ is contained per-file (Story 5.19 flip)
//
// Pre-5.19: scanSources propagated MalformedExecutionManifestError to the
// boundary on the first malformed manifest, aborting the whole pass.
// Post-5.19: each bad manifest is contained — the ref lands in
// result.skippedRefs with reason "unreadable-manifest" and a non-empty detail,
// and the scan continues with the remaining manifests. See
// scan-sources-readfile-resilience.test.ts for the dedicated coverage.
// ---------------------------------------------------------------------------

describe("AC5 (post 5.19 flip) — malformed manifest is contained, not thrown", () => {
  it("structurally-valid YAML missing a required field (source_hash) is contained per-file", async () => {
    // First scan — create manifests.
    await scanSources({ targetRepoRoot: scratch });

    const path11 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.1.yaml");

    // Overwrite with YAML that is valid YAML but missing required field.
    await fs.writeFile(
      path11,
      "ref: bmad:1.1\nstatus: to-do\nadapter: bmad\nsource_path: some/path.md\ndepends_on: []\nacceptance_criteria:\n  - text: Some AC\n    kind: unit\ntitle: Test\nnarrative: As a test.\nwithdrawn: false\n",
    );

    // Re-scan: must NOT throw; the bad ref lands in skippedRefs.
    const result = await scanSources({ targetRepoRoot: scratch });
    const skipped = result.skippedRefs.find((s) => s.ref === "bmad:1.1");
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toBe("unreadable-manifest");
    expect(skipped!.detail).toBeDefined();
    expect(skipped!.detail!.length).toBeGreaterThan(0);
    // Detail still references the manifest path so the operator can act.
    expect(skipped!.detail).toContain(path11);
  });

  it("YAML with extra unknown key is contained per-file (strict-mode reject path)", async () => {
    // First scan.
    await scanSources({ targetRepoRoot: scratch });

    const path11 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.1.yaml");
    const raw = await fs.readFile(path11, "utf8");
    // Append an unknown key to trigger .strict() rejection.
    await fs.writeFile(path11, raw + "unknown_future_field: surprise\n");

    const result = await scanSources({ targetRepoRoot: scratch });
    const skipped = result.skippedRefs.find((s) => s.ref === "bmad:1.1");
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toBe("unreadable-manifest");
    expect(skipped!.detail).toBeDefined();
    expect(skipped!.detail!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC7 — SKILL.md content anchors (retired — /flow:scan skill removed in
// native:01KVCFDDECZR57R5YH50GYEA17; scan capability lives in MCP tool only)
// ---------------------------------------------------------------------------
// The /flow:scan skill has been retired. The scan capability remains available
// via the scanSources MCP tool, called internally by writeNativeStory and by
// the /flow:plan skill on exit. The skill-file test that previously guarded
// skills/scan/SKILL.md is removed alongside the file itself.

// ---------------------------------------------------------------------------
// Story 3.5 AC4 — scan-sources writes blocked manifest for discipline violation
// ---------------------------------------------------------------------------

describe("AC4 (Story 3.5) — scan-sources blocked manifest on discipline violation", () => {
  let disciplineScratch: string;

  beforeEach(async () => {
    disciplineScratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-scan-disc-"));
    await fs.cp(DISCIPLINE_FIXTURE_DIR, disciplineScratch, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(disciplineScratch, { recursive: true, force: true });
  });

  it("AC4 — state-mutating BMad story without integration AC produces a blocked/ manifest", async () => {
    const result = await scanSources({ targetRepoRoot: disciplineScratch });

    // The story should be skipped (discipline-violation) and blocked.
    expect(result.skippedRefs.some((s) => s.ref === "bmad:2.1" && s.reason === "discipline-violation")).toBe(true);
    expect(result.blockedRefs).toContain("bmad:2.1");
    expect(result.createdRefs).not.toContain("bmad:2.1");

    // The blocked manifest should exist on disk.
    const blockedPath = path.join(disciplineScratch, ".flow", "state", "blocked", "bmad:2.1.yaml");
    const raw = await fs.readFile(blockedPath, "utf8");
    const manifest = yamlParse(raw) as Record<string, unknown>;

    expect(manifest["status"]).toBe("blocked");
    expect(manifest["blocked_by"]).toBe("planning-discipline");
    expect(Array.isArray(manifest["discipline_violations"])).toBe(true);

    const violations = manifest["discipline_violations"] as Array<{ code: string; field: string; detail: string }>;
    expect(violations.some((v) => v.code === "missing-integration-ac")).toBe(true);

    // Manifest MUST NOT also exist in to-do/.
    const toDoPath = path.join(disciplineScratch, ".flow", "state", "to-do", "bmad:2.1.yaml");
    await expect(fs.stat(toDoPath)).rejects.toThrow();
  });

  it("AC4 — two-pass idempotency: second scan does NOT rewrite the blocked manifest when source is unchanged", async () => {
    // First scan — creates the blocked manifest.
    await scanSources({ targetRepoRoot: disciplineScratch });

    const blockedPath = path.join(disciplineScratch, ".flow", "state", "blocked", "bmad:2.1.yaml");

    // Backdate mtime so any rewrite is detectable on 1 s granularity filesystems.
    const past = new Date(Date.now() - 5000);
    await fs.utimes(blockedPath, past, past);
    const mtimeBefore = (await fs.stat(blockedPath)).mtimeMs;

    // Second scan — source unchanged, so must NOT touch the blocked manifest.
    const result2 = await scanSources({ targetRepoRoot: disciplineScratch });

    // blockedRefs should be empty (source unchanged — no re-evaluation triggered).
    expect(result2.blockedRefs).not.toContain("bmad:2.1");
    // The ref should be skipped (reason: not-in-to-do — hash-unchanged short-circuit).
    expect(result2.skippedRefs.some((s) => s.ref === "bmad:2.1" && s.reason === "not-in-to-do")).toBe(true);

    // Mtime must be unchanged — idempotency load-bearing assertion.
    const mtimeAfter = (await fs.stat(blockedPath)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("path (c): source changed AND validator still fails — blocked manifest is rewritten with new hash and violations", async () => {
    // First scan — creates the blocked manifest with the original source_hash.
    await scanSources({ targetRepoRoot: disciplineScratch });

    const blockedPath = path.join(disciplineScratch, ".flow", "state", "blocked", "bmad:2.1.yaml");
    const toDoPath = path.join(disciplineScratch, ".flow", "state", "to-do", "bmad:2.1.yaml");

    const rawAfterFirstScan = await fs.readFile(blockedPath, "utf8");
    const manifestAfterFirstScan = yamlParse(rawAfterFirstScan) as Record<string, unknown>;
    const originalBlockedHash = manifestAfterFirstScan["source_hash"] as string;

    // Edit the source story to change its hash — but keep it discipline-violating
    // (still state-mutating with no integration AC).
    const storyPath = path.join(
      disciplineScratch,
      "_bmad-output",
      "planning-artifacts",
      "stories",
      "2-1-state-mutating-no-integration.md",
    );
    const original = await fs.readFile(storyPath, "utf8");
    // Append a comment to change the content (still no integration AC → still fails).
    const edited = original + "\n<!-- narrative updated, still missing integration AC -->\n";
    await fs.writeFile(storyPath, edited, "utf8");

    const newExpectedHash = createHash("sha256").update(edited).digest("hex");
    expect(newExpectedHash).not.toBe(originalBlockedHash); // Sanity: hash must differ.

    // Second scan — validator re-runs (source hash changed), story still fails.
    const result2 = await scanSources({ targetRepoRoot: disciplineScratch });

    // (i) The blocked manifest's source_hash must be updated to the new hash.
    const rawAfterSecondScan = await fs.readFile(blockedPath, "utf8");
    const manifestAfterSecondScan = yamlParse(rawAfterSecondScan) as Record<string, unknown>;
    expect(manifestAfterSecondScan["source_hash"]).toBe(newExpectedHash);

    // (ii) discipline_violations must reflect the latest validator output (still non-empty).
    const violations = manifestAfterSecondScan["discipline_violations"] as Array<{
      code: string;
      field: string;
      detail: string;
    }>;
    expect(Array.isArray(violations)).toBe(true);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.code === "missing-integration-ac")).toBe(true);

    // (iii) The ref appears in blockedRefs.
    expect(result2.blockedRefs).toContain("bmad:2.1");

    // (iv) No to-do/ manifest was written.
    await expect(fs.stat(toDoPath)).rejects.toThrow();
  });

  it("AC4 — fix-then-rescan: fixing blocked story deletes blocked manifest and writes to-do/ manifest", async () => {
    // First scan — creates the blocked manifest.
    await scanSources({ targetRepoRoot: disciplineScratch });

    const blockedPath = path.join(disciplineScratch, ".flow", "state", "blocked", "bmad:2.1.yaml");
    const toDoPath = path.join(disciplineScratch, ".flow", "state", "to-do", "bmad:2.1.yaml");

    // Verify the blocked manifest exists and to-do/ does not.
    await expect(fs.stat(blockedPath)).resolves.toBeTruthy();
    await expect(fs.stat(toDoPath)).rejects.toThrow();

    // Fix the source story by inserting an integration-tagged AC into the
    // ## Acceptance Criteria section (before the ## Dev Notes section).
    const storyPath = path.join(
      disciplineScratch,
      "_bmad-output",
      "planning-artifacts",
      "stories",
      "2-1-state-mutating-no-integration.md",
    );
    const original = await fs.readFile(storyPath, "utf8");
    // Insert before "## Dev Notes" to stay within the Acceptance Criteria section.
    const fixed = original.replace(
      "## Dev Notes",
      "**AC2 (integration):**\n**Given** the tool runs,\n**When** the manifest is written,\n**Then** the blocked/ manifest is created and verifiable end-to-end.\n\n## Dev Notes",
    );
    await fs.writeFile(storyPath, fixed, "utf8");

    // Second scan — validator re-runs (source hash changed), story now passes.
    const result2 = await scanSources({ targetRepoRoot: disciplineScratch });

    // Story should now be in createdRefs (promoted to to-do/).
    expect(result2.createdRefs).toContain("bmad:2.1");
    expect(result2.blockedRefs).not.toContain("bmad:2.1");
    expect(result2.skippedRefs.some((s) => s.ref === "bmad:2.1")).toBe(false);

    // Blocked manifest must be deleted; to-do/ manifest must now exist.
    await expect(fs.stat(blockedPath)).rejects.toThrow();
    const raw = await fs.readFile(toDoPath, "utf8");
    const manifest = yamlParse(raw) as Record<string, unknown>;
    expect(manifest["status"]).toBe("to-do");
    expect(manifest["ref"]).toBe("bmad:2.1");
  });
});

// ---------------------------------------------------------------------------
// Story 5.22 — renderScanResult cosmetic guarantees
//
// Forward-looking guard: no non-empty line of the rendered output starts with
// whitespace. A future refactor that introduces continuation indent or
// per-section padding would trip this assertion and force an explicit
// re-shape decision instead of quietly drifting.
// ---------------------------------------------------------------------------

describe("renderScanResult cosmetic guarantees (Story 5.22)", () => {
  it("rendered output has no leading whitespace on any non-empty line", async () => {
    // Use the standard 2-story fixture. The resulting render covers all six
    // counts (created/updated/unchanged/skipped/blocked) plus header + adapter
    // lines — comfortably above the AC1 floor of 5 non-empty lines.
    const result = await scanSources({ targetRepoRoot: scratch });
    const rendered = renderScanResult(result);
    const lines = rendered.split("\n");
    const nonEmptyLines = lines.filter((line) => line !== "");

    // Floor per AC1: counts + skippedRefs + blockedRefs sections, typical.
    expect(nonEmptyLines.length).toBeGreaterThanOrEqual(5);

    for (const line of nonEmptyLines) {
      expect(/^\s/.test(line), `leading whitespace detected on line: ${JSON.stringify(line)}`).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Story 10.3 AC1 — Tier-0 fail-closed at scan on a NATIVE workspace.
//   (a) a native story that violates a new check → blocked/ with
//       blocked_by: "planning-discipline" + discipline_violations carrying the
//       new code(s); NOT written to to-do/.
//   (b) a fully-compliant native story scans to to-do/.
//   (c) non-regression — the existing BMad-fixture tests above already prove a
//       BMad source lacking the enriched fields scans exactly as before; this
//       block adds the explicit assertion that the new codes never fire on BMad.
//
// Also covers AC3 (resolvability) end-to-end through the scan path: T0-5
// (cited sources present + resolve) and T0-6 (verification target well-formed;
// artifact: resolves; vitest: shape-only, not required to pre-exist).
// ---------------------------------------------------------------------------

describe("Story 10.3 AC1/AC3 — Tier-0 fail-closed at scan (native workspace)", () => {
  let nativeScratch: string;
  let storiesDir: string;

  // Two valid Crockford Base32 ULIDs (uppercase, 26 chars, no I/L/O/U).
  const ULID_A = "01HZDRF00000000000000000AA";
  const ULID_B = "01HZDRF00000000000000000BB";

  beforeEach(async () => {
    nativeScratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-scan-native-"));
    storiesDir = path.join(nativeScratch, ".flow", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    await atomicWriteFile(
      path.join(nativeScratch, ".flow", "config.yaml"),
      `adapter: native\nadapter_config: {}\n`,
    );
  });

  afterEach(async () => {
    await fs.rm(nativeScratch, { recursive: true, force: true });
  });

  /** Seed a repo-relative file under the native workspace so a path resolves. */
  async function seedFile(relPath: string): Promise<void> {
    const abs = path.join(nativeScratch, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "// seeded\n");
  }

  /**
   * Build a canonical native-story body parseable by parseNativeStory. Defaults
   * are fully Tier-0-compliant; overrides inject specific violations.
   */
  function nativeBody(opts: {
    acVerificationLines?: string[]; // one per AC; omit a line to drop verification
    taskLines?: string[];
    citedLines?: string[];
  } = {}): string {
    const acVer = opts.acVerificationLines ?? [
      "vitest: src/__tests__/a.test.ts",
      "artifact: build/out.json",
    ];
    const tasks = opts.taskLines ?? ["- Build it (AC: 1, 2)"];
    const cited = opts.citedLines ?? ["- src/index.ts"];

    const lines: string[] = [
      "# A native story",
      "",
      "## Narrative",
      "",
      "As a developer, I want a feature, so that I get value.",
      "",
      "## Acceptance Criteria",
      "",
      "**AC1:**",
      "**Given** a state, **When** an action, **Then** an outcome.",
      ...(acVer[0] ? [acVer[0]] : []),
      "",
      "**AC2 (integration):**",
      "**Given** a system, **When** integrated, **Then** an artifact appears.",
      ...(acVer[1] ? [acVer[1]] : []),
      "",
      "## Tasks",
      "",
      ...tasks,
      "",
      "## Cited Sources",
      "",
      ...cited,
      "",
      "## Dependencies",
      "",
      "",
    ];
    return lines.join("\n");
  }

  async function writeStory(ulid: string, body: string): Promise<void> {
    await atomicWriteFile(path.join(storiesDir, `${ulid}.md`), body);
  }

  function blockedPathOf(ulid: string): string {
    return path.join(nativeScratch, ".flow", "state", "blocked", `native:${ulid}.yaml`);
  }
  function toDoPathOf(ulid: string): string {
    return path.join(nativeScratch, ".flow", "state", "to-do", `native:${ulid}.yaml`);
  }

  async function violationCodesFor(ulid: string): Promise<string[]> {
    const raw = await fs.readFile(blockedPathOf(ulid), "utf8");
    const manifest = yamlParse(raw) as Record<string, unknown>;
    expect(manifest["status"]).toBe("blocked");
    expect(manifest["blocked_by"]).toBe("planning-discipline");
    const violations = (manifest["discipline_violations"] ?? []) as Array<{ code: string }>;
    return violations.map((v) => v.code);
  }

  it("(b) a fully-compliant native story scans to to-do/", async () => {
    await seedFile("src/index.ts");
    await seedFile("build/out.json"); // the artifact: target must resolve.
    await writeStory(ULID_A, nativeBody());

    const result = await scanSources({ targetRepoRoot: nativeScratch });

    expect(result.createdRefs).toContain(`native:${ULID_A}`);
    expect(result.blockedRefs).not.toContain(`native:${ULID_A}`);
    const manifest = parseExecutionManifest(
      yamlParse(await fs.readFile(toDoPathOf(ULID_A), "utf8")),
      { absPath: toDoPathOf(ULID_A) },
    );
    expect(manifest.status).toBe("to-do");
    await expect(fs.stat(blockedPathOf(ULID_A))).rejects.toThrow();
  });

  // Note on the parser seam: three of the AC1a-enumerated violations — an AC
  // with no `verification`, a task whose `ac_refs` is empty/dangling, and an
  // empty `cited_sources` section — are caught EARLIER, by the native parser
  // (`parseNativeStory`), which fail-closes on those exact shapes (Story
  // 3.4/10.1/10.2). A native story carrying one of them is structurally
  // un-parseable: it can never be authored via `writeNativeStory` (the
  // write-time gate covers it — see write-native-story.test.ts) and is rejected
  // before the scan validator ever sees it. The pure validator's T0-1/T0-2
  // checks (planning-discipline.test.ts) are the seam that catches them when a
  // story IS presented structurally (the write path, or a future ingest), and
  // are defense-in-depth at scan for any partially-enriched story that slips
  // past the parser. The scan-only NEW behavior this story adds — the disk-side
  // resolvability the parser CANNOT check — is exercised below.

  it("(a) T0-5 — a cited_sources path that does not resolve on disk is blocked with unresolvable-cited-source", async () => {
    await seedFile("build/out.json");
    // Cite a path that does NOT exist on disk → T0-5 resolvability fires at scan.
    await writeStory(ULID_A, nativeBody({ citedLines: ["- src/does-not-exist.ts"] }));

    const result = await scanSources({ targetRepoRoot: nativeScratch });

    expect(result.blockedRefs).toContain(`native:${ULID_A}`);
    expect(await violationCodesFor(ULID_A)).toContain("unresolvable-cited-source");
    await expect(fs.stat(toDoPathOf(ULID_A))).rejects.toThrow();
  });

  it("(a) T0-6 — an artifact: verification target that does not resolve is blocked with unresolvable-verification-target", async () => {
    await seedFile("src/index.ts");
    // Do NOT seed build/out.json — the artifact: target on AC2 won't resolve.
    await writeStory(ULID_A, nativeBody());

    const result = await scanSources({ targetRepoRoot: nativeScratch });

    expect(result.blockedRefs).toContain(`native:${ULID_A}`);
    expect(await violationCodesFor(ULID_A)).toContain("unresolvable-verification-target");
    await expect(fs.stat(toDoPathOf(ULID_A))).rejects.toThrow();
  });

  it("(a) T0-6 — an invented-flag verification target is blocked with invalid-verification-target", async () => {
    await seedFile("src/index.ts");
    await seedFile("build/out.json");
    // AC1 uses an invented flag instead of a path — the rubric's `vitest --grep`
    // anti-pattern. The verification LINE shape (`vitest: vitest --grep foo`)
    // parses as type=vitest, target="vitest --grep foo"; T0-6 rejects the target.
    await writeStory(
      ULID_A,
      nativeBody({
        acVerificationLines: ["vitest: vitest --grep foo", "artifact: build/out.json"],
      }),
    );

    const result = await scanSources({ targetRepoRoot: nativeScratch });

    expect(result.blockedRefs).toContain(`native:${ULID_A}`);
    expect(await violationCodesFor(ULID_A)).toContain("invalid-verification-target");
    await expect(fs.stat(toDoPathOf(ULID_A))).rejects.toThrow();
  });

  it("(b) T0-6 — a brand-new vitest: target (non-existent test file) does NOT block (chicken-and-egg exemption)", async () => {
    await seedFile("src/index.ts");
    await seedFile("build/out.json");
    // AC1's vitest target points at a test the build will create — it does not
    // exist at scan time. It must NOT block: vitest targets are shape-only.
    await writeStory(
      ULID_A,
      nativeBody({
        acVerificationLines: [
          "vitest: src/__tests__/brand-new.test.ts",
          "artifact: build/out.json",
        ],
      }),
    );

    const result = await scanSources({ targetRepoRoot: nativeScratch });
    expect(result.createdRefs).toContain(`native:${ULID_A}`);
    expect(result.blockedRefs).not.toContain(`native:${ULID_A}`);
  });

  it("(a) multiple violations accumulate in the blocked manifest's discipline_violations array", async () => {
    // Neither cited source nor artifact resolves → two distinct disk violations.
    await writeStory(
      ULID_A,
      nativeBody({ citedLines: ["- src/missing.ts"] }), // unseeded → unresolvable
    );
    // build/out.json also unseeded → unresolvable-verification-target.

    await scanSources({ targetRepoRoot: nativeScratch });
    const codes = await violationCodesFor(ULID_A);
    expect(codes).toContain("unresolvable-cited-source");
    expect(codes).toContain("unresolvable-verification-target");
    expect(codes.length).toBeGreaterThanOrEqual(2);
  });

  it("idempotent remediation — fixing the source moves a blocked native story to to-do/ on re-scan", async () => {
    // First scan: unresolvable cited source → blocked.
    await seedFile("build/out.json");
    await writeStory(ULID_A, nativeBody({ citedLines: ["- src/missing.ts"] }));
    await scanSources({ targetRepoRoot: nativeScratch });
    await expect(fs.stat(blockedPathOf(ULID_A))).resolves.toBeTruthy();

    // Fix: seed the cited file AND change the source so the hash differs so the
    // blocked branch re-evaluates.
    await seedFile("src/now-exists.ts");
    await writeStory(ULID_A, nativeBody({ citedLines: ["- src/now-exists.ts"] }));

    const result2 = await scanSources({ targetRepoRoot: nativeScratch });
    expect(result2.createdRefs).toContain(`native:${ULID_A}`);
    expect(result2.blockedRefs).not.toContain(`native:${ULID_A}`);
    await expect(fs.stat(blockedPathOf(ULID_A))).rejects.toThrow();
    await expect(fs.stat(toDoPathOf(ULID_A))).resolves.toBeTruthy();
  });

  it("(c) non-regression — a compliant native and a BMad-shaped scenario coexist; new codes never fire on BMad", async () => {
    // This block runs the native adapter, so we assert the BMad non-regression
    // at the unit-of-behaviour level here: the new codes are gated to native:
    // refs (see planning-discipline.test.ts for the pure-validator assertion and
    // the BMad-fixture tests above for the untouched-scan assertion). Here we
    // simply prove a compliant native story is not collaterally blocked.
    await seedFile("src/index.ts");
    await seedFile("build/out.json");
    await writeStory(ULID_B, nativeBody());

    const result = await scanSources({ targetRepoRoot: nativeScratch });
    expect(result.createdRefs).toContain(`native:${ULID_B}`);
    expect(result.blockedRefs).not.toContain(`native:${ULID_B}`);
  });

  // -------------------------------------------------------------------------
  // Story 10.4 — author-time risk_tier stamping at native to-do/ creation.
  //
  // These tests rely on the SHIPPED default risk-tiering spec (no target-repo
  // override is seeded), so a story citing only `docs/**` / `*.md` paths lands
  // `low`, a story citing a `migrations/**` / `*.sql` path lands `high`, and a
  // story citing only plain source lands the `medium` fallback. The cited
  // sources are seeded on disk so T0-5 resolvability passes and the story is
  // not blocked before it can be stamped.
  // -------------------------------------------------------------------------
  describe("Story 10.4 — author-time risk_tier stamped on native to-do/ manifest", () => {
    function parseToDo(ulid: string): Promise<ReturnType<typeof parseExecutionManifest>> {
      return fs
        .readFile(toDoPathOf(ulid), "utf8")
        .then((raw) =>
          parseExecutionManifest(yamlParse(raw), { absPath: toDoPathOf(ulid) }),
        );
    }

    it("AC1 — a native story citing migrations/**:high; citing only docs/**:low; persisted with evidence", async () => {
      // High: cite a migration path (matches high.schema-or-migration via the
      // migration change-type detected from the migrations/** path).
      await seedFile("db/migrations/0001_add_table.sql");
      await seedFile("build/out.json"); // artifact: verification target must resolve
      await writeStory(
        ULID_A,
        nativeBody({ citedLines: ["- db/migrations/0001_add_table.sql"] }),
      );

      // Low: cite only docs/markdown paths (all-paths-match low.docs-only).
      await seedFile("docs/guide.md");
      await seedFile("README.md");
      await writeStory(
        ULID_B,
        nativeBody({ citedLines: ["- docs/guide.md", "- README.md"] }),
      );

      const result = await scanSources({ targetRepoRoot: nativeScratch });
      expect(result.createdRefs).toContain(`native:${ULID_A}`);
      expect(result.createdRefs).toContain(`native:${ULID_B}`);

      const high = await parseToDo(ULID_A);
      expect(high.risk_tier).toBe("high");
      // Non-fallback evidence — a real rule matched, not the fallback sentinel.
      expect(high.risk_tier_evidence).toBeDefined();
      expect(high.risk_tier_evidence?.matched_rule).not.toBe("fallback");
      expect(high.risk_tier_evidence?.diff_size).toBe(0);

      const low = await parseToDo(ULID_B);
      expect(low.risk_tier).toBe("low");
      expect(low.risk_tier_evidence).toBeDefined();
      expect(low.risk_tier_evidence?.matched_rule).not.toBe("fallback");
    });

    it("AC2 — scanSources runs classifyRiskTier in author-time mode (diff_size 0) and stamps the tier + evidence", async () => {
      await seedFile("docs/notes.md");
      await seedFile("build/out.json");
      await writeStory(ULID_A, nativeBody({ citedLines: ["- docs/notes.md"] }));

      await scanSources({ targetRepoRoot: nativeScratch });

      const manifest = await parseToDo(ULID_A);
      // Stamped from the declared cited source (author-time path signal).
      expect(manifest.risk_tier).toBe("low");
      expect(manifest.risk_tier_evidence?.diff_size).toBe(0);
      // The cited path is reflected in the evidence paths.
      expect(manifest.risk_tier_evidence?.paths).toContain("docs/notes.md");
    });

    it("AC2 — a native story whose cited paths match no rule lands the medium fallback (still persisted)", async () => {
      await seedFile("src/some-feature.ts");
      await seedFile("build/out.json");
      await writeStory(ULID_A, nativeBody({ citedLines: ["- src/some-feature.ts"] }));

      await scanSources({ targetRepoRoot: nativeScratch });

      const manifest = await parseToDo(ULID_A);
      expect(manifest.risk_tier).toBe("medium");
      expect(manifest.risk_tier_evidence?.matched_rule).toBe("fallback");
    });
  });
});

// ---------------------------------------------------------------------------
// Story 10.4 AC2 — BMad non-regression: a BMad story (no cited_sources) is NOT
// stamped. risk_tier stays undefined; the manifest is otherwise unchanged.
// ---------------------------------------------------------------------------

it("Story 10.4 AC2 — a BMad story with no cited_sources is NOT stamped (risk_tier undefined)", async () => {
  const result = await scanSources({ targetRepoRoot: scratch });
  expect(result.createdRefs).toContain("bmad:1.1");

  const manifestPath11 = path.join(scratch, ".flow", "state", "to-do", "bmad:1.1.yaml");
  const parsed11 = parseExecutionManifest(
    yamlParse(await fs.readFile(manifestPath11, "utf8")),
    { absPath: manifestPath11 },
  );
  // No author-time path signal → no stamp. Both fields stay absent.
  expect(parsed11.risk_tier).toBeUndefined();
  expect(parsed11.risk_tier_evidence).toBeUndefined();
  // The on-disk YAML does not even carry the key.
  const raw11 = await fs.readFile(manifestPath11, "utf8");
  expect(raw11).not.toContain("risk_tier");
});
