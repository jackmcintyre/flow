/**
 * Tests for `reviewMaintainerInbox` — Story native:01KV9QR3VK11RDD1ZDPVJ7SEYA.
 *
 * AC1 — Unit: reviewing a non-empty inbox surfaces each filed item clearly enough
 *        to decide which are worth turning into issues.
 *
 * AC2 — Integration: a chosen item yields a GitHub new-issue URL with title and
 *        body pre-filled from its details; the operator submits the issue themselves
 *        and nothing is filed automatically.
 *
 * AC3 — Integration: the issued link works without a command-line GitHub tool —
 *        it is a plain GitHub web URL, never a gh-CLI call.
 *
 * AC4 — Unit: an empty inbox returns a plain empty-state result; no blank or
 *        malformed URL is emitted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import {
  reviewMaintainerInbox,
  composeStoredItemIssueTitle,
  composeStoredItemIssueBody,
  buildStoredItemIssueUrl,
} from "../review-maintainer-inbox.js";
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

const FAILING_EXEC_SYNC = (_cmd: string, _opts: { encoding: "utf-8" }): string => {
  throw new Error("gh not available");
};

/** Write a single inbox item as JSON (simulating what `recordMaintainerFeedback` does). */
async function writeInboxItem(
  root: string,
  item: MaintainerFeedbackItem,
): Promise<void> {
  const safeTs = item.raised_at.replace(/[:.]/g, "-");
  const filename = `${safeTs}-${item.id}.json`;
  const absPath = path.join(root, ".flow", "maintainer-inbox", filename);
  await atomicWriteFile(absPath, JSON.stringify(item, null, 2));
}

const SAMPLE_ITEM: MaintainerFeedbackItem = {
  id: "01KV9Y21ZMTY2S904HDWKR6ZHP",
  raised_at: "2026-06-17T10:00:00.000Z",
  problem: "The reviewer cannot surface a tool-area gap.",
  tool_area: "run-reviewer-session",
  trigger: "generalist-reviewer / story native:01KV9TEST",
  suggested_direction: "Add a recordMaintainerFeedback seam in the reviewer.",
};

const SAMPLE_ITEM_2: MaintainerFeedbackItem = {
  id: "01KV9Y21ZP8KVY8P1RNKMJFN49",
  raised_at: "2026-06-17T11:00:00.000Z",
  problem: "The planner drops context on large teams.",
  tool_area: "build-persona-spawn-prompt",
  trigger: "generalist-dev / story native:01KV9TEST2",
};

beforeEach(async () => {
  scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "flow-review-maintainer-inbox-"),
  );
  root = path.join(scratch, "repo");
  await fs.mkdir(root, { recursive: true });

  // Minimal workspace config.
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// composeStoredItemIssueTitle — unit tests
// ---------------------------------------------------------------------------

describe("composeStoredItemIssueTitle", () => {
  it("prefixes the tool_area in brackets followed by the problem", () => {
    const title = composeStoredItemIssueTitle(SAMPLE_ITEM);
    expect(title).toBe("[run-reviewer-session] The reviewer cannot surface a tool-area gap.");
  });

  it("trims multi-line problem statements to a single line", () => {
    const item: MaintainerFeedbackItem = {
      ...SAMPLE_ITEM,
      problem: "First line of the problem.\nSecond line is excluded.",
    };
    const title = composeStoredItemIssueTitle(item);
    expect(title).not.toContain("Second line");
    expect(title).toContain("First line");
  });

  it("truncates very long problem statements to MAX_TITLE_LENGTH", () => {
    const longProblem = "A".repeat(200);
    const item: MaintainerFeedbackItem = { ...SAMPLE_ITEM, problem: longProblem };
    const title = composeStoredItemIssueTitle(item);
    // The title must be at most 120 chars.
    expect(title.length).toBeLessThanOrEqual(120);
  });
});

// ---------------------------------------------------------------------------
// composeStoredItemIssueBody — unit tests
// ---------------------------------------------------------------------------

describe("composeStoredItemIssueBody", () => {
  it("includes problem, tool_area, and trigger sections", () => {
    const body = composeStoredItemIssueBody(SAMPLE_ITEM);
    expect(body).toContain("**Problem**");
    expect(body).toContain(SAMPLE_ITEM.problem);
    expect(body).toContain("**Tool area**");
    expect(body).toContain(SAMPLE_ITEM.tool_area);
    expect(body).toContain("**Trigger**");
    expect(body).toContain(SAMPLE_ITEM.trigger);
  });

  it("includes the suggested_direction section when present", () => {
    const body = composeStoredItemIssueBody(SAMPLE_ITEM);
    expect(body).toContain("**Suggested direction**");
    expect(body).toContain(SAMPLE_ITEM.suggested_direction!);
  });

  it("omits the suggested_direction section when not present", () => {
    const body = composeStoredItemIssueBody(SAMPLE_ITEM_2);
    expect(body).not.toContain("**Suggested direction**");
  });
});

// ---------------------------------------------------------------------------
// buildStoredItemIssueUrl — unit tests (AC2 / AC3)
// ---------------------------------------------------------------------------

describe("buildStoredItemIssueUrl (AC2/AC3)", () => {
  it("returns a pre-filled GitHub new-issue URL with title and body (AC2)", () => {
    const result = buildStoredItemIssueUrl("owner", "repo", SAMPLE_ITEM);
    expect(result.bodyShortened).toBe(false);
    expect(result.url).toMatch(
      /^https:\/\/github\.com\/owner\/repo\/issues\/new\?/,
    );
    expect(result.url).toContain("title=");
    expect(result.url).toContain("body=");
  });

  it("the URL opens the GitHub new-issue FORM, not an auto-file endpoint (AC2)", () => {
    const result = buildStoredItemIssueUrl("owner", "repo", SAMPLE_ITEM);
    // Must be the new-issue page — not an API or auto-create endpoint.
    expect(result.url).toContain("/issues/new");
    expect(result.url).not.toContain("api/v3");
    expect(result.url).not.toContain("/issues/create");
  });

  it("does NOT use gh CLI in the URL itself — plain web URL only (AC3)", () => {
    const result = buildStoredItemIssueUrl("owner", "repo", SAMPLE_ITEM);
    // The URL must be a plain HTTPS GitHub link, not a gh-CLI command or output.
    expect(result.url).toMatch(/^https:\/\//);
    expect(result.url).not.toContain("gh ");
    expect(result.url).not.toContain("gh:");
  });

  it("title in the URL includes the tool_area prefix and problem text (AC2)", () => {
    const result = buildStoredItemIssueUrl("owner", "repo", SAMPLE_ITEM);
    const titleParam = new URL(result.url).searchParams.get("title") ?? "";
    expect(titleParam).toContain("run-reviewer-session");
    expect(titleParam).toContain("The reviewer cannot surface a tool-area gap.");
  });

  it("body in the URL includes problem, tool_area, trigger, and suggested_direction (AC2)", () => {
    const result = buildStoredItemIssueUrl("owner", "repo", SAMPLE_ITEM);
    const bodyParam = new URL(result.url).searchParams.get("body") ?? "";
    expect(bodyParam).toContain(SAMPLE_ITEM.problem);
    expect(bodyParam).toContain(SAMPLE_ITEM.tool_area);
    expect(bodyParam).toContain(SAMPLE_ITEM.trigger);
    expect(bodyParam).toContain(SAMPLE_ITEM.suggested_direction!);
  });

  it("URL stays under 8192 bytes for normal-length items", () => {
    const result = buildStoredItemIssueUrl("owner", "repo", SAMPLE_ITEM);
    expect(Buffer.byteLength(result.url, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("shortens and stays under 8192 bytes for a very long item body (length guard)", () => {
    const longItem: MaintainerFeedbackItem = {
      ...SAMPLE_ITEM,
      problem: "P".repeat(10_000),
    };
    const result = buildStoredItemIssueUrl("owner", "repo", longItem);
    expect(result.bodyShortened).toBe(true);
    expect(Buffer.byteLength(result.url, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("shortened URL still opens the new-issue page cleanly (length guard)", () => {
    const longItem: MaintainerFeedbackItem = {
      ...SAMPLE_ITEM,
      problem: "Q".repeat(10_000),
    };
    const result = buildStoredItemIssueUrl("owner", "repo", longItem);
    expect(result.url).toMatch(
      /^https:\/\/github\.com\/owner\/repo\/issues\/new\?/,
    );
    const bodyParam = new URL(result.url).searchParams.get("body") ?? "";
    expect(bodyParam).toContain("body shortened");
    expect(bodyParam).toContain("maintainer inbox");
  });
});

// ---------------------------------------------------------------------------
// reviewMaintainerInbox — AC1: items surfaced clearly on non-empty inbox
// ---------------------------------------------------------------------------

describe("reviewMaintainerInbox (AC1) — items are surfaced clearly", () => {
  it("returns ok:true with all items when the inbox has entries", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);
    await writeInboxItem(root, SAMPLE_ITEM_2);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.ok).toBe(true);
    expect(result.emptyInbox).toBe(false);
    expect(result.items).toHaveLength(2);
    expect(result.malformedCount).toBe(0);
  });

  it("each returned item exposes id, tool_area, problem, trigger, raised_at", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    const item = result.items[0]!;
    expect(item.id).toBe(SAMPLE_ITEM.id);
    expect(item.tool_area).toBe(SAMPLE_ITEM.tool_area);
    expect(item.problem).toBe(SAMPLE_ITEM.problem);
    expect(item.trigger).toBe(SAMPLE_ITEM.trigger);
    expect(item.raised_at).toBe(SAMPLE_ITEM.raised_at);
  });

  it("includes suggested_direction when the stored item has one", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.items[0]!.suggested_direction).toBe(SAMPLE_ITEM.suggested_direction);
  });

  it("omits suggested_direction when the stored item lacks one", async () => {
    await writeInboxItem(root, SAMPLE_ITEM_2);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.items[0]!.suggested_direction).toBeUndefined();
  });

  it("returns items in chronological order (by filename/raised_at)", async () => {
    // Write item 2 first (alphabetically later filename), then item 1.
    await writeInboxItem(root, SAMPLE_ITEM_2);
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    // Items should be in filename-alphabetical (chronological) order.
    expect(result.items[0]!.id).toBe(SAMPLE_ITEM.id);
    expect(result.items[1]!.id).toBe(SAMPLE_ITEM_2.id);
  });
});

// ---------------------------------------------------------------------------
// reviewMaintainerInbox — AC2: pre-filled GitHub issue URL for chosen item
// ---------------------------------------------------------------------------

describe("reviewMaintainerInbox (AC2) — pre-filled GitHub issue URL", () => {
  it("each item includes a pre-filled GitHub new-issue URL when gh stub succeeds", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.items[0]!.issueUrl).toBeDefined();
    expect(result.items[0]!.issueUrl).toMatch(
      /^https:\/\/github\.com\/test-owner\/test-repo\/issues\/new\?/,
    );
  });

  it("the URL is a review-and-submit page — NOT an auto-file endpoint (AC2)", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    const url = result.items[0]!.issueUrl ?? "";
    expect(url).toContain("/issues/new");
    expect(url).not.toContain("api/v3");
    expect(url).not.toContain("/issues/create");
    expect(url).toContain("?title=");
  });

  it("the URL body decodes to include the problem and trigger fields (AC2)", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    const url = result.items[0]!.issueUrl ?? "";
    const bodyParam = new URL(url).searchParams.get("body") ?? "";
    expect(bodyParam).toContain(SAMPLE_ITEM.problem);
    expect(bodyParam).toContain(SAMPLE_ITEM.trigger);
  });

  it("the URL title includes the tool_area bracket prefix (AC2)", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    const url = result.items[0]!.issueUrl ?? "";
    const titleParam = new URL(url).searchParams.get("title") ?? "";
    expect(titleParam).toContain("[run-reviewer-session]");
  });
});

// ---------------------------------------------------------------------------
// reviewMaintainerInbox — AC3: plain web URL, no gh CLI dependency in the link
// ---------------------------------------------------------------------------

describe("reviewMaintainerInbox (AC3) — plain web URL, no gh CLI in the link", () => {
  it("the link is a plain HTTPS GitHub URL, not a gh-CLI invocation", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    const url = result.items[0]!.issueUrl ?? "";
    expect(url).toMatch(/^https:\/\//);
    // The URL itself does not contain any gh-CLI syntax.
    expect(url).not.toContain("gh ");
    expect(url).not.toContain("gh:");
    expect(url).not.toContain("--repo");
  });

  it("items are still listed (without issueUrl) when gh is unavailable (AC3 — fail-soft)", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: FAILING_EXEC_SYNC,
    });

    // The item should still be returned.
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.problem).toBe(SAMPLE_ITEM.problem);
    // But no issueUrl (fail-soft).
    expect(result.items[0]!.issueUrl).toBeUndefined();
  });

  it("the link URL is entirely self-contained — does not depend on gh being installed (AC3)", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    const url = result.items[0]!.issueUrl ?? "";
    // Opening the URL must require nothing beyond a browser — the URL is complete.
    // Check: it has all query params inline.
    const parsed = new URL(url);
    expect(parsed.searchParams.has("title")).toBe(true);
    expect(parsed.searchParams.has("body")).toBe(true);
    // No shell commands or tool calls appear in the URL string.
    expect(url).not.toMatch(/\$\(|`/);
  });
});

// ---------------------------------------------------------------------------
// reviewMaintainerInbox — AC4: empty inbox returns a plain empty-state message
// ---------------------------------------------------------------------------

describe("reviewMaintainerInbox (AC4) — empty inbox handling", () => {
  it("returns emptyInbox:true and empty items array when the inbox directory does not exist", async () => {
    // No inbox directory created.
    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.ok).toBe(true);
    expect(result.emptyInbox).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(result.malformedCount).toBe(0);
  });

  it("returns emptyInbox:true when the inbox directory exists but has no json files", async () => {
    // Create an empty inbox directory.
    await fs.mkdir(path.join(root, ".flow", "maintainer-inbox"), { recursive: true });

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.ok).toBe(true);
    expect(result.emptyInbox).toBe(true);
    expect(result.items).toHaveLength(0);
  });

  it("emits no link when the inbox is empty (AC4)", async () => {
    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    // No items means no links — cannot produce a blank or malformed URL.
    expect(result.items).toHaveLength(0);
    // Double-check: none of the items has an issueUrl.
    for (const item of result.items) {
      expect(item.issueUrl).toBeUndefined();
    }
  });

  it("does NOT return emptyInbox:true when there are valid items (sanity check)", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.emptyInbox).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// reviewMaintainerInbox — resilience: malformed inbox files are skipped
// ---------------------------------------------------------------------------

describe("reviewMaintainerInbox — resilience (malformed files skipped)", () => {
  it("skips malformed JSON files and still returns valid items", async () => {
    // Write one valid item.
    await writeInboxItem(root, SAMPLE_ITEM);
    // Write a malformed file.
    const inboxDir = path.join(root, ".flow", "maintainer-inbox");
    await atomicWriteFile(path.join(inboxDir, "2026-06-17T09-00-00-000Z-MALFORMED.json"), "{bad json");

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.malformedCount).toBe(1);
  });

  it("skips schema-invalid JSON files and still returns valid items", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);
    const inboxDir = path.join(root, ".flow", "maintainer-inbox");
    // Valid JSON but missing required fields.
    await atomicWriteFile(
      path.join(inboxDir, "2026-06-17T09-00-00-001Z-SCHEMA.json"),
      JSON.stringify({ not_a_valid_item: true }),
    );

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.items).toHaveLength(1);
    expect(result.malformedCount).toBe(1);
  });

  it("ignores non-.json files in the inbox directory", async () => {
    await writeInboxItem(root, SAMPLE_ITEM);
    const inboxDir = path.join(root, ".flow", "maintainer-inbox");
    // Write a non-JSON file that should be ignored.
    await atomicWriteFile(path.join(inboxDir, "README.txt"), "should be ignored");

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.items).toHaveLength(1);
    expect(result.malformedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reviewMaintainerInbox — URL length guard integration
// ---------------------------------------------------------------------------

describe("reviewMaintainerInbox — URL length guard", () => {
  it("items with very long bodies still produce URLs under 8192 bytes", async () => {
    const longItem: MaintainerFeedbackItem = {
      id: "01KV9Y21ZPFDAW663WG8A8NMJP",
      raised_at: "2026-06-17T12:00:00.000Z",
      problem: "X".repeat(10_000),
      tool_area: "some-tool",
      trigger: "generalist-dev / story native:01KV9TEST3",
    };
    await writeInboxItem(root, longItem);

    const result = await reviewMaintainerInbox({
      targetRepoRoot: root,
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.items).toHaveLength(1);
    const url = result.items[0]!.issueUrl ?? "";
    expect(Buffer.byteLength(url, "utf8")).toBeLessThanOrEqual(8192);
    expect(result.items[0]!.bodyShortened).toBe(true);
  });
});
