/**
 * Tests for demand-driven specialist proposals in the hiring conversation —
 * Story native:01KVFAJNTE61SFC3MBJF27Q6NV.
 *
 * These tests verify that the hiring conversation wiring is correct:
 *
 *  AC1 — Given a project whose waiting work is heavy on testing and no test
 *         specialist is on the proposed team, when the operator opens the
 *         hiring conversation, the conversation proposes a test specialist
 *         and names the waiting test-heavy work as the reason.
 *
 *  AC2 — Given a brand-new project with no backlog set up yet, when the
 *         operator opens the hiring conversation, the conversation still
 *         completes and proposes the default starting team, quietly falling
 *         back to its surface-clue reading instead of failing.
 *
 *  AC3 — Given any specialist the conversation proposes because of the
 *         waiting work, when the operator reads the proposal, each such
 *         suggestion names the concrete waiting work behind it so the
 *         operator can judge why it is proposed.
 *
 * Strategy: rather than exercising the full subagent conversation (which
 * requires a live Task call), these tests verify the two testable seams
 * that directly underpin the three ACs:
 *
 *  (a) Allowlist seam — `permissions/hiring-manager.yaml` must grant
 *      `analyzeTeamFit` and `readBacklogInventory` so the hiring-manager
 *      subagent can call them (AC3 prerequisite).
 *
 *  (b) Fit-analysis seam — `analyzeTeamFit` produces a hire recommendation
 *      for `test-specialist` when the backlog contains test-heavy work, with
 *      the story refs as evidence (AC1 + AC3). This is the data the skill
 *      assembles into the `<fit-analysis>` block it passes to the subagent.
 *
 *  (c) Graceful-degradation seam — `analyzeTeamFit` throws on a fresh repo
 *      with no `.flow/config.yaml`, and the skill catches it (null fitAnalysis)
 *      so the conversation can still propose the default roster (AC2).
 */

import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import { analyzeTeamFit } from "../analyze-team-fit.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";

// ---------------------------------------------------------------------------
// Helpers — fixtures and tmp dir setup
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-hire-demand-driven-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a minimal native-adapter config so analyzeTeamFit can resolve the
 * workspace. Without this the tool throws NoAdapterMatchedError (which is
 * exactly what we test in the fresh-repo / AC2 scenario).
 */
async function writeNativeConfig(): Promise<void> {
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  await atomicWriteFile(path.join(tmpRoot, ".flow", "config.yaml"), "adapter: native\n");
}

/**
 * Write a PERSONA.md for a role — minimal fixture that satisfies schema.
 */
async function hireRole(role: string, domain: string): Promise<void> {
  const dir = path.join(tmpRoot, "team", role);
  await fs.mkdir(dir, { recursive: true });
  const content =
    `---\n` +
    `role: ${role}\n` +
    `domain: "${domain}"\n` +
    `model_tier: sonnet\n` +
    `tools_allow:\n  - Read\n` +
    `gh_allow: []\n` +
    `locked_phrases:\n` +
    `  handoff: "Handoff to reviewer — story <story-id> ready for review."\n` +
    `  yield: "This sits in <role>'s domain — handing off."\n` +
    `  verdict: "**Verdict: <SENTINEL>**"\n` +
    `hired_at: "2026-01-01T00:00:00.000Z"\n` +
    `catalogue_version: "0.1.0"\n` +
    `---\n\n# ${role}\n\n## Domain\n\n${domain}\n\n## Mandate\n\n- Do the work.\n\n## Out of mandate\n\n- Nothing.\n\n## Prompt\n\nYou are the ${role}.\n\n## Knowledge\n\n`;
  await atomicWriteFile(path.join(dir, "PERSONA.md"), content);
}

/**
 * Write a minimal valid to-do execution manifest. Intentionally omits
 * source_path file creation — readBacklogInventory only reads the manifest
 * for most fields; specText is loaded from source_path only when
 * includeSpecText:true. We create the native-story file separately.
 */
async function writeTodoManifest(opts: {
  ref: string;
  title: string;
  riskTier?: "low" | "medium" | "high";
}): Promise<void> {
  const dir = path.join(tmpRoot, ".flow", "state", "to-do");
  await fs.mkdir(dir, { recursive: true });
  const riskLine = opts.riskTier ? `risk_tier: ${opts.riskTier}\n` : "";
  const manifest =
    `ref: "${opts.ref}"\n` +
    `status: to-do\n` +
    `adapter: native\n` +
    `source_path: .flow/native-stories/${opts.ref.replace("native:", "")}.md\n` +
    `source_hash: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n` +
    `depends_on: []\n` +
    `acceptance_criteria:\n` +
    `  - text: "Given this feature, when used, then it works."\n` +
    `    kind: integration\n` +
    `title: "${opts.title}"\n` +
    `narrative: "As a user, I want this feature so that I can use it."\n` +
    `withdrawn: false\n` +
    `ready: true\n` +
    riskLine +
    `risk_tier_evidence:\n` +
    `  matched_rule: fallback\n` +
    `  paths: []\n` +
    `  change_types: []\n` +
    `  diff_size: 0\n` +
    `lane: full\n`;
  await atomicWriteFile(path.join(dir, `${opts.ref}.yaml`), manifest);
}

/**
 * Write a native-story source file. The content controls what
 * isTestHeavy() classifies.
 */
async function writeNativeStorySource(ref: string, content: string): Promise<void> {
  const ulid = ref.replace("native:", "");
  const dir = path.join(tmpRoot, ".flow", "native-stories");
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, `${ulid}.md`), content);
}

// ---------------------------------------------------------------------------
// Allowlist seam — permissions/hiring-manager.yaml grants required tools
// ---------------------------------------------------------------------------

describe("Allowlist seam — permissions/hiring-manager.yaml", () => {
  it("grants analyzeTeamFit in tools_allow (AC3 prerequisite: subagent can call the analyzer)", async () => {
    // Resolve the real plugin root relative to the __tests__ folder.
    // __tests__/ → tools/ → src/ → mcp-server/ → flow/ (plugin root)
    const pluginRoot = path.resolve(__dirname, "../../../../");
    const specPath = path.join(pluginRoot, "permissions", "hiring-manager.yaml");
    const raw = await fs.readFile(specPath, "utf8");
    const parsed = yamlParse(raw) as { tools_allow?: string[] };

    expect(parsed.tools_allow).toBeDefined();
    expect(parsed.tools_allow).toContain("analyzeTeamFit");
  });

  it("grants readBacklogInventory in tools_allow (AC3 prerequisite: subagent can read the backlog)", async () => {
    const pluginRoot = path.resolve(__dirname, "../../../../");
    const specPath = path.join(pluginRoot, "permissions", "hiring-manager.yaml");
    const raw = await fs.readFile(specPath, "utf8");
    const parsed = yamlParse(raw) as { tools_allow?: string[] };

    expect(parsed.tools_allow).toBeDefined();
    expect(parsed.tools_allow).toContain("readBacklogInventory");
  });
});

// ---------------------------------------------------------------------------
// Fit-analysis seam — analyzeTeamFit produces demand-driven recommendations
// ---------------------------------------------------------------------------

describe("AC1 + AC3 — fit-analysis seam: test-heavy backlog yields test-specialist proposal with evidence", () => {
  it("produces a hire recommendation for test-specialist when test-heavy stories are waiting", async () => {
    await writeNativeConfig();

    // Minimal team — no test-specialist.
    await hireRole("generalist-dev", "feature implementation in a story scope");
    await hireRole("generalist-reviewer", "code review and verdict authoring");
    await hireRole("planner", "story authoring and acceptance criteria");
    await hireRole("orchestrator", "session liveness and story state transitions");
    await hireRole("retro-analyst", "cycle-end lessons and rule proposals");

    // Two test-heavy stories in the backlog.
    const ref1 = "native:01AAAAAAAAAAAAAAAAAAAAAA01";
    const ref2 = "native:01AAAAAAAAAAAAAAAAAAAAAA02";
    await writeTodoManifest({ ref: ref1, title: "Write test coverage for auth flow", riskTier: "medium" });
    await writeNativeStorySource(
      ref1,
      "# Write test coverage for auth flow\n\nWe need to write tests for the new auth flow and improve test coverage.\n",
    );
    await writeTodoManifest({ ref: ref2, title: "Design test strategy for payment system", riskTier: "medium" });
    await writeNativeStorySource(
      ref2,
      "# Design test strategy for payment system\n\nDesign the test strategy and write a comprehensive test plan for the payment module.\n",
    );

    // Non-test story — should NOT appear in evidence.
    const ref3 = "native:01AAAAAAAAAAAAAAAAAAAAAA03";
    await writeTodoManifest({ ref: ref3, title: "Add user profile page", riskTier: "low" });
    await writeNativeStorySource(ref3, "# Add user profile page\n\nBuild a new user profile view.\n");

    const result = await analyzeTeamFit({ targetRepoRoot: tmpRoot });

    // AC1: test-specialist is recommended.
    const testHire = result.hire.find((h) => h.role === "test-specialist");
    expect(testHire).toBeDefined();

    // AC1: the waiting test-heavy work is named as the reason.
    expect(testHire!.reason).toMatch(/test/i);

    // AC3: concrete waiting work is named — both test-heavy story refs are in evidence.
    expect(testHire!.evidence).toContain(ref1);
    expect(testHire!.evidence).toContain(ref2);

    // AC3: the non-test story is NOT in the evidence.
    expect(testHire!.evidence).not.toContain(ref3);
  });

  it("names the count of test-heavy stories in the reason (AC3: concrete waiting work)", async () => {
    await writeNativeConfig();

    await hireRole("generalist-dev", "feature implementation in a story scope");

    const ref = "native:01BBBBBBBBBBBBBBBBBBBBBB01";
    await writeTodoManifest({ ref, title: "Test coverage improvement", riskTier: "low" });
    await writeNativeStorySource(
      ref,
      "# Test coverage improvement\n\nWrite tests to cover the uncovered code paths and improve test coverage.\n",
    );

    const result = await analyzeTeamFit({ targetRepoRoot: tmpRoot });

    const testHire = result.hire.find((h) => h.role === "test-specialist");
    expect(testHire).toBeDefined();
    // Reason mentions the count (1) and the test-specialist or test-heavy framing.
    expect(testHire!.reason).toMatch(/1 queued|1 stor/i);
    // AC3: evidence carries the ref so the operator can judge why it is proposed.
    expect(testHire!.evidence).toContain(ref);
  });
});

// ---------------------------------------------------------------------------
// Graceful-degradation seam — fresh repo, no backlog (AC2)
// ---------------------------------------------------------------------------

describe("AC2 — graceful-degradation seam: fresh repo falls back without crashing", () => {
  it("throws when there is no .flow/config.yaml (NoAdapterMatchedError)", async () => {
    // Deliberately do NOT write any .flow/config.yaml.
    // analyzeTeamFit must throw so the skill can catch and set fitAnalysis=null.
    await expect(analyzeTeamFit({ targetRepoRoot: tmpRoot })).rejects.toThrow();
  });

  it("does not crash the hiring flow: catching the error yields null fitAnalysis", async () => {
    // This is the skill's own error-handling contract: wrap analyzeTeamFit in
    // try/catch, treat any throw as fitAnalysis=null.  Verify this pattern
    // works correctly and does not itself throw.
    let fitAnalysis: Awaited<ReturnType<typeof analyzeTeamFit>> | null = null;
    let caughtError: unknown = null;

    try {
      fitAnalysis = await analyzeTeamFit({ targetRepoRoot: tmpRoot });
    } catch (err) {
      caughtError = err;
      fitAnalysis = null;
    }

    // The error was caught — it must be an instance of Error.
    expect(caughtError).toBeInstanceOf(Error);
    // fitAnalysis is null — the skill falls back to surface-signal-only mode.
    expect(fitAnalysis).toBeNull();
  });

  it("falls back to surface-signal mode when backlog exists but has no test-heavy stories", async () => {
    // A repo with a backlog but zero test-heavy work → analyzeTeamFit succeeds
    // but returns an empty hire array. This is the 'clean backlog' fallback path.
    await writeNativeConfig();

    await hireRole("generalist-dev", "feature implementation in a story scope");

    const ref = "native:01CCCCCCCCCCCCCCCCCCCCCC01";
    await writeTodoManifest({ ref, title: "Implement new feature", riskTier: "low" });
    await writeNativeStorySource(ref, "# Implement new feature\n\nBuild the new onboarding flow.\n");

    const result = await analyzeTeamFit({ targetRepoRoot: tmpRoot });

    // No test-heavy work → no test-specialist hire recommendation.
    const testHire = result.hire.find((h) => h.role === "test-specialist");
    expect(testHire).toBeUndefined();

    // hire/unhire/gaps arrays are all defined (no crash).
    expect(result.hire).toBeDefined();
    expect(result.unhire).toBeDefined();
    expect(result.gaps).toBeDefined();
  });

  it("returns clean empty arrays on a config-only repo with no backlog (first-run mode)", async () => {
    // Config exists but no state/ and no native-stories/ — analyzeTeamFit
    // must complete without crashing and return empty arrays.
    await writeNativeConfig();
    // No team, no backlog, no telemetry.

    const result = await analyzeTeamFit({ targetRepoRoot: tmpRoot });

    expect(result.hire).toHaveLength(0);
    expect(result.unhire).toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
  });
});
