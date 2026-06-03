/**
 * Integration tests for the `scanSources` deps-drift gate — Story 5.13 AC4.
 *
 * Covers the four cases from the spec Test Plan:
 *   (a) prose declares a dep the manifest omits → blocked with deps-drift
 *   (b) prose and manifest agree → to-do (no drift)
 *   (c) manifest has extra dep prose doesn't mention → blocked (symmetric drift)
 *   (d) operator fixes the drift → re-scan promotes from blocked/ to to-do/
 *
 * Each test gets its own scratch dir copied from the committed fixture at
 * `tests/fixtures/scan-sources-deps-drift-fixture/`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { parseExecutionManifest } from "../src/schemas/execution-manifest.js";
import { scanSources, renderScanResult } from "../src/tools/scan-sources.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "scan-sources-deps-drift-fixture");

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-drift-"));
  await fs.cp(FIXTURE_DIR, scratch, { recursive: true });
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC (a): prose declares dep that manifest omits → blocked with deps-drift
// ---------------------------------------------------------------------------

describe("AC (a): prose dep not in manifest", () => {
  it("bmad:1.2 is blocked with blocked_by: deps-drift", async () => {
    const result = await scanSources({ targetRepoRoot: scratch });

    expect(result.blockedRefs).toContain("bmad:1.2");
    expect(result.depsDriftRefs.some((d) => d.ref === "bmad:1.2")).toBe(true);

    const drift = result.depsDriftRefs.find((d) => d.ref === "bmad:1.2")!;
    expect(drift.proseRefs).toContain("bmad:1.1");
    expect(drift.manifestRefs).toHaveLength(0);

    // Verify the on-disk blocked manifest
    const blockedPath = path.join(scratch, ".flow", "state", "blocked", "bmad:1.2.yaml");
    const raw = await fs.readFile(blockedPath, "utf8");
    const parsed = parseExecutionManifest(yamlParse(raw), { absPath: blockedPath });
    expect(parsed.blocked_by).toBe("deps-drift");
    expect(parsed.discipline_violations).toBeDefined();
    expect(parsed.discipline_violations![0]!.code).toBe("deps-drift-prose-vs-manifest");
  });

  it("rendered result contains [deps-drift] line for bmad:1.2", async () => {
    const result = await scanSources({ targetRepoRoot: scratch });
    const rendered = renderScanResult(result);

    // The AC1 surface: [deps-drift] <ref> — prose: {...}, manifest: {...}
    expect(rendered).toMatch(/\[deps-drift\] bmad:1\.2 — prose: \{bmad:1\.1\}, manifest: \{\}/);
  });
});

// ---------------------------------------------------------------------------
// AC (b): prose and manifest agree → to-do (no drift)
// ---------------------------------------------------------------------------

describe("AC (b): prose and manifest agree", () => {
  it("bmad:1.3 is created in to-do/ (no drift)", async () => {
    const result = await scanSources({ targetRepoRoot: scratch });

    expect(result.createdRefs).toContain("bmad:1.3");
    expect(result.blockedRefs).not.toContain("bmad:1.3");
    expect(result.depsDriftRefs.some((d) => d.ref === "bmad:1.3")).toBe(false);

    const todoPath = path.join(scratch, ".flow", "state", "to-do", "bmad:1.3.yaml");
    const raw = await fs.readFile(todoPath, "utf8");
    const parsed = parseExecutionManifest(yamlParse(raw), { absPath: todoPath });
    expect(parsed.status).toBe("to-do");
    expect(parsed.blocked_by).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC (c): manifest has extra dep prose doesn't mention → blocked (symmetric)
// ---------------------------------------------------------------------------

describe("AC (c): manifest superset of prose (symmetric drift)", () => {
  it("bmad:1.4 is blocked with deps-drift", async () => {
    const result = await scanSources({ targetRepoRoot: scratch });

    expect(result.blockedRefs).toContain("bmad:1.4");
    expect(result.depsDriftRefs.some((d) => d.ref === "bmad:1.4")).toBe(true);

    const drift = result.depsDriftRefs.find((d) => d.ref === "bmad:1.4")!;
    // prose says bmad:1.1 only; manifest says bmad:1.1 + bmad:1.3
    expect(drift.proseRefs).toContain("bmad:1.1");
    expect(drift.manifestRefs).toContain("bmad:1.1");
    expect(drift.manifestRefs).toContain("bmad:1.3");

    const blockedPath = path.join(scratch, ".flow", "state", "blocked", "bmad:1.4.yaml");
    const raw = await fs.readFile(blockedPath, "utf8");
    const parsed = parseExecutionManifest(yamlParse(raw), { absPath: blockedPath });
    expect(parsed.blocked_by).toBe("deps-drift");
  });

  it("rendered result contains [deps-drift] line for bmad:1.4 with both prose and manifest sets", async () => {
    const result = await scanSources({ targetRepoRoot: scratch });
    const rendered = renderScanResult(result);

    // manifest refs are bmad:1.1 and bmad:1.3 (sorted); prose is bmad:1.1
    expect(rendered).toMatch(/\[deps-drift\] bmad:1\.4 — prose: \{bmad:1\.1\}, manifest: \{bmad:1\.1, bmad:1\.3\}/);
  });
});

// ---------------------------------------------------------------------------
// AC (d): operator fixes drift → re-scan promotes from blocked/ to to-do/
// ---------------------------------------------------------------------------

describe("AC (d): operator fixes drift, re-scan promotes", () => {
  it("after fixing prose to match manifest, re-scan promotes from blocked/ to to-do/", async () => {
    // First scan — bmad:1.2 ends up in blocked/ (prose has bmad:1.1, manifest has []).
    await scanSources({ targetRepoRoot: scratch });

    const blockedPath = path.join(scratch, ".flow", "state", "blocked", "bmad:1.2.yaml");
    expect(await fs.stat(blockedPath).then(() => true).catch(() => false)).toBe(true);

    // Simulate operator fix: rewrite the story without the prose dep line.
    // (so prose set becomes empty, matching the empty manifest depends_on).
    const storyPath = path.join(
      scratch,
      "_bmad-output",
      "planning-artifacts",
      "stories",
      "1-2-prose-has-dep-manifest-does-not.md",
    );
    // Write a fixed version of the story that has no "Depends on:" prose line.
    const fixedContent = [
      "# Story 1.2: Prose declares dep that manifest omits",
      "",
      "Status: ready-for-dev",
      "",
      "## Story",
      "",
      "As a **fixture story**,",
      "I want **to no longer declare a prose dep**,",
      "so that **the drift resolves on re-scan**.",
      "",
      "## Acceptance Criteria",
      "",
      "**AC1 (integration):**",
      "**Given** this story no longer has a prose dep,",
      "**When** scanSources is called,",
      "**Then** this story is created in to-do/ (no drift).",
      "",
      "## Dev Notes",
      "",
      "Fixed fixture: prose dep removed, no section dep — both empty, no drift.",
    ].join("\n") + "\n";
    await fs.writeFile(storyPath, fixedContent, "utf8");

    // Re-scan — source hash changed, drift check re-runs.
    const result2 = await scanSources({ targetRepoRoot: scratch });

    // bmad:1.2 should now be promoted to to-do/
    expect(result2.createdRefs).toContain("bmad:1.2");
    expect(result2.blockedRefs).not.toContain("bmad:1.2");
    expect(result2.depsDriftRefs.some((d) => d.ref === "bmad:1.2")).toBe(false);

    const todoPath = path.join(scratch, ".flow", "state", "to-do", "bmad:1.2.yaml");
    expect(await fs.stat(todoPath).then(() => true).catch(() => false)).toBe(true);

    // blocked/ manifest should be removed
    expect(await fs.stat(blockedPath).then(() => true).catch(() => false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bmad:1.1 (no deps, no prose deps) — should pass cleanly
// ---------------------------------------------------------------------------

it("bmad:1.1 (no deps anywhere) is created in to-do/ without drift", async () => {
  const result = await scanSources({ targetRepoRoot: scratch });
  expect(result.createdRefs).toContain("bmad:1.1");
  expect(result.depsDriftRefs.some((d) => d.ref === "bmad:1.1")).toBe(false);
});
