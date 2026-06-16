/**
 * Tests for the cross-role shared lesson signal and shared-skill-promotion
 * proposal — Story native:01KV7FJHK9CAAS860MJAG70QVS.
 *
 * AC1 (integration): Given a team where the same lesson appears in two or more
 *   roles' knowledge, When the retrospective runs over that cycle, Then it
 *   produces a recommendation to promote that lesson into a shared skill, and
 *   the recommendation names the roles that share it.
 *
 * AC2 (integration): Given a team where no lesson is shared across two or more
 *   roles, When the retrospective runs, Then no shared-skill promotion
 *   recommendation appears.
 *
 * AC3 (unit): Given the same shared lesson, When the recommendation is
 *   produced, Then the operator must still approve it through the usual
 *   review-and-confirm step before anything is promoted, because the
 *   retrospective only recommends and never promotes on its own.
 *
 * All tests use real tool implementations against a temp filesystem — no mocks
 * of the things under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { gatherRetroInputs } from "../gather-retro-inputs.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import {
  parseRetroProposalFile,
  RETRO_PROPOSAL_TYPES,
} from "../../schemas/retro-proposal.js";
import { LESSON_BLOCK_PREFIX, LESSON_BLOCK_SUFFIX } from "../../lib/lesson-archive.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ISO = "2026-06-16T10:00:00.000Z";
const ULID_A = "01KV7FJHTEST00000000000001";
const ULID_B = "01KV7FJHTEST00000000000002";
const DEV_ROLE = "generalist-dev";
const REVIEWER_ROLE = "generalist-reviewer";
const PLANNER_ROLE = "generalist-planner";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a structured lesson block for embedding in a PERSONA.md Knowledge section. */
function makeLessonBlock(opts: {
  id: string;
  kind?: string;
  applies_when: string;
  detail: string;
  use_count?: number;
}): string {
  const obj: Record<string, unknown> = {
    id: opts.id,
    kind: opts.kind ?? "pattern",
    applies_when: opts.applies_when,
    detail: opts.detail,
    learned_at: "2026-05-01T00:00:00.000Z",
  };
  if (opts.use_count !== undefined) obj["use_count"] = opts.use_count;
  return `${LESSON_BLOCK_PREFIX}${JSON.stringify(obj)}${LESSON_BLOCK_SUFFIX}`;
}

/** A minimal well-formed persona file body for a given role. */
function fixturePersona(role: string, knowledgeBody: string = ""): string {
  const h1 = role
    .split("-")
    .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ");
  return `---
role: ${role}
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
gh_allow:
  - pr-view
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# ${h1}

## Domain

Implements one story at a time end-to-end.

## Mandate

- Claim a story, work it, open a PR.

## Out of mandate

- Reviewing the PR.

## Prompt

You are the ${role}.

## Knowledge

${knowledgeBody}
`;
}

async function seedPersona(
  root: string,
  role: string,
  knowledgeBody: string = "",
): Promise<void> {
  const dir = path.join(root, "team", role);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(
    path.join(dir, "PERSONA.md"),
    fixturePersona(role, knowledgeBody),
  );
}

// ---------------------------------------------------------------------------
// AC1 — Integration: shared lesson across roles produces crossRoleSharedLessons
// ---------------------------------------------------------------------------

describe("AC1 — gatherRetroInputs surfaces crossRoleSharedLessons when a lesson is shared across roles", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "retro-cross-role-ac1-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("detects a lesson shared between two roles and names both roles", async () => {
    // Both roles have essentially the same lesson about always running git fetch before rebasing.
    const sharedLesson = makeLessonBlock({
      id: "01KV7FJH0000000000000000L1",
      kind: "discipline",
      applies_when: "before rebasing a story branch",
      detail: "always run git fetch to get the latest upstream before rebasing to avoid stale base",
    });

    await seedPersona(tmpRoot, DEV_ROLE, sharedLesson);
    await seedPersona(tmpRoot, REVIEWER_ROLE, sharedLesson);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // The crossRoleSharedLessons signal must be non-empty.
    expect(bundle.crossRoleSharedLessons.length).toBeGreaterThanOrEqual(1);

    // The entry must name both roles.
    const entry = bundle.crossRoleSharedLessons[0]!;
    expect(entry.roles).toContain(DEV_ROLE);
    expect(entry.roles).toContain(REVIEWER_ROLE);

    // The entry carries a lesson_text.
    expect(entry.lesson_text.length).toBeGreaterThan(0);

    // The similarity must be above 0 (the lessons are the same).
    expect(entry.similarity).toBeGreaterThan(0);
  });

  it("names all roles when three or more roles share the same lesson", async () => {
    const sharedLesson = makeLessonBlock({
      id: "01KV7FJH0000000000000000L2",
      kind: "pattern",
      applies_when: "when building the dist folder after src changes",
      detail: "always rebuild the dist folder after src changes and commit both together so CI does not drift",
    });

    await seedPersona(tmpRoot, DEV_ROLE, sharedLesson);
    await seedPersona(tmpRoot, REVIEWER_ROLE, sharedLesson);
    await seedPersona(tmpRoot, PLANNER_ROLE, sharedLesson);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.crossRoleSharedLessons.length).toBeGreaterThanOrEqual(1);

    // All three roles must be named somewhere in the shared lessons.
    const allRoles = bundle.crossRoleSharedLessons.flatMap((e) => e.roles);
    expect(allRoles).toContain(DEV_ROLE);
    expect(allRoles).toContain(REVIEWER_ROLE);
    expect(allRoles).toContain(PLANNER_ROLE);
  });

  it("a shared-skill-promotion proposal validates and round-trips through writeRetroProposal", async () => {
    // AC1 end-to-end: the signal is gathered → a proposal can be drafted → it
    // validates and is written to the proposal file → the frontmatter round-trips.
    const sharedLesson = makeLessonBlock({
      id: "01KV7FJH0000000000000000L3",
      kind: "discipline",
      applies_when: "when opening a PR",
      detail: "always verify CI is green before requesting review to avoid blocking the reviewer on a red build",
    });

    await seedPersona(tmpRoot, DEV_ROLE, sharedLesson);
    await seedPersona(tmpRoot, REVIEWER_ROLE, sharedLesson);

    // The bundle must surface the shared lesson.
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.crossRoleSharedLessons.length).toBeGreaterThanOrEqual(1);

    const entry = bundle.crossRoleSharedLessons[0]!;

    // Draft a shared-skill-promotion proposal from the bundle signal.
    const { absPath, proposalCount } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "shared-skill-promotion",
          id: ULID_A,
          created_at: ISO,
          rationale:
            `Both '${entry.roles.join("' and '")}' carry the same lesson about verifying CI before requesting review (similarity ${entry.similarity.toFixed(2)}). Promoting this into a shared skill would remove the duplication and ensure all roles reference one authoritative source.`,
          sharing_roles: entry.roles,
          shared_lesson_text: entry.lesson_text,
          representative_lesson_id: entry.lesson_id,
          proposed_skill_path: ".flow/skills/verify-ci-before-review.md",
          skill_description: "Always verify CI is green before requesting review.",
        },
      ],
    });

    expect(proposalCount).toBe(1);

    // Round-trip: parse the frontmatter back.
    const raw = await fs.readFile(absPath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    expect(fmMatch).not.toBeNull();
    const { parse: yamlParse } = await import("yaml");
    const reparsed = parseRetroProposalFile(yamlParse(fmMatch![1]!));

    expect(reparsed.proposals).toHaveLength(1);
    const proposal = reparsed.proposals[0]!;
    expect(proposal.type).toBe("shared-skill-promotion");
    if (proposal.type === "shared-skill-promotion") {
      expect(proposal.sharing_roles).toContain(DEV_ROLE);
      expect(proposal.sharing_roles).toContain(REVIEWER_ROLE);
      expect(proposal.proposed_skill_path).toBe(".flow/skills/verify-ci-before-review.md");
      expect(proposal.skill_description).toMatch(/CI.*green.*review|review.*CI.*green/i);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — Integration: no shared lesson → no crossRoleSharedLessons entries
// ---------------------------------------------------------------------------

describe("AC2 — gatherRetroInputs returns empty crossRoleSharedLessons when no lesson is shared across roles", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "retro-cross-role-ac2-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns empty array when no roles are hired", async () => {
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.crossRoleSharedLessons).toHaveLength(0);
  });

  it("returns empty array when only one role is hired", async () => {
    const lesson = makeLessonBlock({
      id: "01KV7FJH0000000000000000L4",
      kind: "pattern",
      applies_when: "when writing tests",
      detail: "always run the tests locally before opening a PR",
    });
    await seedPersona(tmpRoot, DEV_ROLE, lesson);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.crossRoleSharedLessons).toHaveLength(0);
  });

  it("returns empty array when two roles have entirely different lessons", async () => {
    // Dev has a lesson about git operations; reviewer has a completely
    // different lesson about checking CI status — no overlap in vocabulary.
    const devLesson = makeLessonBlock({
      id: "01KV7FJH0000000000000000L5",
      kind: "tool-quirk",
      applies_when: "when cherry-picking commits",
      detail: "git cherry-pick -x appends the source commit hash to the message — use this when porting hotfixes",
    });
    const reviewerLesson = makeLessonBlock({
      id: "01KV7FJH0000000000000000L6",
      kind: "discipline",
      applies_when: "when writing acceptance criteria",
      detail: "acceptance criteria must each have a verification type tag — vitest or integration — to be executable",
    });

    await seedPersona(tmpRoot, DEV_ROLE, devLesson);
    await seedPersona(tmpRoot, REVIEWER_ROLE, reviewerLesson);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.crossRoleSharedLessons).toHaveLength(0);
  });

  it("returns empty array when roles have no lessons at all (empty Knowledge)", async () => {
    await seedPersona(tmpRoot, DEV_ROLE, "");
    await seedPersona(tmpRoot, REVIEWER_ROLE, "");

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.crossRoleSharedLessons).toHaveLength(0);
  });

  it("within-role near-duplicates do not contribute to crossRoleSharedLessons", async () => {
    // Two very similar lessons in the SAME role — should produce nearDuplicateLessonPairs,
    // but NOT crossRoleSharedLessons (the second role has a completely different lesson).
    const devLesson1 = makeLessonBlock({
      id: "01KV7FJH0000000000000000L7",
      kind: "pattern",
      applies_when: "before rebasing",
      detail: "run git fetch before rebasing to update the upstream refs",
    });
    const devLesson2 = makeLessonBlock({
      id: "01KV7FJH0000000000000000L8",
      kind: "pattern",
      applies_when: "before doing a git rebase",
      detail: "always fetch origin before rebasing so upstream refs are current",
    });
    const reviewerLesson = makeLessonBlock({
      id: "01KV7FJH0000000000000000L9",
      kind: "discipline",
      applies_when: "when reviewing a PR",
      detail: "the reviewer must verify acceptance criteria are met before approving",
    });

    await seedPersona(tmpRoot, DEV_ROLE, `${devLesson1}\n${devLesson2}`);
    await seedPersona(tmpRoot, REVIEWER_ROLE, reviewerLesson);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // The within-role near-duplicates may surface in nearDuplicateLessonPairs
    // but the cross-role signal must remain empty (reviewer lesson is different).
    expect(bundle.crossRoleSharedLessons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Unit: shared-skill-promotion is a proposal-only, no auto-apply handler
// ---------------------------------------------------------------------------

describe("AC3 — shared-skill-promotion is recommendation-only, never auto-applied", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "retro-cross-role-ac3-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("shared-skill-promotion is in RETRO_PROPOSAL_TYPES", () => {
    expect(RETRO_PROPOSAL_TYPES).toContain("shared-skill-promotion");
    expect(RETRO_PROPOSAL_TYPES).toHaveLength(13);
  });

  it("a shared-skill-promotion proposal writes successfully and survives a round-trip parse", async () => {
    // This confirms the proposal is written correctly and the operator CAN read
    // it back — the first step of the review-and-confirm path.
    const { absPath, proposalCount } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "shared-skill-promotion",
          id: ULID_B,
          created_at: ISO,
          rationale:
            "Both generalist-dev and generalist-reviewer independently documented that dist must be rebuilt after src changes. Moving this into a shared skill would give both roles a single authoritative reference.",
          sharing_roles: [DEV_ROLE, REVIEWER_ROLE],
          shared_lesson_text: "rebuild dist after src changes: always rebuild dist after src changes and commit both together",
          representative_lesson_id: "01KV7FJH0000000000000000LA",
          proposed_skill_path: ".flow/skills/rebuild-dist-after-src-change.md",
          skill_description: "Rebuild the dist folder after any src change and commit both in the same commit.",
        },
      ],
    });

    expect(proposalCount).toBe(1);

    // Verify the proposal file was written (the file exists).
    await expect(fs.access(absPath)).resolves.not.toThrow();

    // Round-trip: re-parse the frontmatter.
    const raw = await fs.readFile(absPath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    expect(fmMatch).not.toBeNull();
    const { parse: yamlParse } = await import("yaml");
    const reparsed = parseRetroProposalFile(yamlParse(fmMatch![1]!));

    expect(reparsed.proposals).toHaveLength(1);
    const proposal = reparsed.proposals[0]!;
    expect(proposal.type).toBe("shared-skill-promotion");

    // The proposal carries all required fields.
    if (proposal.type === "shared-skill-promotion") {
      expect(proposal.sharing_roles).toHaveLength(2);
      expect(proposal.sharing_roles).toContain(DEV_ROLE);
      expect(proposal.sharing_roles).toContain(REVIEWER_ROLE);
      expect(proposal.shared_lesson_text).toContain("dist");
      expect(proposal.proposed_skill_path).toBe(".flow/skills/rebuild-dist-after-src-change.md");
    }
  });

  it("the proposal schema rejects a shared-skill-promotion with fewer than two sharing_roles", async () => {
    // The schema enforces sharing_roles.min(2) — one role is not a cross-role signal.
    const { RetroProposalSchema } = await import("../../schemas/retro-proposal.js");
    const result = RetroProposalSchema.safeParse({
      type: "shared-skill-promotion",
      id: ULID_A,
      created_at: ISO,
      rationale: "Only one role shares this lesson.",
      sharing_roles: [DEV_ROLE], // Only one role — should be rejected.
      shared_lesson_text: "some lesson text",
      representative_lesson_id: "01KV7FJH0000000000000000LB",
      proposed_skill_path: ".flow/skills/some-skill.md",
      skill_description: "Some skill description.",
    });
    expect(result.success).toBe(false);
  });

  it("the proposal schema rejects a shared-skill-promotion with an empty shared_lesson_text", async () => {
    const { RetroProposalSchema } = await import("../../schemas/retro-proposal.js");
    const result = RetroProposalSchema.safeParse({
      type: "shared-skill-promotion",
      id: ULID_A,
      created_at: ISO,
      rationale: "Valid rationale.",
      sharing_roles: [DEV_ROLE, REVIEWER_ROLE],
      shared_lesson_text: "", // Empty — should be rejected.
      representative_lesson_id: "01KV7FJH0000000000000000LC",
      proposed_skill_path: ".flow/skills/some-skill.md",
      skill_description: "Some skill.",
    });
    expect(result.success).toBe(false);
  });

  it("the proposal schema rejects a shared-skill-promotion with an absolute proposed_skill_path", async () => {
    // Path-traversal guard: absolute paths must be rejected.
    const { RetroProposalSchema } = await import("../../schemas/retro-proposal.js");
    const result = RetroProposalSchema.safeParse({
      type: "shared-skill-promotion",
      id: ULID_A,
      created_at: ISO,
      rationale: "Valid rationale.",
      sharing_roles: [DEV_ROLE, REVIEWER_ROLE],
      shared_lesson_text: "some lesson text",
      representative_lesson_id: "01KV7FJH0000000000000000LD",
      proposed_skill_path: "/absolute/path/to/skill.md", // Absolute — rejected.
      skill_description: "Some skill.",
    });
    expect(result.success).toBe(false);
  });

  it("the retro-analyst catalogue prompt carries the cross-role shared lesson discipline (STRICT)", async () => {
    const { getPluginRoot } = await import("../../lib/plugin-root.js");
    const { readCatalogue } = await import("../read-catalogue.js");
    const role = await readCatalogue({
      pluginRoot: getPluginRoot(),
      role: "retro-analyst",
    });

    // The catalogue must mention the new signal and proposal type.
    expect(role.sections.Prompt).toContain("crossRoleSharedLessons");
    expect(role.sections.Prompt).toContain("shared-skill-promotion");
    expect(role.sections.Prompt).toContain("STRICT");

    // The Mandate section must also reference the signal and the proposal type.
    expect(role.sections.Mandate).toContain("crossRoleSharedLessons");
    expect(role.sections.Mandate).toContain("shared-skill-promotion");

    // The discipline must instruct the analyst NOT to re-scan persona files.
    expect(role.sections.Prompt).toMatch(/NEVER re-scan persona files|consume.*crossRoleSharedLessons/i);

    // The discipline must state this is recommendation-only (never promotes on its own).
    expect(role.sections.Prompt).toMatch(/recommendation.only|never promotes|operator.*approve/i);
  });
});
