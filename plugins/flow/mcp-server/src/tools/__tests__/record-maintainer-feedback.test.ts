/**
 * Tests for `recordMaintainerFeedback` — Story native:01KV7FHZ41Z6CFPABW1B8J38BV.
 *
 * AC1 — Integration: raising a feedback item lands a self-contained entry in the
 *        maintainer inbox while leaving the team's working state and backlog
 *        byte-unchanged.
 *
 * AC2 — Validation: malformed / incomplete items are refused rather than stored.
 *
 * AC3 — Accumulation: multiple items accumulate as distinct entries rather than
 *        overwriting one another.
 *
 * Approach:
 * - Use a minimal workspace in a tmpdir (real filesystem ops via `atomicWriteFile`).
 * - Seed state directories to prove they are untouched after a call.
 * - Assert the written file is valid JSON matching the full schema.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { MalformedMaintainerFeedbackError } from "../../errors.js";
import {
  recordMaintainerFeedback,
  maintainerInboxItemPath,
} from "../record-maintainer-feedback.js";
import { MaintainerFeedbackItemSchema } from "../../schemas/maintainer-feedback.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let scratch: string;
let root: string;

const SENTINEL_MANIFEST_CONTENT = "ref: native:01SENTINEL\nstatus: to-do\n";

beforeEach(async () => {
  scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "flow-record-maintainer-feedback-"),
  );
  root = path.join(scratch, "repo");
  await fs.mkdir(root, { recursive: true });

  // Create a minimal .flow/config.yaml so workspace resolution succeeds.
  await atomicWriteFile(
    path.join(root, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );

  // Seed state directories with sentinel content so we can assert they are
  // untouched after a recordMaintainerFeedback call.
  for (const state of ["to-do", "in-progress", "done", "blocked"]) {
    const dir = path.join(root, ".flow", "state", state);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(
      path.join(dir, "native:01SENTINEL.yaml"),
      SENTINEL_MANIFEST_CONTENT,
    );
  }
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — Integration: item lands in the inbox; working state is unchanged
// ---------------------------------------------------------------------------

describe("recordMaintainerFeedback (AC1) — item lands in inbox; team state unchanged", () => {
  it("writes a self-contained entry to .flow/maintainer-inbox/ on a valid item", async () => {
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "The retro-analyst cannot route a structural finding anywhere.",
        tool_area: "gather-retro-inputs",
        trigger: "retro-analyst / cycle-end retro, story native:01TESTXYZ",
        suggested_direction: "Add a recordMaintainerFeedback seam the analyst can call.",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.absPath).toContain(path.join(".flow", "maintainer-inbox"));

    // The file must exist on disk.
    const raw = await fs.readFile(result.absPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    // Must be schema-valid.
    const schemaResult = MaintainerFeedbackItemSchema.safeParse(parsed);
    expect(schemaResult.success).toBe(true);

    const item = schemaResult.data!;
    expect(item.id).toBe(result.id);
    expect(item.problem).toBe(
      "The retro-analyst cannot route a structural finding anywhere.",
    );
    expect(item.tool_area).toBe("gather-retro-inputs");
    expect(item.trigger).toBe(
      "retro-analyst / cycle-end retro, story native:01TESTXYZ",
    );
    expect(item.suggested_direction).toBe(
      "Add a recordMaintainerFeedback seam the analyst can call.",
    );
    expect(item.raised_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    );
  });

  it("leaves the team's state directories byte-unchanged after recording an item", async () => {
    // Snapshot all state files before.
    const stateDirs = ["to-do", "in-progress", "done", "blocked"];
    const beforeContents: Record<string, string> = {};
    for (const dir of stateDirs) {
      const p = path.join(root, ".flow", "state", dir, "native:01SENTINEL.yaml");
      beforeContents[dir] = await fs.readFile(p, "utf8");
    }

    await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "State is mutated when it should not be.",
        tool_area: "execution-manifest",
        trigger: "generalist-dev / story native:01TEST",
      },
    });

    // Snapshot all state files after — must be identical.
    for (const dir of stateDirs) {
      const p = path.join(root, ".flow", "state", dir, "native:01SENTINEL.yaml");
      const after = await fs.readFile(p, "utf8");
      expect(after).toBe(beforeContents[dir]);
    }

    // No files were added to any state directory.
    for (const dir of stateDirs) {
      const entries = await fs.readdir(
        path.join(root, ".flow", "state", dir),
      );
      expect(entries).toHaveLength(1); // only the sentinel
    }
  });

  it("does not write to .flow/state/ when recording an item (inbox is separate)", async () => {
    await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Test isolation of the inbox path.",
        tool_area: "managed-fs",
        trigger: "generalist-dev / story native:01TEST",
      },
    });

    // .flow/state/ hierarchy must contain only the sentinel files.
    const stateRoot = path.join(root, ".flow", "state");
    async function flatList(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          results.push(...(await flatList(full)));
        } else {
          results.push(full);
        }
      }
      return results;
    }
    const stateFiles = await flatList(stateRoot);
    // Only sentinel files — one per state dir.
    expect(stateFiles).toHaveLength(4);
    for (const f of stateFiles) {
      expect(path.basename(f)).toBe("native:01SENTINEL.yaml");
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — Validation: malformed / incomplete items are refused
// ---------------------------------------------------------------------------

describe("recordMaintainerFeedback (AC2) — malformed/incomplete items are refused", () => {
  it("throws MalformedMaintainerFeedbackError when 'problem' is missing", async () => {
    const err = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        tool_area: "gather-retro-inputs",
        trigger: "generalist-dev",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedMaintainerFeedbackError);
  });

  it("throws MalformedMaintainerFeedbackError when 'tool_area' is missing", async () => {
    const err = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Something is wrong.",
        trigger: "generalist-dev",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedMaintainerFeedbackError);
  });

  it("throws MalformedMaintainerFeedbackError when 'trigger' is missing", async () => {
    const err = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Something is wrong.",
        tool_area: "gather-retro-inputs",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedMaintainerFeedbackError);
  });

  it("throws MalformedMaintainerFeedbackError for an empty 'problem' string", async () => {
    const err = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "",
        tool_area: "gather-retro-inputs",
        trigger: "generalist-dev",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedMaintainerFeedbackError);
  });

  it("throws MalformedMaintainerFeedbackError for an empty 'tool_area' string", async () => {
    const err = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Something is wrong.",
        tool_area: "",
        trigger: "generalist-dev",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedMaintainerFeedbackError);
  });

  it("throws MalformedMaintainerFeedbackError for an empty 'trigger' string", async () => {
    const err = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Something is wrong.",
        tool_area: "gather-retro-inputs",
        trigger: "",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedMaintainerFeedbackError);
  });

  it("throws MalformedMaintainerFeedbackError for an unknown key (strict schema)", async () => {
    const err = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Something is wrong.",
        tool_area: "gather-retro-inputs",
        trigger: "generalist-dev",
        unknown_field: "rejected",
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MalformedMaintainerFeedbackError);
  });

  it("does NOT write any inbox file when validation fails", async () => {
    await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        // missing 'trigger'
        problem: "Something is wrong.",
        tool_area: "gather-retro-inputs",
      },
    }).catch(() => {
      /* expected */
    });

    // Inbox directory must not exist (or if it does, must be empty).
    const inboxDir = path.join(root, ".flow", "maintainer-inbox");
    let entries: string[] = [];
    try {
      entries = await fs.readdir(inboxDir);
    } catch {
      // ENOENT — directory was never created, which is also fine.
      entries = [];
    }
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Accumulation: multiple items accumulate as distinct entries
// ---------------------------------------------------------------------------

describe("recordMaintainerFeedback (AC3) — multiple items accumulate without overwriting", () => {
  it("writes N items as N distinct files in the inbox", async () => {
    const items = [
      {
        problem: "Problem one: the retro cannot record a structural limitation.",
        tool_area: "gather-retro-inputs",
        trigger: "retro-analyst / story native:01A",
      },
      {
        problem: "Problem two: the dev cannot surface a tool-area gap.",
        tool_area: "run-dev-terminal-action",
        trigger: "generalist-dev / story native:01B",
        suggested_direction: "Add a recordMaintainerFeedback call in the dev seam.",
      },
      {
        problem: "Problem three: the reviewer cannot flag an engine defect.",
        tool_area: "run-reviewer-session",
        trigger: "generalist-reviewer / story native:01C",
      },
    ];

    const results = [];
    for (const item of items) {
      results.push(await recordMaintainerFeedback({ targetRepoRoot: root, item }));
    }

    // Each call must return a distinct id and path.
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
    const paths = results.map((r) => r.absPath);
    expect(new Set(paths).size).toBe(3);

    // All three files must exist on disk.
    for (const r of results) {
      const stat = await fs.stat(r.absPath);
      expect(stat.isFile()).toBe(true);
    }

    // Inbox directory must contain exactly three files.
    const inboxDir = path.join(root, ".flow", "maintainer-inbox");
    const entries = await fs.readdir(inboxDir);
    expect(entries).toHaveLength(3);
  });

  it("each accumulated item is independently schema-valid and self-contained", async () => {
    const problems = [
      "First structural limitation found.",
      "Second structural limitation found.",
    ];

    for (const problem of problems) {
      const result = await recordMaintainerFeedback({
        targetRepoRoot: root,
        item: {
          problem,
          tool_area: "test-area",
          trigger: "generalist-dev / story native:01TEST",
        },
      });

      const raw = await fs.readFile(result.absPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const schemaResult = MaintainerFeedbackItemSchema.safeParse(parsed);
      expect(schemaResult.success).toBe(true);
      expect(schemaResult.data!.problem).toBe(problem);
    }
  });

  it("re-recording the same payload writes two distinct files (not an overwrite)", async () => {
    const item = {
      problem: "Idempotency check — this should NOT overwrite.",
      tool_area: "managed-fs",
      trigger: "generalist-dev / story native:01TEST",
    };

    const r1 = await recordMaintainerFeedback({ targetRepoRoot: root, item });
    const r2 = await recordMaintainerFeedback({ targetRepoRoot: root, item });

    // Different ids and paths.
    expect(r1.id).not.toBe(r2.id);
    expect(r1.absPath).not.toBe(r2.absPath);

    // Both files exist.
    await fs.access(r1.absPath);
    await fs.access(r2.absPath);

    // Two distinct files in the inbox.
    const inboxDir = path.join(root, ".flow", "maintainer-inbox");
    const entries = await fs.readdir(inboxDir);
    expect(entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// maintainerInboxItemPath helper
// ---------------------------------------------------------------------------

describe("maintainerInboxItemPath helper", () => {
  it("produces a filesystem-safe path under .flow/maintainer-inbox/", () => {
    const id = "01HZMAINTAINERTEST000000001";
    const raisedAt = "2026-06-16T12:00:00.000Z";
    const p = maintainerInboxItemPath("/repo/root", id, raisedAt);

    expect(p).toContain(path.join(".flow", "maintainer-inbox"));
    expect(p).toContain(id);
    expect(path.basename(p)).toMatch(/\.json$/);
    // No raw colons in the filename (filesystem-safe).
    expect(path.basename(p)).not.toContain(":");
  });
});

// ---------------------------------------------------------------------------
// AC2 (story native:01KW5WMS33XC463QM60AXDGK81)
// recordMaintainerFeedback — live-session issueUrl targets the plugin's own repo
// ---------------------------------------------------------------------------

/** Stub plugin package.json returning a recognisable plugin repo identity. */
const STUB_READ_PLUGIN_PKG_JSON = (): string =>
  JSON.stringify({
    name: "flow",
    repository: {
      type: "git",
      url: "https://github.com/test-plugin-owner/test-plugin-repo",
    },
  });

describe("recordMaintainerFeedback (AC2) — live-session issueUrl targets plugin repo", () => {
  it("issueUrl is present and targets the plugin repo when readPluginPkgJsonImpl succeeds", async () => {
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "The run seam cannot route a structural finding.",
        tool_area: "run-dev-terminal-action",
        trigger: "generalist-dev / story native:01TESTAC2",
      },
      readPluginPkgJsonImpl: STUB_READ_PLUGIN_PKG_JSON,
    });

    expect(result.ok).toBe(true);
    expect(result.issueUrl).toBeDefined();
    // Must target the plugin repo, not whatever cwd project is active.
    expect(result.issueUrl).toContain("test-plugin-owner/test-plugin-repo");
    expect(result.issueUrl).not.toContain("my-cwd-owner");
  });

  it("issueUrl is a valid pre-filled GitHub new-issue URL (not an API or auto-file endpoint)", async () => {
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Issue URL shape check.",
        tool_area: "record-maintainer-feedback",
        trigger: "generalist-dev / story native:01TESTAC2B",
      },
      readPluginPkgJsonImpl: STUB_READ_PLUGIN_PKG_JSON,
    });

    expect(result.issueUrl).toMatch(
      /^https:\/\/github\.com\/test-plugin-owner\/test-plugin-repo\/issues\/new\?/,
    );
    expect(result.issueUrl).not.toContain("api/v3");
    expect(result.issueUrl).not.toContain("/issues/create");
  });

  it("issueUrl body includes the problem and trigger fields", async () => {
    const problem = "The reviewer cannot flag a structural engine defect.";
    const trigger = "generalist-reviewer / story native:01TESTAC2C";

    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: { problem, tool_area: "run-reviewer-session", trigger },
      readPluginPkgJsonImpl: STUB_READ_PLUGIN_PKG_JSON,
    });

    const url = result.issueUrl ?? "";
    const bodyParam = new URL(url).searchParams.get("body") ?? "";
    expect(bodyParam).toContain(problem);
    expect(bodyParam).toContain(trigger);
  });

  it("issueUrl is absent when readPluginPkgJsonImpl returns null (fail-soft)", async () => {
    // When the plugin package.json is unreadable, the inbox write still
    // succeeds — only the URL bonus is suppressed (fail-soft).
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Fail-soft check — inbox write must still succeed.",
        tool_area: "managed-fs",
        trigger: "generalist-dev / story native:01TESTAC2D",
      },
      readPluginPkgJsonImpl: () => null,
    });

    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.issueUrl).toBeUndefined();

    // The inbox file must still have been written.
    const stat = await import("node:fs").then((m) => m.promises.stat(result.absPath));
    expect(stat.isFile()).toBe(true);
  });

  it("issueUrl is absent when the repository field is absent in the plugin package.json (fail-soft)", async () => {
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Repository field absent check.",
        tool_area: "build-feedback-issue-url",
        trigger: "generalist-dev / story native:01TESTAC2E",
      },
      readPluginPkgJsonImpl: () => JSON.stringify({ name: "flow" }),
    });

    expect(result.ok).toBe(true);
    expect(result.issueUrl).toBeUndefined();
  });

  it("also returns issueTitle and issueBody when issueUrl is present", async () => {
    const result = await recordMaintainerFeedback({
      targetRepoRoot: root,
      item: {
        problem: "Title and body fields check.",
        tool_area: "review-maintainer-inbox",
        trigger: "generalist-dev / story native:01TESTAC2F",
      },
      readPluginPkgJsonImpl: STUB_READ_PLUGIN_PKG_JSON,
    });

    expect(result.issueUrl).toBeDefined();
    expect(result.issueTitle).toBeDefined();
    expect(result.issueBody).toBeDefined();
    expect(result.issueTitle).toContain("review-maintainer-inbox");
    expect(result.issueBody).toContain("Title and body fields check.");
  });
});
