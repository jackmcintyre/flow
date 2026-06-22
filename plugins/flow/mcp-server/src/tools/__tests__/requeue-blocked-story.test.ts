/**
 * Tests for `requeueBlockedStory` — Story native:01KVN6ASCWXAHZ0FF7YRFKJECC.
 *
 * Covers all three acceptance criteria:
 *
 *   AC1 (integration — blocked story requeued successfully):
 *     A story in blocked/ is moved to to-do/ with its block cleared, claimed_by
 *     removed, and status reset to "to-do". The very next claimNextStory call
 *     can claim it normally. The operator never touches a story file by hand.
 *
 *   AC2 (boundary — non-blocked refs refused, nothing changed):
 *     Calling requeueBlockedStory on a story that is NOT in blocked/ is refused
 *     with a plain-language NotABlockedStoryError, and the story is left exactly
 *     as it was. Covers to-do, in-progress, done, and not-found.
 *
 *   AC3 (one-copy invariant — no duplicate after requeue):
 *     A successful requeue leaves exactly one copy of the manifest in to-do/
 *     and no copy remaining in blocked/. A run can never claim and build twice.
 *
 * Uses a real tmpdir with real node:fs ops, matching the pattern in
 * discard-draft.test.ts and mark-story-ready.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { NotABlockedStoryError } from "../../errors.js";
import { requeueBlockedStory } from "../requeue-blocked-story.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_REF = "native:01KVN6ASCWXAHZ0FF7YRFKJECC";
const SESSION_ULID = "01KVPH2B0VE1E6NK60B82Z6M3H";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeBaseManifest(
  ref: string,
  opts: { adapter?: "native" | "bmad" } = {},
): Omit<ExecutionManifest, "status"> {
  return {
    ref,
    adapter: opts.adapter ?? "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Test story ${ref}`,
    narrative: "As an operator, I want to test.",
    withdrawn: false,
    ready: true,
  };
}

function makeBlockedManifest(ref: string, overrides: Partial<ExecutionManifest> = {}): ExecutionManifest {
  return {
    ...makeBaseManifest(ref),
    status: "blocked",
    claimed_by: SESSION_ULID,
    blocked_by: "worker-threw",
    ...overrides,
  } as ExecutionManifest;
}

function makeTodoManifest(ref: string): ExecutionManifest {
  return {
    ...makeBaseManifest(ref),
    status: "to-do",
  } as ExecutionManifest;
}

function makeInProgressManifest(ref: string): ExecutionManifest {
  return {
    ...makeBaseManifest(ref),
    status: "in-progress",
    claimed_by: SESSION_ULID,
  } as ExecutionManifest;
}

function makeDoneManifest(ref: string): ExecutionManifest {
  return {
    ...makeBaseManifest(ref),
    status: "done",
    claimed_by: SESSION_ULID,
  } as ExecutionManifest;
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
let todoDir: string;
let inProgressDir: string;
let doneDir: string;
let blockedDir: string;

function blockedPath(ref: string): string {
  return path.join(blockedDir, `${ref}.yaml`);
}

function todoPath(ref: string): string {
  return path.join(todoDir, `${ref}.yaml`);
}

function inProgressPath(ref: string): string {
  return path.join(inProgressDir, `${ref}.yaml`);
}

function donePath(ref: string): string {
  return path.join(doneDir, `${ref}.yaml`);
}

async function seedBlocked(manifest: ExecutionManifest): Promise<void> {
  await atomicWriteFile(blockedPath(manifest.ref), yamlStringify(manifest, { lineWidth: 0 }));
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-requeue-blocked-"));
  todoDir = path.join(tmpRoot, ".flow", "state", "to-do");
  inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
  doneDir = path.join(tmpRoot, ".flow", "state", "done");
  blockedDir = path.join(tmpRoot, ".flow", "state", "blocked");
  await fs.mkdir(todoDir, { recursive: true });
  await fs.mkdir(inProgressDir, { recursive: true });
  await fs.mkdir(doneDir, { recursive: true });
  await fs.mkdir(blockedDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — blocked story is returned to the buildable queue
// ---------------------------------------------------------------------------

describe("requeueBlockedStory AC1 — blocked story returns to to-do/", () => {
  it("moves a blocked manifest to to-do/ and returns { ref, todoPath }", async () => {
    await seedBlocked(makeBlockedManifest(STORY_REF));

    const result = await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    expect(result.ref).toBe(STORY_REF);
    expect(result.todoPath).toBe(todoPath(STORY_REF));

    // The to-do manifest now exists.
    await expect(fs.stat(todoPath(STORY_REF))).resolves.toBeTruthy();
  });

  it("clears blocked_by and claimed_by in the requeued manifest", async () => {
    await seedBlocked(makeBlockedManifest(STORY_REF));

    await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    const raw = await fs.readFile(todoPath(STORY_REF), "utf8");
    const manifest = yamlParse(raw) as ExecutionManifest;

    expect(manifest.blocked_by).toBeUndefined();
    expect(manifest.claimed_by).toBeUndefined();
  });

  it("sets status to 'to-do' in the requeued manifest", async () => {
    await seedBlocked(makeBlockedManifest(STORY_REF));

    await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    const raw = await fs.readFile(todoPath(STORY_REF), "utf8");
    const manifest = yamlParse(raw) as ExecutionManifest;

    expect(manifest.status).toBe("to-do");
  });

  it("preserves all other manifest fields (title, ACs, depends_on, etc.)", async () => {
    const original = makeBlockedManifest(STORY_REF);
    await seedBlocked(original);

    await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    const raw = await fs.readFile(todoPath(STORY_REF), "utf8");
    const manifest = yamlParse(raw) as ExecutionManifest;

    expect(manifest.ref).toBe(original.ref);
    expect(manifest.title).toBe(original.title);
    expect(manifest.narrative).toBe(original.narrative);
    expect(manifest.source_hash).toBe(original.source_hash);
    expect(manifest.acceptance_criteria).toHaveLength(original.acceptance_criteria.length);
    expect(manifest.withdrawn).toBe(false);
    expect(manifest.ready).toBe(true);
  });

  it("works for a story blocked with 'handoff-grammar' reason", async () => {
    await seedBlocked(makeBlockedManifest(STORY_REF, { blocked_by: "handoff-grammar" }));

    const result = await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    expect(result.ref).toBe(STORY_REF);

    const raw = await fs.readFile(todoPath(STORY_REF), "utf8");
    const manifest = yamlParse(raw) as ExecutionManifest;
    expect(manifest.status).toBe("to-do");
    expect(manifest.blocked_by).toBeUndefined();
  });

  it("works for a story blocked with 'reviewer-verdict-needs-changes' reason", async () => {
    await seedBlocked(
      makeBlockedManifest(STORY_REF, { blocked_by: "reviewer-verdict-needs-changes" }),
    );

    await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    const raw = await fs.readFile(todoPath(STORY_REF), "utf8");
    const manifest = yamlParse(raw) as ExecutionManifest;
    expect(manifest.status).toBe("to-do");
    expect(manifest.blocked_by).toBeUndefined();
  });

  it("does not leave the original blocked manifest behind (no stale copy)", async () => {
    await seedBlocked(makeBlockedManifest(STORY_REF));

    await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    // The blocked/ entry is gone.
    await expect(fs.stat(blockedPath(STORY_REF))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC2 — non-blocked refs refused with a plain-language explanation
// ---------------------------------------------------------------------------

describe("requeueBlockedStory AC2 — non-blocked refs refused, story left untouched", () => {
  it("throws NotABlockedStoryError for a story in to-do/ (reason: to-do)", async () => {
    await atomicWriteFile(
      todoPath(STORY_REF),
      yamlStringify(makeTodoManifest(STORY_REF), { lineWidth: 0 }),
    );

    await expect(
      requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF }),
    ).rejects.toBeInstanceOf(NotABlockedStoryError);

    // Story is still in to-do/ exactly as it was.
    await expect(fs.stat(todoPath(STORY_REF))).resolves.toBeTruthy();
  });

  it("throws NotABlockedStoryError for a story in in-progress/", async () => {
    await atomicWriteFile(
      inProgressPath(STORY_REF),
      yamlStringify(makeInProgressManifest(STORY_REF), { lineWidth: 0 }),
    );

    await expect(
      requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF }),
    ).rejects.toBeInstanceOf(NotABlockedStoryError);

    // In-progress manifest untouched.
    await expect(fs.stat(inProgressPath(STORY_REF))).resolves.toBeTruthy();
  });

  it("throws NotABlockedStoryError for a story in done/", async () => {
    await atomicWriteFile(
      donePath(STORY_REF),
      yamlStringify(makeDoneManifest(STORY_REF), { lineWidth: 0 }),
    );

    await expect(
      requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF }),
    ).rejects.toBeInstanceOf(NotABlockedStoryError);

    // Done manifest untouched.
    await expect(fs.stat(donePath(STORY_REF))).resolves.toBeTruthy();
  });

  it("throws NotABlockedStoryError for a ref not found in any state directory", async () => {
    await expect(
      requeueBlockedStory({
        targetRepoRoot: tmpRoot,
        ref: "native:DOESNOTEXIST00000000000000",
      }),
    ).rejects.toBeInstanceOf(NotABlockedStoryError);
  });

  it("the typed error carries ref and foundState for a to-do story", async () => {
    await atomicWriteFile(
      todoPath(STORY_REF),
      yamlStringify(makeTodoManifest(STORY_REF), { lineWidth: 0 }),
    );

    let thrown: NotABlockedStoryError | null = null;
    try {
      await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });
    } catch (e) {
      if (e instanceof NotABlockedStoryError) thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.ref).toBe(STORY_REF);
    expect(thrown!.foundState).toBe("to-do");
  });

  it("the typed error carries foundState=null for a not-found ref", async () => {
    let thrown: NotABlockedStoryError | null = null;
    try {
      await requeueBlockedStory({
        targetRepoRoot: tmpRoot,
        ref: "native:DOESNOTEXIST00000000000000",
      });
    } catch (e) {
      if (e instanceof NotABlockedStoryError) thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.foundState).toBeNull();
  });

  it("the error message is plain-language and contains the ref", async () => {
    let thrown: NotABlockedStoryError | null = null;
    try {
      await requeueBlockedStory({
        targetRepoRoot: tmpRoot,
        ref: "native:DOESNOTEXIST00000000000000",
      });
    } catch (e) {
      if (e instanceof NotABlockedStoryError) thrown = e;
    }

    expect(thrown).not.toBeNull();
    // The message should be a plain-language refusal, not a stack trace or JSON blob.
    expect(thrown!.message).toContain("requeueBlockedStory refused");
    expect(thrown!.message).toContain("native:DOESNOTEXIST00000000000000");
  });
});

// ---------------------------------------------------------------------------
// AC3 — one-copy invariant: exactly one copy in to-do/ after requeue
// ---------------------------------------------------------------------------

describe("requeueBlockedStory AC3 — one-copy invariant: no duplicate after requeue", () => {
  it("leaves exactly one copy in to-do/ and none in blocked/ after requeue", async () => {
    await seedBlocked(makeBlockedManifest(STORY_REF));

    await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    // to-do/ has exactly one matching file.
    const todoEntries = await fs.readdir(todoDir);
    const todoMatches = todoEntries.filter((f) => f === `${STORY_REF}.yaml`);
    expect(todoMatches).toHaveLength(1);

    // blocked/ has zero matching files.
    const blockedEntries = await fs.readdir(blockedDir);
    const blockedMatches = blockedEntries.filter((f) => f === `${STORY_REF}.yaml`);
    expect(blockedMatches).toHaveLength(0);
  });

  it("total manifest count across all lanes is unchanged by the requeue", async () => {
    // Pre-condition: one manifest in blocked/ (count = 1 across all lanes).
    await seedBlocked(makeBlockedManifest(STORY_REF));

    const countBefore = await countManifests(tmpRoot);
    await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });
    const countAfter = await countManifests(tmpRoot);

    // The total count of manifests is unchanged — the story moved, not duplicated.
    expect(countAfter).toBe(countBefore);
  });

  it("the manifest in to-do/ is the only copy readable — blocked/ copy is gone", async () => {
    await seedBlocked(makeBlockedManifest(STORY_REF));

    await requeueBlockedStory({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    // to-do/ copy is readable and well-formed.
    const todoRaw = await fs.readFile(todoPath(STORY_REF), "utf8");
    const todoManifest = yamlParse(todoRaw) as ExecutionManifest;
    expect(todoManifest.status).toBe("to-do");

    // blocked/ copy does not exist (stat throws).
    await expect(fs.stat(blockedPath(STORY_REF))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helper: count all YAML manifests across the four state directories
// ---------------------------------------------------------------------------

async function countManifests(root: string): Promise<number> {
  const stateRoot = path.join(root, ".flow", "state");
  const lanes = ["to-do", "in-progress", "blocked", "done"];
  let total = 0;
  for (const lane of lanes) {
    const laneDir = path.join(stateRoot, lane);
    try {
      const entries = await fs.readdir(laneDir);
      total += entries.filter((f) => f.endsWith(".yaml")).length;
    } catch {
      // Lane dir absent — count 0.
    }
  }
  return total;
}
