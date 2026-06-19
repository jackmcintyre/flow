/**
 * Tests for the `team-change`-kind apply handler — Story native:01KVFAP16TD6ENBDSQ9AQQCXTQ.
 *
 * Five acceptance criteria:
 *
 *  AC1 (integration) — Given the retrospective has recommended hiring a
 *      particular role, When I accept that recommendation, Then that role is
 *      added to my team and, looking at the preview of what changed, only my
 *      team's records are affected — nothing else in the project is touched.
 *
 *  AC2 (integration) — Given the retrospective has recommended letting a role
 *      go and accepting it would still leave enough reviewers to run the
 *      quality-grading panel, When I accept the recommendation, Then that role
 *      is set aside using the safe, reversible method and only my team's
 *      records change.
 *
 *  AC3 (integration) — Given the retrospective has recommended letting a role
 *      go but doing so would leave the quality-grading panel unable to run,
 *      When I look at the preview before confirming, Then I am shown a refusal
 *      explaining it would break the panel, and if I proceed nothing in my
 *      team is changed.
 *
 *  AC4 — Given I accept any team-change recommendation, When I inspect
 *      everything the change touched, Then the reviewer's quality-rubric file
 *      is never among the things that changed.
 *
 *  AC5 — Given a team-change recommendation, When I accept it, Then it passes
 *      through the same confirm-first step every accepted recommendation uses
 *      and the change can be undone afterwards.
 *
 * Fixture approach: seed a minimal team in a temp dir using `atomicWriteFile`,
 * then call `acceptProposal` with an injected fake `gitCommit` seam. The
 * handler is seeded with the real plugin root so `instantiatePersona` can
 * resolve catalogue roles.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { acceptProposal } from "../accept-proposal.js";
import { makeTeamChangeHandler } from "../../lib/apply-team-change.js";
import {
  createProductionRegistry,
  type ProposalApplyRegistry,
} from "../../lib/proposal-apply-registry.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { UnhireBelowJudgeMinimumError } from "../../errors.js";
import type { gitCommit as gitCommitType } from "../../lib/git.js";

// ---------------------------------------------------------------------------
// Plugin root resolution (real catalogue for instantiatePersona)
// ---------------------------------------------------------------------------

/**
 * Resolve the real plugin root (`plugins/flow/`) by walking up from this
 * test file until the `.claude-plugin/plugin.json` marker is found.
 * This mirrors `getPluginRoot()`'s logic so tests can pass the real catalogue.
 */
function resolvePluginRoot(): string {
  // This file: src/tools/__tests__/apply-team-change.test.ts
  // Plugin root: plugins/flow/ (4 levels up from __tests__)
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

// Resolved once per module (stable across tests).
const REAL_PLUGIN_ROOT = resolvePluginRoot();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ISO = "2026-05-28T14:32:11.123Z";
const FIXED_NOW = new Date("2026-06-19T10:00:00.000Z");
const FIXED_CLOCK = () => FIXED_NOW;

// ULIDs used as proposal ids in tests.
// Must be valid Crockford base32 ULIDs (no I, L, O, U).
const ULID_HIRE = "01HZTEAM0000HREQ0000000000";
const ULID_UNHIRE = "01HZTEAM0000NHRQ0000000000";
const ULID_BREAK = "01HZTEAM0000BRKQ0000000000";

/** The five default roster roles that satisfy the judge panel. */
const DEFAULT_ROSTER = [
  "planner",
  "generalist-dev",
  "generalist-reviewer",
  "retro-analyst",
  "orchestrator",
];

// A role not in the default roster that can be hired via the real catalogue.
const HIRE_ROLE = "test-specialist";

// The role we will unhire in the safe-unhire test (must keep panel intact).
// We add a 6th role (test-specialist) first so removing one of the 5 is safe.
const UNHIRE_ROLE = "test-specialist";

// A role whose removal from the 5-role default roster would break the panel.
const PANEL_BREAKING_ROLE = "generalist-dev";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-team-change-"));
  // Minimal .flow config so managed-fs context is valid.
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\n",
  );
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

// ---------------------------------------------------------------------------
// Helper: write a minimal PERSONA.md for a role (for pre-hired roles)
// ---------------------------------------------------------------------------

async function seedPersona(role: string): Promise<void> {
  const dir = path.join(tmpRoot, "team", role);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(
    path.join(dir, "PERSONA.md"),
    `---\nrole: ${role}\ndomain: "${role} domain"\nmodel_tier: sonnet\n` +
      `tools_allow:\n  - Read\ngh_allow: []\n` +
      `locked_phrases:\n  handoff: "Handoff to reviewer — story <story-id> ready for review."\n` +
      `  yield: "This sits in <role>'s domain — handing off."\n` +
      `  verdict: "**Verdict: <SENTINEL>**"\n` +
      `hired_at: "2026-01-01T00:00:00.000Z"\n` +
      `catalogue_version: "0.1.0"\n---\n\n# ${role}\n\n## Domain\n\n${role} domain\n\n` +
      `## Mandate\n\n- Work.\n\n## Out of mandate\n\n- Nothing.\n\n## Prompt\n\nYou are ${role}.\n\n## Knowledge\n\n`,
  );
}

async function seedDefaultRoster(): Promise<void> {
  for (const role of DEFAULT_ROSTER) {
    await seedPersona(role);
  }
}

// ---------------------------------------------------------------------------
// Helper: fake gitCommit seam
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: fake filterGitIgnoredPaths (pass all through)
// ---------------------------------------------------------------------------

async function noopFilterGitIgnoredPaths(args: {
  targetRepoRoot: string;
  paths: readonly string[];
}): Promise<string[]> {
  return [...args.paths];
}

// ---------------------------------------------------------------------------
// Helper: build a registry containing only the team-change handler
// ---------------------------------------------------------------------------

function teamChangeOnlyRegistry(
  opts: { pluginRoot?: string; clock?: () => Date } = {},
): ProposalApplyRegistry {
  const map: ProposalApplyRegistry = new Map();
  map.set(
    "team-change",
    makeTeamChangeHandler({
      pluginRoot: opts.pluginRoot ?? REAL_PLUGIN_ROOT,
      clock: opts.clock ?? FIXED_CLOCK,
    }),
  );
  return map;
}

// ---------------------------------------------------------------------------
// Helper: team-change proposal objects
// ---------------------------------------------------------------------------

function hireProposal(id: string, role: string): Record<string, unknown> {
  return {
    type: "team-change",
    id,
    created_at: ISO,
    rationale: "Retro recommended adding this role to the team.",
    action: "hire",
    target_role: role,
    justification: "The team lacks coverage for this area.",
    predicted_impact: {
      affected_failure_classes: ["tooling-coverage"],
    },
  };
}

function unhireProposal(id: string, role: string): Record<string, unknown> {
  return {
    type: "team-change",
    id,
    created_at: ISO,
    rationale: "Retro recommended letting this role go.",
    action: "unhire",
    target_role: role,
    justification: "This role's contributions have been minimal.",
    predicted_impact: {
      affected_failure_classes: ["tooling-coverage"],
    },
  };
}

// ---------------------------------------------------------------------------
// AC1 — hire adds the role; changedPaths is only team records
// ---------------------------------------------------------------------------

describe("AC1 — hire recommendation adds the role to the team", () => {
  it("writes the new persona file under team/<role>/PERSONA.md", async () => {
    // No pre-existing team needed for a pure hire test.
    await fs.mkdir(path.join(tmpRoot, "team"), { recursive: true });

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [hireProposal(ULID_HIRE, HIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_HIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.status).toBe("applied");

    // Persona file must exist at team/<role>/PERSONA.md.
    const personaPath = path.join(tmpRoot, "team", HIRE_ROLE, "PERSONA.md");
    await expect(fs.access(personaPath)).resolves.toBeUndefined();
  });

  it("changedPaths from hire are strictly under the team/ directory", async () => {
    await fs.mkdir(path.join(tmpRoot, "team"), { recursive: true });

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [hireProposal(ULID_HIRE, HIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_HIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(git.calls).toHaveLength(1);
    const committedPaths = git.calls[0]!.paths;

    // Every non-proposal path must be under team/.
    const nonProposalPaths = committedPaths.filter(
      (p) => !p.startsWith(".flow/retro-proposals/"),
    );
    for (const p of nonProposalPaths) {
      expect(p).toMatch(/^team\//);
    }
  });

  it("preview for hire shows the role would be added; no file is written", async () => {
    await fs.mkdir(path.join(tmpRoot, "team"), { recursive: true });

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [hireProposal(ULID_HIRE, HIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_HIRE,
      // No confirm → preview mode.
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.status).toBe("preview");
    if (result.status === "preview") {
      expect(result.type).toBe("team-change");
      // Preview must mention the role and the action.
      expect(result.diff).toContain(HIRE_ROLE);
      expect(result.diff).toContain("hire");
    }

    // No commit made and no persona file created.
    expect(git.calls).toHaveLength(0);
    await expect(
      fs.access(path.join(tmpRoot, "team", HIRE_ROLE, "PERSONA.md")),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC2 — unhire sets the role aside reversibly; changedPaths only team records
// ---------------------------------------------------------------------------

describe("AC2 — unhire recommendation sets role aside reversibly", () => {
  it("archives the persona and removes it from the live team", async () => {
    // Need 6 roles so removing one still staffs all 5 lenses.
    await seedDefaultRoster();
    await seedPersona(UNHIRE_ROLE); // 6th role.

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [unhireProposal(ULID_UNHIRE, UNHIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_UNHIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.status).toBe("applied");

    // Live persona must be gone.
    await expect(
      fs.access(path.join(tmpRoot, "team", UNHIRE_ROLE, "PERSONA.md")),
    ).rejects.toThrow();

    // Archived persona must exist (reversible — not deleted).
    await expect(
      fs.access(
        path.join(tmpRoot, "team", "_archived", UNHIRE_ROLE, "PERSONA.md"),
      ),
    ).resolves.toBeUndefined();
  });

  it("changedPaths from unhire are strictly under the team/ directory", async () => {
    await seedDefaultRoster();
    await seedPersona(UNHIRE_ROLE);

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [unhireProposal(ULID_UNHIRE, UNHIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_UNHIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(git.calls).toHaveLength(1);
    const committedPaths = git.calls[0]!.paths;

    // Every non-proposal path must be under team/.
    const nonProposalPaths = committedPaths.filter(
      (p) => !p.startsWith(".flow/retro-proposals/"),
    );
    for (const p of nonProposalPaths) {
      expect(p).toMatch(/^team\//);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — panel-breaking unhire: refusal in preview; apply changes nothing
// ---------------------------------------------------------------------------

describe("AC3 — panel-breaking unhire is refused before and during apply", () => {
  it("preview shows a refusal message when unhire would break the panel", async () => {
    // With only the 5-role default roster, removing any role breaks the panel.
    await seedDefaultRoster();

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [unhireProposal(ULID_BREAK, PANEL_BREAKING_ROLE)],
    });

    const git = makeFakeGitCommit();

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_BREAK,
      // No confirm → preview mode.
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.status).toBe("preview");
    if (result.status === "preview") {
      // Preview must explicitly describe the refusal.
      expect(result.diff).toMatch(/REFUSAL|refusal|would leave the quality-grading panel/i);
      expect(result.diff).toContain(PANEL_BREAKING_ROLE);
    }

    // No commit made.
    expect(git.calls).toHaveLength(0);
  });

  it("apply throws UnhireBelowJudgeMinimumError when unhire would break the panel", async () => {
    await seedDefaultRoster();

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [unhireProposal(ULID_BREAK, PANEL_BREAKING_ROLE)],
    });

    const git = makeFakeGitCommit();

    await expect(
      acceptProposal({
        targetRepoRoot: tmpRoot,
        proposalId: ULID_BREAK,
        confirm: true,
        handlers: teamChangeOnlyRegistry(),
        gitCommitImpl: git.impl,
        filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
        now: () => FIXED_NOW,
      }),
    ).rejects.toBeInstanceOf(UnhireBelowJudgeMinimumError);
  });

  it("team is completely unchanged after a refused panel-breaking unhire", async () => {
    await seedDefaultRoster();

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [unhireProposal(ULID_BREAK, PANEL_BREAKING_ROLE)],
    });

    const git = makeFakeGitCommit();

    try {
      await acceptProposal({
        targetRepoRoot: tmpRoot,
        proposalId: ULID_BREAK,
        confirm: true,
        handlers: teamChangeOnlyRegistry(),
        gitCommitImpl: git.impl,
        filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
        now: () => FIXED_NOW,
      });
    } catch {
      // Expected refusal.
    }

    // Live persona must still be intact.
    await expect(
      fs.access(
        path.join(tmpRoot, "team", PANEL_BREAKING_ROLE, "PERSONA.md"),
      ),
    ).resolves.toBeUndefined();

    // Archive must NOT have been created.
    await expect(
      fs.access(
        path.join(tmpRoot, "team", "_archived", PANEL_BREAKING_ROLE, "PERSONA.md"),
      ),
    ).rejects.toThrow();

    // No git commit made.
    expect(git.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — quality-rubric / standards file is NEVER in changedPaths
// ---------------------------------------------------------------------------

describe("AC4 — quality-rubric/standards file is never among the changed paths", () => {
  const STANDARDS_CANDIDATES = [
    "docs/standards.md",
    ".flow/standards.md",
    "standards.md",
  ];

  it("hire: standards file is not in the committed paths", async () => {
    await fs.mkdir(path.join(tmpRoot, "team"), { recursive: true });

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [hireProposal(ULID_HIRE, HIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_HIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(git.calls).toHaveLength(1);
    const committedPaths = git.calls[0]!.paths;

    for (const candidate of STANDARDS_CANDIDATES) {
      expect(committedPaths).not.toContain(candidate);
    }
    // Also check none of the paths ends with standards.md
    const hasStandards = committedPaths.some((p) => p.endsWith("standards.md"));
    expect(hasStandards).toBe(false);
  });

  it("unhire: standards file is not in the committed paths", async () => {
    await seedDefaultRoster();
    await seedPersona(UNHIRE_ROLE);

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [unhireProposal(ULID_UNHIRE, UNHIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_UNHIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(git.calls).toHaveLength(1);
    const committedPaths = git.calls[0]!.paths;

    for (const candidate of STANDARDS_CANDIDATES) {
      expect(committedPaths).not.toContain(candidate);
    }
    const hasStandards = committedPaths.some((p) => p.endsWith("standards.md"));
    expect(hasStandards).toBe(false);
  });

  it("team-change handler is registered in the production registry", () => {
    const registry = createProductionRegistry();
    expect(registry.has("team-change")).toBe(true);
    const handler = registry.get("team-change");
    expect(handler).toBeDefined();
    expect(handler!.type).toBe("team-change");
  });
});

// ---------------------------------------------------------------------------
// AC5 — confirm-gating and reversibility
// ---------------------------------------------------------------------------

describe("AC5 — confirm-first gating and reversibility", () => {
  it("preview (no confirm) does not apply the hire", async () => {
    await fs.mkdir(path.join(tmpRoot, "team"), { recursive: true });

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [hireProposal(ULID_HIRE, HIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    const previewResult = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_HIRE,
      // No confirm = preview only.
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(previewResult.status).toBe("preview");
    // No persona file created by preview.
    await expect(
      fs.access(path.join(tmpRoot, "team", HIRE_ROLE, "PERSONA.md")),
    ).rejects.toThrow();
    // No commit.
    expect(git.calls).toHaveLength(0);

    // Now confirm = the actual apply.
    const applyResult = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_HIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(applyResult.status).toBe("applied");
    await expect(
      fs.access(path.join(tmpRoot, "team", HIRE_ROLE, "PERSONA.md")),
    ).resolves.toBeUndefined();
  });

  it("unhire is reversible — archived persona can be reinstated", async () => {
    await seedDefaultRoster();
    await seedPersona(UNHIRE_ROLE);

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [unhireProposal(ULID_UNHIRE, UNHIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_UNHIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    // Persona is archived (reversible) — not deleted.
    const archivedPath = path.join(
      tmpRoot,
      "team",
      "_archived",
      UNHIRE_ROLE,
      "PERSONA.md",
    );
    await expect(fs.access(archivedPath)).resolves.toBeUndefined();

    // The archived content still carries the original persona content.
    const archivedContents = await fs.readFile(archivedPath, "utf8");
    expect(archivedContents).toContain(`role: ${UNHIRE_ROLE}`);
    // And has the archived_at stamp (can be reinstated = full content preserved).
    expect(archivedContents).toContain("archived_at");
  });

  it("double-apply is a safe no-op (idempotency from the accept gate)", async () => {
    await fs.mkdir(path.join(tmpRoot, "team"), { recursive: true });

    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [hireProposal(ULID_HIRE, HIRE_ROLE)],
    });

    const git = makeFakeGitCommit();

    // First apply.
    const first = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_HIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });
    expect(first.status).toBe("applied");

    // Second apply — must be a no-op (already-applied from the gate stamp).
    const second = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_HIRE,
      confirm: true,
      handlers: teamChangeOnlyRegistry(),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: noopFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });
    expect(second.status).toBe("already-applied");

    // Only one commit from the first apply.
    expect(git.calls).toHaveLength(1);
  });
});
