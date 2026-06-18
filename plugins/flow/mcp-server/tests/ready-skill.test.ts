/**
 * Content self-consistency checks for the merged `/flow:ready` intake cockpit.
 *
 * The standalone `/flow:judge` skill was folded into `/flow:ready`: the bare
 * cockpit is the cheap backlog list, and targeting an item to approve runs
 * the diverse-lens judge panel, surfaces the verdict, then admits / parks /
 * discards. These assertions pin the shipped SKILL.md so the cockpit's
 * two-gear contract (cheap read vs judge-on-approve) can't silently drift.
 *
 * NOT user-surface — operators never type `pnpm --dir plugins/flow test`.
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";

import { getPluginRoot } from "../src/lib/plugin-root.js";

const SKILL_FILE = path.resolve(
  getPluginRoot(),
  "skills",
  "ready",
  "SKILL.md",
);

async function readFrontmatterAndBody(): Promise<{
  fm: Record<string, unknown>;
  body: string;
}> {
  const raw = await fs.readFile(SKILL_FILE, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  expect(match, "frontmatter not found").toBeTruthy();
  return {
    fm: yamlParse(match![1]!) as Record<string, unknown>,
    body: match![2]!,
  };
}

describe("/flow:ready SKILL.md self-consistency (judge folded in)", () => {
  it("frontmatter name === 'flow:ready'", async () => {
    const { fm } = await readFrontmatterAndBody();
    expect(fm.name).toBe("flow:ready");
  });

  it("allowed_tools carries both the cockpit tools and the judge-panel tools", async () => {
    const { fm } = await readFrontmatterAndBody();
    const tools = fm.allowed_tools as string[];
    // Cockpit (cheap read + mutations).
    expect(tools).toContain("listClaimableTodos");
    expect(tools).toContain("markStoryReady");
    expect(tools).toContain("discardDraft");
    // Judge-on-approve panel.
    expect(tools).toContain("Task");
    expect(tools).toContain("resolveLensRoles");
    expect(tools).toContain("writeLensVerdict");
    expect(tools).toContain("aggregateJudgePanel");
    expect(tools).toContain("buildPersonaSpawnPrompt");
  });

  it("body describes the cheap bare cockpit AND the judge-on-approve path", async () => {
    const { body } = await readFrontmatterAndBody();
    // Names the three panel tools so the approve path is wired in prose.
    expect(body).toContain("resolveLensRoles");
    expect(body).toContain("writeLensVerdict");
    expect(body).toContain("aggregateJudgePanel");
    // The grading-before-approval contract.
    expect(body.toLowerCase()).toContain("judge panel");
  });

  it("body keeps the cheap paths panel-free (unapprove / discard never grade)", async () => {
    const { body } = await readFrontmatterAndBody();
    expect(body.toLowerCase()).toContain("never runs the panel");
  });

  it("body keeps grading separate from approval (only the operator approves)", async () => {
    const { body } = await readFrontmatterAndBody();
    expect(body.toLowerCase()).toContain("grading does not approve");
  });
});
