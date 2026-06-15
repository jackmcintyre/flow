/**
 * Integration tests for Story native:01KTSR3E7FE61XB2PN8VJ24289 AC2.
 *
 * AC2: Given a run looks for the next story to work on and every ready story
 * is being held back (for any reason — a not-yet-merged earlier change, an
 * unsatisfied prerequisite, or an in-flight overlapping story), When the run
 * reports it found nothing to start, Then it states how many stories are being
 * held and lists them, instead of implying the queue is simply empty.
 *
 * Also verifies AC4 on the claim surface: when the queue truly IS empty (no
 * held stories at all), the same counter line reads zero across the board.
 *
 * Uses a real tmpdir with real fs ops. No mocking.
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
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_ULID = "01HZSESSION00000000000099";
const REF_A = "native:01J9P0K2N3MZX0YV4S5RTQ4AAA";
const REF_B = "native:01J9P0K2N3MZX0YV4S5RTQ4BBB";
const DEP_REF = "native:01J9P0K2N3MZX0YV4S5RTQ4DDD";

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
    source_path: `.flow/native-stories/${ref}.md`,
    source_hash: "a".repeat(64),
    depends_on: opts.depends_on ?? [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Test story ${ref}`,
    narrative: "As a dev, I want to test.",
    withdrawn: false,
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
    source_path: `.flow/native-stories/${ref}.md`,
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
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let todoDir: string;
let inProgressDir: string;
let doneDir: string;

async function seedTodoStory(manifest: ExecutionManifest): Promise<void> {
  await atomicWriteFile(
    path.join(todoDir, `${manifest.ref}.yaml`),
    yamlStringify(manifest, { lineWidth: 0 }),
  );
}

async function seedInProgressStory(manifest: ExecutionManifest): Promise<void> {
  await atomicWriteFile(
    path.join(inProgressDir, `${manifest.ref}.yaml`),
    yamlStringify(manifest, { lineWidth: 0 }),
  );
}

async function seedDoneStory(
  ref: string,
  opts: { cited_sources?: string[]; pr_number?: number } = {},
): Promise<void> {
  const manifest: ExecutionManifest = {
    ref,
    status: "done",
    adapter: "native",
    source_path: `.flow/native-stories/${ref}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Done story ${ref}`,
    narrative: "As a dev, I want to test.",
    withdrawn: false,
    ready: true,
    ...(opts.cited_sources ? { cited_sources: opts.cited_sources } : {}),
    ...(opts.pr_number !== undefined ? { pr_number: opts.pr_number } : {}),
  };
  await atomicWriteFile(
    path.join(doneDir, `${ref}.yaml`),
    yamlStringify(manifest, { lineWidth: 0 }),
  );
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-claim-held-counts-"));
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
// AC2: held stories are named in the chatLog output
// ---------------------------------------------------------------------------

describe("AC2 — held stories are counted and named when no eligible story is found", () => {
  it("reports held count > 0 when the only to-do story is not-ready", async () => {
    await seedTodoStory(makeTodoManifest(REF_A, { ready: false }));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(result.next).toBe("queue-drained");

    // The chatLog must include the expected-work counter line naming the held story.
    const counterLine = result.chatLog.find((l) => l.includes("expected-work:"));
    expect(counterLine).toBeDefined();
    expect(counterLine).toContain("1 held");
    // The held ref must be named.
    const heldLine = result.chatLog.find((l) => l.includes(REF_A) && l.includes("not-ready"));
    expect(heldLine).toBeDefined();
  });

  it("reports held count > 0 when the only to-do story has unsatisfied deps (not in done/)", async () => {
    // The dep is not present in done/ at all (so depsReady: false in listClaimableTodos).
    await seedTodoStory(makeTodoManifest(REF_A, { depends_on: [DEP_REF] }));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(result.next).toBe("queue-drained");

    const counterLine = result.chatLog.find((l) => l.includes("expected-work:"));
    expect(counterLine).toBeDefined();
    expect(counterLine).toContain("1 held");
    const heldLine = result.chatLog.find(
      (l) => l.includes(REF_A) && l.includes("deps-not-done"),
    );
    expect(heldLine).toBeDefined();
  });

  it("reports held count > 0 when every story is held for an unmerged declared dep (WAITING outcome)", async () => {
    await seedDoneStory(DEP_REF);
    await seedTodoStory(makeTodoManifest(REF_A, { depends_on: [DEP_REF] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isDependencyMerged: async () => false,
    });
    expect(result.next).toBe("waiting-on-unmerged-dependency");

    // chatLog must include the verbatim WAITING line AND the counter line.
    expect(result.chatLog.some((l) => l.startsWith(WAITING_ON_UNMERGED_DEPENDENCY_LINE))).toBe(
      true,
    );
    const counterLine = result.chatLog.find((l) => l.includes("expected-work:"));
    expect(counterLine).toBeDefined();
    expect(counterLine).toContain("1 held");
    const heldLine = result.chatLog.find(
      (l) => l.includes(REF_A) && l.includes("unmerged-dependency"),
    );
    expect(heldLine).toBeDefined();
  });

  it("reports held count > 0 when every story is held for an unmerged overlap (WAITING outcome)", async () => {
    const SHARED_SRC = "plugins/flow/mcp-server/src/shared.ts";
    // The done story's ref must sort BEFORE the todo story's ref so it is
    // considered "earlier" and thus blocks the later todo story.
    const EARLIER_DONE_REF = "native:01J9P0K2N3MZX0YV4S5RTQ4000";
    const LATER_TODO_REF = "native:01J9P0K2N3MZX0YV4S5RTQ4ZZZ";
    await seedDoneStory(EARLIER_DONE_REF, { cited_sources: [SHARED_SRC], pr_number: 902 });
    await seedTodoStory(makeTodoManifest(LATER_TODO_REF, { cited_sources: [SHARED_SRC] }));

    const result = await claimNextStory({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      isOverlapBlockerInFlight: async () => true, // earlier story's PR still open
    });
    expect(result.next).toBe("waiting-on-unmerged-overlap");

    expect(result.chatLog.some((l) => l.startsWith(WAITING_ON_UNMERGED_OVERLAP_LINE))).toBe(true);
    const counterLine = result.chatLog.find((l) => l.includes("expected-work:"));
    expect(counterLine).toBeDefined();
    expect(counterLine).toContain("1 held");
    const heldLine = result.chatLog.find(
      (l) => l.includes(LATER_TODO_REF) && l.includes("unmerged-overlap"),
    );
    expect(heldLine).toBeDefined();
  });

  it("reports aggregate held count > 0 when stories are held for different reasons", async () => {
    // REF_A is not-ready; REF_B has an unsatisfied dep.
    await seedTodoStory(makeTodoManifest(REF_A, { ready: false }));
    await seedTodoStory(makeTodoManifest(REF_B, { depends_on: [DEP_REF] }));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(result.next).toBe("queue-drained");

    const counterLine = result.chatLog.find((l) => l.includes("expected-work:"));
    expect(counterLine).toBeDefined();
    // Two stories held.
    expect(counterLine).toContain("2 held");
    // Both named for their respective reasons.
    expect(result.chatLog.some((l) => l.includes(REF_A) && l.includes("not-ready"))).toBe(true);
    expect(result.chatLog.some((l) => l.includes(REF_B) && l.includes("deps-not-done"))).toBe(
      true,
    );
  });

  it("reports held count on the waiting-on-in-progress path when held stories exist", async () => {
    // An in-progress story is running; one to-do story is not-ready.
    await seedInProgressStory(makeInProgressManifest(REF_B));
    await seedTodoStory(makeTodoManifest(REF_A, { ready: false }));

    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(result.next).toBe("waiting-on-in-progress");
    expect(result.chatLog.some((l) => l === WAITING_ON_IN_PROGRESS_LINE)).toBe(true);

    const counterLine = result.chatLog.find((l) => l.includes("expected-work:"));
    expect(counterLine).toBeDefined();
    expect(counterLine).toContain("1 held");
    expect(result.chatLog.some((l) => l.includes(REF_A) && l.includes("not-ready"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 on claim surface: explicit zero counter line when queue is genuinely empty
// ---------------------------------------------------------------------------

describe("AC4 on claim surface — explicit zero counter when queue is truly empty", () => {
  it("emits an explicit zero-held counter line when both to-do/ and in-progress/ are empty", async () => {
    const result = await claimNextStory({ targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID });
    expect(result.next).toBe("queue-drained");
    expect(result.chatLog.some((l) => l === QUEUE_DRAINED_LINE)).toBe(true);

    const counterLine = result.chatLog.find((l) => l.includes("expected-work:"));
    expect(counterLine).toBeDefined();
    expect(counterLine).toContain("0 held");
    expect(counterLine).toContain("0 rejected");
  });
});
