/**
 * Tests for the `persona-append`-kind handler and the retro-proposal type-count
 * invariant — Story 6.9, AC1–AC4.
 *
 * AC1 (integration): confirmed apply appends a new bullet to the Knowledge
 *   section and commits via the gate (tested end-to-end via acceptProposal with
 *   a fake gitCommit seam).
 *
 * AC2 (unit): preview returns the lesson text and target role, writes nothing
 *   to disk.
 *
 * AC3 (unit): missing persona file surfaces a clear PersonaFileNotFoundError;
 *   no file is created or modified.
 *
 * AC4 (unit): `persona-append` is present in `RETRO_PROPOSAL_TYPES` (the
 *   discriminated union), the production registry registers it, and the
 *   type-count assertion passes at 9.
 *
 * Fixture approach: seed a minimal persona in a temp dir using `atomicWriteFile`
 * (the same pattern as build-persona-spawn-prompt.test.ts), then call
 * `acceptProposal` with an injected fake `gitCommit` seam. No real git.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { acceptProposal } from "../accept-proposal.js";
import { makePersonaAppendHandler } from "../../lib/apply-persona-append.js";
import { createProductionRegistry, } from "../../lib/proposal-apply-registry.js";
import { RETRO_PROPOSAL_TYPES, RetroProposalSchema, } from "../../schemas/retro-proposal.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { PersonaFileNotFoundError } from "../../errors.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ULID_A = "01HZRETR0000000000000000PA";
const ISO = "2026-05-28T14:32:11.123Z";
const FIXED_NOW = new Date("2026-06-01T10:00:00.000Z");
const ROLE = "generalist-dev";
const LESSON = "Always emit the handoff phrase on a line by itself.";
// ---------------------------------------------------------------------------
// Fixture persona file
// ---------------------------------------------------------------------------
const FIXTURE_PERSONA_MD = `---
role: generalist-dev
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
  - Task
gh_allow:
  - pr-create
  - pr-view
  - pr-comment
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Dev

## Domain

Implements one story at a time end-to-end: claim, code, test, open PR, hand off to reviewer.

## Mandate

- Claim a story from the ready queue, work it in an isolated worktree.
- Implement against the AC, write tests, run the project's build/test gates green before opening a PR.
- Open the PR with the locked handoff phrase so the reviewer is woken.

## Out of mandate

- Reviewing the PR — yield to generalist-reviewer.
- Shaping the source story — yield to planner if the story is under-specified.

## Prompt

You are the generalist dev. You implement one story at a time, end-to-end, against the AC.

## Knowledge

`;
// Same fixture but with an existing knowledge bullet (for appending-to-non-empty test).
const FIXTURE_PERSONA_WITH_KNOWLEDGE = `---
role: generalist-dev
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
  - Task
gh_allow:
  - pr-create
  - pr-view
  - pr-comment
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Dev

## Domain

Implements one story at a time end-to-end: claim, code, test, open PR, hand off to reviewer.

## Mandate

- Claim a story from the ready queue, work it in an isolated worktree.
- Implement against the AC, write tests, run the project's build/test gates green before opening a PR.
- Open the PR with the locked handoff phrase so the reviewer is woken.

## Out of mandate

- Reviewing the PR — yield to generalist-reviewer.
- Shaping the source story — yield to planner if the story is under-specified.

## Prompt

You are the generalist dev. You implement one story at a time, end-to-end, against the AC.

## Knowledge

- Existing lesson one.
`;
// ---------------------------------------------------------------------------
// Helper: fake gitCommit seam
// ---------------------------------------------------------------------------
function makeFakeGitCommit(sha = "deadbeefcafe0000000000000000000000000000") {
    const calls = [];
    const impl = (async (args) => {
        calls.push({ paths: args.paths, message: args.message });
        return { commitSha: sha, stdout: "", stderr: "" };
    });
    return { impl, calls };
}
// ---------------------------------------------------------------------------
// Helper: build a registry containing only the persona-append handler
// ---------------------------------------------------------------------------
function personaAppendOnlyRegistry() {
    const map = new Map();
    map.set("persona-append", makePersonaAppendHandler());
    return map;
}
// ---------------------------------------------------------------------------
// Fixture: persona-append proposal object
// ---------------------------------------------------------------------------
function personaAppendProposal(id, lesson) {
    return {
        type: "persona-append",
        id,
        created_at: ISO,
        rationale: "Retro identified repeated handoff-grammar failures for this role.",
        target_role: ROLE,
        lesson,
    };
}
// ---------------------------------------------------------------------------
// tmpdir lifecycle
// ---------------------------------------------------------------------------
let tmpRoot;
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-persona-append-"));
});
afterEach(async () => {
    try {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    }
    catch {
        /* swallow */
    }
});
// ---------------------------------------------------------------------------
// Helper: seed a persona file in the tmp repo
// ---------------------------------------------------------------------------
async function seedPersona(root, role, content) {
    const dir = path.join(root, "team", role);
    await fs.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, "PERSONA.md");
    await atomicWriteFile(absPath, content);
    return absPath;
}
// ---------------------------------------------------------------------------
// AC4 — type-count and discriminated union invariant
// ---------------------------------------------------------------------------
describe("persona-append schema and registry (AC4)", () => {
    it("persona-append is present in RETRO_PROPOSAL_TYPES and the count is 9", () => {
        expect(RETRO_PROPOSAL_TYPES).toHaveLength(9);
        expect(RETRO_PROPOSAL_TYPES).toContain("persona-append");
    });
    it("RetroProposalSchema accepts a valid persona-append proposal", () => {
        const result = RetroProposalSchema.safeParse(personaAppendProposal(ULID_A, LESSON));
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.type).toBe("persona-append");
            if (result.data.type === "persona-append") {
                expect(result.data.target_role).toBe(ROLE);
                expect(result.data.lesson).toBe(LESSON);
            }
        }
    });
    it("RetroProposalSchema rejects persona-append with an empty lesson", () => {
        const result = RetroProposalSchema.safeParse(personaAppendProposal(ULID_A, ""));
        expect(result.success).toBe(false);
    });
    it("RetroProposalSchema rejects persona-append with a non-kebab target_role", () => {
        const result = RetroProposalSchema.safeParse({
            ...personaAppendProposal(ULID_A, LESSON),
            target_role: "Generalist Dev",
        });
        expect(result.success).toBe(false);
    });
    it("production registry registers a persona-append handler", () => {
        const registry = createProductionRegistry();
        expect(registry.has("persona-append")).toBe(true);
        const handler = registry.get("persona-append");
        expect(handler).toBeDefined();
        expect(handler.type).toBe("persona-append");
    });
});
// ---------------------------------------------------------------------------
// AC2 — preview is a no-op
// ---------------------------------------------------------------------------
describe("persona-append — preview is a no-op (AC2)", () => {
    it("returns a diff preview showing the lesson and target role; writes nothing", async () => {
        await seedPersona(tmpRoot, ROLE, FIXTURE_PERSONA_MD);
        // Seed a proposal file.
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [personaAppendProposal(ULID_A, LESSON)],
        });
        const git = makeFakeGitCommit();
        const result = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_A,
            // confirm omitted → preview mode
            handlers: personaAppendOnlyRegistry(),
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        expect(result.status).toBe("preview");
        if (result.status === "preview") {
            expect(result.type).toBe("persona-append");
            // Diff should mention the lesson text and the role.
            expect(result.diff).toContain(LESSON);
            expect(result.diff).toContain(ROLE);
        }
        // No commit made.
        expect(git.calls).toHaveLength(0);
        // Persona file unchanged (not written via the diff path).
        const personaAbs = path.join(tmpRoot, "team", ROLE, "PERSONA.md");
        const personaContents = await fs.readFile(personaAbs, "utf8");
        expect(personaContents).toBe(FIXTURE_PERSONA_MD);
    });
});
// ---------------------------------------------------------------------------
// AC3 — missing persona file surfaces a clear error
// ---------------------------------------------------------------------------
describe("persona-append — missing persona file (AC3)", () => {
    it("throws PersonaFileNotFoundError when the persona file does not exist", async () => {
        // Do NOT seed a persona file.
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [personaAppendProposal(ULID_A, LESSON)],
        });
        const git = makeFakeGitCommit();
        await expect(acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_A,
            confirm: true,
            handlers: personaAppendOnlyRegistry(),
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        })).rejects.toBeInstanceOf(PersonaFileNotFoundError);
        // No commit, no file created.
        expect(git.calls).toHaveLength(0);
        const teamDir = path.join(tmpRoot, "team", ROLE);
        await expect(fs.access(teamDir)).rejects.toThrow();
    });
    it("PersonaFileNotFoundError names the role and path", async () => {
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [personaAppendProposal(ULID_A, LESSON)],
        });
        const git = makeFakeGitCommit();
        let caught;
        try {
            await acceptProposal({
                targetRepoRoot: tmpRoot,
                proposalId: ULID_A,
                confirm: true,
                handlers: personaAppendOnlyRegistry(),
                gitCommitImpl: git.impl,
            });
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PersonaFileNotFoundError);
        const e = caught;
        expect(e.role).toBe(ROLE);
        expect(e.personaPath).toContain(ROLE);
    });
});
// ---------------------------------------------------------------------------
// AC1 — confirmed apply appends bullet and commits
// ---------------------------------------------------------------------------
describe("persona-append — confirmed apply (AC1)", () => {
    it("appends the lesson as a new bullet to the Knowledge section (empty body)", async () => {
        await seedPersona(tmpRoot, ROLE, FIXTURE_PERSONA_MD);
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [personaAppendProposal(ULID_A, LESSON)],
        });
        const git = makeFakeGitCommit("aabb1122ccdd3344eeff5566778899001122aabb");
        const result = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_A,
            confirm: true,
            handlers: personaAppendOnlyRegistry(),
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        expect(result.status).toBe("applied");
        // Persona file now contains the new bullet in Knowledge section.
        const personaAbs = path.join(tmpRoot, "team", ROLE, "PERSONA.md");
        const contents = await fs.readFile(personaAbs, "utf8");
        expect(contents).toContain(`## Knowledge`);
        expect(contents).toContain(`- ${LESSON}`);
        // Original sections preserved.
        expect(contents).toContain(`## Domain`);
        expect(contents).toContain(`## Mandate`);
        expect(contents).toContain(`## Prompt`);
    });
    it("appends a second bullet when Knowledge body is already non-empty", async () => {
        await seedPersona(tmpRoot, ROLE, FIXTURE_PERSONA_WITH_KNOWLEDGE);
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [personaAppendProposal(ULID_A, LESSON)],
        });
        const git = makeFakeGitCommit();
        await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_A,
            confirm: true,
            handlers: personaAppendOnlyRegistry(),
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        const personaAbs = path.join(tmpRoot, "team", ROLE, "PERSONA.md");
        const contents = await fs.readFile(personaAbs, "utf8");
        // Both bullets are present.
        expect(contents).toContain(`- Existing lesson one.`);
        expect(contents).toContain(`- ${LESSON}`);
    });
    it("only modifies the target role's persona file (no other persona changed)", async () => {
        // Seed both roles.
        const otherRole = "generalist-reviewer";
        const otherContents = FIXTURE_PERSONA_MD.replace("generalist-dev", otherRole);
        await seedPersona(tmpRoot, ROLE, FIXTURE_PERSONA_MD);
        await seedPersona(tmpRoot, otherRole, otherContents);
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [personaAppendProposal(ULID_A, LESSON)],
        });
        const git = makeFakeGitCommit();
        const otherBefore = await fs.readFile(path.join(tmpRoot, "team", otherRole, "PERSONA.md"), "utf8");
        await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_A,
            confirm: true,
            handlers: personaAppendOnlyRegistry(),
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        // The other role's file is byte-identical.
        const otherAfter = await fs.readFile(path.join(tmpRoot, "team", otherRole, "PERSONA.md"), "utf8");
        expect(otherAfter).toBe(otherBefore);
    });
    it("commits exactly one commit carrying the persona file and the proposal file", async () => {
        await seedPersona(tmpRoot, ROLE, FIXTURE_PERSONA_MD);
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [personaAppendProposal(ULID_A, LESSON)],
        });
        const git = makeFakeGitCommit("ff001122334455667788990011223344556677ee");
        await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_A,
            confirm: true,
            handlers: personaAppendOnlyRegistry(),
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        expect(git.calls).toHaveLength(1);
        const committed = git.calls[0];
        // Persona file is in the commit.
        expect(committed.paths).toContain(`team/${ROLE}/PERSONA.md`);
        // Proposal file is in the commit.
        expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);
        expect(committed.message).toBe(`accept-proposal: ${ULID_A}`);
    });
});
