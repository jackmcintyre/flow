/**
 * Parity test — AC3 (Story native:01KTZFWZWN1DZ6N9HF43SYHFF5).
 *
 * Asserts that `validatePlannerBacklog` (the pre-submit check) and
 * `renderGateWriteNativeStory` / the `resolveDisciplinePaths` call inside
 * `writeNativeStory` return THE IDENTICAL set of resolvability violations
 * for the same enriched story against the same working tree, because BOTH
 * delegate to the one shared `resolveDisciplinePaths` implementation.
 *
 * This is the anti-drift guarantee: a hand-copied checker in the pre-submit
 * path would produce a divergent result for at least one fixture, making the
 * parity assertion fail loudly instead of silently diverging in production.
 *
 * Why we test at the `resolveDisciplinePaths` seam rather than end-to-end:
 * The save gate (`writeNativeStory`) throws `DisciplineViolationError` on any
 * violation, so exercising it end-to-end requires catching the error and
 * reconstructing the violation set — more fragile than just calling
 * `resolveDisciplinePaths` directly, which IS the shared implementation both
 * callers invoke. The parity guarantee holds because both callers call the
 * SAME function with the same `SourceStory` and `targetRepoRoot`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { resolveDisciplinePaths } from "../discipline-resolvability.js";
import { validatePlannerBacklog } from "../../tools/validate-planner-backlog.js";
import type { SourceStory } from "../../adapters/adapter.js";

let root: string;

/** Seed a repo-relative file so resolvability checks pass for it. */
async function seedFile(relPath: string): Promise<void> {
  await atomicWriteFile(path.join(root, relPath), "// seeded\n");
}

/**
 * Build a SourceStory that mirrors the enriched story the save gate receives —
 * the same shape `inputToSourceStory` inside `writeNativeStory` produces, so
 * the parity assertion covers the real call site.
 */
function makeEnrichedSourceStory(overrides: Partial<SourceStory> = {}): SourceStory {
  return {
    ref: "native:PARITY-TEST-ULID-000001",
    title: "Parity test story",
    narrative: "As a developer, I want parity, so that checks never diverge.",
    acceptance_criteria: [
      {
        text: "Given X When Y Then Z",
        kind: "unit",
        verification: { type: "vitest", target: "src/__tests__/parity.test.ts" },
      },
    ],
    tasks: [{ text: "Do the thing", ac_refs: ["AC1"] }],
    cited_sources: ["src/tools/validate-planner-backlog.ts"],
    depends_on: [],
    raw_path: "",
    raw_frontmatter: {},
    source_hash: "a".repeat(64),
    ...overrides,
  };
}

/**
 * Build the PendingStoryInput mirror of the SourceStory above — same enriched
 * fields, same paths — for the pre-submit check call.
 */
function makeEnrichedPendingInput(citedSources: string[], verificationTarget: string): unknown {
  return {
    targetRepoRoot: root,
    pendingStories: [
      {
        title: "Parity test story",
        narrative: "As a developer, I want parity, so that checks never diverge.",
        acceptance_criteria: [
          {
            text: "Given X When Y Then Z",
            kind: "unit",
            verification: { type: "vitest", target: verificationTarget },
          },
        ],
        depends_on: [],
        ship_gate: true,
        state_mutating: "auto",
        cited_sources: citedSources,
      },
    ],
  };
}

beforeEach(async () => {
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "flow-discipline-parity-"),
  );
  root = path.join(scratch, "workspace");
  await fs.mkdir(path.join(root, ".flow", "native-stories"), { recursive: true });
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    `adapter: native\nadapter_config: {}\n`,
  );
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Parity: clean case — both return zero violations
// ---------------------------------------------------------------------------

describe("AC3 parity — clean story: pre-submit check and save gate return identical (empty) violations", () => {
  it("both return an empty violation set when cited sources resolve", async () => {
    await seedFile("src/tools/validate-planner-backlog.ts");

    const story = makeEnrichedSourceStory({
      cited_sources: ["src/tools/validate-planner-backlog.ts"],
    });

    // Save-gate half: resolveDisciplinePaths directly (the shared implementation).
    const saveGateViolations = await resolveDisciplinePaths(story, root);

    // Pre-submit half: validatePlannerBacklog returns ok:true → no resolvability violations.
    const preSubmitResult = await validatePlannerBacklog(
      makeEnrichedPendingInput(
        ["src/tools/validate-planner-backlog.ts"],
        "src/__tests__/parity.test.ts",
      ),
    );

    // Both should report zero resolvability violations.
    expect(saveGateViolations).toHaveLength(0);
    expect(preSubmitResult).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Parity: failing case — both return the same violation set
// ---------------------------------------------------------------------------

describe("AC3 parity — failing story: pre-submit check and save gate return identical violations", () => {
  it("both report the same unresolvable-cited-source violation for the same missing path", async () => {
    const missingPath = "src/tools/does-not-exist-for-parity.ts";

    const story = makeEnrichedSourceStory({
      cited_sources: [missingPath],
    });

    // Save-gate half: resolveDisciplinePaths directly.
    const saveGateViolations = await resolveDisciplinePaths(story, root);

    // Pre-submit half: validatePlannerBacklog extracts the resolvability violations.
    const preSubmitResult = await validatePlannerBacklog(
      makeEnrichedPendingInput([missingPath], "src/__tests__/parity.test.ts"),
    );

    // Save gate must have exactly one unresolvable-cited-source violation.
    expect(saveGateViolations).toHaveLength(1);
    expect(saveGateViolations[0]?.code).toBe("unresolvable-cited-source");
    expect(saveGateViolations[0]?.detail).toContain(missingPath);

    // Pre-submit check must report the same violation set.
    expect(preSubmitResult.ok).toBe(false);
    if (!preSubmitResult.ok) {
      const preSubmitResolvabilityReasons = preSubmitResult.violations
        .flatMap((v) => v.violations)
        .filter((r) => r.code === "unresolvable-cited-source");

      // Same count and same offending path.
      const saveGateCodes = saveGateViolations.map((v) => v.code).sort();
      const preSubmitCodes = preSubmitResolvabilityReasons.map((v) => v.code).sort();
      expect(preSubmitCodes).toEqual(saveGateCodes);

      // Same offending path named in both.
      expect(preSubmitResolvabilityReasons[0]?.detail).toContain(missingPath);
    }
  });

  it("both report artifact: unresolvable-verification-target for the same missing artifact path", async () => {
    await seedFile("src/tools/validate-planner-backlog.ts");
    const missingArtifact = "build/out/missing-for-parity.json";

    const story = makeEnrichedSourceStory({
      cited_sources: ["src/tools/validate-planner-backlog.ts"],
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z",
          kind: "integration",
          verification: { type: "artifact", target: missingArtifact },
        },
      ],
    });

    // Save-gate half.
    const saveGateViolations = await resolveDisciplinePaths(story, root);

    // Pre-submit half — use artifact: type to trigger the existence check.
    const preSubmitInput = {
      targetRepoRoot: root,
      pendingStories: [
        {
          title: "Parity test story",
          narrative: "As a developer, I want parity, so that checks never diverge.",
          acceptance_criteria: [
            {
              text: "Given X When Y Then Z",
              kind: "integration",
              verification: { type: "artifact", target: missingArtifact },
            },
          ],
          depends_on: [],
          ship_gate: true,
          state_mutating: "auto",
          cited_sources: ["src/tools/validate-planner-backlog.ts"],
        },
      ],
    };
    const preSubmitResult = await validatePlannerBacklog(preSubmitInput);

    // Save gate must have exactly one unresolvable-verification-target.
    const saveGateArtifactViolations = saveGateViolations.filter(
      (v) => v.code === "unresolvable-verification-target",
    );
    expect(saveGateArtifactViolations).toHaveLength(1);
    expect(saveGateArtifactViolations[0]?.detail).toContain(missingArtifact);

    // Pre-submit must report the same violation.
    expect(preSubmitResult.ok).toBe(false);
    if (!preSubmitResult.ok) {
      const preSubmitArtifactReasons = preSubmitResult.violations
        .flatMap((v) => v.violations)
        .filter((r) => r.code === "unresolvable-verification-target");

      const saveGateCodes = saveGateArtifactViolations.map((v) => v.code).sort();
      const preSubmitCodes = preSubmitArtifactReasons.map((v) => v.code).sort();
      expect(preSubmitCodes).toEqual(saveGateCodes);
      expect(preSubmitArtifactReasons[0]?.detail).toContain(missingArtifact);
    }
  });
});

// ---------------------------------------------------------------------------
// Parity: structural guarantee — both call the same implementation
// ---------------------------------------------------------------------------

describe("AC3 structural parity — same story, same tree, identical violation codes", () => {
  it("pre-submit and save-gate return zero violations for a fully-seeded enriched story", async () => {
    // Seed everything.
    await seedFile("src/tools/validate-planner-backlog.ts");
    await seedFile("src/validators/discipline-resolvability.ts");

    const story = makeEnrichedSourceStory({
      cited_sources: [
        "src/tools/validate-planner-backlog.ts",
        "src/validators/discipline-resolvability.ts",
      ],
      // vitest: target intentionally NOT seeded — shape-checked only.
      acceptance_criteria: [
        {
          text: "Given X When Y Then Z",
          kind: "unit",
          verification: { type: "vitest", target: "src/__tests__/new.test.ts" },
        },
      ],
    });

    const saveGateViolations = await resolveDisciplinePaths(story, root);

    const preSubmitResult = await validatePlannerBacklog(
      makeEnrichedPendingInput(
        [
          "src/tools/validate-planner-backlog.ts",
          "src/validators/discipline-resolvability.ts",
        ],
        "src/__tests__/new.test.ts",
      ),
    );

    // Neither side should produce any resolvability violation.
    expect(saveGateViolations).toHaveLength(0);
    expect(preSubmitResult).toEqual({ ok: true });
  });

  it("both identify every missing path when multiple cited sources are unresolvable", async () => {
    const missing1 = "src/missing-one.ts";
    const missing2 = "src/missing-two.ts";

    const story = makeEnrichedSourceStory({
      cited_sources: [missing1, missing2],
    });

    const saveGateViolations = await resolveDisciplinePaths(story, root);
    const saveGateMissingPaths = saveGateViolations
      .filter((v) => v.code === "unresolvable-cited-source")
      .map((v) => v.detail)
      .sort();

    const preSubmitResult = await validatePlannerBacklog(
      makeEnrichedPendingInput([missing1, missing2], "src/__tests__/x.test.ts"),
    );

    expect(preSubmitResult.ok).toBe(false);
    if (!preSubmitResult.ok) {
      const preSubmitMissingPaths = preSubmitResult.violations
        .flatMap((v) => v.violations)
        .filter((r) => r.code === "unresolvable-cited-source")
        .map((r) => r.detail)
        .sort();

      // Same two paths reported by both.
      expect(preSubmitMissingPaths).toEqual(saveGateMissingPaths);
      expect(preSubmitMissingPaths).toHaveLength(2);
    }
  });
});
