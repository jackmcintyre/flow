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
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { gatherRetroInputs } from "../gather-retro-inputs.js";
import { getTeamSnapshot } from "../get-team-snapshot.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { readCatalogue } from "../read-catalogue.js";
import { loadRolePermissions } from "../../state/load-role-permissions.js";
import { parseRetroProposalFile, RETRO_PROPOSAL_TYPES, } from "../../schemas/retro-proposal.js";
// ---------------------------------------------------------------------------
// Resolve the real plugin root from this file's location (same pattern as
// retro-skill.test.ts):
//   plugins/flow/                       <-- REAL_PLUGIN_ROOT
//     mcp-server/src/tools/__tests__/   <-- HERE
// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_PLUGIN_ROOT = path.resolve(HERE, "..", "..", "..", "..");
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
function fixturePersona(role) {
    const h1 = role
        .split("-")
        .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
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
function buildDoneManifest(ref, retro = {}) {
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
async function writeYaml(absPath, obj) {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, yamlStringify(obj), "utf8");
}
async function seedPersona(root, role) {
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
    let tmpRoot;
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
        await writeYaml(path.join(doneDir, "native:1.1.yaml"), buildDoneManifest("native:1.1", {
            lessons: [
                {
                    kind: "tool-quirk",
                    text: "git rebase --onto needs an explicit upstream when the branch was cut from a stale base.",
                },
            ],
        }));
        const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
        // The lesson is present in the bundle — the analyst has the raw material.
        expect(bundle.doneManifests).toHaveLength(1);
        const lessons = bundle.doneManifests[0].lessons ?? [];
        expect(lessons).toHaveLength(1);
        expect(lessons[0].text).toContain("git rebase --onto");
        // The target role is hired (so a persona-append for it is legitimate).
        const team = await getTeamSnapshot({ targetRepoRoot: tmpRoot });
        expect(team.roles.map((r) => r.role)).toContain(DEV_ROLE);
    });
    it("a grounded persona-append proposal validates and writes to the proposal file", async () => {
        await seedPersona(tmpRoot, DEV_ROLE);
        const lesson = "When rebasing a story branch, run `git fetch` then rebase onto the fresh upstream — a stale base silently drops sibling commits.";
        const { absPath, proposalCount } = await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [
                {
                    type: "persona-append",
                    id: ULID_A,
                    created_at: ISO,
                    rationale: "done manifest native:1.1 lessons[] carried a tool-quirk about git rebase --onto; routed to generalist-dev whose domain owns git operations.",
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
        const reparsed = parseRetroProposalFile(yamlParse(fmMatch[1]));
        expect(reparsed.proposals).toHaveLength(1);
        const proposal = reparsed.proposals[0];
        expect(proposal.type).toBe("persona-append");
        if (proposal.type === "persona-append") {
            expect(proposal.target_role).toBe(DEV_ROLE);
            expect(proposal.lesson).toBe(lesson);
        }
    });
    it("persona-append is one of the eight typed proposal variants", () => {
        expect(RETRO_PROPOSAL_TYPES).toContain("persona-append");
        expect(RETRO_PROPOSAL_TYPES).toHaveLength(8);
    });
});
// ---------------------------------------------------------------------------
// AC2 — empty-signal cycle produces zero persona-append proposals.
// ---------------------------------------------------------------------------
describe("AC2 — empty-signal cycle yields zero persona-append proposals", () => {
    let tmpRoot;
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
        await writeYaml(path.join(doneDir, "native:2.1.yaml"), buildDoneManifest("native:2.1"));
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
        const reparsed = parseRetroProposalFile(yamlParse(fmMatch[1]));
        // Zero persona-append proposals — the basis for one was absent.
        const personaAppends = reparsed.proposals.filter((p) => p.type === "persona-append");
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
        const reparsed = parseRetroProposalFile(yamlParse(fmMatch[1]));
        const personaAppends = reparsed.proposals.filter((p) => p.type === "persona-append");
        expect(personaAppends).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// AC3 — a produced persona-append names a real hired role with grounded,
// non-placeholder lesson text.
// ---------------------------------------------------------------------------
describe("AC3 — produced persona-append names a hired role with grounded lesson text", () => {
    let tmpRoot;
    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-persona-ac3-"));
    });
    afterEach(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    it("the proposal's target_role resolves to a persona file that exists in the team directory", async () => {
        await seedPersona(tmpRoot, DEV_ROLE);
        await seedPersona(tmpRoot, REVIEWER_ROLE);
        const lesson = "Verify each AC artifact actually built before approving — do not rubber-stamp READY FOR MERGE.";
        const { absPath } = await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [
                {
                    type: "persona-append",
                    id: ULID_B,
                    created_at: ISO,
                    rationale: "done manifest native:3.1 lessons[] carried a pitfall (failure_class reviewer-skips-artifact-check); routed to generalist-reviewer.",
                    target_role: REVIEWER_ROLE,
                    lesson,
                },
            ],
        });
        const raw = await fs.readFile(absPath, "utf8");
        const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
        const { parse: yamlParse } = await import("yaml");
        const reparsed = parseRetroProposalFile(yamlParse(fmMatch[1]));
        const proposal = reparsed.proposals[0];
        expect(proposal.type).toBe("persona-append");
        // The named role is a real hired role — getTeamSnapshot lists it and its
        // persona file exists on disk.
        const team = await getTeamSnapshot({ targetRepoRoot: tmpRoot });
        const hiredRoleIds = team.roles.map((r) => r.role);
        if (proposal.type === "persona-append") {
            expect(hiredRoleIds).toContain(proposal.target_role);
            const personaPath = path.join(tmpRoot, "team", proposal.target_role, "PERSONA.md");
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
        await expect(writeRetroProposal({
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
        })).rejects.toThrow();
    });
    it("the schema refuses a persona-append whose target_role is not a kebab role id", async () => {
        await expect(writeRetroProposal({
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
        })).rejects.toThrow();
    });
});
