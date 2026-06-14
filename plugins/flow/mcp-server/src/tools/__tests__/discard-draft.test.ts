/**
 * Tests for `discardDraft` — Story native:01KTZKHJ1KDYKGXR20FZ15Y4WB.
 *
 * Covers:
 *
 *   AC1 (integration — eligible discard):
 *     (a) An un-claimed native to-do draft is removed from the backlog AND
 *         its source file under .flow/native-stories/ is removed, so a fresh
 *         projection pass does not re-create it (scan-proof assertion).
 *
 *   AC2 (boundary — non-eligible refs refused, nothing removed):
 *     (b) A ref already in in-progress/ raises NotAnEligibleDraftError.
 *     (c) A ref in done/ raises NotAnEligibleDraftError.
 *     (d) A ref in blocked/ raises NotAnEligibleDraftError.
 *     (e) A withdrawn to-do ref raises NotAnEligibleDraftError.
 *     (f) A non-native (bmad) adapter ref raises NotAnEligibleDraftError.
 *
 *   AC3 (idempotency — already-absent ref is a clean no-op):
 *     (g) A ref that does not exist anywhere returns { removed:false, noop:true }
 *         without raising.
 *
 * Uses a real tmpdir with real node:fs ops — same pattern as
 * mark-story-ready.test.ts. Manifests are written via the canonical
 * `atomicWriteFile` primitive to comply with the static fs-guard.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { NotAnEligibleDraftError } from "../../errors.js";
import { discardDraft } from "../discard-draft.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_REF = "native:01J9P0K2N3MZX0YV4S5RTQ4AAA";
const STORY_ULID = "01J9P0K2N3MZX0YV4S5RTQ4AAA";
const SESSION_ULID = "01HZSESSION00000000000099";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTodoManifest(
  ref: string,
  opts: {
    ready?: boolean;
    withdrawn?: boolean;
    adapter?: string;
  } = {},
): ExecutionManifest {
  return {
    ref,
    status: "to-do",
    adapter: (opts.adapter ?? "native") as "native" | "bmad",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: `Test story ${ref}`,
    narrative: "As a dev, I want to test.",
    withdrawn: opts.withdrawn ?? false,
    ready: opts.ready ?? false,
  };
}

function makeInProgressManifest(ref: string): ExecutionManifest {
  return {
    ...makeTodoManifest(ref),
    status: "in-progress",
    claimed_by: SESSION_ULID,
  };
}

function makeDoneManifest(ref: string): ExecutionManifest {
  return {
    ...makeTodoManifest(ref),
    status: "done",
    claimed_by: SESSION_ULID,
  };
}

function makeBlockedManifest(ref: string): ExecutionManifest {
  return {
    ...makeTodoManifest(ref),
    status: "blocked",
    claimed_by: SESSION_ULID,
  };
}

let tmpRoot: string;
let todoDir: string;
let inProgressDir: string;
let doneDir: string;
let blockedDir: string;
let nativeStoriesDir: string;

function todoPath(ref: string): string {
  return path.join(todoDir, `${ref}.yaml`);
}

function inProgressPath(ref: string): string {
  return path.join(inProgressDir, `${ref}.yaml`);
}

function donePath(ref: string): string {
  return path.join(doneDir, `${ref}.yaml`);
}

function blockedPath(ref: string): string {
  return path.join(blockedDir, `${ref}.yaml`);
}

function sourceDraftPath(ulid: string): string {
  return path.join(nativeStoriesDir, `${ulid}.md`);
}

async function seedTodo(manifest: ExecutionManifest): Promise<void> {
  await atomicWriteFile(todoPath(manifest.ref), yamlStringify(manifest, { lineWidth: 0 }));
}

async function seedSourceDraft(ulid: string, content = `# Story ${ulid}\n\nDraft content.\n`): Promise<void> {
  await atomicWriteFile(sourceDraftPath(ulid), content);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-discard-draft-"));
  todoDir = path.join(tmpRoot, ".flow", "state", "to-do");
  inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
  doneDir = path.join(tmpRoot, ".flow", "state", "done");
  blockedDir = path.join(tmpRoot, ".flow", "state", "blocked");
  nativeStoriesDir = path.join(tmpRoot, ".flow", "native-stories");
  await fs.mkdir(todoDir, { recursive: true });
  await fs.mkdir(inProgressDir, { recursive: true });
  await fs.mkdir(doneDir, { recursive: true });
  await fs.mkdir(blockedDir, { recursive: true });
  await fs.mkdir(nativeStoriesDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — eligible discard: manifest AND source removed; projection cannot
//        re-create (scan-proof assertion)
// ---------------------------------------------------------------------------

describe("discardDraft AC1 — eligible discard removes manifest and source draft", () => {
  it("(a) removes the to-do manifest AND the source draft for an un-claimed native draft", async () => {
    await seedTodo(makeTodoManifest(STORY_REF, { ready: false }));
    await seedSourceDraft(STORY_ULID);

    const result = await discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    expect(result.ref).toBe(STORY_REF);
    expect(result.removed).toBe(true);
    expect(result.noop).toBe(false);
    expect(result.manifestPath).toBe(todoPath(STORY_REF));
    expect(result.sourcePath).toBe(sourceDraftPath(STORY_ULID));

    // Both files are gone.
    await expect(fs.stat(todoPath(STORY_REF))).rejects.toThrow();
    await expect(fs.stat(sourceDraftPath(STORY_ULID))).rejects.toThrow();
  });

  it("(a) scan-proof: a fresh scan after discard would find no source to re-materialise", async () => {
    await seedTodo(makeTodoManifest(STORY_REF, { ready: false }));
    await seedSourceDraft(STORY_ULID);

    await discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    // The native-stories directory exists but the source draft is gone.
    const storiesEntries = await fs.readdir(nativeStoriesDir);
    const draftFiles = storiesEntries.filter((f) => f.endsWith(".md"));
    expect(draftFiles).toHaveLength(0);

    // The to-do directory has no manifest for this ref.
    const todoEntries = await fs.readdir(todoDir);
    const refManifests = todoEntries.filter((f) => f.includes(STORY_ULID));
    expect(refManifests).toHaveLength(0);
  });

  it("(a) succeeds even when the source draft file has already been hand-deleted", async () => {
    await seedTodo(makeTodoManifest(STORY_REF, { ready: false }));
    // Intentionally do NOT seed the source draft — it's already gone.

    const result = await discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    // The manifest was still removed successfully.
    expect(result.removed).toBe(true);
    expect(result.noop).toBe(false);
    await expect(fs.stat(todoPath(STORY_REF))).rejects.toThrow();
  });

  it("(a) works for a ready-true draft (operator had already approved it but not yet claimed)", async () => {
    await seedTodo(makeTodoManifest(STORY_REF, { ready: true }));
    await seedSourceDraft(STORY_ULID);

    const result = await discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF });

    expect(result.removed).toBe(true);
    await expect(fs.stat(todoPath(STORY_REF))).rejects.toThrow();
    await expect(fs.stat(sourceDraftPath(STORY_ULID))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC2 — boundary: non-eligible refs are refused; nothing is removed
// ---------------------------------------------------------------------------

describe("discardDraft AC2 — boundary refusals: non-eligible refs refused, nothing removed", () => {
  it("(b) a ref in in-progress/ raises NotAnEligibleDraftError (reason: not-in-to-do)", async () => {
    await atomicWriteFile(
      inProgressPath(STORY_REF),
      yamlStringify(makeInProgressManifest(STORY_REF), { lineWidth: 0 }),
    );
    await seedSourceDraft(STORY_ULID);

    await expect(
      discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF }),
    ).rejects.toBeInstanceOf(NotAnEligibleDraftError);

    // Nothing was removed.
    await expect(fs.stat(inProgressPath(STORY_REF))).resolves.toBeTruthy();
    await expect(fs.stat(sourceDraftPath(STORY_ULID))).resolves.toBeTruthy();
  });

  it("(b) the typed error carries ref, foundState, and reason for a non-to-do item", async () => {
    await atomicWriteFile(
      inProgressPath(STORY_REF),
      yamlStringify(makeInProgressManifest(STORY_REF), { lineWidth: 0 }),
    );

    let thrown: NotAnEligibleDraftError | null = null;
    try {
      await discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF });
    } catch (e) {
      if (e instanceof NotAnEligibleDraftError) thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.ref).toBe(STORY_REF);
    expect(thrown!.foundState).toBe("in-progress");
    expect(thrown!.reason).toBe("not-in-to-do");
  });

  it("(c) a ref in done/ raises NotAnEligibleDraftError", async () => {
    await atomicWriteFile(
      donePath(STORY_REF),
      yamlStringify(makeDoneManifest(STORY_REF), { lineWidth: 0 }),
    );
    await seedSourceDraft(STORY_ULID);

    await expect(
      discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF }),
    ).rejects.toBeInstanceOf(NotAnEligibleDraftError);

    await expect(fs.stat(donePath(STORY_REF))).resolves.toBeTruthy();
    await expect(fs.stat(sourceDraftPath(STORY_ULID))).resolves.toBeTruthy();
  });

  it("(d) a ref in blocked/ raises NotAnEligibleDraftError", async () => {
    await atomicWriteFile(
      blockedPath(STORY_REF),
      yamlStringify(makeBlockedManifest(STORY_REF), { lineWidth: 0 }),
    );
    await seedSourceDraft(STORY_ULID);

    await expect(
      discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF }),
    ).rejects.toBeInstanceOf(NotAnEligibleDraftError);

    await expect(fs.stat(blockedPath(STORY_REF))).resolves.toBeTruthy();
    await expect(fs.stat(sourceDraftPath(STORY_ULID))).resolves.toBeTruthy();
  });

  it("(e) a withdrawn to-do ref raises NotAnEligibleDraftError (reason: withdrawn)", async () => {
    await seedTodo(makeTodoManifest(STORY_REF, { withdrawn: true }));
    await seedSourceDraft(STORY_ULID);

    let thrown: NotAnEligibleDraftError | null = null;
    try {
      await discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF });
    } catch (e) {
      if (e instanceof NotAnEligibleDraftError) thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.reason).toBe("withdrawn");

    // Neither the manifest nor the source draft was touched.
    await expect(fs.stat(todoPath(STORY_REF))).resolves.toBeTruthy();
    await expect(fs.stat(sourceDraftPath(STORY_ULID))).resolves.toBeTruthy();
  });

  it("(f) a non-native (bmad) adapter ref raises NotAnEligibleDraftError (reason: wrong-adapter)", async () => {
    const bmadRef = "native:01J9P0K2N3MZX0YV4S5RTQ4AAA"; // ref field stays native but adapter overridden
    // Simulate a bmad-adapter manifest that somehow ended up in to-do/
    const manifest: ExecutionManifest = {
      ...makeTodoManifest(bmadRef, { adapter: "bmad" }),
    };
    await atomicWriteFile(
      todoPath(bmadRef),
      yamlStringify(manifest, { lineWidth: 0 }),
    );
    await seedSourceDraft(STORY_ULID);

    let thrown: NotAnEligibleDraftError | null = null;
    try {
      await discardDraft({ targetRepoRoot: tmpRoot, ref: bmadRef });
    } catch (e) {
      if (e instanceof NotAnEligibleDraftError) thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.reason).toBe("wrong-adapter");

    // Nothing was removed.
    await expect(fs.stat(todoPath(bmadRef))).resolves.toBeTruthy();
    await expect(fs.stat(sourceDraftPath(STORY_ULID))).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC3 — idempotency: already-absent ref is a clean no-op
// ---------------------------------------------------------------------------

describe("discardDraft AC3 — already-absent ref is a clean no-op", () => {
  it("(g) a ref not found in any state directory returns { removed:false, noop:true } without raising", async () => {
    // Do not seed any manifest — the ref is entirely absent.
    const result = await discardDraft({
      targetRepoRoot: tmpRoot,
      ref: "native:DOESNOTEXIST00000000000000",
    });

    expect(result.removed).toBe(false);
    expect(result.noop).toBe(true);
    expect(result.manifestPath).toBeUndefined();
    expect(result.sourcePath).toBeUndefined();
  });

  it("(g) calling discardDraft twice on the same ref: second call is a no-op", async () => {
    await seedTodo(makeTodoManifest(STORY_REF, { ready: false }));
    await seedSourceDraft(STORY_ULID);

    // First call removes it.
    const first = await discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF });
    expect(first.removed).toBe(true);
    expect(first.noop).toBe(false);

    // Second call: ref is now absent → clean no-op.
    const second = await discardDraft({ targetRepoRoot: tmpRoot, ref: STORY_REF });
    expect(second.removed).toBe(false);
    expect(second.noop).toBe(true);
  });
});
