/**
 * Tests for the runnable-test-kind discipline check
 * (Story native:01KV6S35N4VF64WZT99SMZSFRJ).
 *
 * A `vitest:` verification target must point at a recognised runnable test
 * (file named `.test.ts` / `.spec.ts` etc., or living under `__tests__/`).
 * Pointing at an ordinary source file runs zero tests and is refused at both
 * the save gate and scan time via the shared `resolveDisciplinePaths` function.
 *
 * Test matrix:
 *   - AC1: clean-pass — a valid runnable-test `vitest:` target is accepted.
 *   - AC2: refusal — a source-file `vitest:` target is refused with a
 *     `non-runnable-test-target` violation naming exactly which criterion is
 *     wrong and explaining that its proof is not a runnable test.
 *   - Back-compat: a non-test-based (`artifact:`) proof is unaffected by the
 *     new rule.
 *
 * Tests use `resolveDisciplinePaths` directly (the shared implementation both
 * callers invoke) so the parity guarantee holds without end-to-end plumbing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { resolveDisciplinePaths, isRunnableTestTarget } from "../discipline-resolvability.js";
import type { SourceStory } from "../../adapters/adapter.js";

let root: string;

/** Seed a repo-relative file so resolvability checks pass for it. */
async function seedFile(relPath: string): Promise<void> {
  await atomicWriteFile(path.join(root, relPath), "// seeded\n");
}

/**
 * Build a Tier-0-compliant native SourceStory for testing.
 *
 * Defaults: one `vitest:` AC pointing at a recognisable test file, one task,
 * one cited source. Callers override only the fields relevant to their test.
 */
function makeStory(overrides: Partial<SourceStory> = {}): SourceStory {
  return {
    ref: "native:RUNNABLETESTTEST00000000001",
    title: "Runnable-test-kind check test story",
    narrative: "As an operator, I want the check to pass, so that the story enters the backlog.",
    acceptance_criteria: [
      {
        text: "Given a valid test target When the story is saved Then it is accepted.",
        kind: "integration",
        verification: {
          type: "vitest",
          target: "src/validators/__tests__/discipline-runnable-test-kind.test.ts",
        },
      },
    ],
    tasks: [{ text: "Implement the check", ac_refs: ["AC1"] }],
    cited_sources: ["src/validators/discipline-resolvability.ts"],
    depends_on: [],
    raw_path: "/fake/story.md",
    raw_frontmatter: {},
    source_hash: "a".repeat(64),
    ...overrides,
  };
}

beforeEach(async () => {
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "flow-runnable-test-kind-"),
  );
  root = path.join(scratch, "workspace");
  await fs.mkdir(path.join(root, ".flow", "native-stories"), { recursive: true });
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    `adapter: native\nadapter_config: {}\n`,
  );
  // Seed the cited source so the cited-source check never false-fires.
  await seedFile("src/validators/discipline-resolvability.ts");
  // Seed a package.json at the repo root so the vitest-target resolvability
  // check (Story native:01KVS2MG) resolves a package for default targets like
  // `src/validators/__tests__/foo.test.ts` (findPackageRoot walks up to here).
  await atomicWriteFile(path.join(root, "package.json"), `{ "name": "fixture" }\n`);
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isRunnableTestTarget — unit tests for the pure helper
// ---------------------------------------------------------------------------

describe("isRunnableTestTarget — recognises conventional test file patterns", () => {
  it("accepts a .test.ts file", () => {
    expect(isRunnableTestTarget("src/validators/__tests__/foo.test.ts")).toBe(true);
  });

  it("accepts a .spec.ts file at the root", () => {
    expect(isRunnableTestTarget("src/foo.spec.ts")).toBe(true);
  });

  it("accepts a .test.js file", () => {
    expect(isRunnableTestTarget("lib/util.test.js")).toBe(true);
  });

  it("accepts a .spec.jsx file", () => {
    expect(isRunnableTestTarget("components/Button.spec.jsx")).toBe(true);
  });

  it("accepts a .test.tsx file", () => {
    expect(isRunnableTestTarget("src/components/App.test.tsx")).toBe(true);
  });

  it("accepts a file inside __tests__/ without a .test. suffix", () => {
    // A file in __tests__/ is conventionally a test even without the suffix.
    expect(isRunnableTestTarget("src/__tests__/helpers.ts")).toBe(true);
  });

  it("accepts a __tests__/ path using forward slash", () => {
    expect(isRunnableTestTarget("plugins/flow/__tests__/integration.ts")).toBe(true);
  });

  it("rejects an ordinary source file", () => {
    expect(isRunnableTestTarget("src/validators/discipline-resolvability.ts")).toBe(false);
  });

  it("rejects a source file that has 'test' in its name but not as the right extension segment", () => {
    // e.g. a file called test-utils.ts — 'test' appears but it is not '.test.ts'
    expect(isRunnableTestTarget("src/lib/test-utils.ts")).toBe(false);
  });

  it("rejects a plain .ts file at the root level", () => {
    expect(isRunnableTestTarget("index.ts")).toBe(false);
  });

  it("rejects a built artifact", () => {
    expect(isRunnableTestTarget("dist/cli.js")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC1 — clean-pass: valid runnable-test vitest: target is accepted
// ---------------------------------------------------------------------------

describe("AC1 — vitest: target pointing at a runnable test: no non-runnable-test-target violation", () => {
  it("returns zero violations for a .test.ts target", async () => {
    const story = makeStory({
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z",
          kind: "integration",
          verification: {
            type: "vitest",
            target: "src/validators/__tests__/foo.test.ts",
          },
        },
      ],
    });

    const violations = await resolveDisciplinePaths(story, root);

    const kindViolations = violations.filter((v) => v.code === "non-runnable-test-target");
    expect(kindViolations).toHaveLength(0);
  });

  it("returns zero violations for a .spec.ts target", async () => {
    const story = makeStory({
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z",
          kind: "integration",
          verification: {
            type: "vitest",
            target: "src/__tests__/my-feature.spec.ts",
          },
        },
      ],
    });

    const violations = await resolveDisciplinePaths(story, root);
    const kindViolations = violations.filter((v) => v.code === "non-runnable-test-target");
    expect(kindViolations).toHaveLength(0);
  });

  it("returns zero violations for a path inside __tests__/", async () => {
    const story = makeStory({
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z",
          kind: "unit",
          verification: {
            type: "vitest",
            target: "plugins/flow/__tests__/integration-helpers.ts",
          },
        },
      ],
    });

    const violations = await resolveDisciplinePaths(story, root);
    const kindViolations = violations.filter((v) => v.code === "non-runnable-test-target");
    expect(kindViolations).toHaveLength(0);
  });

  it("proceeds as today — no new objection beyond what the existing T0-6 shape check enforces", async () => {
    // A fully compliant story with a valid vitest: target must pass clean
    // through resolveDisciplinePaths (zero violations of any kind).
    const story = makeStory(); // default has a .test.ts target + seeded cited source

    const violations = await resolveDisciplinePaths(story, root);
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — refusal: source-file vitest: target is refused with a named reason
// ---------------------------------------------------------------------------

describe("AC2 — vitest: target pointing at an ordinary source file: non-runnable-test-target violation", () => {
  it("emits a non-runnable-test-target violation naming the offending AC and explaining the problem", async () => {
    const sourceFileTarget = "src/validators/discipline-resolvability.ts";

    const story = makeStory({
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z.",
          kind: "integration",
          verification: {
            type: "vitest",
            target: sourceFileTarget,
          },
        },
      ],
    });

    const violations = await resolveDisciplinePaths(story, root);
    const kindViolations = violations.filter((v) => v.code === "non-runnable-test-target");

    // Exactly one violation of the new kind.
    expect(kindViolations).toHaveLength(1);

    const v = kindViolations[0]!;
    // Must name the offending AC (AC1 in this case).
    expect(v.detail).toMatch(/AC1/);
    // Must name the target path in the reason.
    expect(v.detail).toContain(sourceFileTarget);
    // Must explain in plain language that the proof is not a runnable test.
    expect(v.detail.toLowerCase()).toMatch(/not a runnable test|runs zero tests/);
  });

  it("names the correct AC index when the source-file proof is AC2 (not AC1)", async () => {
    const story = makeStory({
      acceptance_criteria: [
        {
          text: "AC1 is fine.",
          kind: "unit",
          verification: {
            type: "vitest",
            target: "src/__tests__/good.test.ts",
          },
        },
        {
          text: "AC2 is the bad one.",
          kind: "integration",
          verification: {
            type: "vitest",
            target: "src/tools/write-native-story.ts", // ordinary source file
          },
        },
      ],
    });

    const violations = await resolveDisciplinePaths(story, root);
    const kindViolations = violations.filter((v) => v.code === "non-runnable-test-target");

    // Only AC2 should fire.
    expect(kindViolations).toHaveLength(1);
    expect(kindViolations[0]?.detail).toMatch(/AC2/);
    expect(kindViolations[0]?.detail).toContain("src/tools/write-native-story.ts");
  });

  it("fires on every AC that has a source-file proof when multiple ACs are wrong", async () => {
    const story = makeStory({
      acceptance_criteria: [
        {
          text: "Bad AC1.",
          kind: "integration",
          verification: {
            type: "vitest",
            target: "src/tools/scan-sources.ts", // source file
          },
        },
        {
          text: "Bad AC2.",
          kind: "integration",
          verification: {
            type: "vitest",
            target: "src/adapters/adapter.ts", // source file
          },
        },
      ],
    });

    const violations = await resolveDisciplinePaths(story, root);
    const kindViolations = violations.filter((v) => v.code === "non-runnable-test-target");

    expect(kindViolations).toHaveLength(2);
    expect(kindViolations.some((v) => v.detail.includes("scan-sources.ts"))).toBe(true);
    expect(kindViolations.some((v) => v.detail.includes("adapter.ts"))).toBe(true);
  });

  it("does NOT write a story entry — the violation prevents any manifest from being admitted (structural: save gate throws)", async () => {
    // This is tested structurally: `resolveDisciplinePaths` returns violations
    // (non-empty array), which causes the save gate (`renderGateWriteNativeStory`)
    // to throw `DisciplineViolationError` BEFORE writing the story file.
    // We verify the violation array is non-empty — that is the signal the save
    // gate and scan path both check before writing.
    const story = makeStory({
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z.",
          kind: "integration",
          verification: {
            type: "vitest",
            target: "src/validators/planning-discipline.ts", // source file
          },
        },
      ],
    });

    const violations = await resolveDisciplinePaths(story, root);

    // A non-empty array means the gate refuses. The save-gate path calls
    // `throw new DisciplineViolationError({ violations })` on any violations.length > 0.
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.code === "non-runnable-test-target")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Back-compat — non-test-based proof kinds are unaffected
// ---------------------------------------------------------------------------

describe("back-compat — artifact: proof is unaffected by the runnable-test-kind rule", () => {
  it("does not emit non-runnable-test-target for an artifact: target pointing at a source-like path", async () => {
    // An artifact: proof pointing at any path should NOT trigger the new
    // runnable-test-kind check — the check applies to vitest: proofs only.
    // We seed the artifact file so the T0-6 existence check passes too.
    await seedFile("dist/output.json");

    const story = makeStory({
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z.",
          kind: "integration",
          verification: {
            type: "artifact",
            target: "dist/output.json",
          },
        },
      ],
    });

    const violations = await resolveDisciplinePaths(story, root);
    const kindViolations = violations.filter((v) => v.code === "non-runnable-test-target");

    // The new rule must NOT fire for artifact: proofs.
    expect(kindViolations).toHaveLength(0);
  });

  it("does not emit non-runnable-test-target when there are no vitest: ACs at all", async () => {
    // A story with zero vitest: ACs should be entirely unaffected.
    await seedFile("dist/manifest.json");

    const story = makeStory({
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z.",
          kind: "integration",
          verification: {
            type: "artifact",
            target: "dist/manifest.json",
          },
        },
      ],
    });

    const violations = await resolveDisciplinePaths(story, root);
    const kindViolations = violations.filter((v) => v.code === "non-runnable-test-target");
    expect(kindViolations).toHaveLength(0);
  });

  it("does not emit unresolvable-test-target for a BMad story (non-enriched, gated by isEnrichedStory)", async () => {
    // A BMad story whose vitest: target would NOT resolve to a package must still
    // be skipped entirely — resolveDisciplinePaths returns [] for non-enriched.
    const bmadStory: SourceStory = {
      ref: "bmad:2.7",
      title: "BMad story with wrong-prefix vitest target",
      narrative: "As a user, I want things.",
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z.",
          kind: "integration",
          // wrong-prefix target with no package above it — would fire for native.
          verification: { type: "vitest", target: "mcp-server/tests/x.test.ts" },
        },
      ],
      depends_on: [],
      raw_path: "/fake/bmad.md",
      raw_frontmatter: {},
      source_hash: "c".repeat(64),
    };

    const violations = await resolveDisciplinePaths(bmadStory, root);
    expect(violations).toHaveLength(0);
  });

  it("does not emit non-runnable-test-target for a BMad story (non-enriched, gated by isEnrichedStory)", async () => {
    // BMad stories are non-enriched (bmad: ref). resolveDisciplinePaths returns
    // [] immediately for non-enriched stories — no new check fires.
    const bmadStory: SourceStory = {
      ref: "bmad:1.5",
      title: "BMad story",
      narrative: "As a user, I want things.",
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z.",
          kind: "integration",
          // vitest: proof pointing at a source file — would fire for a native story.
          verification: { type: "vitest", target: "src/tools/scan-sources.ts" },
        },
      ],
      depends_on: [],
      raw_path: "/fake/bmad.md",
      raw_frontmatter: {},
      source_hash: "b".repeat(64),
    };

    const violations = await resolveDisciplinePaths(bmadStory, root);
    // BMad stories are gated out entirely by isEnrichedStory.
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KVS2MG — vitest-target resolvability check
//
// A shape-valid `vitest:` target is additionally required to resolve to a
// runnable PACKAGE: a package.json must exist between the target path and the
// repo root (the same `findPackageRoot` walk the reviewer uses). The test FILE
// itself need NOT pre-exist (the build creates it) — only the package above it.
// These tests use a separate scratch tree per case so we control exactly where
// (if anywhere) a package.json sits above the target.
// ---------------------------------------------------------------------------

describe("Story native:01KVS2MG — vitest target must resolve to a runnable package", () => {
  let repoRoot: string;

  beforeEach(async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-resolvable-test-target-"));
    repoRoot = path.join(scratch, "repo");
    // Mirror the real monorepo layout: the package lives under
    // plugins/flow/mcp-server, NOT directly at the repo root. So the repo root
    // itself has NO package.json — a wrong-prefix target that lands directly
    // under the root cannot resolve a package.
    await fs.mkdir(path.join(repoRoot, "plugins", "flow", "mcp-server", "src"), {
      recursive: true,
    });
    await atomicWriteFile(
      path.join(repoRoot, "plugins", "flow", "mcp-server", "package.json"),
      `{ "name": "@flow/mcp-server" }\n`,
    );
  });

  afterEach(async () => {
    await fs.rm(path.dirname(repoRoot), { recursive: true, force: true });
  });

  /** Build a native story with a single vitest: AC, citing a seeded source. */
  async function makeResolvabilityStory(target: string): Promise<SourceStory> {
    // Seed a cited source under the real package so the cited-source check passes.
    const citedRel = "plugins/flow/mcp-server/src/feature.ts";
    await atomicWriteFile(path.join(repoRoot, citedRel), "// seeded\n");
    return {
      ref: "native:RESOLVABLETEST000000000001",
      title: "Resolvability test story",
      narrative: "As an operator, I want the check to gate wrong-path targets.",
      acceptance_criteria: [
        {
          text: "Given a vitest target When the story is saved Then resolvability is checked.",
          kind: "integration",
          verification: { type: "vitest", target },
        },
      ],
      tasks: [{ text: "Implement", ac_refs: ["AC1"] }],
      cited_sources: [citedRel],
      depends_on: [],
      raw_path: "/fake/story.md",
      raw_frontmatter: {},
      source_hash: "d".repeat(64),
    };
  }

  // AC1 — a wrong-prefix target with NO package.json between it and the repo
  // root is refused with an `unresolvable-test-target` violation naming the
  // offending target, and nothing else fires (no build wasted).
  it("AC1: refuses a wrong-prefix vitest target that resolves to no package", async () => {
    // Wrong prefix: 'mcp-server/...' instead of 'plugins/flow/mcp-server/...'.
    // No package.json exists at repoRoot/mcp-server or above (up to repoRoot).
    const wrongPrefix = "mcp-server/tests/x.test.ts";
    const story = await makeResolvabilityStory(wrongPrefix);

    const violations = await resolveDisciplinePaths(story, repoRoot);

    const unresolvable = violations.filter((v) => v.code === "unresolvable-test-target");
    expect(unresolvable).toHaveLength(1);
    // Names the offending target.
    expect(unresolvable[0]!.detail).toContain(wrongPrefix);
    // Names the AC.
    expect(unresolvable[0]!.detail).toMatch(/AC1/);
    // The shape check is NOT what fired — the path IS a runnable-test shape.
    expect(violations.some((v) => v.code === "non-runnable-test-target")).toBe(false);
  });

  it("AC1: the violation array is non-empty so the save/scan gate refuses before any build", async () => {
    const story = await makeResolvabilityStory("mcp-server/tests/y.test.ts");
    const violations = await resolveDisciplinePaths(story, repoRoot);
    // A non-empty array is the signal the write gate and scan path both check
    // before materialising the manifest.
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.code === "unresolvable-test-target")).toBe(true);
  });

  // AC2 — a NOT-YET-EXISTING test file under a real package PASSES. The check
  // verifies a package resolves, not that the test file already exists.
  it("AC2: passes a not-yet-existing test file under a real package", async () => {
    // This .test.ts does not exist on disk, but plugins/flow/mcp-server has a
    // package.json that resolves above it.
    const target = "plugins/flow/mcp-server/src/__tests__/not-yet-created.test.ts";
    const story = await makeResolvabilityStory(target);

    // Sanity: the test file genuinely does not exist yet.
    await expect(
      fs.stat(path.join(repoRoot, target)),
    ).rejects.toBeTruthy();

    const violations = await resolveDisciplinePaths(story, repoRoot);
    expect(violations.filter((v) => v.code === "unresolvable-test-target")).toHaveLength(0);
    // And it does not trip any other discipline check either.
    expect(violations).toHaveLength(0);
  });

  // AC3 — a shape-invalid target (not under __tests__/, not ending .test/.spec)
  // still fails with the EXISTING non-runnable-test-target violation, NOT the
  // new resolvability one (no regression to the shape check; no double-report).
  it("AC3: a shape-invalid target still fails non-runnable-test-target, not unresolvable-test-target", async () => {
    // Ordinary source file under the real package — shape-invalid as a test.
    const sourceFile = "plugins/flow/mcp-server/src/feature.ts";
    const story = await makeResolvabilityStory(sourceFile);

    const violations = await resolveDisciplinePaths(story, repoRoot);

    const shape = violations.filter((v) => v.code === "non-runnable-test-target");
    expect(shape).toHaveLength(1);
    expect(shape[0]!.detail).toContain(sourceFile);
    // The resolvability check must NOT also fire — the shape error is the single
    // actionable signal for a malformed/source-file target.
    expect(violations.some((v) => v.code === "unresolvable-test-target")).toBe(false);
  });
});
