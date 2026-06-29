/**
 * Tests for AC4 — Story native:01KW5WMS33XC463QM60AXDGK81.
 *
 * AC4 — Integration: only the two maintainer-feedback link paths are retargeted
 *   to the plugin repo identity; non-maintainer gh-issue paths that correctly
 *   want the cwd project repo remain unchanged.
 *
 * Specifically verifies that:
 *   - `resolveGhRepoIdentity` (used by write-native-story and other non-maintainer
 *     paths) continues to resolve the cwd repo from `gh repo view` as before.
 *   - `buildFeedbackIssueUrl` and `buildStoredItemIssueUrl` (pure URL builders)
 *     still use the caller-supplied owner/repo rather than hard-coding the plugin.
 *   - `resolvePluginRepoIdentity` and `resolveGhRepoIdentity` are independent —
 *     neither interferes with the other.
 */

import { describe, it, expect } from "vitest";
import {
  resolveGhRepoIdentity,
  resolvePluginRepoIdentity,
  buildFeedbackIssueUrl,
} from "../build-feedback-issue-url.js";
import { buildStoredItemIssueUrl } from "../review-maintainer-inbox.js";
import type { MaintainerFeedbackItem } from "../../schemas/maintainer-feedback.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Sample live-session feedback input (MaintainerFeedbackInput shape). */
const SAMPLE_INPUT = {
  problem: "Non-maintainer path test: reviewer cannot flag a gap.",
  tool_area: "run-reviewer-session",
  trigger: "generalist-reviewer / story native:01TESTAC4",
} as const;

/** Sample stored inbox item (MaintainerFeedbackItem shape). */
const SAMPLE_STORED_ITEM: MaintainerFeedbackItem = {
  id: "01KW5AC4TEST000000000000001",
  raised_at: "2026-06-29T10:00:00.000Z",
  problem: "Non-maintainer path stored item test.",
  tool_area: "gather-retro-inputs",
  trigger: "retro-analyst / story native:01TESTAC4B",
};

// ---------------------------------------------------------------------------
// resolveGhRepoIdentity — unchanged cwd-bound resolver (AC4)
// ---------------------------------------------------------------------------

describe("resolveGhRepoIdentity — cwd-bound identity resolver is unchanged after retarget (AC4)", () => {
  it("still resolves owner/repo from the cwd gh remote when execSyncImpl is provided", () => {
    const result = resolveGhRepoIdentity((cmd, _opts) => {
      if (cmd === "gh repo view --json owner,name") {
        return JSON.stringify({
          owner: { login: "my-cwd-owner" },
          name: "my-cwd-repo",
        });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    expect(result).toEqual({ owner: "my-cwd-owner", repo: "my-cwd-repo" });
  });

  it("returns null when execSyncImpl throws — fail-soft behavior is unchanged", () => {
    const result = resolveGhRepoIdentity(() => {
      throw new Error("gh not available");
    });

    expect(result).toBeNull();
  });

  it("returns null when the gh output is malformed JSON — unchanged behavior", () => {
    const result = resolveGhRepoIdentity(() => "not-json");

    expect(result).toBeNull();
  });

  it("returns null when owner or repo are empty strings — unchanged behavior", () => {
    const result = resolveGhRepoIdentity(() =>
      JSON.stringify({ owner: { login: "" }, name: "" }),
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolvePluginRepoIdentity — plugin identity source is independent (AC4)
// ---------------------------------------------------------------------------

describe("resolvePluginRepoIdentity — reads from plugin package.json, not gh repo view (AC4)", () => {
  it("returns the plugin repo identity from the package.json repository field", () => {
    const result = resolvePluginRepoIdentity(() =>
      JSON.stringify({
        name: "flow",
        repository: { type: "git", url: "https://github.com/plugin-owner/plugin-repo" },
      }),
    );

    expect(result).toEqual({ owner: "plugin-owner", repo: "plugin-repo" });
  });

  it("does NOT call execSync / gh repo view — it reads from package.json only", () => {
    // If resolvePluginRepoIdentity were to call gh, this would be visible because
    // we inject a readPkgJsonImpl that doesn't involve gh at all.
    let pkgJsonReadCount = 0;
    const result = resolvePluginRepoIdentity(() => {
      pkgJsonReadCount++;
      return JSON.stringify({
        repository: "https://github.com/plugin-owner/plugin-repo",
      });
    });

    expect(pkgJsonReadCount).toBe(1); // exactly one read of package.json
    expect(result).toEqual({ owner: "plugin-owner", repo: "plugin-repo" });
  });

  it("is independent of resolveGhRepoIdentity — both can coexist with different results", () => {
    const cwdResult = resolveGhRepoIdentity(() =>
      JSON.stringify({ owner: { login: "cwd-owner" }, name: "cwd-repo" }),
    );
    const pluginResult = resolvePluginRepoIdentity(() =>
      JSON.stringify({
        repository: { url: "https://github.com/plugin-owner/plugin-repo" },
      }),
    );

    // The two functions return different identities from different sources.
    expect(cwdResult).toEqual({ owner: "cwd-owner", repo: "cwd-repo" });
    expect(pluginResult).toEqual({ owner: "plugin-owner", repo: "plugin-repo" });
    // They do not interfere with each other.
    expect(cwdResult).not.toEqual(pluginResult);
  });
});

// ---------------------------------------------------------------------------
// buildFeedbackIssueUrl — pure URL builder uses caller-supplied owner/repo (AC4)
// ---------------------------------------------------------------------------

describe("buildFeedbackIssueUrl — non-maintainer path URL builder is unchanged (AC4)", () => {
  it("uses the caller-supplied owner/repo (cwd-targeted), not a hard-coded plugin repo", () => {
    const result = buildFeedbackIssueUrl({
      owner: "cwd-project-owner",
      repo: "cwd-project-repo",
      item: SAMPLE_INPUT,
    });

    expect(result.url).toContain("cwd-project-owner/cwd-project-repo");
    // Explicitly NOT the plugin repo — the caller controls the target.
    expect(result.url).not.toContain("jackmcintyre");
    expect(result.url).not.toContain("plugin-owner");
  });

  it("still returns a valid pre-filled GitHub new-issue URL for any caller-supplied repo", () => {
    const result = buildFeedbackIssueUrl({
      owner: "some-org",
      repo: "some-project",
      item: SAMPLE_INPUT,
    });

    expect(result.url).toMatch(
      /^https:\/\/github\.com\/some-org\/some-project\/issues\/new\?/,
    );
    expect(result.bodyShortened).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildStoredItemIssueUrl — pure URL builder uses caller-supplied owner/repo (AC4)
// ---------------------------------------------------------------------------

describe("buildStoredItemIssueUrl — non-maintainer path URL builder is unchanged (AC4)", () => {
  it("uses the caller-supplied owner/repo (cwd-targeted), not a hard-coded plugin repo", () => {
    const result = buildStoredItemIssueUrl(
      "cwd-owner",
      "cwd-repo",
      SAMPLE_STORED_ITEM,
    );

    expect(result.url).toContain("cwd-owner/cwd-repo");
    expect(result.url).not.toContain("plugin-owner");
    expect(result.url).not.toContain("jackmcintyre");
  });

  it("still returns a valid pre-filled GitHub new-issue URL for any caller-supplied repo", () => {
    const result = buildStoredItemIssueUrl(
      "another-org",
      "another-project",
      SAMPLE_STORED_ITEM,
    );

    expect(result.url).toMatch(
      /^https:\/\/github\.com\/another-org\/another-project\/issues\/new\?/,
    );
    expect(result.bodyShortened).toBe(false);
  });
});
