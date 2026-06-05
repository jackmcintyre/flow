/**
 * Tests for the mechanical-failure hardening-story draft — Story
 * native:01KT6RHTE3YME1ZAD5VRQAKDSW.
 *
 * AC1 (integration): Given a retro cycle whose lessons include at least two
 *   entries with the same kind and failure_class, When the retro loop runs,
 *   Then a hardening story appears in the backlog parked not-ready — visible in
 *   /flow:board — proposing a code guard against that failure class.
 *
 * AC2 (unit): Given a retro cycle whose lessons do not contain repeated
 *   mechanical failures, When the retro loop runs, Then no hardening story is
 *   drafted and the backlog is unchanged.
 *
 * AC3 (unit): Given a recurring failure that has already produced a not-ready
 *   hardening story in the backlog, When the retro loop runs again before that
 *   story is built, Then no duplicate hardening story is drafted.
 *
 * All tests use real tool implementations against a temp filesystem (same
 * pattern as retro-friction-signal.test.ts) — no mocks of the things under
 * test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { gatherRetroInputs } from "./gather-retro-inputs.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SOURCE_HASH = "a".repeat(64);

/**
 * Build a minimal done/ manifest YAML string. Pass `lessons` to inject pitfall
 * entries for the mechanical-failure signal.
 */
function makeDoneManifestYaml(
  ref: string,
  lessons?: Array<{ kind: string; text: string; failure_class?: string }>,
): string {
  const manifest: Record<string, unknown> = {
    ref,
    status: "done",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      { text: "Given x, when y, then z.", kind: "unit" },
    ],
    title: `Story ${ref}`,
    narrative: "As a user, I want X, so that Y.",
    withdrawn: false,
    claimed_by: "01HZSESSTEST0000000000001",
  };
  if (lessons !== undefined) {
    manifest["lessons"] = lessons;
  }
  return yamlStringify(manifest, { lineWidth: 0 });
}

/**
 * Seed a done/ manifest in the tmpRoot.
 */
async function seedDoneManifest(
  tmpRoot: string,
  ref: string,
  lessons?: Array<{ kind: string; text: string; failure_class?: string }>,
): Promise<void> {
  const doneDir = path.join(tmpRoot, ".flow", "state", "done");
  await fs.mkdir(doneDir, { recursive: true });
  await fs.writeFile(
    path.join(doneDir, `${ref}.yaml`),
    makeDoneManifestYaml(ref, lessons),
    "utf8",
  );
}

/**
 * Build a minimal native-adapter workspace config.
 * Needed for writeNativeStory to not throw WrongAdapterError.
 */
async function setupNativeWorkspace(tmpRoot: string): Promise<void> {
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );
  // Seed the cited source that hardening stories reference.
  await atomicWriteFile(
    path.join(tmpRoot, "plugins", "flow", "mcp-server", "src", "tools", "gather-retro-inputs.ts"),
    "// seeded for discipline-resolvability check\n",
  );
}

/**
 * List all `.md` files under `.flow/native-stories/`.
 */
async function listNativeStories(tmpRoot: string): Promise<string[]> {
  const dir = path.join(tmpRoot, ".flow", "native-stories");
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// AC1: Integration — recurring pitfall failure_class triggers a hardening draft
// ---------------------------------------------------------------------------

describe("AC1 — retro loop drafts a hardening story when same failure_class recurs", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gather-retro-ac1-"));
    await setupNativeWorkspace(tmpRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("drafts one hardening story when one failure_class appears in two done manifests", async () => {
    // Two done manifests each with a pitfall lesson sharing failure_class "parse-drift".
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000001A", [
      { kind: "pitfall", text: "parser drifted on long inputs", failure_class: "parse-drift" },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000001B", [
      { kind: "pitfall", text: "parser failed silently on empty string", failure_class: "parse-drift" },
    ]);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // Exactly one hardening story drafted.
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(1);
    const draft = bundle.mechanicalFailuresDrafted[0]!;
    expect(draft.failure_class).toBe("parse-drift");
    expect(draft.recurrence_count).toBe(2);
    expect(draft.hardening_story_ref).toMatch(/^native:[0-9A-Z]{26}$/);
    expect(draft.hardening_story_path).toContain(".flow/native-stories/");

    // The story file exists on disk.
    await expect(fs.stat(draft.hardening_story_path)).resolves.not.toThrow();
  });

  it("hardening story appears in native-stories dir (visible via readBacklogInventory)", async () => {
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000002A", [
      { kind: "pitfall", text: "tool call skipped under load", failure_class: "tool-skip" },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000002B", [
      { kind: "pitfall", text: "tool call skipped again", failure_class: "tool-skip" },
    ]);

    const beforeFiles = await listNativeStories(tmpRoot);
    expect(beforeFiles).toHaveLength(0);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.mechanicalFailuresDrafted).toHaveLength(1);

    // The hardening story file landed in native-stories.
    const afterFiles = await listNativeStories(tmpRoot);
    expect(afterFiles).toHaveLength(1);
  });

  it("hardening story title encodes failure_class for deduplication", async () => {
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000003A", [
      { kind: "pitfall", text: "handoff sentinel missing", failure_class: "handoff-grammar" },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000003B", [
      { kind: "pitfall", text: "handoff phrase not found by parser", failure_class: "handoff-grammar" },
    ]);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.mechanicalFailuresDrafted).toHaveLength(1);
    const draft = bundle.mechanicalFailuresDrafted[0]!;

    // Read the written native-story file and verify the title.
    const raw = await fs.readFile(draft.hardening_story_path, "utf8");
    expect(raw).toContain("[Hardening] Guard against handoff-grammar");
    expect(raw).toContain("## Narrative");
    expect(raw).toContain("## Acceptance Criteria");
  });

  it("drafts one hardening story per qualifying failure_class when multiple qualify", async () => {
    // Two distinct failure classes, each with 2 occurrences.
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000004A", [
      { kind: "pitfall", text: "parse issue A", failure_class: "parse-drift" },
      { kind: "pitfall", text: "retry issue A", failure_class: "forced-retry" },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000004B", [
      { kind: "pitfall", text: "parse issue B", failure_class: "parse-drift" },
      { kind: "pitfall", text: "retry issue B", failure_class: "forced-retry" },
    ]);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // Two distinct failure classes → two hardening stories.
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(2);
    const classes = bundle.mechanicalFailuresDrafted.map((d) => d.failure_class).sort();
    expect(classes).toEqual(["forced-retry", "parse-drift"]);
  });

  it("below-threshold count (exactly 1) does not produce a draft — threshold is 2", async () => {
    // Only one pitfall lesson with a failure_class — below threshold.
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000005A", [
      { kind: "pitfall", text: "one-off issue", failure_class: "one-off-class" },
    ]);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2: Unit — no recurring failures → backlog unchanged
// ---------------------------------------------------------------------------

describe("AC2 — retro loop does not draft when no repeated mechanical failures exist", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gather-retro-ac2-"));
    await setupNativeWorkspace(tmpRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns empty mechanicalFailuresDrafted when no done manifests at all", async () => {
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(0);
  });

  it("returns empty mechanicalFailuresDrafted when done manifests have no lessons", async () => {
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000006A");
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000006B");

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(0);
    expect(await listNativeStories(tmpRoot)).toHaveLength(0);
  });

  it("returns empty when lessons exist but none are pitfalls", async () => {
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000007A", [
      { kind: "pattern", text: "use the deterministic seam" },
      { kind: "tool-quirk", text: "the tool behaves strangely on empty input" },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000007B", [
      { kind: "discipline", text: "validate before writing" },
    ]);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(0);
    expect(await listNativeStories(tmpRoot)).toHaveLength(0);
  });

  it("returns empty when pitfall lessons exist but each failure_class appears only once", async () => {
    // Two pitfalls, different failure_class values — each appears only once.
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000008A", [
      { kind: "pitfall", text: "first unique issue", failure_class: "class-alpha" },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000008B", [
      { kind: "pitfall", text: "second unique issue", failure_class: "class-beta" },
    ]);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(0);
    expect(await listNativeStories(tmpRoot)).toHaveLength(0);
  });

  it("returns empty mechanicalFailuresDrafted on a non-native workspace (no WrongAdapterError)", async () => {
    // Overwrite config.yaml to use bmad adapter — should silently skip drafting.
    await atomicWriteFile(
      path.join(tmpRoot, ".flow", "config.yaml"),
      "adapter: bmad\nadapter_config:\n  stories_root: _bmad-output\n",
    );
    // Seed two pitfall lessons of the same class in done manifests.
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000009A", [
      { kind: "pitfall", text: "issue on bmad", failure_class: "bmad-class" },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000009B", [
      { kind: "pitfall", text: "issue on bmad 2", failure_class: "bmad-class" },
    ]);

    // Must not throw — gracefully returns [].
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3: Unit — duplicate suppression (already has a pending hardening story)
// ---------------------------------------------------------------------------

describe("AC3 — retro loop does not draft a duplicate when a pending hardening story exists", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gather-retro-ac3-"));
    await setupNativeWorkspace(tmpRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Seed a to-do/ manifest that looks like a hardening story for `failure_class`.
   * The deduplication key is the title: "[Hardening] Guard against <failure_class>".
   */
  async function seedHardeningManifest(failureClass: string, state: "to-do" | "in-progress"): Promise<void> {
    const ref = `native:01HZHARD${state === "to-do" ? "TODO" : "INPR"}0000000001`;
    const manifest: Record<string, unknown> = {
      ref,
      status: state,
      adapter: "native",
      source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
      source_hash: SOURCE_HASH,
      depends_on: [],
      acceptance_criteria: [
        { text: "Given x, when y, then z.", kind: "integration" },
      ],
      title: `[Hardening] Guard against ${failureClass}`,
      narrative: "As a non-engineer operator, I want a guard.",
      withdrawn: false,
    };
    if (state === "in-progress") {
      manifest["claimed_by"] = "01HZSESSTEST0000000000001";
    }
    const stateDir = path.join(tmpRoot, ".flow", "state", state);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, `${ref}.yaml`),
      yamlStringify(manifest, { lineWidth: 0 }),
      "utf8",
    );
  }

  it("skips drafting when a not-ready (to-do) hardening story already exists for the same failure_class", async () => {
    const FC = "parse-drift";
    // Seed two recurring pitfall lessons.
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000010A", [
      { kind: "pitfall", text: "parse drifted again", failure_class: FC },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000010B", [
      { kind: "pitfall", text: "parse drifted once more", failure_class: FC },
    ]);

    // An existing to-do/ hardening story for "parse-drift".
    await seedHardeningManifest(FC, "to-do");

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // No new story drafted — already pending.
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(0);
    // No new file appeared in native-stories.
    expect(await listNativeStories(tmpRoot)).toHaveLength(0);
  });

  it("skips drafting when an in-progress hardening story already exists for the same failure_class", async () => {
    const FC = "handoff-grammar";
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000011A", [
      { kind: "pitfall", text: "handoff missing", failure_class: FC },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000011B", [
      { kind: "pitfall", text: "handoff wrong phrase", failure_class: FC },
    ]);

    // Existing in-progress hardening story.
    await seedHardeningManifest(FC, "in-progress");

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.mechanicalFailuresDrafted).toHaveLength(0);
    expect(await listNativeStories(tmpRoot)).toHaveLength(0);
  });

  it("drafts for a second failure_class when only the first is already pending", async () => {
    const FC_EXISTING = "parse-drift";
    const FC_NEW = "forced-retry";

    // Both classes have 2 occurrences.
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000012A", [
      { kind: "pitfall", text: "parse issue", failure_class: FC_EXISTING },
      { kind: "pitfall", text: "retry issue", failure_class: FC_NEW },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000012B", [
      { kind: "pitfall", text: "parse issue 2", failure_class: FC_EXISTING },
      { kind: "pitfall", text: "retry issue 2", failure_class: FC_NEW },
    ]);

    // Pending hardening story only for FC_EXISTING.
    await seedHardeningManifest(FC_EXISTING, "to-do");

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // Only the new failure class was drafted.
    expect(bundle.mechanicalFailuresDrafted).toHaveLength(1);
    expect(bundle.mechanicalFailuresDrafted[0]!.failure_class).toBe(FC_NEW);
  });

  it("second retro run on same cycle does not produce a duplicate (idempotency)", async () => {
    const FC = "parse-drift";
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000013A", [
      { kind: "pitfall", text: "parse issue first run", failure_class: FC },
    ]);
    await seedDoneManifest(tmpRoot, "native:01HZSTORY000000000000013B", [
      { kind: "pitfall", text: "parse issue second run", failure_class: FC },
    ]);

    // First run — drafts the hardening story.
    const firstBundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(firstBundle.mechanicalFailuresDrafted).toHaveLength(1);
    const firstStoriesCount = (await listNativeStories(tmpRoot)).length;
    expect(firstStoriesCount).toBe(1);

    // The hardening story was written to native-stories/ but has no manifest yet
    // (it is "native-source-only" in readBacklogInventory). The dedup check reads
    // the backlog inventory — but native-source-only entries come from the
    // native-stories/ directory, not from a state/ manifest. The dedup key is
    // the story title; native-source-only entries get their title from the H1.
    // Since the hardening story was written with the canonical title, the second
    // run should find it and skip re-drafting.
    //
    // Second run — must NOT draft a duplicate.
    const secondBundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(secondBundle.mechanicalFailuresDrafted).toHaveLength(0);

    // Still only one file in native-stories.
    const secondStoriesCount = (await listNativeStories(tmpRoot)).length;
    expect(secondStoriesCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KTAP1N6DEF181646EW3RJH8W — AC4: friction events written by
// execution-phase seams surface in recurringFriction at threshold.
//
// Proves the end-to-end path: emitFriction → logTelemetryEvent →
// .flow/telemetry/<month>.jsonl → gatherRetroInputs.recurringFriction.
// ---------------------------------------------------------------------------

describe("AC4 — friction events written to telemetry appear in recurringFriction at threshold", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gather-retro-ac4-"));
    await setupNativeWorkspace(tmpRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Write N agent.friction events of the given kind directly to the telemetry
   * JSONL file, using logTelemetryEvent (the same path the real seams use).
   */
  async function seedFrictionEvents(
    kind: "empty-input" | "missing-cited-source" | "forced-fallback",
    count: number,
  ): Promise<void> {
    const { logTelemetryEvent } = await import("../lib/logger.js");
    for (let i = 0; i < count; i++) {
      await logTelemetryEvent({
        targetRepoRoot: tmpRoot,
        event: {
          type: "agent.friction",
          session_id: "01HZSESSTEST0000000000001",
          agent: "generalist-dev",
          story_id: `native:01HZSTORY00000000000AC4${String(i).padStart(2, "0")}`,
          data: {
            kind,
            expected: "clean gate",
            observed: `gate failed (iteration ${i})`,
          },
        },
      });
    }
  }

  it("two forced-fallback events appear in recurringFriction with count >= 2", async () => {
    await seedFrictionEvents("forced-fallback", 2);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // The kind appears in recurringFriction with count at least 2.
    const entry = bundle.recurringFriction.find((e) => e.kind === "forced-fallback");
    expect(entry).toBeDefined();
    expect(entry!.count).toBeGreaterThanOrEqual(2);
  });

  it("two empty-input events appear in recurringFriction with count >= 2", async () => {
    await seedFrictionEvents("empty-input", 2);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    const entry = bundle.recurringFriction.find((e) => e.kind === "empty-input");
    expect(entry).toBeDefined();
    expect(entry!.count).toBeGreaterThanOrEqual(2);
  });

  it("two events of each kind both appear in recurringFriction (both kinds surface)", async () => {
    await seedFrictionEvents("forced-fallback", 2);
    await seedFrictionEvents("empty-input", 2);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    const forcedEntry = bundle.recurringFriction.find((e) => e.kind === "forced-fallback");
    const emptyEntry = bundle.recurringFriction.find((e) => e.kind === "empty-input");
    expect(forcedEntry).toBeDefined();
    expect(forcedEntry!.count).toBeGreaterThanOrEqual(2);
    expect(emptyEntry).toBeDefined();
    expect(emptyEntry!.count).toBeGreaterThanOrEqual(2);
  });

  it("a single event (below threshold) does NOT appear in recurringFriction", async () => {
    await seedFrictionEvents("missing-cited-source", 1);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    const entry = bundle.recurringFriction.find((e) => e.kind === "missing-cited-source");
    expect(entry).toBeUndefined();
  });
});
