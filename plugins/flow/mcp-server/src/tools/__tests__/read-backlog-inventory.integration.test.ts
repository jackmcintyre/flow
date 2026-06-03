/**
 * Integration tests for `readBacklogInventory` — Story 3.6 HIGH-1 / HIGH-3 fix.
 *
 * These tests verify that the tool:
 *   1. Scans manifests across all four state directories and returns the correct
 *      `backlog_inventory` shape the planner skill prose consumes.
 *   2. Derives `mode: "first-run"` on an empty repo and `mode: "re-open"` when
 *      at least one manifest exists.
 *   3. Includes `withdrawn` flag correctly.
 *   4. On native repos, supplements with `native-source-only` entries for ULID
 *      `.md` files that have no corresponding manifest.
 *   5. Surfaces `MalformedExecutionManifestError` verbatim on a corrupt manifest.
 *   6. Works on a BMad repo (skips native-stories scan).
 *
 * Each test operates against a copy of the committed fixture trees (or a
 * freshly-constructed tmpdir) so the committed fixtures are never mutated.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { MalformedExecutionManifestError } from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { readBacklogInventory } from "../read-backlog-inventory.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const NATIVE_FIXTURE = path.resolve(
  HERE,
  "..",
  "..",
  "adapters",
  "native",
  "fixtures",
  "sample-target-repo",
);

const BMAD_FIXTURE = path.resolve(
  HERE,
  "..",
  "..",
  "adapters",
  "bmad",
  "fixtures",
  "sample-target-repo",
);

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-read-backlog-inventory-"));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function copyFixture(fixturePath: string): Promise<string> {
  const dest = path.join(scratch, path.basename(fixturePath));
  await fs.cp(fixturePath, dest, { recursive: true });
  return dest;
}

// ---------------------------------------------------------------------------
// (1) mode: "first-run" on an empty native repo
// ---------------------------------------------------------------------------

describe("readBacklogInventory (1) — first-run on empty native repo", () => {
  it('returns mode:"first-run" and empty backlog_inventory when no manifests exist', async () => {
    // Build a minimal native repo with no state manifests.
    const root = path.join(scratch, "empty-native");
    await fs.mkdir(path.join(root, ".flow"), { recursive: true });
    await atomicWriteFile(
      path.join(root, ".flow", "config.yaml"),
      "adapter: native\n",
    );

    const result = await readBacklogInventory({ targetRepoRoot: root });

    expect(result.mode).toBe("first-run");
    expect(result.backlog_inventory).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (2) mode: "re-open" — manifests across multiple state directories
// ---------------------------------------------------------------------------

describe("readBacklogInventory (2) — re-open: manifests across to-do, in-progress, done", () => {
  it("returns mode:re-open and inventory entries from all populated state dirs", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);

    const result = await readBacklogInventory({ targetRepoRoot: root });

    expect(result.mode).toBe("re-open");

    // The fixture has manifests in to-do/, in-progress/, and done/.
    const refs = result.backlog_inventory.map((e) => e.ref);
    expect(refs).toContain("native:01HZABC0000000000000000001");
    expect(refs).toContain("native:01HZABC0000000000000000002");
    expect(refs).toContain("native:01HZABC0000000000000000003");
  });

  it("state field in each entry reflects the state directory, not the manifest status field", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);

    const result = await readBacklogInventory({ targetRepoRoot: root });

    const entry1 = result.backlog_inventory.find(
      (e) => e.ref === "native:01HZABC0000000000000000001",
    );
    const entry2 = result.backlog_inventory.find(
      (e) => e.ref === "native:01HZABC0000000000000000002",
    );
    const entry3 = result.backlog_inventory.find(
      (e) => e.ref === "native:01HZABC0000000000000000003",
    );

    // Manifest file lives in to-do/ → state: "to-do"
    expect(entry1?.state).toBe("to-do");
    // Manifest file lives in in-progress/ → state: "in-progress"
    expect(entry2?.state).toBe("in-progress");
    // Manifest file lives in done/ → state: "done"
    expect(entry3?.state).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// (3) withdrawn flag is surfaced correctly
// ---------------------------------------------------------------------------

describe("readBacklogInventory (3) — withdrawn flag is surfaced correctly", () => {
  it("returns withdrawn:false for normal manifests", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);

    const result = await readBacklogInventory({ targetRepoRoot: root });

    for (const entry of result.backlog_inventory) {
      if (entry.state !== "native-source-only") {
        expect(entry.withdrawn).toBe(false);
      }
    }
  });

  it("returns withdrawn:true for a manifest that has been flipped", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);

    // Manually flip the to-do manifest's withdrawn field.
    const manifestPath = path.join(
      root,
      ".flow",
      "state",
      "to-do",
      "native:01HZABC0000000000000000001.yaml",
    );
    const raw = await fs.readFile(manifestPath, "utf8");
    const updated = raw.replace("withdrawn: false", "withdrawn: true");
    await atomicWriteFile(manifestPath, updated);

    const result = await readBacklogInventory({ targetRepoRoot: root });
    const entry = result.backlog_inventory.find(
      (e) => e.ref === "native:01HZABC0000000000000000001",
    );
    expect(entry?.withdrawn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (4) native-source-only entries for ULID .md files without manifests
// ---------------------------------------------------------------------------

describe("readBacklogInventory (4) — native-source-only entries", () => {
  it("adds native-source-only entries for ULID .md files with no manifest", async () => {
    // Build a native repo with a source story but no manifest.
    const root = path.join(scratch, "source-only-native");
    await fs.mkdir(path.join(root, ".flow", "native-stories"), { recursive: true });
    await atomicWriteFile(
      path.join(root, ".flow", "config.yaml"),
      "adapter: native\n",
    );
    const ulid = "01HZABC0000000000000000099";
    const storyPath = path.join(root, ".flow", "native-stories", `${ulid}.md`);
    await atomicWriteFile(storyPath, "# My orphan story\n\n## Narrative\n\nAs a user, I want it.\n");

    const result = await readBacklogInventory({ targetRepoRoot: root });

    expect(result.mode).toBe("re-open");
    const entry = result.backlog_inventory.find((e) => e.ref === `native:${ulid}`);
    expect(entry).toBeDefined();
    expect(entry?.state).toBe("native-source-only");
    expect(entry?.withdrawn).toBe(false);
    expect(entry?.title).toBe("My orphan story");
  });

  it("does NOT add native-source-only entries for ULIDs that already have a manifest", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);

    const result = await readBacklogInventory({ targetRepoRoot: root });

    // The fixture has source stories 01HZABC000...001, 002, 003 — all have
    // manifests. None should appear as native-source-only.
    const sourceOnlyEntries = result.backlog_inventory.filter(
      (e) => e.state === "native-source-only",
    );
    const fixtureRefs = [
      "native:01HZABC0000000000000000001",
      "native:01HZABC0000000000000000002",
      "native:01HZABC0000000000000000003",
    ];
    for (const entry of sourceOnlyEntries) {
      expect(fixtureRefs).not.toContain(entry.ref);
    }
  });
});

// ---------------------------------------------------------------------------
// (5) MalformedExecutionManifestError surfaces verbatim
// ---------------------------------------------------------------------------

describe("readBacklogInventory (5) — MalformedExecutionManifestError surfaces verbatim", () => {
  it("throws MalformedExecutionManifestError when a manifest fails schema validation", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);

    // Corrupt the to-do manifest by removing the required `ref` field.
    const manifestPath = path.join(
      root,
      ".flow",
      "state",
      "to-do",
      "native:01HZABC0000000000000000001.yaml",
    );
    await atomicWriteFile(manifestPath, "status: to-do\ntitle: broken\n");

    await expect(
      readBacklogInventory({ targetRepoRoot: root }),
    ).rejects.toBeInstanceOf(MalformedExecutionManifestError);
  });
});

// ---------------------------------------------------------------------------
// (6) BMad repo — manifest scanned, no native-source-only entries
// ---------------------------------------------------------------------------

describe("readBacklogInventory (6) — BMad repo scans manifests, skips native-stories", () => {
  it("returns the BMad manifest and does not add native-source-only entries", async () => {
    const root = await copyFixture(BMAD_FIXTURE);

    const result = await readBacklogInventory({ targetRepoRoot: root });

    expect(result.mode).toBe("re-open");

    // The BMad fixture has bmad:1.1 in done/.
    const entry = result.backlog_inventory.find((e) => e.ref === "bmad:1.1");
    expect(entry).toBeDefined();
    expect(entry?.state).toBe("done");
    expect(entry?.withdrawn).toBe(false);

    // No native-source-only entries on a BMad repo.
    const sourceOnlyEntries = result.backlog_inventory.filter(
      (e) => e.state === "native-source-only",
    );
    expect(sourceOnlyEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (7) Shape contract — every entry has the fields the planner skill prose consumes
// ---------------------------------------------------------------------------

describe("readBacklogInventory (7) — shape contract: every entry has ref, title, state, withdrawn", () => {
  it("every backlog_inventory entry is shaped { ref, title, state, withdrawn }", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);

    const result = await readBacklogInventory({ targetRepoRoot: root });

    for (const entry of result.backlog_inventory) {
      expect(typeof entry.ref).toBe("string");
      expect(entry.ref.length).toBeGreaterThan(0);
      expect(typeof entry.title).toBe("string");
      expect(entry.title.length).toBeGreaterThan(0);
      expect(["to-do", "in-progress", "blocked", "done", "native-source-only"]).toContain(
        entry.state,
      );
      expect(typeof entry.withdrawn).toBe("boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// (8) Story 10.6 AC2 — after the cutover flip the inventory reads `native:<ULID>`
// refs identically to `bmad:<ref>` refs (the ref format is immaterial to state
// reading), and an explicit `adapter: native` config resolves WITHOUT detection
// ambiguity even when a BMad backlog also sits in the tree. This pins the
// pre-mortem: with both `.flow/native-stories/` and a BMad stories tree present,
// `detect()` could match both — the cutover avoids that by binding via explicit
// config (Branch A), never detection.
// ---------------------------------------------------------------------------

describe("readBacklogInventory (8) — Story 10.6 cutover: native reads ULID refs, no detection ambiguity", () => {
  it("reads native:<ULID> manifests identically to how a BMad repo reads bmad:<ref> manifests", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);

    const result = await readBacklogInventory({ targetRepoRoot: root });

    // Every state-manifest entry on a native repo carries a `native:<ULID>` ref
    // and is read by the same scan path as bmad refs — same { ref, title, state }
    // shape, derived from the state directory the file lives in.
    const stateEntries = result.backlog_inventory.filter(
      (e) => e.state !== "native-source-only",
    );
    expect(stateEntries.length).toBeGreaterThanOrEqual(3);
    for (const entry of stateEntries) {
      expect(entry.ref).toMatch(/^native:[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it("an explicit `adapter: native` config binds native even when a BMad stories tree also exists (no AmbiguousAdapterError)", async () => {
    // Build a repo that would be AMBIGUOUS under detection: it has BOTH a
    // populated `.flow/native-stories/` AND a BMad stories tree. The explicit
    // `adapter: native` config is what makes the cutover deterministic — the
    // workspace resolver takes Branch B (config exists) and never calls detect().
    const root = path.join(scratch, "ambiguous-but-config-pinned");
    await fs.mkdir(path.join(root, ".flow", "native-stories"), { recursive: true });
    await atomicWriteFile(
      path.join(root, ".flow", "config.yaml"),
      "adapter: native\nadapter_config: {}\n",
    );
    // A native source story (would make NativeAdapter.detect() true).
    const ulid = "01HZABC0000000000000000077";
    await atomicWriteFile(
      path.join(root, ".flow", "native-stories", `${ulid}.md`),
      "# Pinned native story\n\n## Narrative\n\nAs a user, I want it.\n",
    );
    // A BMad stories tree (would make BmadAdapter.detect() true).
    const bmadStories = path.join(root, "_bmad-output", "planning-artifacts", "stories");
    await fs.mkdir(bmadStories, { recursive: true });
    await atomicWriteFile(
      path.join(bmadStories, "1-1-some-story.md"),
      "# Story 1.1: Some story\n\nStatus: ready-for-dev\n",
    );

    // Must resolve cleanly to native and surface the native source story — NOT
    // throw AmbiguousAdapterError. The explicit config is the cutover's pin.
    const result = await readBacklogInventory({ targetRepoRoot: root });
    const entry = result.backlog_inventory.find((e) => e.ref === `native:${ulid}`);
    expect(entry).toBeDefined();
    expect(entry?.state).toBe("native-source-only");
  });
});

// ---------------------------------------------------------------------------
// (AC1, this story) — a mid-build story's claim-time `<ref>.snapshot.yaml`
// sidecar must NOT be parsed as a manifest. The sidecar has no top-level `ref`
// field, so feeding it to `parseExecutionManifest` threw
// MalformedExecutionManifestError and crashed the board. With the snapshot
// excluded, the board renders, the mid-build story appears exactly once, and
// the result is non-empty.
// ---------------------------------------------------------------------------

describe("readBacklogInventory (AC1) — mid-build snapshot sidecar does not crash the board", () => {
  it("renders the full backlog with the mid-build story exactly once when a snapshot sidecar is present", async () => {
    const root = await copyFixture(NATIVE_FIXTURE);

    // The fixture has native:...002 in in-progress/. Drop a claim-time snapshot
    // sidecar alongside it, mirroring what claim-story.ts writes on claim.
    const inProgressRef = "native:01HZABC0000000000000000002";
    const snapshotPath = path.join(
      root,
      ".flow",
      "state",
      "in-progress",
      `${inProgressRef}.snapshot.yaml`,
    );
    await atomicWriteFile(
      snapshotPath,
      yamlStringify({ source_hash: "a".repeat(64) }, { lineWidth: 0 }),
    );

    // Must not throw (pre-fix this raised MalformedExecutionManifestError).
    const result = await readBacklogInventory({ targetRepoRoot: root });

    // Board is rendered and non-empty.
    expect(result.backlog_inventory.length).toBeGreaterThan(0);

    // The mid-build story appears exactly once — the snapshot did not become a
    // phantom second entry.
    const matches = result.backlog_inventory.filter((e) => e.ref === inProgressRef);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.state).toBe("in-progress");
  });
});

// ---------------------------------------------------------------------------
// (9) gate-1 spec-feed fix — `includeSpecText` enriches entries with the real
// source markdown + persisted risk tier, and `ref` returns a single entry.
// Without this the gate-1 judge workflow fed the lens judges an empty spec.
// ---------------------------------------------------------------------------

describe("readBacklogInventory (9) — includeSpecText + ref single-item fetch", () => {
  const SPEC_ULID = "01HZABC0000000000000000091";
  const SOURCE_ONLY_ULID = "01HZABC0000000000000000092";
  const SPEC_CONTENT =
    "# Spec-feed test story\n\n## Narrative\n\nAs a tester, I want the real spec fed to judges.\n\n## Acceptance Criteria\n\n**Given** a draft **When** the panel runs **Then** it grades the real text.\n";
  const SOURCE_ONLY_CONTENT =
    "# Source-only draft\n\n## Narrative\n\nAs a tester, I want native-source-only specText too.\n";

  async function buildRepo(): Promise<string> {
    const root = path.join(scratch, "spec-feed-native");
    await fs.mkdir(path.join(root, ".flow", "native-stories"), { recursive: true });
    await fs.mkdir(path.join(root, ".flow", "state", "to-do"), { recursive: true });
    await atomicWriteFile(path.join(root, ".flow", "config.yaml"), "adapter: native\n");

    // A scanned to-do story: source file + manifest carrying source_path + risk_tier.
    await atomicWriteFile(
      path.join(root, ".flow", "native-stories", `${SPEC_ULID}.md`),
      SPEC_CONTENT,
    );
    const manifest = {
      ref: `native:${SPEC_ULID}`,
      status: "to-do",
      adapter: "native",
      source_path: `.flow/native-stories/${SPEC_ULID}.md`,
      source_hash: "a".repeat(64),
      depends_on: [],
      acceptance_criteria: [
        { text: "**Given** x **When** y **Then** z", kind: "unit" },
      ],
      title: "Spec-feed test story",
      narrative: "As a tester, I want the real spec fed to judges.",
      risk_tier: "medium",
      withdrawn: false,
      ready: true,
    };
    await atomicWriteFile(
      path.join(root, ".flow", "state", "to-do", `native:${SPEC_ULID}.yaml`),
      yamlStringify(manifest),
    );

    // A native-source-only story (no manifest).
    await atomicWriteFile(
      path.join(root, ".flow", "native-stories", `${SOURCE_ONLY_ULID}.md`),
      SOURCE_ONLY_CONTENT,
    );
    return root;
  }

  it("omits specText/riskTier by default (lean path unchanged)", async () => {
    const root = await buildRepo();
    const result = await readBacklogInventory({ targetRepoRoot: root });
    const entry = result.backlog_inventory.find((e) => e.ref === `native:${SPEC_ULID}`);
    expect(entry).toBeDefined();
    expect(entry?.specText).toBeUndefined();
    expect(entry?.riskTier).toBeUndefined();
  });

  it("includeSpecText returns the real source markdown + persisted risk tier", async () => {
    const root = await buildRepo();
    const result = await readBacklogInventory({
      targetRepoRoot: root,
      includeSpecText: true,
    });
    const entry = result.backlog_inventory.find((e) => e.ref === `native:${SPEC_ULID}`);
    expect(entry?.specText).toBe(SPEC_CONTENT);
    expect(entry?.riskTier).toBe("medium");
  });

  it("native-source-only entries get their file content as specText (no riskTier)", async () => {
    const root = await buildRepo();
    const result = await readBacklogInventory({
      targetRepoRoot: root,
      includeSpecText: true,
    });
    const entry = result.backlog_inventory.find(
      (e) => e.ref === `native:${SOURCE_ONLY_ULID}`,
    );
    expect(entry?.state).toBe("native-source-only");
    expect(entry?.specText).toBe(SOURCE_ONLY_CONTENT);
    expect(entry?.riskTier).toBeUndefined();
  });

  it("ref returns exactly the matching entry (single-item fetch), still enriched", async () => {
    const root = await buildRepo();
    const result = await readBacklogInventory({
      targetRepoRoot: root,
      ref: `native:${SPEC_ULID}`,
      includeSpecText: true,
    });
    expect(result.backlog_inventory).toHaveLength(1);
    expect(result.backlog_inventory[0]?.ref).toBe(`native:${SPEC_ULID}`);
    expect(result.backlog_inventory[0]?.specText).toBe(SPEC_CONTENT);
    // mode still reflects the whole backlog (>=1 item), not the filtered view.
    expect(result.mode).toBe("re-open");
  });
});
