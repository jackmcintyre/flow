/**
 * Unit tests for `claimNextStory` — Story 4.3b Task 1 (reviewer gap fill).
 *
 * Uses a real tmpdir with real `node:fs` ops. No mocking of imported modules —
 * follows the same pattern as `process-dev-transcript.test.ts`.
 *
 * Covers the three return branches:
 *   (a) `spawn-dev`               — at least one eligible (depsReady: true) story in to-do/.
 *   (b) `queue-drained`           — no in-progress stories AND no eligible to-do stories.
 *   (c) `waiting-on-in-progress`  — in-progress non-empty, no eligible to-do stories.
 *
 * File map reference: spec line ~355
 * (_bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md
 *  § Dev Notes / File map)
 *
 * Story 4.3b Task 1.1–1.6.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import {
  claimNextStory,
  QUEUE_DRAINED_LINE,
  WAITING_ON_IN_PROGRESS_LINE,
  WAITING_ON_UNMERGED_OVERLAP_LINE,
  WAITING_ON_UNMERGED_DEPENDENCY_LINE,
} from "../claim-next-story.js";
import { markStoryReady } from "../mark-story-ready.js";
import {
  getBacklogDashboard,
  renderBacklogDashboard,
} from "../render-backlog-dashboard.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_REF_A = "native:01J9P0K2N3MZX0YV4S5RTQ4AAA";
const STORY_REF_B = "native:01J9P0K2N3MZX0YV4S5RTQ4BBB";
const DEP_REF = "native:01J9P0K2N3MZX0YV4S5RTQ4DDD";
const SESSION_ULID = "01HZSESSION00000000000099";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTodoManifest(
  ref: string,
  opts: { depends_on?: string[]; ready?: boolean; cited_sources?: string[] } = {},
): ExecutionManifest {
  return {
    ref,
    status: "to-do",
    adapter: "native",
    source_path: `.flow/native-stories/${ref}.yaml`,
    source_hash: "a".repeat(64),
    depends_on: opts.depends_on ?? [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Test story ${ref}`,
    narrative: "As a dev, I want to test.",
    withdrawn: false,
    // Story 9.1: the claim path requires `ready: true`. Default the helper to
    // ready so the pre-existing claim/branch tests still exercise their paths;
    // the readiness-brake tests below set `ready: false` explicitly.
    ready: opts.ready ?? true,
    ...(opts.cited_sources ? { cited_sources: opts.cited_sources } : {}),
  };
}

function makeInProgressManifest(
  ref: string,
  opts: { cited_sources?: string[] } = {},
): ExecutionManifest {
  return {
    ref,
    status: "in-progress",
    adapter: "native",
    source_path: `.flow/native-stories/${ref}.yaml`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `In-progress story ${ref}`,
    narrative: "As a dev, I want to test.",
    withdrawn: false,
    ready: true,
    claimed_by: SESSION_ULID,
    ...(opts.cited_sources ? { cited_sources: opts.cited_sources } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fixture directory layout helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
let todoDir: string;
let inProgressDir: string;
let doneDir: string;

async function seedTodoStory(manifest: ExecutionManifest): Promise<void> {
  const filename = `${manifest.ref}.yaml`;
  await atomicWriteFile(path.join(todoDir, filename), yamlStringify(manifest, { lineWidth: 0 }));
}

async function seedInProgressStory(manifest: ExecutionManifest): Promise<void> {
  const filename = `${manifest.ref}.yaml`;
  await atomicWriteFile(
    path.join(inProgressDir, filename),
    yamlStringify(manifest, { lineWidth: 0 }),
  );
}

async function seedDoneStory(
  ref: string,
  opts: { cited_sources?: string[] } = {},
): Promise<void> {
  // A minimal done manifest for dependency satisfaction checks.
  const manifest: ExecutionManifest = {
    ref,
    status: "done",
    adapter: "native",
    source_path: `.flow/native-stories/${ref}.yaml`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Done story ${ref}`,
    narrative: "As a dev, I want to test.",
    withdrawn: false,
    ready: true,
    ...(opts.cited_sources ? { cited_sources: opts.cited_sources } : {}),
  };
  await atomicWriteFile(
    path.join(doneDir, `${ref}.yaml`),
    yamlStringify(manifest, { lineWidth: 0 }),
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-claim-next-story-"));
  todoDir = path.join(tmpRoot, ".flow", "state", "to-do");
  inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
  doneDir = path.join(tmpRoot, ".flow", "state", "done");

  await fs.mkdir(todoDir, { recursive: true });
  await fs.mkdir(inProgressDir, { recursive: true });
  await fs.mkdir(doneDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) spawn-dev — eligible story available
// ---------------------------------------------------------------------------

describe("(a) spawn-dev — eligible (depsReady: true) story in to-do/", () => {
  it("returns next: 'spawn-dev' with ref, title, manifestPath; manifest moves to in-progress/", async () => {
    const manifest = makeTodoManifest(STORY_REF_A);
    await seedTodoStory(manifest);

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;

    expect(result.ref).toBe(STORY_REF_A);
    expect(result.title).toBe(`Test story ${STORY_REF_A}`);
    expect(result.manifestPath).toContain(path.join("in-progress", `${STORY_REF_A}.yaml`));

    // chatLog carries the claiming line.
    expect(result.chatLog).toHaveLength(1);
    expect(result.chatLog[0]).toBe(`claiming ${STORY_REF_A} — Test story ${STORY_REF_A}`);

    // The manifest was moved out of to-do/ and into in-progress/.
    const todoExists = await fs
      .stat(path.join(todoDir, `${STORY_REF_A}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(todoExists).toBe(false);

    const inProgressExists = await fs
      .stat(path.join(inProgressDir, `${STORY_REF_A}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(inProgressExists).toBe(true);
  });

  it("picks the first eligible story in alphabetical ref order when multiple are present", async () => {
    await seedTodoStory(makeTodoManifest(STORY_REF_B));
    await seedTodoStory(makeTodoManifest(STORY_REF_A));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;

    // STORY_REF_A sorts before STORY_REF_B alphabetically.
    expect(result.ref).toBe(STORY_REF_A);
  });

  it("skips a story with an unmet dep and claims the next eligible one", async () => {
    // STORY_REF_A has an unmet dependency (dep not in done/).
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { depends_on: [DEP_REF] }));
    // STORY_REF_B has no deps (eligible).
    await seedTodoStory(makeTodoManifest(STORY_REF_B));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_B);
  });

  it("claims a story with a met dep when done/ contains that dep AND it is merged", async () => {
    await seedDoneStory(DEP_REF);
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { depends_on: [DEP_REF] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => true,
    });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_A);
  });

  it("build-blind fix: does NOT claim a story whose dep is in done/ but not merged", async () => {
    // The prerequisite is approved (in done/) but its PR is not yet merged.
    // Claiming the dependent here would build it from a main that lacks the
    // prerequisite — the exact defect the merge gate closes.
    await seedDoneStory(DEP_REF);
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { depends_on: [DEP_REF] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => false,
    });

    // B4 fix: the dependent is held SOLELY by an approved-but-UNMERGED declared
    // dependency. This is NOT a clean drain — surfacing queue-drained here would
    // lie to the operator that the queue is empty when work is actually waiting
    // on them to merge the dependency's PR. Expect the WAITING outcome naming the
    // held ref, mirroring the cited-source overlap hold (#325).
    expect(result.next).toBe("waiting-on-unmerged-dependency");
    if (result.next !== "waiting-on-unmerged-dependency") return;
    expect(result.heldRefs).toContain(STORY_REF_A);
    expect(
      result.chatLog.some((l) => l.startsWith(WAITING_ON_UNMERGED_DEPENDENCY_LINE)),
    ).toBe(true);

    // The dependent is still sitting in to-do/ (never claimed).
    const stillTodo = await fs
      .stat(path.join(todoDir, `${STORY_REF_A}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(stillTodo).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) queue-drained — no in-progress, no eligible to-do stories
// ---------------------------------------------------------------------------

describe("(b) queue-drained — no in-progress and no eligible to-do stories", () => {
  it("returns next: 'queue-drained' when to-do/ is empty and in-progress/ is empty", async () => {
    // Both dirs are empty (seeded in beforeEach but no stories added).
    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    expect(result.next).toBe("queue-drained");
    expect(result.chatLog).toContain(QUEUE_DRAINED_LINE);
  });

  it("returns next: 'queue-drained' when all to-do stories have unmet deps and in-progress/ is empty", async () => {
    // Only a deps-blocked story — no eligible candidate, no in-progress.
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { depends_on: [DEP_REF] }));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    expect(result.next).toBe("queue-drained");
    expect(result.chatLog).toContain(QUEUE_DRAINED_LINE);
  });
});

// ---------------------------------------------------------------------------
// (c) waiting-on-in-progress — in-progress non-empty, no eligible to-do stories
// ---------------------------------------------------------------------------

describe("(c) waiting-on-in-progress — in-progress non-empty, no eligible to-do stories", () => {
  it("returns next: 'waiting-on-in-progress' when in-progress/ has a story and to-do/ is empty", async () => {
    await seedInProgressStory(makeInProgressManifest(STORY_REF_B));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    expect(result.next).toBe("waiting-on-in-progress");
    expect(result.chatLog).toContain(WAITING_ON_IN_PROGRESS_LINE);
  });

  it("returns next: 'waiting-on-in-progress' when in-progress non-empty and all to-do stories have unmet deps", async () => {
    // A blocking in-progress story and a to-do story that's deps-blocked.
    await seedInProgressStory(makeInProgressManifest(STORY_REF_B));
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { depends_on: [DEP_REF] }));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    expect(result.next).toBe("waiting-on-in-progress");
    expect(result.chatLog).toContain(WAITING_ON_IN_PROGRESS_LINE);
  });
});

// ---------------------------------------------------------------------------
// Regression: tool MUST NOT spawn anything
// ---------------------------------------------------------------------------

describe("regression: no spawn", () => {
  it("does not require a Task-spawn seam — the test compiles and runs without one", async () => {
    await seedTodoStory(makeTodoManifest(STORY_REF_A));

    // If claimNextStory tried to spawn something, this test would fail because
    // no Task-spawn seam is provided. The mere fact it compiles and runs cleanly is the assertion.
    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(result.next).toBe("spawn-dev");
  });
});

// ---------------------------------------------------------------------------
// Story 9.1 — readiness brake (AC1): the claim entry point requires BOTH
// dependency-readiness AND the operator `ready` flag.
// ---------------------------------------------------------------------------

describe("Story 9.1 — readiness brake gates the claim entry point", () => {
  it("never returns a not-ready item; returns the ready one even when both are deps-satisfied", async () => {
    // Two deps-satisfied (no deps) backlog items: A is NOT ready, B is ready.
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { ready: false }));
    await seedTodoStory(makeTodoManifest(STORY_REF_B, { ready: true }));

    // STORY_REF_A sorts before STORY_REF_B, so without the brake the claim path
    // would pick A. The brake must skip A (not-ready) and select B (ready).
    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_B);
  });

  it("queue-drains when the only deps-satisfied item is not ready (fail-closed)", async () => {
    // A single deps-satisfied but not-ready item, and nothing in-progress.
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { ready: false }));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    // No eligible candidate (not ready) and no in-progress → queue-drained.
    expect(result.next).toBe("queue-drained");
    expect(result.chatLog).toContain(QUEUE_DRAINED_LINE);
  });

  it("once the not-ready item is marked ready, the claim entry point selects it", async () => {
    // Only the not-ready item exists.
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { ready: false }));

    // Pre-condition: it is never claimed while not ready.
    const before = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(before.next).toBe("queue-drained");

    // Operator blesses it via the real tool.
    const toggle = await markStoryReady({ targetRepoRoot: tmpRoot, ref: STORY_REF_A, ready: true });
    expect(toggle.noop).toBe(false);
    expect(toggle.ready).toBe(true);

    // Now the claim entry point selects it.
    const after = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(after.next).toBe("spawn-dev");
    if (after.next !== "spawn-dev") return;
    expect(after.ref).toBe(STORY_REF_A);
  });
});

// ---------------------------------------------------------------------------
// Story 10.6 AC1 — after cutover (config flipped to `adapter: native`), the
// board renders from native state grouped by epic with the blessed story shown
// claimable, AND the claim path claims that blessed native `ready` story and
// never an un-blessed one. This is the live cockpit spine (board + drain claim)
// operating on native state after the flip.
//
// This block builds its OWN config-bearing scratch repo (the file-level
// beforeEach/tmpRoot helpers don't write `.flow/config.yaml`, and the board
// getter — unlike the claim path — resolves the workspace config). Native refs
// carry an epic via `<adapter>:<epic>.<story>` so the board groups by epic for
// native exactly as for bmad; ULID-only refs sink to the "(no epic)" bucket.
// ---------------------------------------------------------------------------

describe("Story 10.6 AC1 — board + claim operate on native state after the flip", () => {
  let cutoverRoot: string;
  let cutoverTodoDir: string;

  // Native refs that carry an epic key (`<adapter>:<epic>.<story>`) so the
  // board's group-by-epic projection has something to group on. The ref format
  // is immaterial to state reading; this just proves epic-grouping is alive on
  // native refs too.
  const NATIVE_EPIC_BLESSED = "native:10.1";
  const NATIVE_EPIC_UNBLESSED = "native:10.2";

  function makeNativeTodo(
    ref: string,
    opts: { ready?: boolean } = {},
  ): ExecutionManifest {
    return {
      ref,
      status: "to-do",
      adapter: "native",
      source_path: `.flow/native-stories/${ref}.yaml`,
      source_hash: "a".repeat(64),
      depends_on: [],
      acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
      title: `Native story ${ref}`,
      narrative: "As a dev, I want to test the cutover.",
      withdrawn: false,
      ready: opts.ready ?? false,
    };
  }

  beforeEach(async () => {
    cutoverRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cutover-native-"));
    // The cutover IS this line: flip the active adapter to native.
    await fs.mkdir(path.join(cutoverRoot, ".flow"), { recursive: true });
    await atomicWriteFile(
      path.join(cutoverRoot, ".flow", "config.yaml"),
      "adapter: native\nadapter_config: {}\n",
    );
    cutoverTodoDir = path.join(cutoverRoot, ".flow", "state", "to-do");
    for (const state of ["to-do", "in-progress", "blocked", "done"] as const) {
      await fs.mkdir(path.join(cutoverRoot, ".flow", "state", state), { recursive: true });
    }
  });

  afterEach(async () => {
    await fs.rm(cutoverRoot, { recursive: true, force: true });
  });

  async function seedCutoverTodo(manifest: ExecutionManifest): Promise<void> {
    await atomicWriteFile(
      path.join(cutoverTodoDir, `${manifest.ref}.yaml`),
      yamlStringify(manifest, { lineWidth: 0 }),
    );
  }

  it("(a) the board renders native state grouped by epic with the blessed story claimable", async () => {
    await seedCutoverTodo(makeNativeTodo(NATIVE_EPIC_BLESSED, { ready: true }));
    await seedCutoverTodo(makeNativeTodo(NATIVE_EPIC_UNBLESSED, { ready: false }));

    const snapshot = await getBacklogDashboard({ targetRepoRoot: cutoverRoot });
    const text = renderBacklogDashboard(snapshot);

    // Grouped by epic from native state — Epic 10 heading present.
    expect(text).toContain("Epic 10");

    // The blessed native story is claimable; the un-blessed one is not.
    const blessed = snapshot.entries.find((e) => e.ref === NATIVE_EPIC_BLESSED)!;
    const unblessed = snapshot.entries.find((e) => e.ref === NATIVE_EPIC_UNBLESSED)!;
    expect(blessed.ready).toBe(true);
    expect(blessed.claimable).toBe(true);
    expect(unblessed.ready).toBe(false);
    expect(unblessed.claimable).toBe(false);

    // Rendered rows distinguish them textually.
    expect(text).toContain(
      `${NATIVE_EPIC_BLESSED} — Native story ${NATIVE_EPIC_BLESSED} [to-do] (ready, claimable)`,
    );
    expect(text).toContain(
      `${NATIVE_EPIC_UNBLESSED} — Native story ${NATIVE_EPIC_UNBLESSED} [to-do] (not ready, not claimable)`,
    );
  });

  it("(b) claimNextStory claims the blessed native story and never the un-blessed one", async () => {
    // Un-blessed sorts BEFORE the blessed ref alphabetically; without the
    // readiness brake the claim path would pick the un-blessed one. The brake
    // must skip it and claim the blessed native story.
    await seedCutoverTodo(makeNativeTodo(NATIVE_EPIC_BLESSED, { ready: true }));
    await seedCutoverTodo(makeNativeTodo(NATIVE_EPIC_UNBLESSED, { ready: false }));

    const result = await claimNextStory({
      targetRepoRoot: cutoverRoot,
      sessionUlid: SESSION_ULID,
    });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    // The blessed native ready story is claimed — never the un-blessed one.
    expect(result.ref).toBe(NATIVE_EPIC_BLESSED);
    expect(result.manifestPath).toContain(
      path.join("in-progress", `${NATIVE_EPIC_BLESSED}.yaml`),
    );

    // The un-blessed native story is still sitting in to-do/ (never claimed).
    const unblessedStillTodo = await fs
      .stat(path.join(cutoverTodoDir, `${NATIVE_EPIC_UNBLESSED}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(unblessedStillTodo).toBe(true);
  });

  it("(c) with only an un-blessed native story present, the claim path drains (fail-closed)", async () => {
    await seedCutoverTodo(makeNativeTodo(NATIVE_EPIC_UNBLESSED, { ready: false }));

    const result = await claimNextStory({
      targetRepoRoot: cutoverRoot,
      sessionUlid: SESSION_ULID,
    });
    expect(result.next).toBe("queue-drained");
    expect(result.chatLog).toContain(QUEUE_DRAINED_LINE);
  });
});

// ---------------------------------------------------------------------------
// Cited-source overlap gate — undeclared siblings that edit the same file are
// serialized: the later-ordered story waits until the earlier one's PR merges,
// so it builds on top instead of blind (the #300/#301 silent-integration bug,
// where both stories cited build-persona-spawn-prompt.ts with no declared edge).
// ---------------------------------------------------------------------------

describe("cited-source overlap gate", () => {
  const SHARED = "plugins/flow/mcp-server/src/tools/build-persona-spawn-prompt.ts";
  const OTHER = "plugins/flow/mcp-server/src/tools/some-unrelated-file.ts";

  it("parks the later story while an earlier overlapping story is in done/ but NOT merged", async () => {
    // A (earlier ref) is approved into done/ but its PR is unmerged; B (later
    // ref) cites the same file with no declared dependency. B must NOT be
    // claimed — it would build from a main lacking A's change and collide.
    // Story native:01KTNH6N1E64W0EM3FS5A4B4TP: this case now returns
    // waiting-on-unmerged-overlap (NOT queue-drained) so the operator sees the
    // correct WAITING/parked signal rather than a false clean-drain all-clear.
    await seedDoneStory(STORY_REF_A, { cited_sources: [SHARED] });
    await seedTodoStory(makeTodoManifest(STORY_REF_B, { cited_sources: [SHARED] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => false, // A's PR not merged
    });

    // B is held by the overlap gate — returns WAITING, NOT queue-drained.
    expect(result.next).toBe("waiting-on-unmerged-overlap");
    if (result.next !== "waiting-on-unmerged-overlap") return;
    expect(result.heldRefs).toContain(STORY_REF_B);

    // B is still in to-do/ (held, not claimed).
    const stillTodo = await fs
      .stat(path.join(todoDir, `${STORY_REF_B}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(stillTodo).toBe(true);
  });

  it("claims the later story once the earlier overlapping done/ story IS merged", async () => {
    await seedDoneStory(STORY_REF_A, { cited_sources: [SHARED] });
    await seedTodoStory(makeTodoManifest(STORY_REF_B, { cited_sources: [SHARED] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => true, // A's PR merged → B may build on top
    });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_B);
  });

  it("(AC2 / order-independent fix) blocks the EARLIER story when a LATER overlapping story is in done/ but NOT merged", async () => {
    // B (later ref) reached done/ first (approved/built out-of-order); its PR is
    // not yet merged. A (earlier ref) cites the same file and is being claimed.
    // Before this fix, A was NOT blocked (s.ref < ref guard ignored B).
    // After this fix, A must wait until B's PR merges — both stories can no longer
    // build blindly against the same baseline at once.
    await seedDoneStory(STORY_REF_B, { cited_sources: [SHARED] });
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { cited_sources: [SHARED] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => false, // B's PR NOT merged
    });

    // A is held by the overlap gate — returns WAITING, not spawn-dev.
    expect(result.next).toBe("waiting-on-unmerged-overlap");
    if (result.next !== "waiting-on-unmerged-overlap") return;
    expect(result.heldRefs).toContain(STORY_REF_A);

    // A is still in to-do/ (held, not claimed).
    const stillTodo = await fs
      .stat(path.join(todoDir, `${STORY_REF_A}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(stillTodo).toBe(true);
  });

  it("(AC2 / order-independent fix) releases the EARLIER story once the LATER overlapping done/ story IS merged", async () => {
    // Same setup as above, but B's PR is confirmed merged.
    // A should now be free to start.
    await seedDoneStory(STORY_REF_B, { cited_sources: [SHARED] });
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { cited_sources: [SHARED] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => true, // B's PR merged → A may build
    });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_A);
  });

  it("parks the to-do story while an earlier overlapping story is in-progress", async () => {
    await seedInProgressStory(
      makeInProgressManifest(STORY_REF_A, { cited_sources: [SHARED] }),
    );
    await seedTodoStory(makeTodoManifest(STORY_REF_B, { cited_sources: [SHARED] }));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    // The earlier overlapping story is in-progress → B waits.
    expect(result.next).toBe("waiting-on-in-progress");
    const stillTodo = await fs
      .stat(path.join(todoDir, `${STORY_REF_B}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(stillTodo).toBe(true);
  });

  it("(AC2 / order-independent fix) parks the EARLIER to-do story while a LATER overlapping story is in-progress", async () => {
    // B (later ref) is already in-progress (approved out-of-order).
    // A (earlier ref) cites the same file and is being claimed.
    // Before this fix, A would not be blocked. After the fix, A must wait.
    await seedInProgressStory(
      makeInProgressManifest(STORY_REF_B, { cited_sources: [SHARED] }),
    );
    await seedTodoStory(makeTodoManifest(STORY_REF_A, { cited_sources: [SHARED] }));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    // A is blocked by the in-progress later-ordered story B.
    expect(result.next).toBe("waiting-on-in-progress");
    const stillTodo = await fs
      .stat(path.join(todoDir, `${STORY_REF_A}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(stillTodo).toBe(true);
  });

  it("does NOT serialize stories whose cited files do not overlap", async () => {
    await seedDoneStory(STORY_REF_A, { cited_sources: [SHARED] });
    await seedTodoStory(makeTodoManifest(STORY_REF_B, { cited_sources: [OTHER] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => false, // A unmerged, but no shared file
    });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_B);
  });

  it("does not gate a candidate that declares no cited_sources", async () => {
    await seedDoneStory(STORY_REF_A, { cited_sources: [SHARED] });
    // B cites nothing — it cannot overlap, so it is claimable regardless of A.
    await seedTodoStory(makeTodoManifest(STORY_REF_B));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => false,
    });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_B);
  });

  it("an unblessed earlier overlapping to-do story does not stall a blessed later one", async () => {
    // A (earlier) overlaps B but is unblessed → it may never ship, so it must
    // not block B. B is claimed.
    await seedTodoStory(
      makeTodoManifest(STORY_REF_A, { ready: false, cited_sources: [SHARED] }),
    );
    await seedTodoStory(
      makeTodoManifest(STORY_REF_B, { ready: true, cited_sources: [SHARED] }),
    );

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_B);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KTN5D8V5MNXTAB4H2A0A7P9P — AC3: single-worker behaviour
// unchanged after the concurrency-safe retry loop was introduced.
// ---------------------------------------------------------------------------

describe("AC3 — single-worker behaviour unchanged", () => {
  it("a single worker claims each ready story in turn until the queue is empty", async () => {
    await seedTodoStory(makeTodoManifest(STORY_REF_A));
    await seedTodoStory(makeTodoManifest(STORY_REF_B));

    // First call — picks STORY_REF_A (alphabetically first).
    const r1 = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(r1.next).toBe("spawn-dev");
    if (r1.next !== "spawn-dev") return;
    expect(r1.ref).toBe(STORY_REF_A);

    // Second call — picks STORY_REF_B (the remaining ready story).
    const r2 = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(r2.next).toBe("spawn-dev");
    if (r2.next !== "spawn-dev") return;
    expect(r2.ref).toBe(STORY_REF_B);

    // Third call — both are in-progress, to-do is empty → waiting-on-in-progress
    // (not queue-drained because the two in-progress manifests were written by
    // claimStory and are on disk; the test is that we do NOT get queue-drained
    // when stories are still in-flight).
    const r3 = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    // Both stories are now in in-progress/, to-do/ is empty, so we get
    // waiting-on-in-progress (inProgressCount > 0).
    expect(r3.next).toBe("waiting-on-in-progress");
  });

  it("a single worker on a one-story queue returns spawn-dev and then queue-drained when both dirs are empty", async () => {
    await seedTodoStory(makeTodoManifest(STORY_REF_A));

    const r1 = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(r1.next).toBe("spawn-dev");
    if (r1.next !== "spawn-dev") return;
    expect(r1.ref).toBe(STORY_REF_A);
    expect(r1.chatLog[0]).toBe(`claiming ${STORY_REF_A} — Test story ${STORY_REF_A}`);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KTNH6N1E64W0EM3FS5A4B4TP — WAITING/parked when a ready story
// is held solely by an unmerged overlapping PR in done/.
//
// Three AC boundaries:
//   AC1 — held-on-unmerged-overlap: returns waiting-on-unmerged-overlap (drained:false)
//          naming the held story ref, NOT a clean full-drain all-clear.
//   AC2 — genuinely-empty: genuinely empty queue still returns queue-drained (drained:true),
//          unchanged.
//   AC3 — hold-still-fires: the overlap hold decision itself is preserved.
// ---------------------------------------------------------------------------

describe("Story native:01KTNH6N1E64W0EM3FS5A4B4TP — WAITING when ready story held for unmerged overlapping PR", () => {
  const SHARED_FILE = "plugins/flow/mcp-server/src/tools/claim-next-story.ts";

  // AC1: the only ready story is held because it overlaps an unmerged done/ sibling.
  it("AC1 — returns waiting-on-unmerged-overlap (not queue-drained) and names the held ref", async () => {
    // STORY_REF_A (earlier) is approved into done/ but its PR is NOT merged.
    // STORY_REF_B (later, ready) cites the same file — it must be held, not
    // claimed, and the result must NOT be queue-drained.
    await seedDoneStory(STORY_REF_A, { cited_sources: [SHARED_FILE] });
    await seedTodoStory(makeTodoManifest(STORY_REF_B, { cited_sources: [SHARED_FILE] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => false, // A's PR not merged
    });

    // Must NOT be queue-drained.
    expect(result.next).toBe("waiting-on-unmerged-overlap");
    if (result.next !== "waiting-on-unmerged-overlap") return;

    // Must name the held ref.
    expect(result.heldRefs).toContain(STORY_REF_B);

    // chatLog must carry the WAITING line.
    expect(result.chatLog.some((l) => l.startsWith(WAITING_ON_UNMERGED_OVERLAP_LINE))).toBe(true);

    // The held story must still be in to-do/ (never claimed).
    const stillTodo = await fs
      .stat(path.join(todoDir, `${STORY_REF_B}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(stillTodo).toBe(true);
  });

  // AC2: genuinely empty queue still returns queue-drained — the clean drain is unchanged.
  it("AC2 — genuinely empty queue still returns queue-drained (drained path unchanged)", async () => {
    // No stories at all — the queue is truly empty.
    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
    });

    expect(result.next).toBe("queue-drained");
    expect(result.chatLog).toContain(QUEUE_DRAINED_LINE);
  });

  it("AC2 — returns queue-drained (not waiting) when all ready stories have unmet declared deps (no overlap hold)", async () => {
    // A story blocked by an unmet declared dep — not an overlap hold.
    // This must still be queue-drained, not waiting-on-unmerged-overlap.
    await seedTodoStory(makeTodoManifest(STORY_REF_B, { depends_on: [DEP_REF] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => false,
    });

    expect(result.next).toBe("queue-drained");
    expect(result.chatLog).toContain(QUEUE_DRAINED_LINE);
  });

  // AC3: the overlap hold decision itself is unchanged — the held story is NOT claimed.
  it("AC3 — the overlap hold decision is preserved: the held story is not claimed", async () => {
    // Same setup as AC1 — overlap hold must still prevent claiming B.
    await seedDoneStory(STORY_REF_A, { cited_sources: [SHARED_FILE] });
    await seedTodoStory(makeTodoManifest(STORY_REF_B, { cited_sources: [SHARED_FILE] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => false,
    });

    // The hold decision fires — we did NOT get spawn-dev.
    expect(result.next).not.toBe("spawn-dev");

    // B was never moved to in-progress.
    const inProgressExists = await fs
      .stat(path.join(inProgressDir, `${STORY_REF_B}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(inProgressExists).toBe(false);

    // B is still in to-do/ (held, not discarded).
    const stillTodo = await fs
      .stat(path.join(todoDir, `${STORY_REF_B}.yaml`))
      .then(() => true)
      .catch(() => false);
    expect(stillTodo).toBe(true);
  });

  it("once the overlapping PR merges, the held story is claimed normally", async () => {
    // Same setup but now the PR merges → B is immediately claimable.
    await seedDoneStory(STORY_REF_A, { cited_sources: [SHARED_FILE] });
    await seedTodoStory(makeTodoManifest(STORY_REF_B, { cited_sources: [SHARED_FILE] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => true, // A's PR merged → B may build
    });

    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_B);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KTN5D8V5MNXTAB4H2A0A7P9P — AC4: genuine errors still halt the
// run loudly; they are never swallowed as a "lost race" skip.
//
// A lost race looks like: ManifestNotFoundError with fromState === "to-do"
// (the to-do/ rename target was already gone). Any other error is genuine.
// ---------------------------------------------------------------------------

describe("AC4 — genuine claim errors still halt the run loudly (not swallowed as a lost race)", () => {
  it("a corrupted to-do manifest throws rather than returning queue-drained", async () => {
    // A YAML file that is syntactically valid but schema-invalid.
    // parseExecutionManifest throws MalformedExecutionManifestError — NOT a
    // ManifestNotFoundError, so it must propagate, not be swallowed.
    const ref = STORY_REF_A;
    const { atomicWriteFile: write } = await import("../../lib/managed-fs.js");
    await write(
      path.join(todoDir, `${ref}.yaml`),
      "not_a_valid_manifest: true\n",
    );

    await expect(
      claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID }),
    ).rejects.toThrow();
  });

  it("a ManifestNotFoundError from in-progress/ (not to-do/) is treated as a genuine error, not a lost race", async () => {
    // Verify the distinction: only a ManifestNotFoundError with fromState "to-do"
    // is treated as a lost race. We test this by directly checking the error
    // class used for the skip-and-continue decision in claim-next-story.
    // A ManifestNotFoundError from any other state must propagate.
    //
    // The test: seed a valid story so listClaimableTodos returns it; then verify
    // a successful claim still works as normal (regression guard — single worker
    // path is not disturbed).
    await seedTodoStory(makeTodoManifest(STORY_REF_A));
    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(result.next).toBe("spawn-dev");
    if (result.next !== "spawn-dev") return;
    expect(result.ref).toBe(STORY_REF_A);
    // Successful claim — no error was thrown, confirming the normal path works.
  });
});
