/**
 * Integration tests for Story native:01KTSR3E7FE61XB2PN8VJ24289 AC3.
 *
 * AC3: Given the backlog folder contains both usable and unusable story files,
 * When the operator views the backlog dashboard, Then the dashboard shows a
 * single consistent line of expected-work counters — files seen, files rejected
 * and why, and stories held — so the operator never sees a count of stories the
 * scan could not actually pick up presented as ready work.
 *
 * Also verifies AC4 on the dashboard surface: when everything is claimable (no
 * held items), the counter line reads zero across the board.
 *
 * Uses a real tmpdir with real fs ops (the inventory reader is impure).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import {
  getBacklogDashboard,
  renderBacklogDashboard,
} from "../render-backlog-dashboard.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function stateDir(state: string): string {
  return path.join(tmpRoot, ".flow", "state", state);
}

function makeManifest(
  ref: string,
  state: "to-do" | "in-progress" | "done" | "blocked",
  opts: { ready?: boolean; depends_on?: string[]; withdrawn?: boolean } = {},
): ExecutionManifest {
  return {
    ref,
    status: state,
    adapter: "native",
    source_path: `.flow/native-stories/${ref}.md`,
    source_hash: "a".repeat(64),
    depends_on: opts.depends_on ?? [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Story ${ref}`,
    narrative: "As a dev, I want to test.",
    withdrawn: opts.withdrawn ?? false,
    ready: opts.ready ?? false,
  };
}

async function seedManifest(manifest: ExecutionManifest): Promise<void> {
  const dir = stateDir(manifest.status);
  await atomicWriteFile(
    path.join(dir, `${manifest.ref}.yaml`),
    yamlStringify(manifest, { lineWidth: 0 }),
  );
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-dashboard-ew-counters-"));
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  // A bmad config so the inventory reader resolves the workspace (these fixtures
  // are native-ref shaped but the bmad adapter skips the stories scan for reading).
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: bmad\nadapter_config:\n  stories_root: _bmad-output/stories\n",
  );
  for (const state of ["to-do", "in-progress", "blocked", "done"]) {
    await fs.mkdir(stateDir(state), { recursive: true });
  }
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC3: dashboard shows held refs in the counter line
// ---------------------------------------------------------------------------

describe("AC3 — dashboard expected-work counters reflect held (not-claimable) to-do items", () => {
  it("shows non-zero held count and lists held refs when to-do items are not claimable", async () => {
    const REF_UNBLESSED = "native:01AAAAAAAAAAAAAAAAAAAAAAAA";
    const REF_DEPS_BLOCKED = "native:01BBBBBBBBBBBBBBBBBBBBBBBB";
    const MISSING_DEP = "native:01CCCCCCCCCCCCCCCCCCCCCCCC";

    // One not-ready story, one deps-blocked story (dep not in done/).
    await seedManifest(makeManifest(REF_UNBLESSED, "to-do", { ready: false }));
    await seedManifest(makeManifest(REF_DEPS_BLOCKED, "to-do", { ready: true, depends_on: [MISSING_DEP] }));

    const snapshot = await getBacklogDashboard({ targetRepoRoot: tmpRoot });
    const text = renderBacklogDashboard(snapshot);

    // Counter line present with non-zero held count.
    expect(text).toContain("expected-work:");
    expect(text).toContain("2 held");

    // Both held refs named with their reasons.
    expect(text).toContain(`${REF_UNBLESSED} (not-ready)`);
    expect(text).toContain(`${REF_DEPS_BLOCKED} (deps-not-done)`);
  });

  it("snapshot.refsHeld has exactly the not-claimable to-do items with their reasons", async () => {
    const REF_READY = "native:01AAAAAAAAAAAAAAAAAAAAAAAB";
    const REF_NOT_READY = "native:01BBBBBBBBBBBBBBBBBBBBBBBC";

    // One claimable (ready, no deps), one not-claimable (not ready).
    await seedManifest(makeManifest(REF_READY, "to-do", { ready: true }));
    await seedManifest(makeManifest(REF_NOT_READY, "to-do", { ready: false }));

    const snapshot = await getBacklogDashboard({ targetRepoRoot: tmpRoot });

    // Only the not-claimable one should appear in refsHeld.
    expect(snapshot.refsHeld).toHaveLength(1);
    expect(snapshot.refsHeld[0]!.ref).toBe(REF_NOT_READY);
    expect(snapshot.refsHeld[0]!.reason).toBe("not-ready");
  });

  it("does not include withdrawn or non-to-do items in held refs", async () => {
    const REF_WITHDRAWN = "native:01AAAAAAAAAAAAAAAAAAAAAAAC";
    const REF_DONE = "native:01AAAAAAAAAAAAAAAAAAAAAAAD";
    const REF_IN_PROGRESS = "native:01AAAAAAAAAAAAAAAAAAAAAAAE";

    await seedManifest(makeManifest(REF_WITHDRAWN, "to-do", { ready: false, withdrawn: true }));
    await seedManifest(makeManifest(REF_DONE, "done", { ready: true }));
    await seedManifest(makeManifest(REF_IN_PROGRESS, "in-progress", { ready: true }));

    const snapshot = await getBacklogDashboard({ targetRepoRoot: tmpRoot });

    // Withdrawn and non-to-do items must not appear in held refs.
    expect(snapshot.refsHeld).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 on dashboard surface: explicit zero counter when all items are claimable
// ---------------------------------------------------------------------------

describe("AC4 on dashboard surface — explicit zero counter when everything is claimable", () => {
  it("renders an explicit zero-held counter line when all to-do items are claimable", async () => {
    const REF_CLAIMABLE = "native:01AAAAAAAAAAAAAAAAAAAAAAAF";
    await seedManifest(makeManifest(REF_CLAIMABLE, "to-do", { ready: true }));

    const snapshot = await getBacklogDashboard({ targetRepoRoot: tmpRoot });
    const text = renderBacklogDashboard(snapshot);

    expect(text).toContain("expected-work:");
    expect(text).toContain("0 held");
    expect(text).toContain("0 rejected");
  });

  it("renders the all-zero counter line even when the backlog is completely empty", async () => {
    const snapshot = await getBacklogDashboard({ targetRepoRoot: tmpRoot });
    const text = renderBacklogDashboard(snapshot);

    expect(text).toContain("expected-work:");
    expect(text).toContain("0 held");
    expect(text).toContain("0 rejected");
  });
});
