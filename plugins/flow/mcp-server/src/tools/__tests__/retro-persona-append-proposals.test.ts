/**
 * Tests for the retro-analyst's persona-append proposal drafting —
 * Story native:01KT47PSWEBAX6QZB8SR8HDYBQ.
 *
 * This story makes the retro-analyst emit `persona-append` proposals that
 * write a role-attributable lesson into a hired role's Knowledge section,
 * drawn from the cycle's done-manifest lessons and recurring friction. The
 * persona-append schema + apply handler + registry were introduced by the
 * dependency story (native:01KT474NN9F3HWM6HVR07PHZD7); this story's job is
 * the analyst-side: the catalogue prompt discipline plus the deterministic
 * write/round-trip contract those proposals flow through.
 *
 * The acceptance criteria are about the LLM analyst's behaviour, but the
 * load-bearing seam is deterministic (memory `feedback_default_to_deterministic_seams`,
 * `project_reviewer_first_call_enforcement_needed`): a prose-only mandate gets
 * skipped under load, so what makes the behaviour binding is (a) the STRICT
 * discipline section in the catalogue prompt, (b) the `getTeamSnapshot` tool
 * wired into the analyst's allowlist so it can resolve roles, and (c) the
 * `writeRetroProposal` + schema boundary that refuses a malformed or empty-lesson
 * persona-append. These tests pin all three with no LLM invocation.
 *
 * AC1 (integration): Given a cycle with at least one done manifest carrying a
 *   per-role lesson (or a non-empty recurringFriction signal), the produced
 *   proposal file can carry at least one persona-append proposal naming a
 *   specific hired role and a concise lesson drawn from that cycle's data — and
 *   the prompt instructs the analyst to draft exactly that.
 *
 * AC2 (unit): Given a cycle with no per-role lesson signal and no recurring
 *   friction, the proposal file contains zero persona-append proposals — the
 *   prompt instructs the analyst to skip drafting, and an empty proposals file
 *   round-trips cleanly.
 *
 * AC3 (unit): Given a persona-append proposal in the produced file, it names a
 *   real hired role (its persona file exists in the team directory, confirmed
 *   via getTeamSnapshot) and the lesson text is grounded in the cycle's data —
 *   not a generic placeholder.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { gatherRetroInputs, lessonSimilarity } from "../gather-retro-inputs.js";
import { getTeamSnapshot } from "../get-team-snapshot.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { readCatalogue } from "../read-catalogue.js";
import { loadRolePermissions } from "../../state/load-role-permissions.js";
import {
  parseRetroProposalFile,
  RETRO_PROPOSAL_TYPES,
} from "../../schemas/retro-proposal.js";
import { makeLessonConsolidationHandler } from "../../lib/apply-lesson-consolidation.js";
import { LESSON_BLOCK_PREFIX, LESSON_BLOCK_SUFFIX } from "../../lib/lesson-archive.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ISO = "2026-06-03T12:00:00.000Z";
const ULID_A = "01HZRETR0000000000000000A1";
const ULID_B = "01HZRETR0000000000000000B2";
const DEV_ROLE = "generalist-dev";
const REVIEWER_ROLE = "generalist-reviewer";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal well-formed persona file body for a given role. */
function fixturePersona(role: string): string {
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

`;
}

/** Build a minimal valid done/ manifest, layering in retro lessons. */
function buildDoneManifest(
  ref: string,
  retro: { lessons?: unknown[] } = {},
): Record<string, unknown> {
  return {
    ref,
    status: "done",
    adapter: "native",
    source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "an AC", kind: "unit" }],
    title: `Story ${ref}`,
    narrative: "As a user, I want X, so that Y.",
    withdrawn: false,
    claimed_by: "01KSRP1Y9J9R9F5SKB7QXQ83ZK",
    ...retro,
  };
}

async function writeYaml(absPath: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, yamlStringify(obj), "utf8");
}

async function seedPersona(root: string, role: string): Promise<void> {
  const dir = path.join(root, "team", role);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "PERSONA.md"), fixturePersona(role));
}

// ---------------------------------------------------------------------------
// The catalogue prompt carries the persona-append drafting discipline +
// the analyst can resolve roles. This is the load-bearing seam that makes
// the AC behaviour binding (memory project_reviewer_first_call_enforcement_needed).
// ---------------------------------------------------------------------------

describe("retro-analyst prompt — persona-append drafting discipline (AC1/AC2/AC3)", () => {
  it("instructs the analyst to draft persona-append proposals from per-role lessons and recurring friction (AC1)", async () => {
    const { getPluginRoot } = await import("../../lib/plugin-root.js");
    const role = await readCatalogue({
      pluginRoot: getPluginRoot(),
      role: "retro-analyst",
    });
    const prompt = role.sections.Prompt;

    // A dedicated STRICT discipline section, peer to the fire-count and
    // recurring-friction disciplines.
    expect(prompt).toContain("Persona-append discipline");
    expect(prompt).toContain("STRICT");
    // It must tell the analyst to draw from the done-manifest lessons and
    // the recurring-friction signal — not to recount.
    expect(prompt).toContain("lessons[]");
    expect(prompt).toContain("recurringFriction");
    expect(prompt).toContain("persona-append");
    // It must reference the two proposal fields the analyst sets.
    expect(prompt).toContain("target_role");
    expect(prompt).toContain("lesson");
  });

  it("instructs the analyst to skip persona-append drafting on an empty-signal cycle (AC2)", async () => {
    const { getPluginRoot } = await import("../../lib/plugin-root.js");
    const role = await readCatalogue({
      pluginRoot: getPluginRoot(),
      role: "retro-analyst",
    });
    const prompt = role.sections.Prompt;
    // The "skip when no role-attributable signal" instruction must be present.
    expect(prompt).toMatch(/ZERO `persona-append`|skip this entirely|no role-attributable signal/i);
  });

  it("instructs the analyst to confirm the target role is hired before emitting, and fall back otherwise (AC3)", async () => {
    const { getPluginRoot } = await import("../../lib/plugin-root.js");
    const role = await readCatalogue({
      pluginRoot: getPluginRoot(),
      role: "retro-analyst",
    });
    const prompt = role.sections.Prompt;
    // Role-resolution: cross-reference the hired team.
    expect(prompt).toContain("getTeamSnapshot");
    expect(prompt).toMatch(/role-resolution/i);
    // Fall back to a rule / skill-revise proposal when the role is not hired.
    expect(prompt).toMatch(/not hired|not a hired role|does not exist/i);
    expect(prompt).toMatch(/`rule`|`skill-revise`/);
  });

  it("wires getTeamSnapshot into the analyst's catalogue + permission allowlists so it can resolve roles (AC3)", async () => {
    const { getPluginRoot } = await import("../../lib/plugin-root.js");
    const catalogueRole = await readCatalogue({
      pluginRoot: getPluginRoot(),
      role: "retro-analyst",
    });
    const perms = await loadRolePermissions({
      pluginRoot: getPluginRoot(),
      role: "retro-analyst",
    });
    // getTeamSnapshot is a READ tool — confirming a role is hired, not a mutator.
    expect(catalogueRole.tools_allow).toContain("getTeamSnapshot");
    expect(perms.tools_allow).toContain("getTeamSnapshot");
    // The negative-capability posture is preserved: writeRetroProposal stays
    // the ONLY write affordance; no generic file mutators leak in.
    expect(perms.tools_allow).toContain("writeRetroProposal");
    expect(perms.tools_allow).not.toContain("Edit");
    expect(perms.tools_allow).not.toContain("Write");
  });
});

// ---------------------------------------------------------------------------
// AC1 — a cycle with a per-role lesson can produce a grounded persona-append
// proposal that names a hired role; the write + round-trip is deterministic.
// ---------------------------------------------------------------------------

describe("AC1 — grounded persona-append proposal from a cycle's per-role lesson", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-persona-ac1-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("the cycle bundle surfaces a role-attributable lesson the analyst can ground a persona-append in", async () => {
    // Seed a hired role + a done manifest carrying a role-attributable lesson.
    await seedPersona(tmpRoot, DEV_ROLE);
    const doneDir = path.join(tmpRoot, ".flow", "state", "done");
    await writeYaml(
      path.join(doneDir, "native:1.1.yaml"),
      buildDoneManifest("native:1.1", {
        lessons: [
          {
            kind: "tool-quirk",
            text: "git rebase --onto needs an explicit upstream when the branch was cut from a stale base.",
          },
        ],
      }),
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // The lesson is present in the bundle — the analyst has the raw material.
    expect(bundle.doneManifests).toHaveLength(1);
    const lessons = bundle.doneManifests[0]!.lessons ?? [];
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.text).toContain("git rebase --onto");

    // The target role is hired (so a persona-append for it is legitimate).
    const team = await getTeamSnapshot({ targetRepoRoot: tmpRoot });
    expect(team.roles.map((r) => r.role)).toContain(DEV_ROLE);
  });

  it("a grounded persona-append proposal validates and writes to the proposal file", async () => {
    await seedPersona(tmpRoot, DEV_ROLE);

    const lesson =
      "When rebasing a story branch, run `git fetch` then rebase onto the fresh upstream — a stale base silently drops sibling commits.";

    const { absPath, proposalCount } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "persona-append",
          id: ULID_A,
          created_at: ISO,
          rationale:
            "done manifest native:1.1 lessons[] carried a tool-quirk about git rebase --onto; routed to generalist-dev whose domain owns git operations.",
          target_role: DEV_ROLE,
          lesson,
        },
      ],
    });

    expect(proposalCount).toBe(1);

    // Round-trip: the frontmatter is the source of truth — re-parse it.
    const raw = await fs.readFile(absPath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    expect(fmMatch).not.toBeNull();
    const { parse: yamlParse } = await import("yaml");
    const reparsed = parseRetroProposalFile(yamlParse(fmMatch![1]!));

    expect(reparsed.proposals).toHaveLength(1);
    const proposal = reparsed.proposals[0]!;
    expect(proposal.type).toBe("persona-append");
    if (proposal.type === "persona-append") {
      expect(proposal.target_role).toBe(DEV_ROLE);
      expect(proposal.lesson).toBe(lesson);
    }
  });

  it("persona-append is one of the eleven typed proposal variants", () => {
    expect(RETRO_PROPOSAL_TYPES).toContain("persona-append");
    expect(RETRO_PROPOSAL_TYPES).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// AC2 — empty-signal cycle produces zero persona-append proposals.
// ---------------------------------------------------------------------------

describe("AC2 — empty-signal cycle yields zero persona-append proposals", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-persona-ac2-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("the bundle carries no role-attributable lesson and no recurring friction", async () => {
    await seedPersona(tmpRoot, DEV_ROLE);

    // A done manifest with NO lessons, and no friction telemetry at all.
    const doneDir = path.join(tmpRoot, ".flow", "state", "done");
    await writeYaml(
      path.join(doneDir, "native:2.1.yaml"),
      buildDoneManifest("native:2.1"),
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // No lesson signal.
    const allLessons = bundle.doneManifests.flatMap((m) => m.lessons ?? []);
    expect(allLessons).toHaveLength(0);
    // No recurring friction.
    expect(bundle.recurringFriction).toHaveLength(0);
  });

  it("a proposal file with zero persona-append proposals round-trips cleanly", async () => {
    await seedPersona(tmpRoot, DEV_ROLE);

    // The analyst writes an empty proposals array on a no-signal cycle.
    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [],
    });

    const raw = await fs.readFile(absPath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    const { parse: yamlParse } = await import("yaml");
    const reparsed = parseRetroProposalFile(yamlParse(fmMatch![1]!));

    // Zero persona-append proposals — the basis for one was absent.
    const personaAppends = reparsed.proposals.filter(
      (p) => p.type === "persona-append",
    );
    expect(personaAppends).toHaveLength(0);
    expect(reparsed.proposals).toHaveLength(0);
  });

  it("a file that mixes a rule proposal but no persona-append still has zero persona-appends", async () => {
    // A non-empty cycle that yields a rule proposal but NO role-attributable
    // lesson must not smuggle in a persona-append.
    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "rule",
          id: ULID_A,
          created_at: ISO,
          rationale: "fire-count crossed threshold for handwritten-story.",
          text: "Never hand-write stories.",
          target_failure_class: "handwritten-story",
          recommended_promotion_level: "must",
        },
      ],
    });

    const raw = await fs.readFile(absPath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    const { parse: yamlParse } = await import("yaml");
    const reparsed = parseRetroProposalFile(yamlParse(fmMatch![1]!));

    const personaAppends = reparsed.proposals.filter(
      (p) => p.type === "persona-append",
    );
    expect(personaAppends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — a produced persona-append names a real hired role with grounded,
// non-placeholder lesson text.
// ---------------------------------------------------------------------------

describe("AC3 — produced persona-append names a hired role with grounded lesson text", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-persona-ac3-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("the proposal's target_role resolves to a persona file that exists in the team directory", async () => {
    await seedPersona(tmpRoot, DEV_ROLE);
    await seedPersona(tmpRoot, REVIEWER_ROLE);

    const lesson =
      "Verify each AC artifact actually built before approving — do not rubber-stamp READY FOR MERGE.";

    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "persona-append",
          id: ULID_B,
          created_at: ISO,
          rationale:
            "done manifest native:3.1 lessons[] carried a pitfall (failure_class reviewer-skips-artifact-check); routed to generalist-reviewer.",
          target_role: REVIEWER_ROLE,
          lesson,
        },
      ],
    });

    const raw = await fs.readFile(absPath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    const { parse: yamlParse } = await import("yaml");
    const reparsed = parseRetroProposalFile(yamlParse(fmMatch![1]!));
    const proposal = reparsed.proposals[0]!;
    expect(proposal.type).toBe("persona-append");

    // The named role is a real hired role — getTeamSnapshot lists it and its
    // persona file exists on disk.
    const team = await getTeamSnapshot({ targetRepoRoot: tmpRoot });
    const hiredRoleIds = team.roles.map((r) => r.role);
    if (proposal.type === "persona-append") {
      expect(hiredRoleIds).toContain(proposal.target_role);
      const personaPath = path.join(
        tmpRoot,
        "team",
        proposal.target_role,
        "PERSONA.md",
      );
      await expect(fs.access(personaPath)).resolves.toBeUndefined();

      // The lesson is grounded, not a generic placeholder.
      expect(proposal.lesson.length).toBeGreaterThan(20);
      expect(proposal.lesson.toLowerCase()).not.toContain("placeholder");
      expect(proposal.lesson.toLowerCase()).not.toContain("todo");
      expect(proposal.lesson).toContain("artifact");
    }
  });

  it("the schema refuses a persona-append with an empty (placeholder) lesson", async () => {
    await seedPersona(tmpRoot, DEV_ROLE);

    await expect(
      writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: ISO,
        proposals: [
          {
            type: "persona-append",
            id: ULID_A,
            created_at: ISO,
            rationale: "a rationale",
            target_role: DEV_ROLE,
            lesson: "",
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("the schema refuses a persona-append whose target_role is not a kebab role id", async () => {
    await expect(
      writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: ISO,
        proposals: [
          {
            type: "persona-append",
            id: ULID_A,
            created_at: ISO,
            rationale: "a rationale",
            target_role: "Generalist Dev",
            lesson: "a grounded lesson about something specific in the cycle.",
          },
        ],
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Story native:01KV7FFZ5PJKCW6Z6RVJ71XY6T — near-duplicate lesson consolidation
// ---------------------------------------------------------------------------

/**
 * Build a serialised lesson block for seeding persona Knowledge sections.
 */
function lessonBlock(
  id: string,
  applies_when: string,
  detail: string,
): string {
  const obj = {
    id,
    kind: "pattern",
    applies_when,
    detail,
    learned_at: ISO,
    use_count: 0,
  };
  return `${LESSON_BLOCK_PREFIX}${JSON.stringify(obj)}${LESSON_BLOCK_SUFFIX}`;
}

/**
 * Build a persona with pre-seeded lesson blocks in the Knowledge section.
 */
function fixturePersonaWithLessons(role: string, ...blocks: string[]): string {
  const h1 = role
    .split("-")
    .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ");
  const knowledgeBody = blocks.join("\n");
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

// Lesson id constants for consolidation tests.
// Note: ULIDs use Crockford's base32 — no I, L, O, U characters.
const LESSON_ID_A = "01HZPNSA0000000000000000A1";
const LESSON_ID_B = "01HZPNSA0000000000000000B2";
const LESSON_ID_C = "01HZPNSA0000000000000000C3";
const ULID_CONSOL = "01HZPNSA0000000000000000D4";

// Near-duplicate pair: same point expressed differently.
const NEAR_DUP_TEXT_A =
  "Always run git fetch before rebasing a story branch to avoid using a stale base that drops sibling commits.";
const NEAR_DUP_TEXT_B =
  "Before rebasing, run git fetch so the rebase targets the fresh upstream and avoids dropping sibling commits from a stale base.";

// Distinct lesson that has no overlap with the near-duplicate pair.
const DISTINCT_TEXT_C =
  "Use pnpm build:watch in a separate terminal while developing — it recompiles on save and the CLI picks up changes immediately.";

const MERGED_LESSON =
  "Before rebasing, always run git fetch first — rebasing onto a stale base silently drops sibling commits from the upstream.";

// ---------------------------------------------------------------------------
// lessonSimilarity helper (AC2 unit)
// ---------------------------------------------------------------------------

describe("lessonSimilarity helper (AC2 — distinct lessons score below threshold)", () => {
  it("returns high similarity for two lessons that express the same point", () => {
    const a = {
      id: LESSON_ID_A,
      kind: "pattern",
      applies_when: NEAR_DUP_TEXT_A,
      detail: NEAR_DUP_TEXT_A,
      learned_at: ISO,
    };
    const b = {
      id: LESSON_ID_B,
      kind: "pattern",
      applies_when: NEAR_DUP_TEXT_B,
      detail: NEAR_DUP_TEXT_B,
      learned_at: ISO,
    };
    const sim = lessonSimilarity(a, b);
    // Jaccard similarity on token overlap: these two texts share ~40% tokens,
    // which exceeds the NEAR_DUPLICATE_THRESHOLD of 0.35.
    expect(sim).toBeGreaterThan(0.35);
  });

  it("returns low similarity for lessons that are clearly distinct", () => {
    const a = {
      id: LESSON_ID_A,
      kind: "pattern",
      applies_when: NEAR_DUP_TEXT_A,
      detail: NEAR_DUP_TEXT_A,
      learned_at: ISO,
    };
    const c = {
      id: LESSON_ID_C,
      kind: "pattern",
      applies_when: DISTINCT_TEXT_C,
      detail: DISTINCT_TEXT_C,
      learned_at: ISO,
    };
    const sim = lessonSimilarity(a, c);
    expect(sim).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// AC1 — role with near-duplicate lessons → bundle contains a pair + proposal
// round-trips; applying it replaces both with the merged lesson.
// ---------------------------------------------------------------------------

describe("AC1 — near-duplicate lessons produce a consolidation recommendation whose approval replaces both duplicates", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-consol-ac1-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("gatherRetroInputs surfaces a near-duplicate pair for a role that has two overlapping lessons", async () => {
    const personaContent = fixturePersonaWithLessons(
      DEV_ROLE,
      lessonBlock(LESSON_ID_A, NEAR_DUP_TEXT_A, NEAR_DUP_TEXT_A),
      lessonBlock(LESSON_ID_B, NEAR_DUP_TEXT_B, NEAR_DUP_TEXT_B),
    );
    const dir = path.join(tmpRoot, "team", DEV_ROLE);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, "PERSONA.md"), personaContent);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.nearDuplicateLessonPairs).toHaveLength(1);
    const pair = bundle.nearDuplicateLessonPairs[0]!;
    expect(pair.role).toBe(DEV_ROLE);
    expect([pair.lesson_a.id, pair.lesson_b.id]).toContain(LESSON_ID_A);
    expect([pair.lesson_a.id, pair.lesson_b.id]).toContain(LESSON_ID_B);
    expect(pair.similarity).toBeGreaterThan(0.35);
  });

  it("a lesson-consolidation proposal validates and writes to the proposal file", async () => {
    await seedPersona(tmpRoot, DEV_ROLE);

    const { absPath, proposalCount } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "lesson-consolidation",
          id: ULID_CONSOL,
          created_at: ISO,
          rationale:
            "nearDuplicateLessonPairs detected two overlapping git-rebase lessons for generalist-dev (similarity 0.72).",
          target_role: DEV_ROLE,
          lesson_a_id: LESSON_ID_A,
          lesson_b_id: LESSON_ID_B,
          lesson_a_text: NEAR_DUP_TEXT_A,
          lesson_b_text: NEAR_DUP_TEXT_B,
          merged_lesson: MERGED_LESSON,
        },
      ],
    });

    expect(proposalCount).toBe(1);

    const raw = await fs.readFile(absPath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    expect(fmMatch).not.toBeNull();
    const { parse: yamlParse } = await import("yaml");
    const reparsed = parseRetroProposalFile(yamlParse(fmMatch![1]!));

    expect(reparsed.proposals).toHaveLength(1);
    const proposal = reparsed.proposals[0]!;
    expect(proposal.type).toBe("lesson-consolidation");
    if (proposal.type === "lesson-consolidation") {
      expect(proposal.target_role).toBe(DEV_ROLE);
      expect(proposal.lesson_a_id).toBe(LESSON_ID_A);
      expect(proposal.lesson_b_id).toBe(LESSON_ID_B);
      expect(proposal.merged_lesson).toBe(MERGED_LESSON);
    }
  });

  it("applying the consolidation proposal replaces the two duplicate lessons with the single merged lesson", async () => {
    // Seed a persona with two near-duplicate lessons.
    const personaContent = fixturePersonaWithLessons(
      DEV_ROLE,
      lessonBlock(LESSON_ID_A, NEAR_DUP_TEXT_A, NEAR_DUP_TEXT_A),
      lessonBlock(LESSON_ID_B, NEAR_DUP_TEXT_B, NEAR_DUP_TEXT_B),
    );
    const dir = path.join(tmpRoot, "team", DEV_ROLE);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, "PERSONA.md"), personaContent);

    const handler = makeLessonConsolidationHandler();
    const ctx = { targetRepoRoot: tmpRoot, role: "operator" };
    const proposal = {
      type: "lesson-consolidation" as const,
      id: ULID_CONSOL,
      created_at: ISO,
      rationale: "overlap detected",
      target_role: DEV_ROLE,
      lesson_a_id: LESSON_ID_A,
      lesson_b_id: LESSON_ID_B,
      lesson_a_text: NEAR_DUP_TEXT_A,
      lesson_b_text: NEAR_DUP_TEXT_B,
      merged_lesson: MERGED_LESSON,
    };

    const result = await handler.apply(proposal, ctx);
    expect(result.changedPaths).toEqual([`team/${DEV_ROLE}/PERSONA.md`]);

    // The persona Knowledge section should no longer contain the two originals
    // but should contain the merged lesson.
    const updatedRaw = await fs.readFile(
      path.join(tmpRoot, "team", DEV_ROLE, "PERSONA.md"),
      "utf8",
    );
    expect(updatedRaw).not.toContain(LESSON_ID_A);
    expect(updatedRaw).not.toContain(LESSON_ID_B);
    expect(updatedRaw).toContain(MERGED_LESSON);
  });
});

// ---------------------------------------------------------------------------
// AC2 — role with all-distinct lessons → no consolidation recommendation.
// ---------------------------------------------------------------------------

describe("AC2 — all-distinct lessons produce no consolidation recommendation", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-consol-ac2-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("gatherRetroInputs returns no pairs when a role has two clearly distinct lessons", async () => {
    const personaContent = fixturePersonaWithLessons(
      DEV_ROLE,
      lessonBlock(LESSON_ID_A, NEAR_DUP_TEXT_A, NEAR_DUP_TEXT_A),
      lessonBlock(LESSON_ID_C, DISTINCT_TEXT_C, DISTINCT_TEXT_C),
    );
    const dir = path.join(tmpRoot, "team", DEV_ROLE);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, "PERSONA.md"), personaContent);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.nearDuplicateLessonPairs).toHaveLength(0);
  });

  it("gatherRetroInputs returns no pairs when a role has fewer than two lessons", async () => {
    const personaContent = fixturePersonaWithLessons(
      DEV_ROLE,
      lessonBlock(LESSON_ID_A, NEAR_DUP_TEXT_A, NEAR_DUP_TEXT_A),
    );
    const dir = path.join(tmpRoot, "team", DEV_ROLE);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, "PERSONA.md"), personaContent);

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.nearDuplicateLessonPairs).toHaveLength(0);
  });

  it("gatherRetroInputs returns no pairs when no roles are hired", async () => {
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.nearDuplicateLessonPairs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — the proposal preview shows both source lessons and the merged result,
// so the operator is never asked to approve a merge blind.
// ---------------------------------------------------------------------------

describe("AC3 — consolidation proposal preview shows both source lessons and the merged result", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-consol-ac3-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("the proposal schema carries lesson_a_text, lesson_b_text, and merged_lesson for operator review", async () => {
    await seedPersona(tmpRoot, DEV_ROLE);

    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [
        {
          type: "lesson-consolidation",
          id: ULID_CONSOL,
          created_at: ISO,
          rationale: "overlap",
          target_role: DEV_ROLE,
          lesson_a_id: LESSON_ID_A,
          lesson_b_id: LESSON_ID_B,
          lesson_a_text: NEAR_DUP_TEXT_A,
          lesson_b_text: NEAR_DUP_TEXT_B,
          merged_lesson: MERGED_LESSON,
        },
      ],
    });

    // The proposal file body must visibly surface all three texts.
    const raw = await fs.readFile(absPath, "utf8");
    expect(raw).toContain(NEAR_DUP_TEXT_A);
    expect(raw).toContain(NEAR_DUP_TEXT_B);
    expect(raw).toContain(MERGED_LESSON);

    // The frontmatter round-trips cleanly with all three fields.
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    const { parse: yamlParse } = await import("yaml");
    const reparsed = parseRetroProposalFile(yamlParse(fmMatch![1]!));
    const proposal = reparsed.proposals[0]!;
    if (proposal.type === "lesson-consolidation") {
      expect(proposal.lesson_a_text).toBe(NEAR_DUP_TEXT_A);
      expect(proposal.lesson_b_text).toBe(NEAR_DUP_TEXT_B);
      expect(proposal.merged_lesson).toBe(MERGED_LESSON);
    }
  });

  it("the apply handler previewDiff shows both source lessons and the merged result before apply", async () => {
    // Seed persona with the two near-duplicate lessons.
    const personaContent = fixturePersonaWithLessons(
      DEV_ROLE,
      lessonBlock(LESSON_ID_A, NEAR_DUP_TEXT_A, NEAR_DUP_TEXT_A),
      lessonBlock(LESSON_ID_B, NEAR_DUP_TEXT_B, NEAR_DUP_TEXT_B),
    );
    const dir = path.join(tmpRoot, "team", DEV_ROLE);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, "PERSONA.md"), personaContent);

    const handler = makeLessonConsolidationHandler();
    const ctx = { targetRepoRoot: tmpRoot, role: "operator" };
    const proposal = {
      type: "lesson-consolidation" as const,
      id: ULID_CONSOL,
      created_at: ISO,
      rationale: "overlap detected",
      target_role: DEV_ROLE,
      lesson_a_id: LESSON_ID_A,
      lesson_b_id: LESSON_ID_B,
      lesson_a_text: NEAR_DUP_TEXT_A,
      lesson_b_text: NEAR_DUP_TEXT_B,
      merged_lesson: MERGED_LESSON,
    };

    const preview = await handler.previewDiff(proposal, ctx);

    // The preview must include all three texts so the operator can decide
    // whether the merge is appropriate before approving (AC3).
    expect(preview).toContain(NEAR_DUP_TEXT_A);
    expect(preview).toContain(NEAR_DUP_TEXT_B);
    expect(preview).toContain(MERGED_LESSON);
  });

  it("the retro-analyst catalogue has a lesson-consolidation discipline section (STRICT)", async () => {
    const { getPluginRoot } = await import("../../lib/plugin-root.js");
    const catalogueRole = await readCatalogue({
      pluginRoot: getPluginRoot(),
      role: "retro-analyst",
    });
    const prompt = catalogueRole.sections.Prompt;

    expect(prompt).toContain("lesson-consolidation");
    expect(prompt).toContain("STRICT");
    expect(prompt).toContain("nearDuplicateLessonPairs");
    expect(prompt).toContain("merged_lesson");
  });

  it("lesson-consolidation is in RETRO_PROPOSAL_TYPES", () => {
    expect(RETRO_PROPOSAL_TYPES).toContain("lesson-consolidation");
    expect(RETRO_PROPOSAL_TYPES).toHaveLength(11);
  });

  it("the schema refuses a lesson-consolidation with an empty merged_lesson", async () => {
    await seedPersona(tmpRoot, DEV_ROLE);

    await expect(
      writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: ISO,
        proposals: [
          {
            type: "lesson-consolidation",
            id: ULID_CONSOL,
            created_at: ISO,
            rationale: "overlap",
            target_role: DEV_ROLE,
            lesson_a_id: LESSON_ID_A,
            lesson_b_id: LESSON_ID_B,
            lesson_a_text: NEAR_DUP_TEXT_A,
            lesson_b_text: NEAR_DUP_TEXT_B,
            merged_lesson: "",
          },
        ],
      }),
    ).rejects.toThrow();
  });
});
