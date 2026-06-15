/**
 * Tests for `autoAbsorbRetroProposals` — Story native:01KV2Z67850XWWQV0AY2N05JSX.
 *
 * AC1 (integration): note-tier persona-append proposals are absorbed
 *   automatically; higher-stakes proposals (other types or tiers) are left
 *   pending. The gate requires BOTH type === 'persona-append' AND
 *   durability_recommendation.recommendation === 'note'.
 *
 * AC2 (unit): per-run ceiling respected — once maxAutoAbsorb proposals are
 *   absorbed, remaining note-tier proposals are left pending as
 *   'ceiling-reached', not dropped.
 *
 * AC3 (unit): fail-soft — an error during apply does not throw; the proposal
 *   is left pending with reason 'error' and subsequent proposals continue.
 *
 * AC4 (unit): auto-absorbed commits carry a distinct `auto-absorbed: <id>`
 *   marker in the commit message, distinguishable from operator-accepted
 *   `accept-proposal: <id>` commits.
 *
 * Safety boundary tests (from the story's risk mitigation notes):
 *   - persona-append with durability 'skill' must NOT auto-absorb.
 *   - rule-append with durability 'note' must NOT auto-absorb.
 *   - persona-append with NO durability_recommendation must NOT auto-absorb.
 *   - Error during apply → pending('error'), not a throw.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { autoAbsorbRetroProposals } from "../auto-absorb-retro-proposals.js";
import type { RetroProposal } from "../../schemas/retro-proposal.js";
import type { gitCommit as gitCommitType } from "../../lib/git.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ISO_A = "2026-06-15T10:00:00.000Z";

const ULID_A = "01KV2Z000000000000000000AA";
const ULID_B = "01KV2Z000000000000000000BB";
const ULID_C = "01KV2Z000000000000000000CC";

const FIXED_NOW = new Date("2026-06-15T12:00:00.000Z");
const ROLE = "generalist-dev";

// ---------------------------------------------------------------------------
// Fixture: minimal persona file
// ---------------------------------------------------------------------------

const FIXTURE_PERSONA_MD = `---
role: generalist-dev
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
gh_allow:
  - pr-create
  - pr-view
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Dev

## Domain

Implements one story at a time end-to-end.

## Mandate

- Claim a story from the ready queue.

## Out of mandate

- Reviewing the PR.

## Prompt

You are the generalist dev.

## Knowledge

`;

// ---------------------------------------------------------------------------
// Helpers: proposal factories
// ---------------------------------------------------------------------------

/**
 * Build a note-tier persona-append proposal (eligible for auto-absorb).
 */
function notePersonaAppend(
  id: string,
  lesson = "Always emit the handoff phrase on a line by itself.",
  role = ROLE,
): RetroProposal {
  return {
    type: "persona-append",
    id,
    created_at: ISO_A,
    rationale: "Repeated handoff-grammar failures.",
    target_role: role,
    lesson,
    durability_recommendation: {
      recommendation: "note",
      reason: "First occurrence — note tier is appropriate.",
    },
  } as RetroProposal;
}

/**
 * Build a skill-tier persona-append proposal (NOT eligible for auto-absorb).
 */
function skillPersonaAppend(id: string): RetroProposal {
  return {
    type: "persona-append",
    id,
    created_at: ISO_A,
    rationale: "Repeated across 3+ stories — skill tier.",
    target_role: ROLE,
    lesson: "Use runDevTerminalAction, never gh pr create.",
    durability_recommendation: {
      recommendation: "skill",
      reason: "Recurring across 3+ stories — should be a skill.",
    },
  } as RetroProposal;
}

/**
 * Build a rule proposal with note durability (NOT eligible — wrong type).
 */
function noteRuleProposal(id: string): RetroProposal {
  return {
    type: "rule",
    id,
    created_at: ISO_A,
    rationale: "Repeated failure — rule needed.",
    text: "Always check CI before merging.",
    target_failure_class: "ci-merge-skip",
    recommended_promotion_level: "must",
  } as RetroProposal;
}

/**
 * Build a persona-append proposal WITHOUT a durability_recommendation.
 */
function noDurabilityPersonaAppend(id: string): RetroProposal {
  return {
    type: "persona-append",
    id,
    created_at: ISO_A,
    rationale: "One-off lesson, no routing context.",
    target_role: ROLE,
    lesson: "Check the manifest before claiming.",
  } as RetroProposal;
}

// ---------------------------------------------------------------------------
// Fake gitCommit seam
// ---------------------------------------------------------------------------

type GitCommitArgs = Parameters<typeof gitCommitType>[0];

function makeFakeGitCommit(sha = "auto0000000000000000000000000000000000ab") {
  const calls: GitCommitArgs[] = [];
  const impl = (async (args: GitCommitArgs) => {
    calls.push(args);
    return { commitSha: sha, stdout: "", stderr: "" };
  }) as unknown as typeof gitCommitType;
  return { impl, calls };
}

/**
 * A fake filterGitIgnoredPaths that returns ALL paths as tracked (nothing ignored).
 * Mirrors the pattern used in accept-proposal.test.ts.
 */
const fakeFilterGitIgnoredPaths = async (opts: {
  targetRepoRoot: string;
  paths: readonly string[];
}): Promise<string[]> => {
  return [...opts.paths];
};

// ---------------------------------------------------------------------------
// tmpdir lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "auto-absorb-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

// ---------------------------------------------------------------------------
// Helper: seed a persona file + a retro proposal file
// ---------------------------------------------------------------------------

async function seedPersona(
  root: string,
  role: string,
  content = FIXTURE_PERSONA_MD,
): Promise<void> {
  const dir = path.join(root, "team", role);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "PERSONA.md"), content);
}

/**
 * Write a retro proposal file and return its proposals.
 */
async function seedProposals(
  root: string,
  isoTimestamp: string,
  proposals: RetroProposal[],
): Promise<RetroProposal[]> {
  await writeRetroProposal({
    targetRepoRoot: root,
    isoTimestamp,
    proposals,
  });
  return proposals;
}

// ---------------------------------------------------------------------------
// AC1 — integration: note-tier absorbed, higher-stakes left pending
// ---------------------------------------------------------------------------

describe("autoAbsorbRetroProposals — AC1 integration: note absorbed, higher-stakes pending", () => {
  it("absorbs the note-tier persona-append and leaves the skill-tier pending", async () => {
    await seedPersona(tmpRoot, ROLE);

    const noteProposal = notePersonaAppend(ULID_A, "Always emit the handoff phrase.");
    const skillProposal = skillPersonaAppend(ULID_B);
    await seedProposals(tmpRoot, ISO_A, [noteProposal, skillProposal]);

    const git = makeFakeGitCommit();
    const logs: string[] = [];

    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [noteProposal, skillProposal],
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
      log: (msg) => logs.push(msg),
    });

    // Note-tier was absorbed.
    expect(result.absorbed).toHaveLength(1);
    expect(result.absorbed[0]!.proposalId).toBe(ULID_A);

    // Skill-tier stayed pending.
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.proposalId).toBe(ULID_B);
    expect(result.pending[0]!.reason).toBe("not-note-tier");

    // One commit was made for the absorbed lesson.
    expect(git.calls).toHaveLength(1);
  });

  it("absorbs nothing and leaves ALL pending when no proposals pass the gate", async () => {
    const skillProposal = skillPersonaAppend(ULID_A);
    const ruleProposal = noteRuleProposal(ULID_B);
    await seedProposals(tmpRoot, ISO_A, [skillProposal, ruleProposal]);

    const git = makeFakeGitCommit();

    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [skillProposal, ruleProposal],
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.absorbed).toHaveLength(0);
    expect(result.pending).toHaveLength(2);
    expect(git.calls).toHaveLength(0);
  });

  it("leaves persona-append with no durability_recommendation pending (safety boundary)", async () => {
    await seedPersona(tmpRoot, ROLE);

    const noDurabilityProposal = noDurabilityPersonaAppend(ULID_A);
    await seedProposals(tmpRoot, ISO_A, [noDurabilityProposal]);

    const git = makeFakeGitCommit();

    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [noDurabilityProposal],
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    // No durability_recommendation → should not auto-absorb.
    expect(result.absorbed).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.reason).toBe("no-durability-recommendation");
    expect(git.calls).toHaveLength(0);
  });

  it("leaves a rule proposal with note durability pending (wrong type — safety boundary)", async () => {
    const ruleProposal = noteRuleProposal(ULID_A);
    await seedProposals(tmpRoot, ISO_A, [ruleProposal]);

    const git = makeFakeGitCommit();

    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [ruleProposal],
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    // Rule type → not-note-tier (wrong type, even if it had note durability it
    // would still fail the type check).
    expect(result.absorbed).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.reason).toBe("not-note-tier");
    expect(git.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — ceiling respected: overflow stays pending
// ---------------------------------------------------------------------------

describe("autoAbsorbRetroProposals — AC2: per-run ceiling respected", () => {
  it("absorbs exactly maxAutoAbsorb note-tier proposals; the rest are 'ceiling-reached'", async () => {
    await seedPersona(tmpRoot, ROLE);

    const proposals = [
      notePersonaAppend(ULID_A, "Lesson A"),
      notePersonaAppend(ULID_B, "Lesson B"),
      notePersonaAppend(ULID_C, "Lesson C"),
    ];
    await seedProposals(tmpRoot, ISO_A, proposals);

    const git = makeFakeGitCommit();

    // Cap at 2 — third proposal is within the note tier but over the ceiling.
    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals,
      maxAutoAbsorb: 2,
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.absorbed).toHaveLength(2);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.reason).toBe("ceiling-reached");

    // Only 2 commits were made.
    expect(git.calls).toHaveLength(2);
  });

  it("absorbs zero when maxAutoAbsorb is 0", async () => {
    await seedPersona(tmpRoot, ROLE);

    const proposal = notePersonaAppend(ULID_A, "Lesson A");
    await seedProposals(tmpRoot, ISO_A, [proposal]);

    const git = makeFakeGitCommit();

    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [proposal],
      maxAutoAbsorb: 0,
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.absorbed).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.reason).toBe("ceiling-reached");
    expect(git.calls).toHaveLength(0);
  });

  it("does not count non-note-tier proposals against the ceiling", async () => {
    await seedPersona(tmpRoot, ROLE);

    const proposals = [
      skillPersonaAppend(ULID_A), // skipped — skill tier
      notePersonaAppend(ULID_B, "Lesson B"), // absorbed
      notePersonaAppend(ULID_C, "Lesson C"), // absorbed
    ];
    await seedProposals(tmpRoot, ISO_A, proposals);

    const git = makeFakeGitCommit();

    // With ceiling 2, both note-tier proposals should be absorbed even though
    // there was a non-note proposal first.
    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals,
      maxAutoAbsorb: 2,
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.absorbed).toHaveLength(2);
    expect(result.pending).toHaveLength(1); // skill-tier only
    expect(result.pending[0]!.reason).toBe("not-note-tier");
    expect(git.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC3 — fail-soft: error does not throw; lesson stays pending
// ---------------------------------------------------------------------------

describe("autoAbsorbRetroProposals — AC3: fail-soft on error", () => {
  it("does not throw when the persona file is missing; leaves the proposal pending with reason 'error'", async () => {
    // Do NOT seed a persona file — the apply will throw PersonaFileNotFoundError.
    const proposal = notePersonaAppend(ULID_A, "Lesson that will fail.");
    await seedProposals(tmpRoot, ISO_A, [proposal]);

    const git = makeFakeGitCommit();
    const logs: string[] = [];

    // Must NOT throw.
    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [proposal],
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
      log: (msg) => logs.push(msg),
    });

    // No absorption.
    expect(result.absorbed).toHaveLength(0);
    // Left pending with reason 'error'.
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.reason).toBe("error");
    expect(result.pending[0]!.errorMessage).toBeTruthy();

    // No commit.
    expect(git.calls).toHaveLength(0);

    // Error was logged.
    expect(logs.some((l) => l.includes(ULID_A))).toBe(true);
  });

  it("continues processing subsequent proposals after one errors", async () => {
    // Only seed a persona for the SECOND role.
    const ROLE_B = "generalist-reviewer";
    await seedPersona(tmpRoot, ROLE_B);

    const failingProposal = notePersonaAppend(ULID_A, "Will fail — no persona.", ROLE);
    const successProposal = notePersonaAppend(ULID_B, "Will succeed.", ROLE_B);
    await seedProposals(tmpRoot, ISO_A, [failingProposal, successProposal]);

    const git = makeFakeGitCommit();
    const logs: string[] = [];

    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [failingProposal, successProposal],
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
      log: (msg) => logs.push(msg),
    });

    // Second proposal succeeded even though the first errored.
    expect(result.absorbed).toHaveLength(1);
    expect(result.absorbed[0]!.proposalId).toBe(ULID_B);

    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.proposalId).toBe(ULID_A);
    expect(result.pending[0]!.reason).toBe("error");

    // One commit for the successful second proposal.
    expect(git.calls).toHaveLength(1);
  });

  it("does not affect other proposals when gitCommit throws on one", async () => {
    await seedPersona(tmpRoot, ROLE);

    const proposals = [
      notePersonaAppend(ULID_A, "Lesson A — git will fail."),
      notePersonaAppend(ULID_B, "Lesson B — will succeed."),
    ];
    await seedProposals(tmpRoot, ISO_A, proposals);

    let callCount = 0;
    const failingGitCommit = (async (_args: GitCommitArgs) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("simulated git commit failure");
      }
      return { commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", stdout: "", stderr: "" };
    }) as unknown as typeof gitCommitType;

    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals,
      gitCommitImpl: failingGitCommit,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    // First errored, second succeeded.
    expect(result.absorbed).toHaveLength(1);
    expect(result.absorbed[0]!.proposalId).toBe(ULID_B);

    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.proposalId).toBe(ULID_A);
    expect(result.pending[0]!.reason).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// AC4 — auto-absorbed commits carry a distinct 'auto-absorbed' marker
// ---------------------------------------------------------------------------

describe("autoAbsorbRetroProposals — AC4: distinct commit message marker", () => {
  it("commit message uses 'auto-absorbed: <id>' not 'accept-proposal: <id>'", async () => {
    await seedPersona(tmpRoot, ROLE);

    const proposal = notePersonaAppend(ULID_A, "Commit message test lesson.");
    await seedProposals(tmpRoot, ISO_A, [proposal]);

    const git = makeFakeGitCommit();

    await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [proposal],
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(git.calls).toHaveLength(1);
    const commitMessage = git.calls[0]!.message;

    // Must contain the auto-absorbed marker with the proposal id.
    expect(commitMessage).toContain(`auto-absorbed: ${ULID_A}`);
    // Must NOT look like an operator-accepted commit.
    expect(commitMessage).not.toContain("accept-proposal:");
  });

  it("the absorbed result carries the commit sha returned by gitCommit", async () => {
    await seedPersona(tmpRoot, ROLE);

    const EXPECTED_SHA = "deadbeefcafe1234000000000000000000000000";
    const proposal = notePersonaAppend(ULID_A, "Sha test lesson.");
    await seedProposals(tmpRoot, ISO_A, [proposal]);

    const git = makeFakeGitCommit(EXPECTED_SHA);

    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [proposal],
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.absorbed).toHaveLength(1);
    expect(result.absorbed[0]!.commitSha).toBe(EXPECTED_SHA);
  });

  it("already-applied proposals are skipped without a commit", async () => {
    await seedPersona(tmpRoot, ROLE);

    // Build an already-applied proposal (with an applied block stamped).
    const alreadyApplied: RetroProposal = {
      ...notePersonaAppend(ULID_A, "Already applied."),
      applied: {
        applied_at: ISO_A,
        applied_sha: "previoussha000000000000000000000000000000",
        idempotency_key: ULID_A,
      },
    } as RetroProposal;
    await seedProposals(tmpRoot, ISO_A, [alreadyApplied]);

    const git = makeFakeGitCommit();

    const result = await autoAbsorbRetroProposals({
      targetRepoRoot: tmpRoot,
      proposals: [alreadyApplied],
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: fakeFilterGitIgnoredPaths,
      now: () => FIXED_NOW,
    });

    expect(result.absorbed).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.reason).toBe("already-applied");
    expect(git.calls).toHaveLength(0);
  });
});
