/**
 * `skill-*` apply-handler tests — Story 6.7 AC1–AC5.
 *
 * AC1–AC4 drive each handler directly (via `createSkillProposalHandlers`) with
 * a deterministic clock seam, against a tmp `.flow/skills/` tree, asserting the
 * file effects + the typed errors with no mutation on the failure paths.
 *
 * AC5 drives the REAL `acceptProposal` gate (no injected handlers — the
 * production registry now carries the four `skill-*` handlers) through preview +
 * confirm for `skill-create` and `skill-revise`, injecting only the git seam,
 * and asserts the preview-no-op, the single combined commit, the applied stamp,
 * one telemetry event, and the idempotent re-accept.
 *
 * Test conventions mirror `accept-proposal.test.ts`: tmpRoot, seed proposals via
 * `writeRetroProposal`, inject the git seam, read telemetry from
 * `.flow/telemetry/*.jsonl`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { SkillAlreadyExistsError, SkillNotFoundError, } from "../../errors.js";
import { bumpVersion, createSkillProposalHandlers, } from "../../lib/apply-skill-proposal.js";
import { SkillFrontmatterSchema } from "../../schemas/skill-frontmatter.js";
import { createProductionRegistry, } from "../../lib/proposal-apply-registry.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { acceptProposal } from "../accept-proposal.js";
import { parseRetroProposalFile } from "../../schemas/retro-proposal.js";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ULID_CREATE = "01KSYQGHBK09MZZC93J90QZEDQ";
const ULID_REVISE = "01KSYQGHBNYV724V435F5D0FEE";
const ULID_SUPER = "01KSYQGHBNE7AYBJW1BGQK39ST";
const ULID_RETIRE = "01KSYQGHBNDHXQQ564455JYE9P";
const ISO = "2026-05-31T09:00:00.000Z";
const FIXED_NOW = new Date("2026-05-31T10:00:00.000Z");
const FIXED_NOW_ISO = FIXED_NOW.toISOString();
const SKILL_REL = ".flow/skills/foo.md";
const REPLACEMENT_REL = ".flow/skills/foo-v2.md";
function ctxOf(targetRepoRoot) {
    return { targetRepoRoot, role: "operator" };
}
function handlersByType(now) {
    const map = new Map(createSkillProposalHandlers({ now }).map((h) => [h.type, h]));
    return map;
}
/**
 * Seed a `0.1.0` skill file at `<root>/.flow/skills/foo.md` (with a
 * `.history/`-shaped sibling so retire/supersede preservation is observable).
 */
async function seedSkill(root, opts = {}) {
    const relPath = opts.relPath ?? SKILL_REL;
    const version = opts.version ?? "0.1.0";
    const body = opts.body ?? "# Foo skill\n\nDo the foo thing.";
    const frontmatter = [
        "---",
        "name: foo",
        "description: The foo skill",
        "allowed_tools: []",
        `version: ${version}`,
        "introduced_at: 2026-01-01T00:00:00.000Z",
        "source_lesson_refs: []",
        "---",
        "",
    ].join("\n");
    const abs = path.join(root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `${frontmatter}${body}\n`, "utf8");
}
async function readSkill(root, relPath) {
    const abs = path.join(root, relPath);
    const raw = await fs.readFile(abs, "utf8");
    const rest = raw.slice("---\n".length);
    const closeIdx = rest.indexOf("\n---");
    const fmRaw = rest.slice(0, closeIdx + 1);
    const body = rest
        .slice(closeIdx + "\n---".length)
        .replace(/^\s*\n/, "")
        .replace(/\n+$/, "");
    const frontmatter = SkillFrontmatterSchema.parse(yamlParse(fmRaw));
    return { raw, frontmatter, body };
}
async function exists(absOrRoot, rel) {
    const p = rel === undefined ? absOrRoot : path.join(absOrRoot, rel);
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Tmpdir lifecycle
// ---------------------------------------------------------------------------
let tmpRoot;
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-skill-"));
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
// bumpVersion — pure helper (supports AC2's deterministic version assertion)
// ---------------------------------------------------------------------------
describe("bumpVersion", () => {
    it("patch bumps the z component", () => {
        expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
        expect(bumpVersion("1.2.9", "patch")).toBe("1.2.10");
    });
    it("minor bumps y and resets z", () => {
        expect(bumpVersion("0.1.5", "minor")).toBe("0.2.0");
        expect(bumpVersion("3.4.7", "minor")).toBe("3.5.0");
    });
});
// ---------------------------------------------------------------------------
// AC1 — skill-create
// ---------------------------------------------------------------------------
describe("skill-create handler (AC1)", () => {
    function createProposal() {
        return {
            type: "skill-create",
            id: ULID_CREATE,
            created_at: ISO,
            rationale: "Codify the repeatable foo success.",
            proposed_path: SKILL_REL,
            frontmatter_description: "The foo skill",
            body: "# Foo\n\nAlways foo before bar.",
        };
    }
    it("writes a new skill file with all frontmatter fields, schema-valid", async () => {
        const handler = handlersByType(() => FIXED_NOW).get("skill-create");
        const result = await handler.apply(createProposal(), ctxOf(tmpRoot));
        expect(result.changedPaths).toEqual([SKILL_REL]);
        expect(await exists(tmpRoot, SKILL_REL)).toBe(true);
        const { frontmatter, body } = await readSkill(tmpRoot, SKILL_REL);
        // Schema validation (also implicit in readSkill via .parse).
        expect(() => SkillFrontmatterSchema.parse(frontmatter)).not.toThrow();
        expect(frontmatter.name).toBe("foo");
        expect(frontmatter.description).toBe("The foo skill");
        expect(frontmatter.allowed_tools).toEqual([]);
        expect(frontmatter.version).toBe("0.1.0");
        expect(frontmatter.introduced_at).toBe(FIXED_NOW_ISO);
        expect(frontmatter.source_lesson_refs).toEqual([]);
        expect(frontmatter.supersedes).toBeUndefined();
        expect(frontmatter.retired_at).toBeUndefined();
        expect(body).toBe("# Foo\n\nAlways foo before bar.");
    });
    it("preview renders a diff without writing", async () => {
        const handler = handlersByType(() => FIXED_NOW).get("skill-create");
        const diff = await handler.previewDiff(createProposal(), ctxOf(tmpRoot));
        expect(diff).toContain("Create skill");
        expect(diff).toContain("version: 0.1.0");
        expect(await exists(tmpRoot, SKILL_REL)).toBe(false);
    });
    it("a second create at the same path raises SkillAlreadyExistsError with no mutation", async () => {
        const handler = handlersByType(() => FIXED_NOW).get("skill-create");
        await handler.apply(createProposal(), ctxOf(tmpRoot));
        const before = await readSkill(tmpRoot, SKILL_REL);
        await expect(handler.apply({ ...createProposal(), body: "DIFFERENT BODY" }, ctxOf(tmpRoot))).rejects.toBeInstanceOf(SkillAlreadyExistsError);
        // No overwrite — bytes unchanged.
        const after = await readSkill(tmpRoot, SKILL_REL);
        expect(after.raw).toBe(before.raw);
    });
});
// ---------------------------------------------------------------------------
// AC2 — skill-revise
// ---------------------------------------------------------------------------
describe("skill-revise handler (AC2)", () => {
    function reviseProposal(bump = "minor") {
        return {
            type: "skill-revise",
            id: ULID_REVISE,
            created_at: ISO,
            rationale: "Tighten the foo guidance.",
            target_skill_path: SKILL_REL,
            revised_body: "# Foo (revised)\n\nFoo, then verify.",
            version_bump: bump,
        };
    }
    it("archives the prior body, bumps the version, replaces the body", async () => {
        await seedSkill(tmpRoot, { version: "0.1.0", body: "# Foo\n\nOriginal." });
        const handler = handlersByType(() => FIXED_NOW).get("skill-revise");
        const result = await handler.apply(reviseProposal("minor"), ctxOf(tmpRoot));
        const historyRel = `${SKILL_REL}.history/0.1.0.md`;
        expect(result.changedPaths).toEqual([SKILL_REL, historyRel]);
        // Prior body archived at <skill>.history/0.1.0.md.
        const archived = await readSkill(tmpRoot, historyRel);
        expect(archived.body).toBe("# Foo\n\nOriginal.");
        expect(archived.frontmatter.version).toBe("0.1.0");
        // New version per the bump rule; body replaced; frontmatter preserved.
        const live = await readSkill(tmpRoot, SKILL_REL);
        expect(live.frontmatter.version).toBe("0.2.0");
        expect(live.frontmatter.name).toBe("foo");
        expect(live.frontmatter.introduced_at).toBe("2026-01-01T00:00:00.000Z");
        expect(live.body).toBe("# Foo (revised)\n\nFoo, then verify.");
    });
    it("patch bump produces x.y.(z+1)", async () => {
        await seedSkill(tmpRoot, { version: "0.1.0" });
        const handler = handlersByType(() => FIXED_NOW).get("skill-revise");
        await handler.apply(reviseProposal("patch"), ctxOf(tmpRoot));
        const live = await readSkill(tmpRoot, SKILL_REL);
        expect(live.frontmatter.version).toBe("0.1.1");
    });
    it("a revise targeting a non-existent skill raises SkillNotFoundError with no mutation", async () => {
        const handler = handlersByType(() => FIXED_NOW).get("skill-revise");
        await expect(handler.apply(reviseProposal(), ctxOf(tmpRoot))).rejects.toBeInstanceOf(SkillNotFoundError);
        // Nothing written.
        expect(await exists(tmpRoot, SKILL_REL)).toBe(false);
        expect(await exists(tmpRoot, `${SKILL_REL}.history`)).toBe(false);
    });
    it("history archive name derives from the PRIOR version across two revises", async () => {
        await seedSkill(tmpRoot, { version: "0.1.0", body: "v0.1.0 body" });
        const handler = handlersByType(() => FIXED_NOW).get("skill-revise");
        await handler.apply({ ...reviseProposal("minor"), revised_body: "v0.2.0 body" }, ctxOf(tmpRoot));
        await handler.apply({ ...reviseProposal("minor"), revised_body: "v0.3.0 body" }, ctxOf(tmpRoot));
        // Both prior versions archived under distinct names (no clobber).
        expect((await readSkill(tmpRoot, `${SKILL_REL}.history/0.1.0.md`)).body).toBe("v0.1.0 body");
        expect((await readSkill(tmpRoot, `${SKILL_REL}.history/0.2.0.md`)).body).toBe("v0.2.0 body");
        expect((await readSkill(tmpRoot, SKILL_REL)).frontmatter.version).toBe("0.3.0");
    });
});
// ---------------------------------------------------------------------------
// AC3 — skill-supersede
// ---------------------------------------------------------------------------
describe("skill-supersede handler (AC3)", () => {
    function supersedeProposal() {
        return {
            type: "skill-supersede",
            id: ULID_SUPER,
            created_at: ISO,
            rationale: "The foo skill is replaced by foo-v2.",
            superseded_skill_path: SKILL_REL,
            replacement: {
                proposed_path: REPLACEMENT_REL,
                frontmatter_description: "The foo-v2 skill",
                body: "# Foo v2\n\nThe better foo.",
            },
        };
    }
    it("writes the replacement (with supersedes:) and archives the superseded skill (retired_at)", async () => {
        await seedSkill(tmpRoot, { version: "0.1.0", body: "# Foo\n\nOld." });
        const handler = handlersByType(() => FIXED_NOW).get("skill-supersede");
        const result = await handler.apply(supersedeProposal(), ctxOf(tmpRoot));
        const archiveRel = ".flow/skills/_archived/foo.md";
        expect(result.changedPaths).toEqual([
            REPLACEMENT_REL,
            archiveRel,
            SKILL_REL,
        ]);
        // Replacement exists with supersedes: set.
        const replacement = await readSkill(tmpRoot, REPLACEMENT_REL);
        expect(replacement.frontmatter.name).toBe("foo-v2");
        expect(replacement.frontmatter.supersedes).toBe(SKILL_REL);
        expect(replacement.frontmatter.version).toBe("0.1.0");
        expect(replacement.body).toBe("# Foo v2\n\nThe better foo.");
        // Superseded skill archived with retired_at; gone from the live path.
        expect(await exists(tmpRoot, SKILL_REL)).toBe(false);
        const archived = await readSkill(tmpRoot, archiveRel);
        expect(archived.frontmatter.retired_at).toBe(FIXED_NOW_ISO);
        expect(archived.body).toBe("# Foo\n\nOld.");
    });
    it("a supersede of a missing skill raises SkillNotFoundError, writing no replacement", async () => {
        const handler = handlersByType(() => FIXED_NOW).get("skill-supersede");
        await expect(handler.apply(supersedeProposal(), ctxOf(tmpRoot))).rejects.toBeInstanceOf(SkillNotFoundError);
        // No replacement written (the missing-target check runs first).
        expect(await exists(tmpRoot, REPLACEMENT_REL)).toBe(false);
    });
    it("a replacement-path collision raises SkillAlreadyExistsError, leaving the superseded skill intact", async () => {
        await seedSkill(tmpRoot, { version: "0.1.0" });
        await seedSkill(tmpRoot, { relPath: REPLACEMENT_REL, version: "0.5.0" });
        const handler = handlersByType(() => FIXED_NOW).get("skill-supersede");
        await expect(handler.apply(supersedeProposal(), ctxOf(tmpRoot))).rejects.toBeInstanceOf(SkillAlreadyExistsError);
        // Superseded skill still live (archive half never ran).
        expect(await exists(tmpRoot, SKILL_REL)).toBe(true);
        expect(await exists(tmpRoot, ".flow/skills/_archived/foo.md")).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// AC4 — skill-retire
// ---------------------------------------------------------------------------
describe("skill-retire handler (AC4)", () => {
    function retireProposal() {
        return {
            type: "skill-retire",
            id: ULID_RETIRE,
            created_at: ISO,
            rationale: "The foo skill never fires.",
            target_skill_path: SKILL_REL,
            last_invoked_at: null,
        };
    }
    it("moves the skill to _archived/ with retired_at, preserving history, gone from live", async () => {
        await seedSkill(tmpRoot, { version: "0.2.0", body: "# Foo\n\nRetire me." });
        // Seed a history file so we can assert it is preserved.
        const historyRel = `${SKILL_REL}.history/0.1.0.md`;
        const historyAbs = path.join(tmpRoot, historyRel);
        await fs.mkdir(path.dirname(historyAbs), { recursive: true });
        await fs.writeFile(historyAbs, "prior body\n", "utf8");
        const handler = handlersByType(() => FIXED_NOW).get("skill-retire");
        const result = await handler.apply(retireProposal(), ctxOf(tmpRoot));
        const archiveRel = ".flow/skills/_archived/foo.md";
        expect(result.changedPaths).toEqual([archiveRel, SKILL_REL]);
        // Gone from the live path.
        expect(await exists(tmpRoot, SKILL_REL)).toBe(false);
        // Present under _archived/ with retired_at.
        const archived = await readSkill(tmpRoot, archiveRel);
        expect(archived.frontmatter.retired_at).toBe(FIXED_NOW_ISO);
        expect(archived.frontmatter.version).toBe("0.2.0");
        expect(archived.body).toBe("# Foo\n\nRetire me.");
        // History preserved (not deleted).
        expect(await exists(tmpRoot, historyRel)).toBe(true);
    });
    it("a retire of a missing skill raises SkillNotFoundError with no mutation", async () => {
        const handler = handlersByType(() => FIXED_NOW).get("skill-retire");
        await expect(handler.apply(retireProposal(), ctxOf(tmpRoot))).rejects.toBeInstanceOf(SkillNotFoundError);
        expect(await exists(tmpRoot, ".flow/skills/_archived/foo.md")).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// AC5 — the production gate (real registry, only the git seam injected)
// ---------------------------------------------------------------------------
function makeFakeGitCommit(sha = "5c111face0000000000000000000000000000000") {
    const calls = [];
    const impl = (async (args) => {
        calls.push({ paths: args.paths, message: args.message });
        return { commitSha: sha, stdout: "", stderr: "" };
    });
    return { impl, calls };
}
async function readTelemetryEvents(root) {
    const dir = path.join(root, ".flow", "telemetry");
    let files;
    try {
        files = await fs.readdir(dir);
    }
    catch {
        return [];
    }
    const events = [];
    for (const f of files.filter((x) => x.endsWith(".jsonl")).sort()) {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        for (const line of raw.split("\n")) {
            if (line.trim() === "")
                continue;
            events.push(JSON.parse(line));
        }
    }
    return events;
}
async function readProposalFile(root, iso) {
    const abs = path.join(root, ".flow", "retro-proposals", `${iso}.md`);
    const raw = await fs.readFile(abs, "utf8");
    const rest = raw.slice("---\n".length);
    const closeIdx = rest.indexOf("\n---\n");
    const frontmatter = rest.slice(0, closeIdx + 1);
    const file = parseRetroProposalFile(yamlParse(frontmatter));
    return { raw, file };
}
describe("acceptProposal production gate — skill-create end-to-end (AC5)", () => {
    it("preview is a no-op; confirm applies + commits both paths + stamps + one event; re-accept no-ops", async () => {
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [
                {
                    type: "skill-create",
                    id: ULID_CREATE,
                    created_at: ISO,
                    rationale: "Codify foo.",
                    proposed_path: SKILL_REL,
                    frontmatter_description: "The foo skill",
                    body: "# Foo\n\nAlways foo.",
                },
            ],
        });
        const git = makeFakeGitCommit("aa00bb11cc22dd33ee44ff5566778899aabbccdd");
        // Preview — production registry (no handlers injection).
        const preview = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_CREATE,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        expect(preview.status).toBe("preview");
        expect(git.calls).toHaveLength(0);
        expect(await exists(tmpRoot, SKILL_REL)).toBe(false);
        expect(await readTelemetryEvents(tmpRoot)).toHaveLength(0);
        // Confirm.
        const applied = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_CREATE,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        expect(applied.status).toBe("applied");
        // Skill file written.
        expect(await exists(tmpRoot, SKILL_REL)).toBe(true);
        // Exactly one commit carrying BOTH the skill file and the proposal file.
        expect(git.calls).toHaveLength(1);
        const committed = git.calls[0];
        expect(committed.paths).toContain(SKILL_REL);
        expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);
        // Proposal stamped applied.
        const after = await readProposalFile(tmpRoot, ISO);
        expect(after.file.proposals[0].applied).toBeDefined();
        expect(after.file.proposals[0].applied.applied_sha).toBe("aa00bb11cc22dd33ee44ff5566778899aabbccdd");
        // Exactly one telemetry event.
        const events = await readTelemetryEvents(tmpRoot);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("retro.proposal.applied");
        expect(events[0].data).toMatchObject({
            id: ULID_CREATE,
            proposal_type: "skill-create",
        });
        // Idempotent re-accept — no second write, commit, or telemetry.
        const reAccept = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_CREATE,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(reAccept.status).toBe("already-applied");
        expect(git.calls).toHaveLength(1);
        expect(await readTelemetryEvents(tmpRoot)).toHaveLength(1);
    });
});
describe("acceptProposal production gate — skill-revise end-to-end (AC5)", () => {
    it("applies a revise through the real registry, committing skill + history + proposal", async () => {
        await seedSkill(tmpRoot, { version: "0.1.0", body: "# Foo\n\nv1." });
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [
                {
                    type: "skill-revise",
                    id: ULID_REVISE,
                    created_at: ISO,
                    rationale: "Improve foo.",
                    target_skill_path: SKILL_REL,
                    revised_body: "# Foo\n\nv2 — better.",
                    version_bump: "minor",
                },
            ],
        });
        const git = makeFakeGitCommit("bb11cc22dd33ee44ff5566778899aabbccdd0011");
        const applied = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_REVISE,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        expect(applied.status).toBe("applied");
        // One commit carrying skill file + history file + proposal file.
        expect(git.calls).toHaveLength(1);
        const committed = git.calls[0];
        expect(committed.paths).toContain(SKILL_REL);
        expect(committed.paths).toContain(`${SKILL_REL}.history/0.1.0.md`);
        expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);
        // Skill bumped + body replaced; prior archived.
        const live = await readSkill(tmpRoot, SKILL_REL);
        expect(live.frontmatter.version).toBe("0.2.0");
        expect(live.body).toBe("# Foo\n\nv2 — better.");
        expect((await readSkill(tmpRoot, `${SKILL_REL}.history/0.1.0.md`)).body).toBe("# Foo\n\nv1.");
    });
});
// ---------------------------------------------------------------------------
// AC6 — registration: all five kinds resolve to a real handler
// ---------------------------------------------------------------------------
describe("createProductionRegistry registers the five skill-* handlers (AC6)", () => {
    it("each skill-* kind resolves to a handler (none fails closed)", () => {
        const registry = createProductionRegistry();
        for (const kind of [
            "skill-create",
            "skill-revise",
            "skill-supersede",
            "skill-retire",
            "lesson-to-skill",
        ]) {
            const handler = registry.get(kind);
            expect(handler, `${kind} must resolve to a handler`).toBeDefined();
            expect(handler.type).toBe(kind);
        }
    });
});
// ---------------------------------------------------------------------------
// lesson-to-skill — AC1 (integration): creates skill + appends persona ref
// ---------------------------------------------------------------------------
const ULID_PROMOTE = "01KSYQGHBNE7AYBJW1BGQK39SP";
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

## Out of mandate

- Reviewing the PR — yield to generalist-reviewer.

## Prompt

You are the generalist dev.

## Knowledge

- Always emit the handoff phrase on its own line.
`;
const PROMOTE_SKILL_REL = ".flow/skills/handoff-discipline.md";
const PROMOTE_WHEN_TO_USE = "Before handing off a story to the reviewer.";
function promoteLessonProposal() {
    return {
        type: "lesson-to-skill",
        id: ULID_PROMOTE,
        created_at: ISO,
        rationale: "Codify the handoff discipline as a reusable skill.",
        source_role: "generalist-dev",
        proposed_path: PROMOTE_SKILL_REL,
        frontmatter_description: "Handoff discipline for dev roles",
        body: "# Handoff Discipline\n\nAlways emit the handoff phrase on its own line.",
        when_to_use: PROMOTE_WHEN_TO_USE,
    };
}
async function seedPersona(root, role, content) {
    const dir = path.join(root, "team", role);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "PERSONA.md"), content, "utf8");
}
async function readPersonaRaw(root, role) {
    return fs.readFile(path.join(root, "team", role, "PERSONA.md"), "utf8");
}
describe("lesson-to-skill handler (AC1)", () => {
    it("creates the skill file and appends a one-line skill-reference to the persona", async () => {
        await seedPersona(tmpRoot, "generalist-dev", FIXTURE_PERSONA_MD);
        const handler = handlersByType(() => FIXED_NOW).get("lesson-to-skill");
        const result = await handler.apply(promoteLessonProposal(), ctxOf(tmpRoot));
        // changedPaths includes the skill file and the persona file.
        expect(result.changedPaths).toContain(PROMOTE_SKILL_REL);
        expect(result.changedPaths).toContain("team/generalist-dev/PERSONA.md");
        expect(result.changedPaths).toHaveLength(2);
        // Skill file exists and has correct frontmatter.
        expect(await exists(tmpRoot, PROMOTE_SKILL_REL)).toBe(true);
        const skill = await readSkill(tmpRoot, PROMOTE_SKILL_REL);
        expect(skill.frontmatter.name).toBe("handoff-discipline");
        expect(skill.frontmatter.description).toBe("Handoff discipline for dev roles");
        expect(skill.frontmatter.version).toBe("0.1.0");
        expect(skill.frontmatter.introduced_at).toBe(FIXED_NOW_ISO);
        expect(skill.body).toBe("# Handoff Discipline\n\nAlways emit the handoff phrase on its own line.");
        // Persona now has a ## Skills section with a one-line reference.
        const personaContents = await readPersonaRaw(tmpRoot, "generalist-dev");
        expect(personaContents).toContain("## Skills");
        expect(personaContents).toContain(`- handoff-discipline (${PROMOTE_SKILL_REL}): ${PROMOTE_WHEN_TO_USE}`);
        // The full skill body is NOT present in the persona body.
        expect(personaContents).not.toContain("# Handoff Discipline\n\nAlways emit the handoff phrase on its own line.");
    });
    it("preview renders a diff without writing files", async () => {
        await seedPersona(tmpRoot, "generalist-dev", FIXTURE_PERSONA_MD);
        const handler = handlersByType(() => FIXED_NOW).get("lesson-to-skill");
        const diff = await handler.previewDiff(promoteLessonProposal(), ctxOf(tmpRoot));
        expect(diff).toContain("Promote lesson to skill");
        expect(diff).toContain(PROMOTE_SKILL_REL);
        expect(diff).toContain("team/generalist-dev/PERSONA.md");
        // Nothing written.
        expect(await exists(tmpRoot, PROMOTE_SKILL_REL)).toBe(false);
    });
    it("raises SkillAlreadyExistsError when the skill path is already occupied", async () => {
        await seedPersona(tmpRoot, "generalist-dev", FIXTURE_PERSONA_MD);
        await seedSkill(tmpRoot, { relPath: PROMOTE_SKILL_REL });
        const handler = handlersByType(() => FIXED_NOW).get("lesson-to-skill");
        await expect(handler.apply(promoteLessonProposal(), ctxOf(tmpRoot))).rejects.toBeInstanceOf(SkillAlreadyExistsError);
        // Persona file should be unchanged (skill collision prevents persona write).
        const personaContents = await readPersonaRaw(tmpRoot, "generalist-dev");
        expect(personaContents).not.toContain("## Skills");
    });
    it("appends a second skill-reference when the ## Skills section already exists", async () => {
        // Seed a persona that already has a ## Skills section.
        const personaWithSkills = FIXTURE_PERSONA_MD.replace("## Knowledge\n\n- Always emit the handoff phrase on its own line.\n", "## Knowledge\n\n- Always emit the handoff phrase on its own line.\n\n## Skills\n\n- existing-skill (.flow/skills/existing-skill.md): Use it always.\n");
        await seedPersona(tmpRoot, "generalist-dev", personaWithSkills);
        const handler = handlersByType(() => FIXED_NOW).get("lesson-to-skill");
        await handler.apply(promoteLessonProposal(), ctxOf(tmpRoot));
        const personaContents = await readPersonaRaw(tmpRoot, "generalist-dev");
        expect(personaContents).toContain("- existing-skill (.flow/skills/existing-skill.md): Use it always.");
        expect(personaContents).toContain(`- handoff-discipline (${PROMOTE_SKILL_REL}): ${PROMOTE_WHEN_TO_USE}`);
    });
});
describe("lesson-to-skill end-to-end via acceptProposal gate (AC1 — production registry)", () => {
    it("applies + commits skill + persona + proposal; re-accept no-ops", async () => {
        await seedPersona(tmpRoot, "generalist-dev", FIXTURE_PERSONA_MD);
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [promoteLessonProposal()],
        });
        const git = makeFakeGitCommit("cc00dd11ee22ff33aa44bb5566778899ccddee00");
        // Confirm.
        const applied = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_PROMOTE,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        expect(applied.status).toBe("applied");
        // Skill written.
        expect(await exists(tmpRoot, PROMOTE_SKILL_REL)).toBe(true);
        // Persona updated with skill reference.
        const personaContents = await readPersonaRaw(tmpRoot, "generalist-dev");
        expect(personaContents).toContain("## Skills");
        expect(personaContents).toContain(`- handoff-discipline (${PROMOTE_SKILL_REL}): ${PROMOTE_WHEN_TO_USE}`);
        // Exactly one commit carrying skill + persona + proposal.
        expect(git.calls).toHaveLength(1);
        const committed = git.calls[0];
        expect(committed.paths).toContain(PROMOTE_SKILL_REL);
        expect(committed.paths).toContain("team/generalist-dev/PERSONA.md");
        expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);
        // Idempotent re-accept — no second write, commit, or telemetry.
        const reAccept = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_PROMOTE,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(reAccept.status).toBe("already-applied");
        expect(git.calls).toHaveLength(1);
    });
});
