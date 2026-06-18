/**
 * Content self-consistency checks for the merged `/flow:dashboard` skill.
 *
 * `/flow:dashboard` replaces the former `/flow:status`, `/flow:board`, and
 * `/flow:team` commands with a single read-only cockpit that renders three
 * labelled sections (Status / Backlog / Team) by calling getStatus,
 * getBacklogDashboard, and getTeamSnapshot with per-section error handling.
 *
 * These assertions are NOT user-surface — operators never type
 * `pnpm --dir plugins/flow test`. They pin the shipped SKILL.md so the
 * skill's tool orchestration and read-only contract can't silently drift.
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";

import { getPluginRoot } from "../src/lib/plugin-root.js";

const SKILL_FILE = path.resolve(
  getPluginRoot(),
  "skills",
  "dashboard",
  "SKILL.md",
);

describe("/flow:dashboard SKILL.md self-consistency", () => {
  it("frontmatter name === 'flow:dashboard'", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    const match = /^---\n([\s\S]*?)\n---/.exec(raw);
    expect(match, "frontmatter not found").toBeTruthy();
    const frontmatter = yamlParse(match![1]!);
    expect(frontmatter.name).toBe("flow:dashboard");
  });

  it("allowed_tools contains the three read tools and Read", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    const match = /^---\n([\s\S]*?)\n---/.exec(raw);
    const frontmatter = yamlParse(match![1]!);
    const tools = frontmatter.allowed_tools as string[];
    expect(tools).toContain("getStatus");
    expect(tools).toContain("getBacklogDashboard");
    expect(tools).toContain("getTeamSnapshot");
    expect(tools).toContain("Read");
  });

  it("body contains the three section headings in order", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    const headings = ["## Status", "## Backlog", "## Team"];
    let lastIdx = -1;
    for (const heading of headings) {
      const idx = raw.indexOf(heading);
      expect(idx, `missing heading: ${heading}`).toBeGreaterThan(-1);
      expect(idx, `heading out of order: ${heading}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("body references each of the three read tool names", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    expect(raw).toContain("getStatus");
    expect(raw).toContain("getBacklogDashboard");
    expect(raw).toContain("getTeamSnapshot");
  });

  it("body declares read-only behaviour and per-section error handling", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    expect(raw.toLowerCase()).toContain("read-only");
    expect(raw).toContain("unavailable");
  });

  it("body does NOT carry the recordSkillInvoke prose seam (PreToolUse hook is sole recorder)", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    expect(raw).not.toContain("recordSkillInvoke");
  });
});
