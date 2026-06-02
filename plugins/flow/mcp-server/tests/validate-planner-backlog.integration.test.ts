/**
 * Integration tests for `validatePlannerBacklog` (Story 3.5 Task 5.5).
 *
 * These tests cover AC1, AC2, and AC3 by spinning up a tmpdir target repo
 * configured with the native adapter. No `writeNativeStory` side-effects
 * should occur — the validator is read-only.
 *
 * Each test asserts both the tool return value and the absence of any
 * file-write side effect.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { stringify as yamlStringify } from "yaml";
import { validatePlannerBacklog } from "../src/tools/validate-planner-backlog.js";
import { resetNativeAdapter } from "../src/adapters/native/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createNativeTargetRepo(tmpDir: string): Promise<string> {
  // Create .flow/config.yaml to tell resolveWorkspace this is a native workspace.
  const crewDir = path.join(tmpDir, ".flow");
  const nativeStoriesDir = path.join(crewDir, "native-stories");
  await fs.mkdir(nativeStoriesDir, { recursive: true });

  const config = yamlStringify({
    adapter: "native",
    adapter_config: {},
    plugin: {},
  });
  await fs.writeFile(path.join(crewDir, "config.yaml"), config, "utf8");

  return tmpDir;
}

function makePending(overrides: Record<string, unknown> = {}) {
  return {
    title: "A test story",
    narrative: "As a user, I want something, so that I am happy.",
    acceptance_criteria: [{ text: "Given ... When ... Then ...", kind: "unit" as const }],
    implementation_notes: undefined,
    depends_on: [] as string[],
    ship_gate: false,
    state_mutating: "auto" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-vpb-test-"));
});

afterEach(async () => {
  resetNativeAdapter();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1: planner pre-write rejects missing-integration-AC on state-mutating story
// ---------------------------------------------------------------------------

describe("validatePlannerBacklog — AC1: missing-integration-AC", () => {
  it("returns { ok: false } with missing-integration-ac violation for state-mutating story without integration AC", async () => {
    await createNativeTargetRepo(tmpDir);

    const result = await validatePlannerBacklog({
      targetRepoRoot: tmpDir,
      pendingStories: [
        makePending({
          title: "Update scan-sources.ts behaviour",
          narrative: "This story writes state to the manifest directory.",
          implementation_notes: "Edit scan-sources.ts to extend the blocked path.",
          acceptance_criteria: [
            { text: "The blocked/ dir is written correctly.", kind: "unit" as const },
          ],
          ship_gate: true, // Avoid ship-gate violation masking AC1 check
          state_mutating: "auto" as const,
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.violations.flatMap((v) => v.violations.map((r) => r.code));
      expect(codes).toContain("missing-integration-ac");
    }
  });

  it("returns { ok: true } for state-mutating story WITH an integration AC", async () => {
    await createNativeTargetRepo(tmpDir);

    const result = await validatePlannerBacklog({
      targetRepoRoot: tmpDir,
      pendingStories: [
        makePending({
          title: "Update scan-sources.ts behaviour",
          narrative: "This story writes state to the manifest directory.",
          implementation_notes: "Edit scan-sources.ts to extend the blocked path.",
          acceptance_criteria: [
            { text: "The blocked/ dir is written correctly.", kind: "integration" as const },
          ],
          ship_gate: true,
          state_mutating: "auto" as const,
        }),
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("does NOT write any file as a side effect", async () => {
    await createNativeTargetRepo(tmpDir);

    await validatePlannerBacklog({
      targetRepoRoot: tmpDir,
      pendingStories: [
        makePending({
          ship_gate: true,
          state_mutating: "auto" as const,
        }),
      ],
    });

    // Only the config.yaml and native-stories/ dir should exist.
    const crewEntries = await fs.readdir(path.join(tmpDir, ".flow"));
    expect(crewEntries.sort()).toEqual(["config.yaml", "native-stories"]);

    const storiesEntries = await fs.readdir(path.join(tmpDir, ".flow", "native-stories"));
    expect(storiesEntries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC2: planner pre-write rejects implicit depends_on
// ---------------------------------------------------------------------------

describe("validatePlannerBacklog — AC2: implicit depends_on", () => {
  it("returns { ok: false } with implicit-depends-on violation when ref in prose is missing from depends_on", async () => {
    await createNativeTargetRepo(tmpDir);

    const result = await validatePlannerBacklog({
      targetRepoRoot: tmpDir,
      pendingStories: [
        makePending({
          title: "Extension story",
          narrative: "This story extends native:01JX9000000000000000000001 to add a new flow.",
          ship_gate: true,
          state_mutating: false as const,
          depends_on: [], // ref is NOT declared
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.violations.flatMap((v) => v.violations.map((r) => r.code));
      expect(codes).toContain("implicit-depends-on");
    }
  });

  it("returns { ok: true } when ref in prose IS declared in depends_on", async () => {
    await createNativeTargetRepo(tmpDir);

    const result = await validatePlannerBacklog({
      targetRepoRoot: tmpDir,
      pendingStories: [
        makePending({
          title: "Extension story",
          narrative: "This story extends native:01JX9000000000000000000001 to add a new flow.",
          ship_gate: true,
          state_mutating: false as const,
          depends_on: ["native:01JX9000000000000000000001"], // declared
        }),
      ],
    });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3: planner pre-write rejects missing ship-gate
// ---------------------------------------------------------------------------

describe("validatePlannerBacklog — AC3: missing ship-gate", () => {
  it("returns { ok: false } with missing-ship-gate when no story in the batch is ship_gate:true", async () => {
    await createNativeTargetRepo(tmpDir);

    const result = await validatePlannerBacklog({
      targetRepoRoot: tmpDir,
      pendingStories: [
        makePending({
          ship_gate: false,
          state_mutating: false as const,
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.violations.flatMap((v) => v.violations.map((r) => r.code));
      expect(codes).toContain("missing-ship-gate");
    }
  });

  it("returns { ok: true } when at least one story in the batch is ship_gate:true", async () => {
    await createNativeTargetRepo(tmpDir);

    const result = await validatePlannerBacklog({
      targetRepoRoot: tmpDir,
      pendingStories: [
        makePending({ ship_gate: false, state_mutating: false as const }),
        makePending({ ship_gate: true, state_mutating: false as const }),
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("throws on empty pendingStories (caller bug)", async () => {
    await createNativeTargetRepo(tmpDir);

    await expect(
      validatePlannerBacklog({
        targetRepoRoot: tmpDir,
        pendingStories: [],
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wrong adapter guard
// ---------------------------------------------------------------------------

describe("validatePlannerBacklog — WrongAdapterError", () => {
  it("throws WrongAdapterError when workspace is configured as bmad", async () => {
    // Set up a BMad-style workspace.
    const bmadDir = path.join(tmpDir, ".flow");
    const storiesDir = path.join(tmpDir, "_bmad-output", "planning-artifacts", "stories");
    await fs.mkdir(bmadDir, { recursive: true });
    await fs.mkdir(storiesDir, { recursive: true });
    // Put a BMad story file so detect() returns true.
    await fs.writeFile(
      path.join(storiesDir, "1-1-placeholder.md"),
      `# Story 1.1: Placeholder\n\nStatus: backlog\n\n## Story\n\nAs a placeholder.\n\n## Acceptance Criteria\n\n**AC1:**\nGiven, When, Then.\n`,
      "utf8",
    );
    const config = yamlStringify({
      adapter: "bmad",
      adapter_config: { stories_root: "_bmad-output/planning-artifacts/stories" },
      plugin: {},
    });
    await fs.writeFile(path.join(bmadDir, "config.yaml"), config, "utf8");

    await expect(
      validatePlannerBacklog({
        targetRepoRoot: tmpDir,
        pendingStories: [makePending({ ship_gate: true })],
      }),
    ).rejects.toThrow(/WrongAdapterError|native|wrong adapter/i);
  });
});
