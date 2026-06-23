/**
 * Tests for `resolveRunSlot` — Story native:01KVS0XXPMX0K9F650QP0Q2RNQ.
 *
 * AC1: A default generalist with no declared capabilities still staffs its
 * own run slot. Specifically:
 *
 *  (a) A generalist-dev PERSONA.md with NO capabilities block qualifies for
 *      the 'build' slot and wins it (isDefault: true).
 *  (b) A generalist-reviewer PERSONA.md with NO capabilities block qualifies
 *      for the 'review' slot and wins it (isDefault: true).
 *  (c) A NON-generalist role with NO capabilities block does NOT qualify for
 *      any slot — resolveRunSlot throws RunSlotUnstaffedError when it is the
 *      only hired role.
 *  (d) When a generalist WITHOUT a capabilities block coexists with a
 *      specialist WITH a capabilities block declaring the same job, the
 *      generalist default still wins (backward-compatible priority).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRunSlot } from "../resolve-run-slot.js";
import { RunSlotUnstaffedError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-resolve-run-slot-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a PERSONA.md for a role that has NO capabilities block.
 * This simulates a persona hired before the catalogue declared capabilities.
 */
async function seedPersonaNoCapabilities(opts: {
  root: string;
  role: string;
  domain?: string;
}): Promise<void> {
  const { root, role, domain = `${role} domain` } = opts;
  const roleDir = path.join(root, "team", role);
  await fs.mkdir(roleDir, { recursive: true });

  const content = [
    "---",
    `role: ${role}`,
    `domain: "${domain}"`,
    `model_tier: sonnet`,
    `tools_allow:`,
    `  - Read`,
    `gh_allow: []`,
    `locked_phrases:`,
    `  handoff: "Handoff to reviewer — story <story-id> ready for review."`,
    `  yield: "This sits in <domain>'s domain — handing off."`,
    `  verdict: "**Verdict: <SENTINEL>**"`,
    `hired_at: "2026-06-01T00:00:00.000Z"`,
    `catalogue_version: "0.1.0"`,
    "---",
    "",
    `# ${role}`,
    "",
    "## Domain",
    "",
    domain,
    "",
    "## Mandate",
    "",
    "Implement things.",
    "",
    "## Out of mandate",
    "",
    "Nothing.",
    "",
    "## Prompt",
    "",
    `You are the ${role}.`,
    "",
    "## Knowledge",
    "",
  ].join("\n");

  await fs.writeFile(path.join(roleDir, "PERSONA.md"), content, "utf8");
}

/**
 * Write a PERSONA.md for a role that declares capabilities (with run_jobs).
 */
async function seedPersonaWithCapabilities(opts: {
  root: string;
  role: string;
  domain?: string;
  runJobs: string[];
}): Promise<void> {
  const { root, role, domain = `${role} domain`, runJobs } = opts;
  const roleDir = path.join(root, "team", role);
  await fs.mkdir(roleDir, { recursive: true });

  const runJobsYaml = runJobs.map((j) => `    - ${j}`).join("\n");

  const content = [
    "---",
    `role: ${role}`,
    `domain: "${domain}"`,
    `model_tier: sonnet`,
    `tools_allow:`,
    `  - Read`,
    `gh_allow: []`,
    `locked_phrases:`,
    `  handoff: "Handoff to reviewer — story <story-id> ready for review."`,
    `  yield: "This sits in <domain>'s domain — handing off."`,
    `  verdict: "**Verdict: <SENTINEL>**"`,
    `capabilities:`,
    `  review_lenses: []`,
    `  run_jobs:`,
    runJobsYaml,
    `  path_patterns: []`,
    `hired_at: "2026-06-01T00:00:00.000Z"`,
    `catalogue_version: "0.1.0"`,
    "---",
    "",
    `# ${role}`,
    "",
    "## Domain",
    "",
    domain,
    "",
    "## Mandate",
    "",
    "Implement things.",
    "",
    "## Out of mandate",
    "",
    "Nothing.",
    "",
    "## Prompt",
    "",
    `You are the ${role}.`,
    "",
    "## Knowledge",
    "",
  ].join("\n");

  await fs.writeFile(path.join(roleDir, "PERSONA.md"), content, "utf8");
}

// ---------------------------------------------------------------------------
// AC1(a): generalist-dev with NO capabilities block qualifies for 'build'
// ---------------------------------------------------------------------------

describe("AC1(a) — generalist-dev without capabilities block wins the build slot", () => {
  it("resolves 'build' to generalist-dev (isDefault: true) when generalist-dev has no capabilities block", async () => {
    await seedPersonaNoCapabilities({ root: tmpRoot, role: "generalist-dev" });

    const result = await resolveRunSlot({ targetRepoRoot: tmpRoot, job: "build" });

    expect(result.role).toBe("generalist-dev");
    expect(result.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1(b): generalist-reviewer with NO capabilities block qualifies for 'review'
// ---------------------------------------------------------------------------

describe("AC1(b) — generalist-reviewer without capabilities block wins the review slot", () => {
  it("resolves 'review' to generalist-reviewer (isDefault: true) when generalist-reviewer has no capabilities block", async () => {
    await seedPersonaNoCapabilities({ root: tmpRoot, role: "generalist-reviewer" });

    const result = await resolveRunSlot({ targetRepoRoot: tmpRoot, job: "review" });

    expect(result.role).toBe("generalist-reviewer");
    expect(result.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1(c): a NON-generalist role without capabilities block remains unqualified
// ---------------------------------------------------------------------------

describe("AC1(c) — non-generalist without capabilities block is not qualified for any slot", () => {
  it("throws RunSlotUnstaffedError for 'build' when only a non-generalist without capabilities is hired", async () => {
    await seedPersonaNoCapabilities({ root: tmpRoot, role: "reliability-engineer" });

    await expect(
      resolveRunSlot({ targetRepoRoot: tmpRoot, job: "build" }),
    ).rejects.toBeInstanceOf(RunSlotUnstaffedError);
  });

  it("throws RunSlotUnstaffedError for 'review' when only a non-generalist without capabilities is hired", async () => {
    await seedPersonaNoCapabilities({ root: tmpRoot, role: "platform-specialist" });

    await expect(
      resolveRunSlot({ targetRepoRoot: tmpRoot, job: "review" }),
    ).rejects.toBeInstanceOf(RunSlotUnstaffedError);
  });

  it("RunSlotUnstaffedError names the unstaffed slot", async () => {
    await seedPersonaNoCapabilities({ root: tmpRoot, role: "custom-role" });

    let err: unknown;
    try {
      await resolveRunSlot({ targetRepoRoot: tmpRoot, job: "build" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RunSlotUnstaffedError);
    expect((err as RunSlotUnstaffedError).message).toMatch(/build/);
  });
});

// ---------------------------------------------------------------------------
// AC1(d): generalist WITHOUT capabilities wins over specialist WITH capabilities
// ---------------------------------------------------------------------------

describe("AC1(d) — capability-less generalist default wins over qualified specialist", () => {
  it("generalist-dev (no capabilities) still wins 'build' over a specialist that declares build", async () => {
    // Specialist correctly declares build in its capabilities.
    await seedPersonaWithCapabilities({
      root: tmpRoot,
      role: "build-specialist",
      runJobs: ["build"],
    });
    // Generalist-dev has NO capabilities block (old-style hire).
    await seedPersonaNoCapabilities({ root: tmpRoot, role: "generalist-dev" });

    const result = await resolveRunSlot({ targetRepoRoot: tmpRoot, job: "build" });

    expect(result.role).toBe("generalist-dev");
    expect(result.isDefault).toBe(true);
  });

  it("generalist-reviewer (no capabilities) still wins 'review' over a specialist that declares review", async () => {
    await seedPersonaWithCapabilities({
      root: tmpRoot,
      role: "review-specialist",
      runJobs: ["review"],
    });
    await seedPersonaNoCapabilities({ root: tmpRoot, role: "generalist-reviewer" });

    const result = await resolveRunSlot({ targetRepoRoot: tmpRoot, job: "review" });

    expect(result.role).toBe("generalist-reviewer");
    expect(result.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Existing-behaviour preservation: explicit capabilities block still works
// ---------------------------------------------------------------------------

describe("Existing behaviour — explicit capabilities block is respected", () => {
  it("generalist-dev WITH explicit capabilities block wins 'build'", async () => {
    await seedPersonaWithCapabilities({
      root: tmpRoot,
      role: "generalist-dev",
      runJobs: ["build"],
    });

    const result = await resolveRunSlot({ targetRepoRoot: tmpRoot, job: "build" });

    expect(result.role).toBe("generalist-dev");
    expect(result.isDefault).toBe(true);
  });

  it("specialist WITH capabilities block wins when generalist is absent", async () => {
    await seedPersonaWithCapabilities({
      root: tmpRoot,
      role: "build-specialist",
      runJobs: ["build"],
    });

    const result = await resolveRunSlot({ targetRepoRoot: tmpRoot, job: "build" });

    expect(result.role).toBe("build-specialist");
    expect(result.isDefault).toBe(false);
  });

  it("throws RunSlotUnstaffedError when no role qualifies and no capability-less generalist is present", async () => {
    // A non-generalist WITH capabilities but for a different job.
    await seedPersonaWithCapabilities({
      root: tmpRoot,
      role: "review-specialist",
      runJobs: ["review"],
    });

    await expect(
      resolveRunSlot({ targetRepoRoot: tmpRoot, job: "build" }),
    ).rejects.toBeInstanceOf(RunSlotUnstaffedError);
  });
});
