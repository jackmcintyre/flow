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
