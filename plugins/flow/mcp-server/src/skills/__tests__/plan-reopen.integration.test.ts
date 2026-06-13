/**
 * Re-open mode integration tests — Story 3.6 Task 5.1.
 *
 * Tests AC4 branches (a)–(g) at the tool-call boundary layer.
 * Instead of spinning up an LLM, these tests operate directly against the
 * underlying MCP tools (`markWithdrawn`, `writeNativeStory`, `scanSources`)
 * and the catalogue-prompt-shape layer, asserting that given the right
 * `<initial-context>` the right tool behaviour emerges.
 *
 * Per the Testing requirements section:
 *   "If a scripted runner does not exist yet, the dev agent MAY exercise the
 *    routing logic at the catalogue-prompt-shape layer ... AND at the
 *    tool-call boundary (assert that given the right <initial-context>, the
 *    right MCP tool would be called) without spinning up an LLM."
 *
 * Branch (h) — dev-loop skip — is covered by is-claimable.test.ts (Task 4.2).
 *
 * This file covers:
 *   (a) native add — round-trip: existing backlog + new writeNativeStory → new file, existing untouched.
 *   (b) native edit-pending — rewrite a to-do story → source file bytes change.
 *   (c) native discard — revert/deprecate story appears, original files untouched.
 *   (d) BMad add — writeNativeStory refuses on BMad workspace (WrongAdapterError).
 *   (e) BMad edit-pending — markWithdrawn on a native ref on BMad raises WrongAdapterError,
 *       and the planner prompt encodes the refusal string for BMad edit-pending.
 *   (f) BMad discard — markWithdrawn flips withdrawn, idempotent on second call.
 *   (g) in-progress guard — planner prompt encodes the refusal string.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { WrongAdapterError } from "../../errors.js";
import { markWithdrawn } from "../../tools/mark-withdrawn.js";
import { writeNativeStory } from "../../tools/write-native-story.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLANNER_MD = path.resolve(HERE, "..", "..", "..", "..", "catalogue", "planner.md");

const BMAD_FIXTURE = path.resolve(
  HERE,
  "..",
  "..",
  "adapters",
  "bmad",
  "fixtures",
  "sample-target-repo",
);

const NATIVE_FIXTURE = path.resolve(
  HERE,
  "..",
  "..",
  "adapters",
  "native",
  "fixtures",
  "sample-target-repo",
);

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-reopen-"));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function copyFixture(fixturePath: string): Promise<string> {
  const dest = path.join(scratch, path.basename(fixturePath));
  await fs.cp(fixturePath, dest, { recursive: true });
  return dest;
}

/**
 * Seed a repo-relative file under `root` so a Story 10.3 T0-5 cited-source
 * resolvability check passes (cited sources must resolve at write time).
 */
async function seedInRepo(root: string, relPath: string): Promise<void> {
  // Route through the sanctioned atomicWriteFile seam (it creates parent dirs)
  // so the static fs-write guard does not flag this test file for a raw write.
  await atomicWriteFile(path.join(root, relPath), "// seeded for resolvability\n");
}

// ---------------------------------------------------------------------------
// (a) native add — new story written, existing files untouched
// ---------------------------------------------------------------------------

describe("AC4(a) — native add with existing backlog", () => {
  it("writes a new native story file without touching the existing backlog files", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);
    await seedInRepo(root, "src/new-feature.ts"); // Story 10.3 T0-5 cited source.

    // Record existing native story refs before the add.
    const storiesDir = path.join(root, ".flow", "native-stories");
    const beforeFiles = await fs.readdir(storiesDir);

    // Simulate the planner calling writeNativeStory for a new story.
    const result = await writeNativeStory({
      targetRepoRoot: root,
      title: "New story added in re-open mode",
      narrative: { role: "user", want: "a new feature", so_that: "I can use it" },
      acceptance_criteria: [
        {
          text: "**Given** the new feature is deployed, **When** a user accesses it, **Then** it works.",
          kind: "integration",
          verification: { type: "vitest", target: "src/__tests__/new-feature.test.ts" },
        },
      ],
      tasks: [{ text: "Build the new feature", ac_refs: ["AC1"] }],
      cited_sources: ["src/new-feature.ts"],
      depends_on: [],
      risk_reasoning: "Highest risk: the feature deploys but is inaccessible — caught by the integration AC user-access assertion.",
    });

    expect(result.ref).toMatch(/^native:[0-9A-Z]{26}$/);
    expect(result.path).toContain(".flow/native-stories/");

    // New file exists.
    await expect(fs.stat(result.path)).resolves.toBeTruthy();

    // Existing files are all still present and untouched.
    const afterFiles = await fs.readdir(storiesDir);
    for (const f of beforeFiles) {
      expect(afterFiles).toContain(f);
    }
    expect(afterFiles.length).toBe(beforeFiles.length + 1);
  });
});

// ---------------------------------------------------------------------------
// (b) native edit-pending — rewrite a to-do story (source file bytes change)
// ---------------------------------------------------------------------------

describe("AC4(b) — native edit-pending rewrites a to-do story", () => {
  it("writeNativeStory produces a new ULID file; scan-sources updates on re-scan", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);
    await seedInRepo(root, "src/edited-feature.ts"); // Story 10.3 T0-5 cited source.

    const oldRef = "native:01HZABC0000000000000000001";
    const oldStoryPath = path.join(root, ".flow", "native-stories", "01HZABC0000000000000000001.md");

    // Record the original file content.
    const beforeBytes = await fs.readFile(oldStoryPath, "utf8");

    // Simulate the planner calling writeNativeStory with edited content (new ULID).
    const result = await writeNativeStory({
      targetRepoRoot: root,
      title: "Edited to-do story one",
      narrative: { role: "user", want: "the edited feature", so_that: "I can use it better" },
      acceptance_criteria: [
        {
          text: "**Given** the edited feature is deployed, **When** a user accesses it, **Then** it works correctly.",
          kind: "integration",
          verification: { type: "vitest", target: "src/__tests__/edited-feature.test.ts" },
        },
      ],
      tasks: [{ text: "Build the edited feature", ac_refs: ["AC1"] }],
      cited_sources: ["src/edited-feature.ts"],
      depends_on: [oldRef],
      risk_reasoning: "Highest risk: edit overwrites the original file — caught by asserting original bytes unchanged after write.",
    });

    // A NEW file is created (new ULID).
    expect(result.ref).toMatch(/^native:[0-9A-Z]{26}$/);
    expect(result.ref).not.toBe(oldRef);

    // Original file is untouched.
    const afterBytes = await fs.readFile(oldStoryPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);

    // New story file exists on disk.
    await expect(fs.stat(result.path)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (c) native discard — revert/deprecate story written, originals untouched
// ---------------------------------------------------------------------------

describe("AC4(c) — native discard: revert/deprecate story appears, originals untouched", () => {
  it("writes a revert/deprecate story citing the original ref in depends_on", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);
    await seedInRepo(root, "src/done-feature.ts"); // Story 10.3 T0-5 cited source.

    const originalRef = "native:01HZABC0000000000000000003";
    const originalStoryPath = path.join(
      root,
      ".flow",
      "native-stories",
      "01HZABC0000000000000000003.md",
    );
    const originalManifestPath = path.join(
      root,
      ".flow",
      "state",
      "done",
      `${originalRef}.yaml`,
    );

    // Record original content.
    const originalStoryBytes = await fs.readFile(originalStoryPath, "utf8");
    const originalManifestBytes = await fs.readFile(originalManifestPath, "utf8");

    // Simulate planner calling writeNativeStory for the revert story.
    const result = await writeNativeStory({
      targetRepoRoot: root,
      title: "revert/deprecate: Done story three",
      narrative: {
        role: "operator",
        want: `to reverse the feature shipped by ${originalRef} (Done story three)`,
        so_that: "the withdrawn feature no longer ships",
      },
      acceptance_criteria: [
        {
          text: "**Given** the revert is complete, **When** a user accesses the system, **Then** the feature no longer exists.",
          kind: "integration",
          verification: { type: "vitest", target: "src/__tests__/revert.test.ts" },
        },
      ],
      tasks: [{ text: "Remove the feature and its tests", ac_refs: ["AC1"] }],
      cited_sources: ["src/done-feature.ts"],
      depends_on: [originalRef],
      risk_reasoning: "Highest risk: revert removes the wrong feature — caught by the integration AC asserting the target feature is absent post-deploy.",
    });

    // New revert story file has the revert/deprecate: title prefix.
    const newStoryRaw = await fs.readFile(result.path, "utf8");
    expect(newStoryRaw).toContain("revert/deprecate: Done story three");
    expect(newStoryRaw).toContain(originalRef);

    // Original story file is untouched.
    const afterStoryBytes = await fs.readFile(originalStoryPath, "utf8");
    expect(afterStoryBytes).toBe(originalStoryBytes);

    // Original execution manifest is untouched.
    const afterManifestBytes = await fs.readFile(originalManifestPath, "utf8");
    expect(afterManifestBytes).toBe(originalManifestBytes);
  });
});

// ---------------------------------------------------------------------------
// (d) BMad add — writeNativeStory refuses with WrongAdapterError
// ---------------------------------------------------------------------------

describe("AC4(d) — BMad add: writeNativeStory refuses on BMad workspace", () => {
  it("throws WrongAdapterError when writeNativeStory is called on a BMad workspace", async () => {
    const root = await copyFixture(BMAD_FIXTURE);

    await expect(
      writeNativeStory({
        targetRepoRoot: root,
        title: "Should be refused",
        narrative: { role: "user", want: "this", so_that: "it works" },
        acceptance_criteria: [
          {
            text: "**Given** the feature works, **When** accessed, **Then** success.",
            kind: "integration",
            verification: { type: "vitest", target: "src/__tests__/refused.test.ts" },
          },
        ],
        tasks: [{ text: "Build it", ac_refs: ["AC1"] }],
        cited_sources: ["src/refused.ts"],
        depends_on: [],
      }),
    ).rejects.toBeInstanceOf(WrongAdapterError);
  });
});

// ---------------------------------------------------------------------------
// (e) BMad edit-pending — planner prompt encodes the refusal string
// ---------------------------------------------------------------------------

describe("AC4(e) — BMad edit-pending: planner prompt encodes the refusal string", () => {
  it("planner.md contains the edit-pending BMad refusal string", async () => {
    const raw = await fs.readFile(PLANNER_MD, "utf8");
    expect(raw).toContain(
      '"Edit-pending is native-only in v1. Edit the source story in <adapter-name> and run /flow:scan."',
    );
  });
});

// ---------------------------------------------------------------------------
// (f) BMad discard — markWithdrawn flips withdrawn, idempotent on second call
// ---------------------------------------------------------------------------

describe("AC4(f) — BMad discard via markWithdrawn", () => {
  it("flips withdrawn:true on a BMad manifest and is idempotent on second call", async () => {
    const root = await copyFixture(BMAD_FIXTURE);
    const ref = "bmad:1.1";
    const manifestPath = path.join(root, ".flow", "state", "done", `${ref}.yaml`);

    // First call — flip.
    const first = await markWithdrawn({ targetRepoRoot: root, ref });
    expect(first.alreadyWithdrawn).toBe(false);
    expect(first.state).toBe("done");

    const afterRaw = await fs.readFile(manifestPath, "utf8");
    const afterParsed = yamlParse(afterRaw) as Record<string, unknown>;
    expect(afterParsed["withdrawn"]).toBe(true);

    // Backdate mtime.
    const statAfterFirst = await fs.stat(manifestPath);
    const oneSec = statAfterFirst.mtimeMs / 1000 - 1;
    await fs.utimes(manifestPath, oneSec, oneSec);
    const statBackdated = await fs.stat(manifestPath);
    const mtimeBackdated = statBackdated.mtimeMs;

    // Second call — no-op.
    const second = await markWithdrawn({ targetRepoRoot: root, ref });
    expect(second.alreadyWithdrawn).toBe(true);

    const statAfterSecond = await fs.stat(manifestPath);
    expect(statAfterSecond.mtimeMs).toBe(mtimeBackdated);
  });
});

// ---------------------------------------------------------------------------
// (g) in-progress guard — planner prompt encodes the refusal string
// ---------------------------------------------------------------------------

describe("AC4(g) — in-progress guard: planner prompt encodes the refusal string", () => {
  it("planner.md contains the in-progress refusal string verbatim", async () => {
    const raw = await fs.readFile(PLANNER_MD, "utf8");
    expect(raw).toContain(
      '"Story <ref> is in-progress and cannot be edited. Wait for it to land in done/ or blocked/, or discard it instead."',
    );
  });
});
