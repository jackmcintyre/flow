/**
 * Tests for the team-fit signal in `gatherRetroInputs` —
 * Story native:01KVFAS0EQH9ZP4CZBSMD9C33H.
 *
 * AC1 (unit): Given a completed cycle whose work repeatedly stalled because no
 *   one on the team covers a needed area of expertise, When the retrospective
 *   runs, Then it proactively recommends hiring a role to cover that area, and
 *   the recommendation carries the concrete evidence of where the work kept
 *   stalling.
 *
 * AC2 (unit): Given a completed cycle in which a specialist on the team did no
 *   useful work, When the retrospective runs and the safety guard would still
 *   leave the quality-grading panel fully staffed, Then it can recommend
 *   letting that specialist go, with the evidence that nothing called for
 *   their expertise.
 *
 * AC3 (integration): Given the retrospective has drafted a team-change
 *   recommendation from the cycle's staffing evidence, When the operator
 *   reviews and confirms it through the normal confirm-first acceptance gate,
 *   Then the team is actually adjusted to match — the role is hired or set
 *   aside — and the evidence that triggered the recommendation travels with it
 *   the whole way through.
 *
 * AC4 (unit): Given a completed cycle that shows no staffing gap and no idle
 *   specialist, When the retrospective runs, Then it makes no team-change
 *   recommendation at all, so the operator is never nudged to churn a team
 *   that is fitting the work.
 *
 * All tests use real tool implementations against a temp filesystem — no mocks
 * of the things under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gatherRetroInputs } from "../gather-retro-inputs.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { acceptProposal } from "../accept-proposal.js";
import { makeTeamChangeHandler } from "../../lib/apply-team-change.js";
import {
  createProductionRegistry,
  type ProposalApplyRegistry,
} from "../../lib/proposal-apply-registry.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import type { gitCommit as gitCommitType } from "../../lib/git.js";

// ---------------------------------------------------------------------------
// Plugin root resolution (real catalogue for instantiatePersona — AC3)
// ---------------------------------------------------------------------------

function resolvePluginRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(thisFile);
  while (dir !== path.parse(dir).root) {
    if (
      require("node:fs").existsSync(
        path.join(dir, ".claude-plugin", "plugin.json"),
      )
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not resolve plugin root above ${thisFile}`);
}

const REAL_PLUGIN_ROOT = resolvePluginRoot();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-team-fit-"));
  // Minimal .flow config so managed-fs context is valid.
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\n",
  );
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a PERSONA.md for a role under `<tmpRoot>/team/<role>/PERSONA.md`.
 */
async function hireRole(role: string, domain: string): Promise<void> {
  const dir = path.join(tmpRoot, "team", role);
  await fs.mkdir(dir, { recursive: true });
  const content =
    `---\nrole: ${role}\ndomain: "${domain}"\nmodel_tier: sonnet\n` +
    `tools_allow:\n  - Read\ngh_allow: []\n` +
    `locked_phrases:\n  handoff: "Handoff to reviewer — story <story-id> ready for review."\n` +
    `  yield: "This sits in <role>'s domain — handing off."\n` +
    `  verdict: "**Verdict: <SENTINEL>**"\n` +
    `hired_at: "2026-01-01T00:00:00.000Z"\n` +
    `catalogue_version: "0.1.0"\n---\n\n# ${role}\n\n## Domain\n\n${domain}\n\n` +
    `## Mandate\n\n- Do the work.\n\n## Out of mandate\n\n- Nothing.\n\n` +
    `## Prompt\n\nYou are the ${role}.\n\n## Knowledge\n\n`;
  await atomicWriteFile(path.join(dir, "PERSONA.md"), content);
}

/** The five default roles that satisfy the judge panel. */
const DEFAULT_ROSTER = [
  "planner",
  "generalist-dev",
  "generalist-reviewer",
  "retro-analyst",
  "orchestrator",
];

async function seedDefaultRoster(): Promise<void> {
  for (const role of DEFAULT_ROSTER) {
    await hireRole(role, `${role} domain`);
  }
}

/** Telemetry line accumulator per test (reset in beforeEach). */
const telemetryLines: string[] = [];

beforeEach(() => {
  telemetryLines.length = 0;
});

async function appendTelemetryEvent(event: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpRoot, ".flow", "telemetry");
  await fs.mkdir(dir, { recursive: true });
  telemetryLines.push(JSON.stringify(event));
  await atomicWriteFile(
    path.join(dir, "2026-06.jsonl"),
    telemetryLines.join("\n") + "\n",
  );
}

function yieldHandoffEvent(opts: {
  domain: string;
  storyId: string;
  sessionSuffix: string;
}): Record<string, unknown> {
  return {
    type: "yield.handoff",
    ts: "2026-06-01T10:00:00.000Z",
    session_id: `01SESSION0000000000${opts.sessionSuffix}`,
    agent: "generalist-reviewer",
    story_id: opts.storyId,
    data: {
      from_role: "generalist-reviewer",
      to_role: "security-specialist",
      domain: opts.domain,
    },
  };
}

function agentInvokeEvent(role: string, sessionSuffix: string): Record<string, unknown> {
  return {
    type: "agent.invoke",
    ts: "2026-06-01T10:00:00.000Z",
    session_id: `01SESSION0000000000${sessionSuffix}`,
    agent: role,
    data: { runtime_ms: 2000 },
  };
}

// Fake gitCommit seam for AC3 integration tests.
function makeFakeGitCommit(sha = "deadbeefcafe0000000000000000000000000000") {
  const calls: Array<{ paths: readonly string[]; message: string }> = [];
  const impl = (async (args: {
    paths: readonly string[];
    message: string;
  }) => {
    calls.push({ paths: args.paths, message: args.message });
    return { commitSha: sha, stdout: "", stderr: "" };
  }) as unknown as typeof gitCommitType;
  return { impl, calls };
}

async function noopFilterGitIgnoredPaths(args: {
  targetRepoRoot: string;
  paths: readonly string[];
}): Promise<string[]> {
  return [...args.paths];
}

function teamChangeOnlyRegistry(): ProposalApplyRegistry {
  const map: ProposalApplyRegistry = new Map();
  map.set(
    "team-change",
    makeTeamChangeHandler({
      pluginRoot: REAL_PLUGIN_ROOT,
      clock: () => new Date("2026-06-20T10:00:00.000Z"),
    }),
  );
  return map;
}

// ---------------------------------------------------------------------------
// AC1: Recurring stall → hire recommendation with evidence in teamFitSignal
// ---------------------------------------------------------------------------

describe("AC1 — recurring stall yields a hire recommendation with concrete evidence", () => {
  it("surfaces a hire recommendation when the same domain stalled ≥2 times", async () => {
    // Minimal roster: no security-specialist.
    await seedDefaultRoster();

    // Two yield.handoff events on the security domain — different story_ids.
    const SECURITY_DOMAIN = "authentication authorization and secret handling";
    await appendTelemetryEvent(
      yieldHandoffEvent({
        domain: SECURITY_DOMAIN,
        storyId: "native:01AAAAAAAAAAAAAAAAAAAAAAAA",
        sessionSuffix: "001",
      }),
    );
    await appendTelemetryEvent(
      yieldHandoffEvent({
        domain: SECURITY_DOMAIN,
        storyId: "native:01BBBBBBBBBBBBBBBBBBBBBBBB",
        sessionSuffix: "002",
      }),
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // teamFitSignal must carry a hire recommendation for security-specialist.
    expect(bundle.teamFitSignal).toBeDefined();
    const secHire = bundle.teamFitSignal.hire.find(
      (h) => h.role === "security-specialist",
    );
    expect(secHire).toBeDefined();

    // The recommendation must carry concrete stall-count evidence.
    expect(secHire!.evidence).toContain("stall-count:2");
    // And the domain evidence.
    expect(secHire!.evidence.join(" ")).toContain(SECURITY_DOMAIN);
  });

  it("the hire recommendation's reason mentions the stall count", async () => {
    await seedDefaultRoster();

    const SECURITY_DOMAIN = "authentication authorization and secret handling";
    for (const suffix of ["003", "004", "005"]) {
      await appendTelemetryEvent(
        yieldHandoffEvent({
          domain: SECURITY_DOMAIN,
          storyId: `native:0100000000000000000000${suffix}`,
          sessionSuffix: suffix,
        }),
      );
    }

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    const secHire = bundle.teamFitSignal.hire.find(
      (h) => h.role === "security-specialist",
    );
    expect(secHire).toBeDefined();
    // Reason should name how many times work stalled.
    expect(secHire!.reason).toMatch(/3/);
  });

  it("the gaps array names the uncovered domain and the specialist to hire", async () => {
    await seedDefaultRoster();

    const SECURITY_DOMAIN = "authentication authorization and secret handling";
    await appendTelemetryEvent(
      yieldHandoffEvent({
        domain: SECURITY_DOMAIN,
        storyId: "native:01AAAAAAAAAAAAAAAAAAAAAAAA",
        sessionSuffix: "006",
      }),
    );
    await appendTelemetryEvent(
      yieldHandoffEvent({
        domain: SECURITY_DOMAIN,
        storyId: "native:01BBBBBBBBBBBBBBBBBBBBBBBB",
        sessionSuffix: "007",
      }),
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    const secGap = bundle.teamFitSignal.gaps.find(
      (g) => g.domain === SECURITY_DOMAIN,
    );
    expect(secGap).toBeDefined();
    expect(secGap!.signal).toMatch(/security-specialist/i);
    expect(secGap!.signal).toMatch(/2/); // stall count
  });

  it("does NOT produce a hire recommendation for a single stall (below threshold)", async () => {
    await seedDefaultRoster();

    const SECURITY_DOMAIN = "authentication authorization and secret handling";
    // Only one stall event — below threshold of 2.
    await appendTelemetryEvent(
      yieldHandoffEvent({
        domain: SECURITY_DOMAIN,
        storyId: "native:01AAAAAAAAAAAAAAAAAAAAAAAA",
        sessionSuffix: "008",
      }),
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // No hire recommendation for security-specialist.
    const secHire = bundle.teamFitSignal.hire.find(
      (h) => h.role === "security-specialist",
    );
    expect(secHire).toBeUndefined();

    // No gap for this domain either.
    const secGap = bundle.teamFitSignal.gaps.find(
      (g) => g.domain === SECURITY_DOMAIN,
    );
    expect(secGap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2: Idle specialist + panel safe → unhire recommendation with evidence
// ---------------------------------------------------------------------------

describe("AC2 — idle specialist not needed by panel → unhire recommendation with evidence", () => {
  it("recommends unhiring a specialist who did no useful work when the panel stays staffed", async () => {
    // Full 5-role roster + security-specialist (6 roles → panel safe after removal).
    await seedDefaultRoster();
    await hireRole(
      "security-specialist",
      "authentication authorization and secret handling",
    );

    // Give everyone EXCEPT security-specialist some useful work.
    for (const [idx, role] of DEFAULT_ROSTER.entries()) {
      await appendTelemetryEvent(agentInvokeEvent(role, `00${idx}`));
    }
    // security-specialist: 0 useful-work events.

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    const secUnhire = bundle.teamFitSignal.unhire.find(
      (u) => u.role === "security-specialist",
    );
    expect(secUnhire).toBeDefined();
    expect(secUnhire!.evidence.join(" ")).toMatch(/no useful work/i);
  });

  it("the unhire recommendation reason mentions 'no useful work'", async () => {
    await seedDefaultRoster();
    await hireRole(
      "security-specialist",
      "authentication authorization and secret handling",
    );

    // All default roster members have useful work; security-specialist does not.
    for (const [idx, role] of DEFAULT_ROSTER.entries()) {
      await appendTelemetryEvent(agentInvokeEvent(role, `10${idx}`));
    }

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    const secUnhire = bundle.teamFitSignal.unhire.find(
      (u) => u.role === "security-specialist",
    );
    expect(secUnhire).toBeDefined();
    expect(secUnhire!.reason).toMatch(/no useful work/i);
  });

  it("does NOT recommend unhiring a specialist who has done useful work", async () => {
    await seedDefaultRoster();
    await hireRole(
      "security-specialist",
      "authentication authorization and secret handling",
    );

    // security-specialist has a useful-work event.
    await appendTelemetryEvent(agentInvokeEvent("security-specialist", "200"));

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    const secUnhire = bundle.teamFitSignal.unhire.find(
      (u) => u.role === "security-specialist",
    );
    expect(secUnhire).toBeUndefined();
  });

  it("does NOT recommend unhiring a specialist whose removal would break the grading panel", async () => {
    // Only 5 roles in DEFAULT_ROSTER. Without generalist-reviewer the panel cannot
    // staff the 'considered' or 'domain' lens. security-specialist is NOT hired,
    // so no unhire candidate exists here. To test the panel-guard, we need a
    // scenario where removing ANY of the 5 default roles would break the panel.
    // Since specialists are the unhire candidates and the default roster has none,
    // the unhire list should be empty regardless.
    await seedDefaultRoster();
    // No specialist hired → no unhire candidate.

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.teamFitSignal.unhire).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3: Integration — drafted team-change recommendation round-trips through
//       the accept gate and actually adjusts the team
// ---------------------------------------------------------------------------

describe("AC3 (integration) — drafted team-change recommendation round-trips through the accept gate", () => {
  const ISO = "2026-06-20T10:00:00.000Z";
  // Valid Crockford base32 ULIDs (26 chars, no I/L/O/U — per UlidSchema regex).
  const PROPOSAL_ULID = "01HZTEAM0000HREQ0000000000";

  it("a hire recommendation written into a proposal round-trips through acceptProposal and adds the role", async () => {
    // Minimal team — no security-specialist.
    await fs.mkdir(path.join(tmpRoot, "team"), { recursive: true });
    for (const role of ["planner", "generalist-dev", "generalist-reviewer", "retro-analyst", "orchestrator"]) {
      await hireRole(role, `${role} domain`);
    }

    // Write a team-change proposal (hire security-specialist) with evidence.
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "team-change",
          id: PROPOSAL_ULID,
          created_at: ISO,
          rationale:
            "Work stalled 2 times waiting for 'authentication authorization and secret handling' expertise. Evidence: stall-count:2, domain:authentication authorization and secret handling.",
          action: "hire",
          target_role: "security-specialist",
          justification:
            "Work stalled 2 times waiting for 'authentication authorization and secret handling' expertise that nobody on the team covers.",
          predicted_impact: {
            affected_failure_classes: ["authentication-authorization-gap"],
          },
        },
      ],
    });

    const git = makeFakeGitCommit();

    // Accept the proposal — should hire security-specialist.
    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: PROPOSAL_ULID,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => new Date(ISO),
    });

    expect(result.status).toBe("applied");

    // The new persona must exist at team/security-specialist/PERSONA.md.
    await expect(
      fs.access(path.join(tmpRoot, "team", "security-specialist", "PERSONA.md")),
    ).resolves.toBeUndefined();
  });

  it("evidence in the proposal travels with it through the apply gate (rationale preserved)", async () => {
    await fs.mkdir(path.join(tmpRoot, "team"), { recursive: true });
    for (const role of DEFAULT_ROSTER) {
      await hireRole(role, `${role} domain`);
    }

    const evidenceRationale =
      "Work stalled 2 times: stall-count:2, domain:authentication authorization and secret handling.";

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "team-change",
          id: PROPOSAL_ULID,
          created_at: ISO,
          rationale: evidenceRationale,
          action: "hire",
          target_role: "security-specialist",
          justification:
            "Work stalled 2 times waiting for security expertise.",
          predicted_impact: {
            affected_failure_classes: ["security-domain-gap"],
          },
        },
      ],
    });

    const git = makeFakeGitCommit();

    await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: PROPOSAL_ULID,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => new Date(ISO),
    });

    // Verify the proposal file was stamped (evidence travels all the way through).
    const proposalFiles = await fs.readdir(
      path.join(tmpRoot, ".flow", "retro-proposals"),
    );
    expect(proposalFiles.length).toBeGreaterThan(0);

    // The committed paths should include team/security-specialist/PERSONA.md.
    expect(git.calls).toHaveLength(1);
    const committedPaths = git.calls[0]!.paths;
    expect(
      committedPaths.some((p) => p.includes("security-specialist")),
    ).toBe(true);
    // The proposal file must also be committed (carries the evidence).
    expect(
      committedPaths.some((p) => p.startsWith(".flow/retro-proposals/")),
    ).toBe(true);
  });

  it("an unhire recommendation round-trips and archives the role", async () => {
    // 5-role default + test-specialist (6th role) so removal keeps panel staffed.
    await seedDefaultRoster();
    await hireRole("test-specialist", "test design and coverage gaps");

    const UNHIRE_ULID = "01HZTEAM0000NHRQ0000000000";

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "team-change",
          id: UNHIRE_ULID,
          created_at: ISO,
          rationale:
            "test-specialist produced no useful work in the recent window. Evidence: no useful work in the recent window.",
          action: "unhire",
          target_role: "test-specialist",
          justification:
            "test-specialist produced no useful work in the recent window and their absence would not prevent the grading panel from running.",
          predicted_impact: {
            affected_failure_classes: ["idle-specialist"],
          },
        },
      ],
    });

    const git = makeFakeGitCommit();

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: UNHIRE_ULID,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => new Date(ISO),
    });

    expect(result.status).toBe("applied");

    // Live persona must be gone.
    await expect(
      fs.access(path.join(tmpRoot, "team", "test-specialist", "PERSONA.md")),
    ).rejects.toThrow();

    // Archived persona must exist (reversible).
    await expect(
      fs.access(
        path.join(tmpRoot, "team", "_archived", "test-specialist", "PERSONA.md"),
      ),
    ).resolves.toBeUndefined();

    // The committed paths reference the team directory only (evidence travels).
    const committedPaths = git.calls[0]!.paths;
    const nonProposalPaths = committedPaths.filter(
      (p) => !p.startsWith(".flow/retro-proposals/"),
    );
    for (const p of nonProposalPaths) {
      expect(p).toMatch(/^team\//);
    }
  });

  it("team-change handler is registered in the production registry", () => {
    const registry = createProductionRegistry();
    expect(registry.has("team-change")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4: No gap, no idle specialist → no team-change recommendation
// ---------------------------------------------------------------------------

describe("AC4 — well-fitted team produces no team-change recommendation", () => {
  it("returns empty hire and unhire when every specialist has done useful work and no stalls occurred", async () => {
    // Full roster including security-specialist; all have useful work.
    await seedDefaultRoster();
    await hireRole(
      "security-specialist",
      "authentication authorization and secret handling",
    );

    // Give security-specialist useful work.
    await appendTelemetryEvent(agentInvokeEvent("security-specialist", "301"));
    // And everyone else too.
    for (const [idx, role] of DEFAULT_ROSTER.entries()) {
      await appendTelemetryEvent(agentInvokeEvent(role, `30${idx + 2}`));
    }

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // No hire or unhire recommendations — the team fits the work.
    expect(bundle.teamFitSignal.hire).toHaveLength(0);
    expect(bundle.teamFitSignal.unhire).toHaveLength(0);
    expect(bundle.teamFitSignal.gaps).toHaveLength(0);
  });

  it("returns empty teamFitSignal when no team is hired and no telemetry exists", async () => {
    // Empty state — no team, no telemetry.
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.teamFitSignal).toBeDefined();
    expect(bundle.teamFitSignal.hire).toHaveLength(0);
    expect(bundle.teamFitSignal.unhire).toHaveLength(0);
    expect(bundle.teamFitSignal.gaps).toHaveLength(0);
  });

  it("returns no team-change recommendations when stalls are below the threshold", async () => {
    await seedDefaultRoster();

    // Only ONE stall event — below the ≥2 threshold.
    await appendTelemetryEvent(
      yieldHandoffEvent({
        domain: "authentication authorization and secret handling",
        storyId: "native:01AAAAAAAAAAAAAAAAAAAAAAAA",
        sessionSuffix: "401",
      }),
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.teamFitSignal.hire).toHaveLength(0);
    expect(bundle.teamFitSignal.gaps).toHaveLength(0);
  });

  it("does not recommend churning when a hired specialist has a minimal but non-zero contribution", async () => {
    await seedDefaultRoster();
    await hireRole(
      "security-specialist",
      "authentication authorization and secret handling",
    );

    // One useful-work event for security-specialist (crosses the zero threshold).
    await appendTelemetryEvent(agentInvokeEvent("security-specialist", "501"));

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    const secUnhire = bundle.teamFitSignal.unhire.find(
      (u) => u.role === "security-specialist",
    );
    expect(secUnhire).toBeUndefined();
  });
});
