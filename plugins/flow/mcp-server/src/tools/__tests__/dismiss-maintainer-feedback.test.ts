/**
 * Tests for `dismissMaintainerFeedback` — Story native:01KVDXX
 * (surface-maintainer-findings-in-run).
 *
 * (a) dismiss moves the matching file into dismissed/ and returns dismissed:true.
 * (b) after dismiss, reviewMaintainerInbox no longer returns that item (and still
 *     returns the others).
 * (c) dismissing an unknown / already-dismissed id is an idempotent no-op
 *     (dismissed:false, noop:true) — never throws.
 * (d) an invalid (non-ULID) id throws the typed validation error.
 *
 * Mirrors the tmpRoot / seed-files style of review-maintainer-inbox.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { dismissMaintainerFeedback } from "../dismiss-maintainer-feedback.js";
import { reviewMaintainerInbox } from "../review-maintainer-inbox.js";
import { InvalidMaintainerFeedbackIdError } from "../../errors.js";
import type { MaintainerFeedbackItem } from "../../schemas/maintainer-feedback.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let scratch: string;
let root: string;

const STUB_EXEC_SYNC = (cmd: string, _opts: { encoding: "utf-8" }): string => {
  if (cmd === "gh repo view --json owner,name") {
    return JSON.stringify({ owner: { login: "test-owner" }, name: "test-repo" });
  }
  throw new Error(`Unexpected command: ${cmd}`);
};

const INBOX_REL = path.join(".flow", "maintainer-inbox");

/** Write a single inbox item as JSON (simulating what `recordMaintainerFeedback` does). */
async function writeInboxItem(
  repoRoot: string,
  item: MaintainerFeedbackItem,
): Promise<string> {
  const safeTs = item.raised_at.replace(/[:.]/g, "-");
  const filename = `${safeTs}-${item.id}.json`;
  const absPath = path.join(repoRoot, INBOX_REL, filename);
  await atomicWriteFile(absPath, JSON.stringify(item, null, 2));
  return filename;
}

const ITEM_A: MaintainerFeedbackItem = {
  id: "01KV9Y21ZMTY2S904HDWKR6ZHP",
  raised_at: "2026-06-17T10:00:00.000Z",
  problem: "The reviewer cannot surface a tool-area gap.",
  tool_area: "run-reviewer-session",
  trigger: "generalist-reviewer / story native:01KV9TEST",
  suggested_direction: "Add a recordMaintainerFeedback seam in the reviewer.",
};

const ITEM_B: MaintainerFeedbackItem = {
  id: "01KV9Y21ZP8KVY8P1RNKMJFN49",
  raised_at: "2026-06-17T11:00:00.000Z",
  problem: "The planner drops context on large teams.",
  tool_area: "build-persona-spawn-prompt",
  trigger: "generalist-dev / story native:01KV9TEST2",
};

beforeEach(async () => {
  scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "flow-dismiss-maintainer-feedback-"),
  );
  root = path.join(scratch, "repo");
  await fs.mkdir(root, { recursive: true });
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) dismiss moves the matching file into dismissed/ and returns dismissed:true
// ---------------------------------------------------------------------------

describe("dismissMaintainerFeedback (a) — moves the file and reports dismissed", () => {
  it("moves the matching .json file into dismissed/ and returns dismissed:true", async () => {
    const filename = await writeInboxItem(root, ITEM_A);

    const result = await dismissMaintainerFeedback({ targetRepoRoot: root, id: ITEM_A.id });

    expect(result.ok).toBe(true);
    expect(result.dismissed).toBe(true);
    expect(result.id).toBe(ITEM_A.id);
    expect(result.noop).toBeUndefined();
    expect(result.archivedPath).toBe(
      path.join(root, INBOX_REL, "dismissed", filename),
    );

    // The original top-level file is gone; the dismissed/ copy exists.
    await expect(fs.access(path.join(root, INBOX_REL, filename))).rejects.toBeTruthy();
    const archived = await fs.readFile(result.archivedPath!, "utf8");
    // Content is preserved intact (archive, not edit).
    expect(JSON.parse(archived)).toEqual(ITEM_A);
  });
});

// ---------------------------------------------------------------------------
// (b) after dismiss, reviewMaintainerInbox no longer returns that item
// ---------------------------------------------------------------------------

describe("dismissMaintainerFeedback (b) — reviewMaintainerInbox ignores dismissed items", () => {
  it("drops the dismissed item but keeps the others", async () => {
    await writeInboxItem(root, ITEM_A);
    await writeInboxItem(root, ITEM_B);

    // Sanity: both present before dismiss.
    const before = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });
    expect(before.items.map((i) => i.id).sort()).toEqual([ITEM_A.id, ITEM_B.id].sort());

    await dismissMaintainerFeedback({ targetRepoRoot: root, id: ITEM_A.id });

    const after = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.id).toBe(ITEM_B.id);
    expect(after.malformedCount).toBe(0);
  });

  it("dismissing the only item leaves an empty inbox (dismissed/ subdir ignored)", async () => {
    await writeInboxItem(root, ITEM_A);
    await dismissMaintainerFeedback({ targetRepoRoot: root, id: ITEM_A.id });

    const after = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });
    expect(after.emptyInbox).toBe(true);
    expect(after.items).toHaveLength(0);
    expect(after.malformedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) idempotent no-op on unknown / already-dismissed id
// ---------------------------------------------------------------------------

describe("dismissMaintainerFeedback (c) — idempotent no-op", () => {
  it("returns noop:true for an id that was never in the inbox (no throw)", async () => {
    await writeInboxItem(root, ITEM_A);

    const result = await dismissMaintainerFeedback({
      targetRepoRoot: root,
      id: "01KV9Y21ZPFDAW663WG8A8NMJP", // valid ULID, not present
    });

    expect(result.ok).toBe(true);
    expect(result.dismissed).toBe(false);
    expect(result.noop).toBe(true);
    expect(result.archivedPath).toBeUndefined();
  });

  it("returns noop:true when the inbox directory does not exist", async () => {
    const result = await dismissMaintainerFeedback({
      targetRepoRoot: root,
      id: ITEM_A.id,
    });
    expect(result.dismissed).toBe(false);
    expect(result.noop).toBe(true);
  });

  it("dismissing the same id twice is idempotent — second call is a no-op", async () => {
    await writeInboxItem(root, ITEM_A);

    const first = await dismissMaintainerFeedback({ targetRepoRoot: root, id: ITEM_A.id });
    expect(first.dismissed).toBe(true);

    const second = await dismissMaintainerFeedback({ targetRepoRoot: root, id: ITEM_A.id });
    expect(second.dismissed).toBe(false);
    expect(second.noop).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (d) invalid id throws the typed validation error
// ---------------------------------------------------------------------------

describe("dismissMaintainerFeedback (d) — invalid id throws", () => {
  it("throws InvalidMaintainerFeedbackIdError for a non-ULID id", async () => {
    await expect(
      dismissMaintainerFeedback({ targetRepoRoot: root, id: "not-a-ulid" }),
    ).rejects.toBeInstanceOf(InvalidMaintainerFeedbackIdError);
  });

  it("throws for an empty id", async () => {
    await expect(
      dismissMaintainerFeedback({ targetRepoRoot: root, id: "" }),
    ).rejects.toBeInstanceOf(InvalidMaintainerFeedbackIdError);
  });

  it("the error names the offending id", async () => {
    await expect(
      dismissMaintainerFeedback({ targetRepoRoot: root, id: "lowercase01234567890abcde" }),
    ).rejects.toThrow(/lowercase01234567890abcde/);
  });
});
