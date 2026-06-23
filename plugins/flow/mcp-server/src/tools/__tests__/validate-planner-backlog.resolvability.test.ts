/**
 * Integration tests for `validatePlannerBacklog` — resolvability extension
 * (Story native:01KTZFWZWN1DZ6N9HF43SYHFF5).
 *
 * Covers:
 *   AC1 — enriched batch with all cited sources + verification targets
 *         resolving on disk → clean pass, save succeeds.
 *   AC2 — enriched batch with an unresolvable cited source or verification
 *         target → not-ok, names the offending path, no story written.
 *   AC4 — legacy batch (no cited_sources, no verification) → validates
 *         exactly as before, no new failures.
 *
 * AC3 (parity between pre-submit check and save gate) is covered by the
 * dedicated parity test at:
 *   src/validators/__tests__/discipline-resolvability.parity.test.ts
 *
 * Fixture pattern mirrors write-native-story.test.ts: a minimal
 * native-adapter workspace in a fresh tmpdir.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { validatePlannerBacklog } from "../validate-planner-backlog.js";

let root: string;

/** Seed a repo-relative file so resolvability checks pass for it. */
async function seedFile(relPath: string): Promise<void> {
  await atomicWriteFile(path.join(root, relPath), "// seeded\n");
}

/** Build a minimal pending story that passes pure discipline checks. */
function makeBasePending(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Test story",
    narrative: "As a user, I want something, so that I am happy.",
    acceptance_criteria: [
      {
        text: "Given X When Y Then Z",
        kind: "unit",
      },
    ],
    implementation_notes: undefined,
    depends_on: [],
    ship_gate: true,
    state_mutating: "auto",
    ...overrides,
  };
}

beforeEach(async () => {
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "flow-validate-planner-resolvability-"),
  );
  root = path.join(scratch, "workspace");
  await fs.mkdir(path.join(root, ".flow", "native-stories"), { recursive: true });
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    `adapter: native\nadapter_config: {}\n`,
  );
  // Story native:01KVS2MG — a package.json at the workspace root so shape-valid
  // `vitest:` targets (e.g. `src/__tests__/*.test.ts`) resolve to a package.
  await atomicWriteFile(path.join(root, "package.json"), `{ "name": "fixture" }\n`);
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — enriched batch, all paths resolve → clean pass
// ---------------------------------------------------------------------------

describe("AC1 — enriched batch with all cited sources and verification targets resolving", () => {
  it("returns ok:true when cited_sources and vitest: verification targets all resolve", async () => {
    await seedFile("src/tools/foo.ts");
    await seedFile("src/validators/bar.ts");

    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        makeBasePending({
          cited_sources: ["src/tools/foo.ts", "src/validators/bar.ts"],
          acceptance_criteria: [
            {
              text: "Given X When Y Then Z",
              kind: "unit",
              verification: {
                type: "vitest",
                // vitest: targets are shape-checked only — NOT required to exist on disk.
                target: "src/__tests__/new-feature.test.ts",
              },
            },
          ],
        }),
      ],
    });

    expect(result).toEqual({ ok: true });
  });

  it("returns ok:true when cited_sources and artifact: verification targets all resolve", async () => {
    await seedFile("src/tools/foo.ts");
    await seedFile("build/out/report.json");

    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        makeBasePending({
          cited_sources: ["src/tools/foo.ts"],
          acceptance_criteria: [
            {
              text: "Given X When Y Then Z",
              kind: "integration",
              verification: {
                type: "artifact",
                target: "build/out/report.json",
              },
            },
          ],
        }),
      ],
    });

    expect(result).toEqual({ ok: true });
  });

  it("returns ok:true when only cited_sources are present (no verification) and all resolve", async () => {
    await seedFile("src/tools/foo.ts");

    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        makeBasePending({
          cited_sources: ["src/tools/foo.ts"],
        }),
      ],
    });

    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC2 — enriched batch with unresolvable paths → not-ok, names the offending path
// ---------------------------------------------------------------------------

describe("AC2 — enriched batch with unresolvable cited source → not-ok", () => {
  it("returns ok:false and names the missing cited-source path verbatim", async () => {
    // Do NOT seed the cited source — it must not exist on disk.
    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        makeBasePending({
          cited_sources: ["src/tools/does-not-exist.ts"],
          acceptance_criteria: [
            {
              text: "Given X When Y Then Z",
              kind: "unit",
              verification: {
                type: "vitest",
                target: "src/__tests__/new-feature.test.ts",
              },
            },
          ],
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const allReasons = result.violations.flatMap((v) => v.violations);
      // Must name the offending path, not merely signal ok:false.
      const unresolvable = allReasons.find((r) => r.code === "unresolvable-cited-source");
      expect(unresolvable).toBeDefined();
      expect(unresolvable?.detail).toContain("src/tools/does-not-exist.ts");
    }
  });

  it("returns ok:false and names the missing artifact: target verbatim", async () => {
    await seedFile("src/tools/foo.ts");
    // Do NOT seed the artifact target.

    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        makeBasePending({
          cited_sources: ["src/tools/foo.ts"],
          acceptance_criteria: [
            {
              text: "Given X When Y Then Z",
              kind: "integration",
              verification: {
                type: "artifact",
                target: "build/out/missing-artifact.json",
              },
            },
          ],
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const allReasons = result.violations.flatMap((v) => v.violations);
      const unresolvable = allReasons.find(
        (r) => r.code === "unresolvable-verification-target",
      );
      expect(unresolvable).toBeDefined();
      expect(unresolvable?.detail).toContain("build/out/missing-artifact.json");
    }
  });

  it("does NOT write any story file when validation fails", async () => {
    // Neither cited source nor artifact target exists — should fail.
    await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        makeBasePending({
          cited_sources: ["src/tools/does-not-exist.ts"],
        }),
      ],
    });

    // The pre-submit check NEVER writes files; confirm the stories dir is empty.
    const storyFiles = await fs.readdir(path.join(root, ".flow", "native-stories"));
    expect(storyFiles.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("vitest: target does NOT produce unresolvable-verification-target even if missing on disk", async () => {
    // A vitest: target is a build output — it must not be required to pre-exist.
    await seedFile("src/tools/foo.ts");
    // Do NOT seed the vitest: target — it should be shape-checked only.

    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        makeBasePending({
          cited_sources: ["src/tools/foo.ts"],
          acceptance_criteria: [
            {
              text: "Given X When Y Then Z",
              kind: "unit",
              verification: {
                type: "vitest",
                target: "src/__tests__/brand-new.test.ts",
              },
            },
          ],
        }),
      ],
    });

    // Should pass cleanly — vitest: targets are not existence-checked.
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC4 — legacy batch (no cited_sources, no verification) → no new failures
// ---------------------------------------------------------------------------

describe("AC4 — legacy batch with no enriched fields validates exactly as before", () => {
  it("returns ok:true for a clean legacy batch with ship_gate=true", async () => {
    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        // No cited_sources, no verification on ACs — legacy shape.
        makeBasePending(),
      ],
    });

    expect(result).toEqual({ ok: true });
  });

  it("still enforces the existing ship-gate rule on a legacy batch", async () => {
    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        makeBasePending({ ship_gate: false }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const allCodes = result.violations.flatMap((v) => v.violations.map((r) => r.code));
      expect(allCodes).toContain("missing-ship-gate");
    }
  });

  it("still enforces the state-mutating rule on a legacy batch", async () => {
    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        makeBasePending({
          state_mutating: true,
          acceptance_criteria: [
            // Only a unit AC, no integration AC — should fail state-mutating rule.
            { text: "Given X When Y Then Z", kind: "unit" },
          ],
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const allCodes = result.violations.flatMap((v) => v.violations.map((r) => r.code));
      expect(allCodes).toContain("missing-integration-ac");
    }
  });

  it("does NOT introduce any new failure for a legacy batch with null/undefined enriched fields", async () => {
    // cited_sources explicitly absent (undefined), no verification on ACs.
    const result = await validatePlannerBacklog({
      targetRepoRoot: root,
      pendingStories: [
        {
          title: "Legacy story",
          narrative: "As a user, I want something, so that I am happy.",
          acceptance_criteria: [
            { text: "Given X When Y Then Z", kind: "unit" },
          ],
          depends_on: [],
          ship_gate: true,
          state_mutating: "auto",
          // No cited_sources, no verification — omitted entirely.
        },
      ],
    });

    expect(result).toEqual({ ok: true });
  });
});
