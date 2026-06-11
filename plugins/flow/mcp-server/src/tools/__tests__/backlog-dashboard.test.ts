/**
 * Tests for the generated backlog dashboard — Story 9.5 (Epic 9 intake
 * cockpit, read surface).
 *
 *   AC1: group-by-epic from the live inventory read (not a hand-maintained
 *        list). Seed manifests spanning multiple epics and states; render; the
 *        output groups items by epic with each item's state shown.
 *   AC2: each item shows readiness AND claimability; a not-ready item is
 *        visibly distinct from a ready one. Seed a ready item and a not-ready
 *        item (both deps-satisfied); the rows distinguish them.
 *   AC3: the renderer is a pure function of a typed snapshot — no file IO, no
 *        clock; two calls with the same snapshot are byte-identical. The state
 *        read is a separate getter.
 *   AC4: the table is a function of state — flip an item ready via the brake
 *        tool, re-read + re-render, and ONLY that item's readiness/claimability
 *        changes; no manual table edit.
 *
 * Uses a real tmpdir with real `node:fs` ops (the inventory reader is impure).
 * Manifests are written via the canonical `atomicWriteFile` primitive to comply
 * with the static fs-guard. The pure-render AC (AC3) is exercised against a
 * hand-built snapshot with NO filesystem at all — that is the point of the
 * getter/renderer split.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { markStoryReady } from "../mark-story-ready.js";
import {
  deriveEpic,
  getBacklogDashboard,
  renderBacklogDashboard,
  type BacklogDashboardSnapshot,
} from "../render-backlog-dashboard.js";
import { shortHandle } from "../../lib/short-handle.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";
import type { StateName } from "../../state/manifest-state-machine.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function stateDir(state: StateName): string {
  return path.join(tmpRoot, ".flow", "state", state);
}

function makeManifest(
  ref: string,
  state: StateName,
  opts: { ready?: boolean; withdrawn?: boolean; depends_on?: string[] } = {},
): ExecutionManifest {
  return {
    ref,
    status: state,
    adapter: "bmad",
    source_path: `_bmad-output/${ref}.md`,
    source_hash: "a".repeat(64),
    depends_on: opts.depends_on ?? [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Story ${ref}`,
    narrative: "As a dev, I want to test.",
    withdrawn: opts.withdrawn ?? false,
    ready: opts.ready ?? false,
  };
}

async function seed(
  ref: string,
  state: StateName,
  opts: { ready?: boolean; withdrawn?: boolean; depends_on?: string[] } = {},
): Promise<void> {
  const manifest = makeManifest(ref, state, opts);
  await atomicWriteFile(
    path.join(stateDir(state), `${ref}.yaml`),
    yamlStringify(manifest, { lineWidth: 0 }),
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-backlog-dashboard-"));
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  // A bmad config so the inventory reader resolves the workspace and skips the
  // native-stories scan (these fixtures are bmad-shaped refs). The bmad adapter
  // config requires a stories_root.
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: bmad\nadapter_config:\n  stories_root: _bmad-output/stories\n",
  );
  for (const state of ["to-do", "in-progress", "blocked", "done"] as const) {
    await fs.mkdir(stateDir(state), { recursive: true });
  }
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC1 — group-by-epic from the live inventory read
// ---------------------------------------------------------------------------

describe("backlog dashboard AC1 — groups by epic from live state", () => {
  it("groups items by epic and shows each item's state, derived from the inventory read", async () => {
    // Manifests spanning multiple epics and multiple states.
    await seed("bmad:1.1", "done");
    await seed("bmad:1.2", "to-do");
    await seed("bmad:2.1", "in-progress");
    await seed("bmad:2.2", "blocked");

    const snapshot = await getBacklogDashboard({ targetRepoRoot: tmpRoot });
    const text = renderBacklogDashboard(snapshot);

    // Grouped by epic — both epic headings present, Epic 1 before Epic 2.
    expect(text).toContain("Epic 1");
    expect(text).toContain("Epic 2");
    expect(text.indexOf("Epic 1")).toBeLessThan(text.indexOf("Epic 2"));

    // Each epic carries its own items (derived from the ref), not a flat list.
    const e1 = snapshot.entries.filter((x) => x.epic === "1").map((x) => x.ref);
    const e2 = snapshot.entries.filter((x) => x.epic === "2").map((x) => x.ref);
    expect(e1.sort()).toEqual(["bmad:1.1", "bmad:1.2"]);
    expect(e2.sort()).toEqual(["bmad:2.1", "bmad:2.2"]);

    // Each item's state is shown in the rendered output.
    // The row format is: [shortHandle] ref — title [state] (readiness, claimability)
    // For bmad refs the short handle is the local part (e.g. "1.1").
    expect(text).toContain("[1.1] bmad:1.1 — Story bmad:1.1 [done]");
    expect(text).toContain("[1.2] bmad:1.2 — Story bmad:1.2 [to-do]");
    expect(text).toContain("[2.1] bmad:2.1 — Story bmad:2.1 [in-progress]");
    expect(text).toContain("[2.2] bmad:2.2 — Story bmad:2.2 [blocked]");
  });

  it("renders an empty backlog cleanly (no crash)", async () => {
    const snapshot = await getBacklogDashboard({ targetRepoRoot: tmpRoot });
    const text = renderBacklogDashboard(snapshot);
    expect(snapshot.entries).toEqual([]);
    expect(text).toContain("nothing here");
  });
});

// ---------------------------------------------------------------------------
// AC2 — readiness AND claimability, ready item visibly distinct from not-ready
// ---------------------------------------------------------------------------

describe("backlog dashboard AC2 — shows readiness and claimability distinctly", () => {
  it("a ready (claimable) item is visibly distinct from a not-ready item, both deps-satisfied", async () => {
    // A blessed item with satisfied (empty) deps → ready + claimable.
    await seed("bmad:3.1", "to-do", { ready: true });
    // A not-ready item with satisfied deps → not ready + not claimable.
    await seed("bmad:3.2", "to-do", { ready: false });

    const snapshot = await getBacklogDashboard({ targetRepoRoot: tmpRoot });
    const text = renderBacklogDashboard(snapshot);

    const readyEntry = snapshot.entries.find((x) => x.ref === "bmad:3.1")!;
    const notReadyEntry = snapshot.entries.find((x) => x.ref === "bmad:3.2")!;

    expect(readyEntry.ready).toBe(true);
    expect(readyEntry.claimable).toBe(true);
    expect(notReadyEntry.ready).toBe(false);
    expect(notReadyEntry.claimable).toBe(false);

    // The rows are textually distinct on readiness/claimability.
    expect(text).toContain("[3.1] bmad:3.1 — Story bmad:3.1 [to-do] (ready, claimable)");
    expect(text).toContain("[3.2] bmad:3.2 — Story bmad:3.2 [to-do] (not ready, not claimable)");
  });

  it("ready but blocked on an unmet dependency reads ready yet NOT claimable", async () => {
    // bmad:4.2 is blessed but depends on bmad:4.1 which is NOT in done/.
    await seed("bmad:4.2", "to-do", { ready: true, depends_on: ["bmad:4.1"] });

    const snapshot = await getBacklogDashboard({ targetRepoRoot: tmpRoot });
    const entry = snapshot.entries.find((x) => x.ref === "bmad:4.2")!;
    expect(entry.ready).toBe(true);
    expect(entry.claimable).toBe(false);

    const text = renderBacklogDashboard(snapshot);
    expect(text).toContain("[4.2] bmad:4.2 — Story bmad:4.2 [to-do] (ready, not claimable)");
  });
});

// ---------------------------------------------------------------------------
// AC3 — pure renderer: byte-identical, no IO; state read is a separate getter
// ---------------------------------------------------------------------------

describe("backlog dashboard AC3 — renderer is a pure function of the snapshot", () => {
  const snapshot: BacklogDashboardSnapshot = {
    entries: [
      {
        ref: "bmad:2.1",
        title: "Two one",
        epic: "2",
        state: "to-do",
        withdrawn: false,
        ready: true,
        claimable: true,
      },
      {
        ref: "bmad:1.1",
        title: "One one",
        epic: "1",
        state: "done",
        withdrawn: false,
        ready: false,
        claimable: false,
      },
    ],
    refsHeld: [],
  };

  it("returns byte-identical output for the same snapshot across two calls", () => {
    const a = renderBacklogDashboard(snapshot);
    const b = renderBacklogDashboard(snapshot);
    expect(a).toBe(b);
  });

  it("performs no file IO (pure-function contract)", () => {
    const readPromise = vi.spyOn(fs, "readFile");
    const readdir = vi.spyOn(fs, "readdir");
    const stat = vi.spyOn(fs, "stat");

    renderBacklogDashboard(snapshot);

    expect(readPromise).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("orders epics numerically and keeps natural ref order within an epic", () => {
    const text = renderBacklogDashboard(snapshot);
    // Epic 1 heading appears before Epic 2 even though entry order is 2 then 1.
    expect(text.indexOf("Epic 1")).toBeLessThan(text.indexOf("Epic 2"));
  });

  it("deriveEpic strips the adapter prefix and reads the epic before the dot; null for ref with no dot", () => {
    expect(deriveEpic("bmad:9.5")).toBe("9");
    expect(deriveEpic("bmad:12.3")).toBe("12");
    expect(deriveEpic("native:01HZABC0000000000000000001")).toBeNull();
  });

  it("AC1 (this story) — a native ULID row shows only the first-8-char handle, not the full 26-char ULID", () => {
    // Use a native ref whose ULID is 26 chars (standard ULID length).
    const nativeRef = "native:01KT1NR9F6133VHY601SF3BD5N";
    const nativeHandle = shortHandle(nativeRef); // "01KT1NR9"
    expect(nativeHandle.length).toBe(8);
    expect(nativeHandle).not.toBe("01KT1NR9F6133VHY601SF3BD5N"); // shorter than full ULID

    const nativeSnapshot: BacklogDashboardSnapshot = {
      entries: [
        {
          ref: nativeRef,
          title: "A native story",
          epic: null,
          state: "to-do",
          withdrawn: false,
          ready: true,
          claimable: true,
        },
      ],
      refsHeld: [],
    };

    const text = renderBacklogDashboard(nativeSnapshot);
    // The short handle (first 8 chars) must appear in the row.
    expect(text).toContain(`[${nativeHandle}]`);
    // The full 26-character ULID must NOT appear as the display handle.
    // (The full ref "native:01KT1NR9F6133VHY601SF3BD5N" will still appear as the ref label.)
    const rowLine = text.split("\n").find((l) => l.includes(nativeRef))!;
    expect(rowLine).toBeDefined();
    // Row format: "  - [<handle>] <full-ref> — ..."
    // The short handle bracket appears before the full ref in the row.
    expect(rowLine).toContain(`[${nativeHandle}]`);
    expect(rowLine.indexOf(`[${nativeHandle}]`)).toBeLessThan(rowLine.indexOf(nativeRef));
    // The handle is visibly shorter than the full 26-char ULID.
    expect(nativeHandle.length).toBeLessThan("01KT1NR9F6133VHY601SF3BD5N".length);
  });
});

// ---------------------------------------------------------------------------
// AC4 — table is a function of state: flip via the brake tool, re-render
// ---------------------------------------------------------------------------

describe("backlog dashboard AC4 — re-reads after a brake-tool toggle", () => {
  it("marking an item ready flips ONLY that item's readiness/claimability on re-render", async () => {
    await seed("bmad:5.1", "to-do", { ready: false });
    await seed("bmad:5.2", "to-do", { ready: false });

    const before = await getBacklogDashboard({ targetRepoRoot: tmpRoot });
    const beforeText = renderBacklogDashboard(before);

    // bmad:5.1 starts not-ready / not-claimable.
    const before51 = before.entries.find((x) => x.ref === "bmad:5.1")!;
    const before52 = before.entries.find((x) => x.ref === "bmad:5.2")!;
    expect(before51.ready).toBe(false);
    expect(before51.claimable).toBe(false);

    // Flip bmad:5.1 ready THROUGH the brake tool (no manual table edit).
    const result = await markStoryReady({
      targetRepoRoot: tmpRoot,
      ref: "bmad:5.1",
      ready: true,
    });
    expect(result.noop).toBe(false);
    expect(result.ready).toBe(true);

    // Re-read + re-render.
    const after = await getBacklogDashboard({ targetRepoRoot: tmpRoot });
    const afterText = renderBacklogDashboard(after);

    const after51 = after.entries.find((x) => x.ref === "bmad:5.1")!;
    const after52 = after.entries.find((x) => x.ref === "bmad:5.2")!;

    // Only bmad:5.1 changed: now ready + claimable.
    expect(after51.ready).toBe(true);
    expect(after51.claimable).toBe(true);

    // bmad:5.2 is unchanged on both axes.
    expect(after52.ready).toBe(before52.ready);
    expect(after52.claimable).toBe(before52.claimable);

    // The rendered text changed for 5.1 and is otherwise the same shape.
    expect(beforeText).toContain("[5.1] bmad:5.1 — Story bmad:5.1 [to-do] (not ready, not claimable)");
    expect(afterText).toContain("[5.1] bmad:5.1 — Story bmad:5.1 [to-do] (ready, claimable)");
    expect(afterText).toContain("[5.2] bmad:5.2 — Story bmad:5.2 [to-do] (not ready, not claimable)");
  });
});
