/**
 * Writer tests for `writeRetroProposal` — Story 6.3 AC1 / AC8.
 *
 * Covers:
 *   - Happy path: write a file with mixed proposal types; read back;
 *     frontmatter round-trips through `parseRetroProposalFile`; body H2
 *     count equals the proposal count.
 *   - Collision: writing twice with the same `isoTimestamp` throws
 *     `RetroProposalAlreadyExistsError`; the original file is unchanged.
 *   - Empty proposals: produces a valid file with `proposals: []` and a
 *     body containing the "No proposals produced this cycle." sentence.
 *   - Path-traversal in `isoTimestamp`: `"../escape"` and similar rejected
 *     at the writer boundary via the IsoTimestamp schema, before any
 *     path-forming or filesystem op.
 *   - Cycle window present round-trip.
 *   - Idempotency-of-rendering: stringification is byte-stable for the
 *     same inputs (no random ordering).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { MalformedRetroProposalError, RetroProposalAlreadyExistsError, } from "../../errors.js";
import { parseRetroProposalFile } from "../../schemas/retro-proposal.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ULID_A = "01HZRETR0000000000000000A1";
const ULID_B = "01HZRETR0000000000000000B2";
const ULID_C = "01HZRETR0000000000000000C3";
const ISO = "2026-05-28T14:32:11.123Z";
const ISO_FROM = "2026-05-28T12:00:00.000Z";
const ISO_TO = "2026-05-28T14:00:00.000Z";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const RULE_PROPOSAL = {
    type: "rule",
    id: ULID_A,
    created_at: ISO,
    rationale: "Repeated handoff-grammar fires on this story type.",
    text: "Dev MUST emit the handoff phrase verbatim.",
    target_failure_class: "handoff-grammar",
    recommended_promotion_level: "must",
};
const SKILL_CREATE_PROPOSAL = {
    type: "skill-create",
    id: ULID_B,
    created_at: ISO,
    rationale: "Operators need a wrapper for X.",
    proposed_path: ".crew/skills/do-x.md",
    frontmatter_description: "Skill that helps operators do X.",
    body: "# Do X\n\nDetailed body line 1.\nLine 2.\nLine 3.\n",
};
const TEAM_CHANGE_PROPOSAL = {
    type: "team-change",
    id: ULID_C,
    created_at: ISO,
    rationale: "Repeated security-related verdicts.",
    action: "hire",
    target_role: "security-reviewer",
    justification: "12 fires in the last 10 cycles.",
    predicted_impact: { affected_failure_classes: ["security-audit"] },
};
// ---------------------------------------------------------------------------
// Tmpdir helpers
// ---------------------------------------------------------------------------
let tmpRoot;
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-proposal-"));
});
afterEach(async () => {
    // Best-effort cleanup; tolerate ENOENT in case a test consumed the dir.
    try {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    }
    catch {
        /* swallow */
    }
});
/**
 * Read a written proposal file and split its frontmatter / body.
 * Throws if the on-disk shape doesn't have the expected `---\n...\n---\n\n<body>`
 * structure (which would itself be a regression).
 */
async function readWrittenFile(absPath) {
    const raw = await fs.readFile(absPath, "utf8");
    // Expected shape: `---\n<frontmatter>---\n\n<body>`.
    if (!raw.startsWith("---\n")) {
        throw new Error(`written file does not start with '---\\n' frontmatter fence: ${raw.slice(0, 50)}`);
    }
    const rest = raw.slice("---\n".length);
    const closeIdx = rest.indexOf("\n---\n");
    if (closeIdx < 0) {
        throw new Error(`written file does not contain a closing '---\\n' fence: ${raw.slice(0, 200)}`);
    }
    const frontmatter = rest.slice(0, closeIdx + 1); // include trailing \n
    const body = rest.slice(closeIdx + "\n---\n".length).replace(/^\n/, "");
    return { frontmatter, body, raw };
}
// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("writeRetroProposal — happy path (AC1, AC8)", () => {
    it("writes a single file with mixed proposal types under .flow/retro-proposals/", async () => {
        const result = await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [RULE_PROPOSAL, SKILL_CREATE_PROPOSAL, TEAM_CHANGE_PROPOSAL],
        });
        const expectedPath = path.join(tmpRoot, ".flow", "retro-proposals", `${ISO}.md`);
        expect(result.absPath).toBe(expectedPath);
        expect(result.proposalCount).toBe(3);
        // File exists.
        await fs.access(result.absPath);
        // Read back and inspect.
        const { frontmatter, body } = await readWrittenFile(result.absPath);
        // Frontmatter round-trips through the schema parser.
        const parsedYaml = yamlParse(frontmatter);
        const file = parseRetroProposalFile(parsedYaml);
        expect(file.iso_timestamp).toBe(ISO);
        expect(file.cycle_window).toBeNull();
        expect(file.proposals).toHaveLength(3);
        expect(file.proposals.map((p) => p.type)).toEqual([
            "rule",
            "skill-create",
            "team-change",
        ]);
        // Body sanity: H2 per proposal + correct header timestamp.
        const h2Count = (body.match(/^## /gm) ?? []).length;
        expect(h2Count).toBe(3);
        expect(body).toContain(`# Retro proposals — ${ISO}`);
        expect(body).toContain(`Proposals: 3`);
        expect(body).toContain("Cycle window: Not specified");
    });
    it("creates the parent directory if absent (mkdir -p)", async () => {
        // Confirm the parent doesn't exist beforehand.
        const expectedDir = path.join(tmpRoot, ".flow", "retro-proposals");
        await expect(fs.access(expectedDir)).rejects.toThrow();
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [],
        });
        // Now the dir is present.
        await fs.access(expectedDir);
    });
    it("round-trips a cycle_window through the frontmatter", async () => {
        const { absPath } = await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [],
            cycleWindow: { from: ISO_FROM, to: ISO_TO },
        });
        const { frontmatter, body } = await readWrittenFile(absPath);
        const file = parseRetroProposalFile(yamlParse(frontmatter));
        expect(file.cycle_window).toEqual({ from: ISO_FROM, to: ISO_TO });
        expect(body).toContain(`Cycle window: ${ISO_FROM} → ${ISO_TO}`);
    });
});
// ---------------------------------------------------------------------------
// Empty proposals
// ---------------------------------------------------------------------------
describe("writeRetroProposal — empty proposals (AC7)", () => {
    it("writes a valid file with proposals: [] and the 'No proposals' sentence", async () => {
        const { absPath, proposalCount } = await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [],
        });
        expect(proposalCount).toBe(0);
        const { frontmatter, body } = await readWrittenFile(absPath);
        const file = parseRetroProposalFile(yamlParse(frontmatter));
        expect(file.proposals).toEqual([]);
        expect(body).toContain("No proposals produced this cycle.");
        expect(body).toContain("Proposals: 0");
        // No H2 sections when there are no proposals.
        expect(body.match(/^## /gm)).toBeNull();
    });
});
// ---------------------------------------------------------------------------
// Collision refusal
// ---------------------------------------------------------------------------
describe("writeRetroProposal — collision refusal (AC1)", () => {
    it("throws RetroProposalAlreadyExistsError on a duplicate timestamp", async () => {
        const first = await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [RULE_PROPOSAL],
        });
        const firstRaw = await fs.readFile(first.absPath, "utf8");
        await expect(writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [TEAM_CHANGE_PROPOSAL],
        })).rejects.toBeInstanceOf(RetroProposalAlreadyExistsError);
        // Original file is unchanged — no silent overwrite.
        const afterRaw = await fs.readFile(first.absPath, "utf8");
        expect(afterRaw).toBe(firstRaw);
    });
    it("error carries absPath and isoTimestamp for caller diagnostics", async () => {
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [],
        });
        try {
            await writeRetroProposal({
                targetRepoRoot: tmpRoot,
                isoTimestamp: ISO,
                proposals: [],
            });
            throw new Error("expected throw");
        }
        catch (err) {
            expect(err).toBeInstanceOf(RetroProposalAlreadyExistsError);
            const typed = err;
            expect(typed.isoTimestamp).toBe(ISO);
            expect(typed.absPath).toBe(path.join(tmpRoot, ".flow", "retro-proposals", `${ISO}.md`));
        }
    });
});
// ---------------------------------------------------------------------------
// Path-traversal defense (writer boundary)
// ---------------------------------------------------------------------------
describe("writeRetroProposal — path-traversal in isoTimestamp (AC8)", () => {
    it("rejects '../escape' before any filesystem op", async () => {
        await expect(writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: "../escape",
            proposals: [],
        })).rejects.toBeInstanceOf(MalformedRetroProposalError);
        // No directory was created — proves the writer halted before
        // mkdir-p and any filesystem touch.
        await expect(fs.access(path.join(tmpRoot, ".flow", "retro-proposals"))).rejects.toThrow();
    });
    it("rejects an empty isoTimestamp", async () => {
        await expect(writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: "",
            proposals: [],
        })).rejects.toBeInstanceOf(MalformedRetroProposalError);
    });
    it("rejects a non-UTC ISO timestamp (offset form)", async () => {
        await expect(writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: "2026-05-28T14:32:11+02:00",
            proposals: [],
        })).rejects.toBeInstanceOf(MalformedRetroProposalError);
    });
    it("propagates schema rejections for invalid proposals", async () => {
        await expect(writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [
                {
                    // Missing required field for a `rule` variant.
                    type: "rule",
                    id: ULID_A,
                    created_at: ISO,
                    rationale: "x",
                    text: "t",
                    target_failure_class: "fc",
                    // No recommended_promotion_level
                },
            ],
        })).rejects.toBeInstanceOf(MalformedRetroProposalError);
    });
    it("propagates schema rejection for a path-traversal in skill-create.proposed_path", async () => {
        await expect(writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [
                {
                    type: "skill-create",
                    id: ULID_A,
                    created_at: ISO,
                    rationale: "x",
                    proposed_path: "../../etc/passwd",
                    frontmatter_description: "d",
                    body: "b",
                },
            ],
        })).rejects.toBeInstanceOf(MalformedRetroProposalError);
    });
});
// ---------------------------------------------------------------------------
// Idempotency-of-rendering
// ---------------------------------------------------------------------------
describe("writeRetroProposal — byte-stable rendering", () => {
    it("produces identical bytes for identical inputs across two distinct tmpdirs", async () => {
        const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), "retro-proposal-id-"));
        const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), "retro-proposal-id-"));
        try {
            const a = await writeRetroProposal({
                targetRepoRoot: tmpA,
                isoTimestamp: ISO,
                proposals: [RULE_PROPOSAL, SKILL_CREATE_PROPOSAL],
            });
            const b = await writeRetroProposal({
                targetRepoRoot: tmpB,
                isoTimestamp: ISO,
                proposals: [RULE_PROPOSAL, SKILL_CREATE_PROPOSAL],
            });
            const rawA = await fs.readFile(a.absPath, "utf8");
            const rawB = await fs.readFile(b.absPath, "utf8");
            expect(rawA).toBe(rawB);
        }
        finally {
            await fs.rm(tmpA, { recursive: true, force: true });
            await fs.rm(tmpB, { recursive: true, force: true });
        }
    });
});
