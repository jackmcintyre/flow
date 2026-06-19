/**
 * Tests for the feedback-issue-url seam — Story native:01KV7XXKZ0TBPYETZP2X81T40S.
 *
 * AC1 — Integration: raising a feedback item in a live session immediately yields a
 *        pre-filled GitHub new-issue URL with title and body filled from the item's
 *        details. The URL opens GitHub's new-issue form (not a file/submit action).
 *
 * AC2 — No auto-submit: nothing is ever filed automatically; the link works for any
 *        user (not owner-only) because it is a review-and-submit-yourself page.
 *        Asserted by verifying the URL shape and that `recordMaintainerFeedback`
 *        calls NO gh CLI to file an issue (only the URL-builder resolves owner/name).
 *
 * AC3 — URL-length guard: an over-long item still produces a clean, shortened URL
 *        with a sensibly shortened body and a shortened-note.
 *
 * Integration test for AC1/AC2: exercises `recordMaintainerFeedback` end-to-end
 * with a stubbed `execSyncImpl` seam (no real `gh` subprocess) to assert that the
 * returned `issueUrl` is a pre-filled GitHub new-issue URL.
 *
 * Unit tests for AC3: exercises `buildFeedbackIssueUrl` directly with a
 * controlled long body and asserts the result is under the URL-length ceiling.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { recordMaintainerFeedback } from "../record-maintainer-feedback.js";
import {
  buildFeedbackIssueUrl,
  composeFeedbackIssueBody,
  renderFeedbackLinkBlock,
  resolveGhRepoIdentity,
} from "../build-feedback-issue-url.js";

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

beforeEach(async () => {
  scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "flow-feedback-issue-url-"),
  );
  root = path.join(scratch, "repo");
  await fs.mkdir(root, { recursive: true });

  // Minimal workspace config so recordMaintainerFeedback doesn't fail on
  // workspace resolution.
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// composeFeedbackIssueBody — unit tests for body composition
// ---------------------------------------------------------------------------

describe("composeFeedbackIssueBody", () => {
  it("includes problem, tool_area, and trigger sections", () => {
    const body = composeFeedbackIssueBody({
      problem: "The planner cannot route to the correct team.",
      tool_area: "resolve-build-plan",
      trigger: "generalist-dev / story native:01TEST",
    });
    expect(body).toContain("**Problem**");
    expect(body).toContain("The planner cannot route to the correct team.");
    expect(body).toContain("**Tool area**");
    expect(body).toContain("resolve-build-plan");
    expect(body).toContain("**Trigger**");
    expect(body).toContain("generalist-dev / story native:01TEST");
  });

  it("includes suggested_direction when provided", () => {
    const body = composeFeedbackIssueBody({
      problem: "A problem.",
      tool_area: "some-tool",
      trigger: "some-trigger",
      suggested_direction: "Add a new seam to handle this case.",
    });
    expect(body).toContain("**Suggested direction**");
    expect(body).toContain("Add a new seam to handle this case.");
  });

  it("omits suggested_direction section when not provided", () => {
    const body = composeFeedbackIssueBody({
      problem: "A problem.",
      tool_area: "some-tool",
      trigger: "some-trigger",
    });
    expect(body).not.toContain("**Suggested direction**");
  });
});

// ---------------------------------------------------------------------------
// buildFeedbackIssueUrl — unit tests for URL construction and length guard
// ---------------------------------------------------------------------------

describe("buildFeedbackIssueUrl (AC2/AC3)", () => {
  it("returns a pre-filled GitHub new-issue URL for a normal-length item (AC2)", () => {
    const result = buildFeedbackIssueUrl({
      owner: "test-owner",
      repo: "test-repo",
      item: {
        problem: "The planner drops the context when the team is large.",
        tool_area: "build-persona-spawn-prompt",
        trigger: "generalist-dev / story native:01TESTXYZ",
        suggested_direction: "Cap the persona size before relay.",
      },
    });

    expect(result.bodyShortened).toBe(false);
    expect(result.url).toMatch(
      /^https:\/\/github\.com\/test-owner\/test-repo\/issues\/new\?/,
    );
    expect(result.url).toContain("title=");
    expect(result.url).toContain("body=");
    // The link must be a new-issue page — not an auto-file action.
    expect(result.url).not.toContain("/issues/create");
    expect(result.url).not.toContain("api/v3");
    // URL length must be under the ceiling.
    expect(Buffer.byteLength(result.url, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("URL decodes to include the problem text in the body (AC1)", () => {
    const result = buildFeedbackIssueUrl({
      owner: "owner",
      repo: "repo",
      item: {
        problem: "Unique-sentinel-problem-text-for-decode-test",
        tool_area: "gather-retro-inputs",
        trigger: "retro-analyst",
      },
    });

    const bodyParam = new URL(result.url).searchParams.get("body") ?? "";
    expect(bodyParam).toContain("Unique-sentinel-problem-text-for-decode-test");
  });

  it("URL decodes to include the tool_area in the title (AC1)", () => {
    const result = buildFeedbackIssueUrl({
      owner: "owner",
      repo: "repo",
      item: {
        problem: "Some problem.",
        tool_area: "unique-tool-area-for-title-test",
        trigger: "some-trigger",
      },
    });

    const titleParam = new URL(result.url).searchParams.get("title") ?? "";
    expect(titleParam).toContain("unique-tool-area-for-title-test");
  });

  it("keeps the URL under 8192 bytes for an over-long body and sets bodyShortened=true (AC3)", () => {
    // Compose a body that will push the URL well past 8 KB.
    const veryLongProblem = "A".repeat(10_000);

    const result = buildFeedbackIssueUrl({
      owner: "owner",
      repo: "repo",
      item: {
        problem: veryLongProblem,
        tool_area: "some-tool",
        trigger: "some-trigger",
      },
    });

    expect(result.bodyShortened).toBe(true);
    const urlBytes = Buffer.byteLength(result.url, "utf8");
    expect(urlBytes).toBeLessThanOrEqual(8192);
  });

  it("shortened URL still opens the new-issue page cleanly (AC3)", () => {
    const longProblem = "B".repeat(10_000);
    const result = buildFeedbackIssueUrl({
      owner: "owner",
      repo: "repo",
      item: {
        problem: longProblem,
        tool_area: "some-tool",
        trigger: "some-trigger",
      },
    });

    expect(result.url).toMatch(
      /^https:\/\/github\.com\/owner\/repo\/issues\/new\?/,
    );
    // The shortened note must appear in the decoded body.
    const bodyParam = new URL(result.url).searchParams.get("body") ?? "";
    expect(bodyParam).toContain("body shortened");
    expect(bodyParam).toContain("maintainer inbox");
  });

  it("does NOT shorten a body that exactly fits under the ceiling", () => {
    // A short item should never be shortened.
    const result = buildFeedbackIssueUrl({
      owner: "owner",
      repo: "repo",
      item: {
        problem: "Short problem.",
        tool_area: "short-tool",
        trigger: "short-trigger",
      },
    });

    expect(result.bodyShortened).toBe(false);
    expect(Buffer.byteLength(result.url, "utf8")).toBeLessThanOrEqual(8192);
  });
});

// ---------------------------------------------------------------------------
// resolveGhRepoIdentity — unit tests for the resolver shim
// ---------------------------------------------------------------------------

describe("resolveGhRepoIdentity", () => {
  it("returns { owner, repo } when the execSync stub returns a valid shape", () => {
    const result = resolveGhRepoIdentity(STUB_EXEC_SYNC);
    expect(result).toEqual({ owner: "test-owner", repo: "test-repo" });
  });

  it("returns null when execSync throws (gh unavailable)", () => {
    const result = resolveGhRepoIdentity(FAILING_EXEC_SYNC);
    expect(result).toBeNull();
  });

  it("returns null when execSync returns a malformed JSON shape", () => {
    const malformedExecSync = (
      _cmd: string,
      _opts: { encoding: "utf-8" },
    ): string => {
      return JSON.stringify({ unexpected: "shape" });
    };
    const result = resolveGhRepoIdentity(malformedExecSync);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderFeedbackLinkBlock — unit tests (Story native:01KVEZQKWPH8V627QJSAF5F4E6)
//
// AC1 (integration via helper): the _message field contains (a) a markdown
//   hyperlink, (b) a plain bare URL on its own line, and (c) a gh issue create
//   command with --title and --body pre-filled.
// AC3: when issueUrl is absent, returns null — no blank or malformed lines emitted.
// ---------------------------------------------------------------------------

describe("renderFeedbackLinkBlock (AC1/AC3)", () => {
  const SAMPLE_URL = "https://github.com/test-owner/test-repo/issues/new?title=foo&body=bar";
  const SAMPLE_TITLE = "[tool-feedback] some-tool: A problem description";
  const SAMPLE_BODY = "**Problem**\nA problem description\n\n**Tool area**\nsome-tool\n\n**Trigger**\nsome-trigger";

  it("returns a string containing a markdown hyperlink (AC1a)", () => {
    const block = renderFeedbackLinkBlock(SAMPLE_URL, SAMPLE_TITLE, SAMPLE_BODY);
    expect(block).not.toBeNull();
    expect(block).toContain(`[Open in GitHub](${SAMPLE_URL})`);
  });

  it("returns a string containing the plain bare URL on its own line (AC1b)", () => {
    const block = renderFeedbackLinkBlock(SAMPLE_URL, SAMPLE_TITLE, SAMPLE_BODY);
    expect(block).not.toBeNull();
    const lines = block!.split("\n");
    // The plain URL must appear as a standalone line (not embedded in markdown).
    expect(lines).toContain(SAMPLE_URL);
  });

  it("returns a string containing a gh issue create command (AC1c)", () => {
    const block = renderFeedbackLinkBlock(SAMPLE_URL, SAMPLE_TITLE, SAMPLE_BODY);
    expect(block).not.toBeNull();
    expect(block).toContain("gh issue create");
    expect(block).toContain("--title");
    expect(block).toContain("--body");
  });

  it("gh command includes the title text (AC1c)", () => {
    const block = renderFeedbackLinkBlock(SAMPLE_URL, SAMPLE_TITLE, SAMPLE_BODY);
    // The title should appear within the single-quoted --title value.
    expect(block).toContain(SAMPLE_TITLE);
  });

  it("gh command includes the body text (AC1c)", () => {
    const block = renderFeedbackLinkBlock(SAMPLE_URL, SAMPLE_TITLE, SAMPLE_BODY);
    // The body content should appear within the single-quoted --body value.
    expect(block).toContain("A problem description");
  });

  it("returns null when issueUrl is undefined — no blank or malformed lines emitted (AC3)", () => {
    const block = renderFeedbackLinkBlock(undefined, SAMPLE_TITLE, SAMPLE_BODY);
    expect(block).toBeNull();
  });

  it("returns null when issueUrl is null (AC3)", () => {
    const block = renderFeedbackLinkBlock(null, SAMPLE_TITLE, SAMPLE_BODY);
    expect(block).toBeNull();
  });

  it("returns null when issueUrl is an empty string (AC3)", () => {
    const block = renderFeedbackLinkBlock("", SAMPLE_TITLE, SAMPLE_BODY);
    expect(block).toBeNull();
  });

  it("shell-escapes embedded single quotes in the title (AC1c)", () => {
    const titleWithQuote = "It's a problem with 'quotes'";
    const block = renderFeedbackLinkBlock(SAMPLE_URL, titleWithQuote, SAMPLE_BODY);
    expect(block).not.toBeNull();
    // Embedded single quotes must be escaped as '\'' so the shell command is valid.
    expect(block).toContain("It'\\''s a problem with '\\''quotes'\\''");
  });

  it("shell-escapes embedded single quotes in the body (AC1c)", () => {
    const bodyWithQuote = "The tool said 'hello' and then failed.";
    const block = renderFeedbackLinkBlock(SAMPLE_URL, SAMPLE_TITLE, bodyWithQuote);
    expect(block).not.toBeNull();
    // The body content in the gh command must have single quotes escaped.
    expect(block).toContain("The tool said '\\''hello'\\'' and then failed.");
  });

  it("the three elements are on separate lines (AC1)", () => {
    const block = renderFeedbackLinkBlock(SAMPLE_URL, SAMPLE_TITLE, SAMPLE_BODY);
    expect(block).not.toBeNull();
    const lines = block!.split("\n");
    // Line 1: markdown hyperlink
    expect(lines[0]).toMatch(/^\[Open in GitHub\]\(/);
    // Line 2: plain bare URL
    expect(lines[1]).toBe(SAMPLE_URL);
    // Line 3: gh issue create command
    expect(lines[2]).toMatch(/^gh issue create /);
  });
});

// ---------------------------------------------------------------------------
// recordMaintainerFeedback — end-to-end integration (AC1/AC2)
// ---------------------------------------------------------------------------

describe("recordMaintainerFeedback → issueUrl (AC1/AC2)", () => {
  it("returns issueUrl when gh stub succeeds (AC1)", async () => {
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "The retro-analyst cannot route a structural finding.",
        tool_area: "gather-retro-inputs",
        trigger: "retro-analyst / cycle-end retro, story native:01TESTXYZ",
        suggested_direction: "Add a recordMaintainerFeedback seam.",
      },
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.ok).toBe(true);
    expect(result.issueUrl).toBeDefined();
    expect(result.issueUrl).toMatch(
      /^https:\/\/github\.com\/test-owner\/test-repo\/issues\/new\?/,
    );
    expect(result.issueUrl).toContain("title=");
    expect(result.issueUrl).toContain("body=");
  });

  it("the issueUrl is a review-and-submit page — NOT an auto-file endpoint (AC2)", async () => {
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "A structural limitation.",
        tool_area: "test-area",
        trigger: "generalist-dev / story native:01TEST",
      },
      execSyncImpl: STUB_EXEC_SYNC,
    });

    const url = result.issueUrl ?? "";
    // Must point at issues/new — the user-facing form — not an API endpoint
    // or issues/create action that would file automatically.
    expect(url).toContain("/issues/new");
    expect(url).not.toContain("api/v3");
    expect(url).not.toContain("/issues/create");
    // The URL must be a pre-fill (query params) not a POST target.
    expect(url).toContain("?title=");
  });

  it("issueUrl is absent (not null, just missing) when gh is unavailable — inbox still written (AC2/fail-soft)", async () => {
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "A structural limitation.",
        tool_area: "test-area",
        trigger: "generalist-dev / story native:01TEST",
      },
      execSyncImpl: FAILING_EXEC_SYNC,
    });

    // Inbox write must still succeed.
    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // issueUrl must be absent (undefined) — not null.
    expect(result.issueUrl).toBeUndefined();

    // The inbox file must exist on disk.
    const stat = await fs.stat(result.absPath);
    expect(stat.isFile()).toBe(true);
  });

  it("issueUrl body decodes to include all four item fields (AC1)", async () => {
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Sentinel-problem-text",
        tool_area: "sentinel-tool-area",
        trigger: "sentinel-trigger-text",
        suggested_direction: "sentinel-suggested-direction",
      },
      execSyncImpl: STUB_EXEC_SYNC,
    });

    const url = result.issueUrl ?? "";
    const bodyParam = new URL(url).searchParams.get("body") ?? "";
    expect(bodyParam).toContain("Sentinel-problem-text");
    expect(bodyParam).toContain("sentinel-tool-area");
    expect(bodyParam).toContain("sentinel-trigger-text");
    expect(bodyParam).toContain("sentinel-suggested-direction");
  });

  it("over-long item yields a shortened URL still under 8192 bytes (AC3)", async () => {
    const longProblem = "X".repeat(10_000);
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: longProblem,
        tool_area: "some-tool",
        trigger: "some-trigger",
      },
      execSyncImpl: STUB_EXEC_SYNC,
    });

    expect(result.ok).toBe(true);
    expect(result.issueUrl).toBeDefined();
    const urlBytes = Buffer.byteLength(result.issueUrl ?? "", "utf8");
    expect(urlBytes).toBeLessThanOrEqual(8192);

    // The inbox file must contain the FULL item (not the truncated version).
    const raw = await fs.readFile(result.absPath, "utf8");
    const parsed = JSON.parse(raw) as { problem?: string };
    expect(parsed.problem).toBe(longProblem);
  });
});
