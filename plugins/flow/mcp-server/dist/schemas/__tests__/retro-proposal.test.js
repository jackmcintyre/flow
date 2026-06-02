/**
 * Schema tests for retro proposals — Story 6.3 AC3–AC8.
 *
 * Covers:
 *   - One happy-path test per variant (seven tests).
 *   - One rejection test per variant (seven tests; missing-field or
 *     out-of-enum per variant rejected via MalformedRetroProposalError).
 *   - Discriminated-union behaviour: cross-variant field smuggling rejected.
 *   - Path-traversal guard on `skill-create.proposed_path`.
 *   - Promotion-level / version-bump / action closed-enum rejections.
 *   - ULID guard on `id`.
 *   - File-level wrapper: empty proposals round-trip, malformed wrapper
 *     fields rejected.
 */
import { describe, expect, it } from "vitest";
import { RETRO_PROPOSAL_TYPES, RetroProposalFileSchema, RetroProposalSchema, parseRetroProposalFile, } from "../retro-proposal.js";
import { MalformedRetroProposalError } from "../../errors.js";
// ---------------------------------------------------------------------------
// Constants / fixtures
// ---------------------------------------------------------------------------
// Real ULIDs are 26 chars in Crockford base32 (A–Z 0–9 minus I L O U).
const ULID = "01HZRETR0000000000000000A1";
const ULID_B = "01HZRETR0000000000000000B2";
const ULID_C = "01HZRETR0000000000000000C3";
const ISO = "2026-05-28T14:32:11.123Z";
const ISO_B = "2026-05-28T14:32:12.123Z";
// Quick guard: the constants above MUST satisfy the ULID regex used in
// the schema (26 chars; A–Z 0–9 minus I L O U). Catch a typo at test-load.
if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ULID)) {
    throw new Error(`ULID fixture is malformed: ${ULID}`);
}
if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ULID_B)) {
    throw new Error(`ULID_B fixture is malformed: ${ULID_B}`);
}
if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ULID_C)) {
    throw new Error(`ULID_C fixture is malformed: ${ULID_C}`);
}
// Helper — assert parser throws MalformedRetroProposalError when wrapping
// `input` in the file-level schema. Catches the typed envelope so tests
// can additionally assert the offending field's yamlPath when useful.
function expectFileRejected(input, msgFragment) {
    try {
        parseRetroProposalFile(input);
        throw new Error("expected parseRetroProposalFile to throw");
    }
    catch (err) {
        if (!(err instanceof MalformedRetroProposalError)) {
            throw new Error(`expected MalformedRetroProposalError, got ${err.constructor.name}: ${String(err)}`);
        }
        if (msgFragment !== undefined) {
            if (typeof msgFragment === "string") {
                expect(err.message).toContain(msgFragment);
            }
            else {
                expect(err.message).toMatch(msgFragment);
            }
        }
    }
}
// Helper — assert a single proposal parses cleanly via the discriminated
// union schema (not the file-level wrapper).
function parseProposal(input) {
    const r = RetroProposalSchema.safeParse(input);
    if (!r.success) {
        throw new Error(`expected proposal to parse, got Zod issues: ${JSON.stringify(r.error.issues)}`);
    }
    return r.data;
}
// Helper — wrap a single proposal as a one-element file (for parser tests).
function fileWith(proposal) {
    return {
        iso_timestamp: ISO,
        cycle_window: null,
        proposals: [proposal],
    };
}
// ---------------------------------------------------------------------------
// AC2 — Closed enum surface invariant
// ---------------------------------------------------------------------------
describe("RetroProposalSchema (AC2 — discriminated union surface)", () => {
    it("exposes exactly seven proposal types", () => {
        expect(RETRO_PROPOSAL_TYPES).toHaveLength(7);
        expect(new Set(RETRO_PROPOSAL_TYPES)).toEqual(new Set([
            "rule",
            "rule-retirement",
            "skill-create",
            "skill-revise",
            "skill-supersede",
            "skill-retire",
            "team-change",
        ]));
    });
    it("rejects an unknown discriminator literal (no z.string() fallback)", () => {
        expectFileRejected(fileWith({
            type: "rule-mutation", // not in the closed set
            id: ULID,
            created_at: ISO,
            rationale: "x",
        }));
    });
    it("rejects a missing discriminator", () => {
        expectFileRejected(fileWith({
            id: ULID,
            created_at: ISO,
            rationale: "x",
            text: "no type field",
            target_failure_class: "fc",
            recommended_promotion_level: "must",
        }));
    });
});
// ---------------------------------------------------------------------------
// AC3 — `rule` variant
// ---------------------------------------------------------------------------
describe("RuleProposalSchema (AC3)", () => {
    const VALID = {
        type: "rule",
        id: ULID,
        created_at: ISO,
        rationale: "Repeated handoff-grammar fires on this story type.",
        text: "Dev MUST emit the handoff phrase verbatim.",
        target_failure_class: "handoff-grammar",
        recommended_promotion_level: "must",
    };
    it("happy path — parses a valid rule proposal", () => {
        const p = parseProposal(VALID);
        expect(p.type).toBe("rule");
        if (p.type === "rule") {
            expect(p.recommended_promotion_level).toBe("must");
        }
    });
    it("rejects a missing recommended_promotion_level", () => {
        const { recommended_promotion_level: _omit, ...rest } = VALID;
        void _omit;
        expectFileRejected(fileWith(rest));
    });
    it("rejects an unknown recommended_promotion_level value", () => {
        expectFileRejected(fileWith({ ...VALID, recommended_promotion_level: "maybe" }));
    });
    it("rejects an empty text field", () => {
        expectFileRejected(fileWith({ ...VALID, text: "" }));
    });
});
// ---------------------------------------------------------------------------
// AC4 — `skill-create` variant + path traversal
// ---------------------------------------------------------------------------
describe("SkillCreateProposalSchema (AC4)", () => {
    const VALID = {
        type: "skill-create",
        id: ULID,
        created_at: ISO,
        rationale: "Operators repeatedly need to do X.",
        proposed_path: ".crew/skills/do-x.md",
        frontmatter_description: "Skill that helps operators do X.",
        body: "# Do X\n\nWhen operators ...",
    };
    it("happy path — parses a valid skill-create proposal", () => {
        const p = parseProposal(VALID);
        expect(p.type).toBe("skill-create");
    });
    it("rejects an absolute proposed_path (leading '/')", () => {
        expectFileRejected(fileWith({ ...VALID, proposed_path: "/etc/passwd" }));
    });
    it("rejects a proposed_path containing '..' segments (traversal)", () => {
        expectFileRejected(fileWith({ ...VALID, proposed_path: "../../etc/passwd" }));
    });
    it("rejects a missing body field", () => {
        const { body: _omit, ...rest } = VALID;
        void _omit;
        expectFileRejected(fileWith(rest));
    });
    it("rejects an empty frontmatter_description", () => {
        expectFileRejected(fileWith({ ...VALID, frontmatter_description: "" }));
    });
});
// ---------------------------------------------------------------------------
// AC5 — `team-change` variant
// ---------------------------------------------------------------------------
describe("TeamChangeProposalSchema (AC5)", () => {
    const VALID = {
        type: "team-change",
        id: ULID,
        created_at: ISO,
        rationale: "Repeated security-review failures suggest hiring a specialist.",
        action: "hire",
        target_role: "security-reviewer",
        justification: "12 security-related NEEDS CHANGES in the last 10 cycles.",
        predicted_impact: {
            affected_failure_classes: ["security-audit", "auth-permissions"],
        },
    };
    it("happy path — parses a valid team-change proposal", () => {
        const p = parseProposal(VALID);
        expect(p.type).toBe("team-change");
        if (p.type === "team-change") {
            expect(p.action).toBe("hire");
            expect(p.predicted_impact.affected_failure_classes).toHaveLength(2);
        }
    });
    it("rejects a non-kebab-cased target_role (Title Case)", () => {
        expectFileRejected(fileWith({ ...VALID, target_role: "SecurityReviewer" }));
    });
    it("rejects a target_role with spaces", () => {
        expectFileRejected(fileWith({ ...VALID, target_role: "security reviewer" }));
    });
    it("rejects an unknown action value", () => {
        expectFileRejected(fileWith({ ...VALID, action: "promote" }));
    });
    it("rejects an empty affected_failure_classes array", () => {
        expectFileRejected(fileWith({
            ...VALID,
            predicted_impact: { affected_failure_classes: [] },
        }));
    });
    it("rejects an empty justification", () => {
        expectFileRejected(fileWith({ ...VALID, justification: "" }));
    });
});
// ---------------------------------------------------------------------------
// AC6 — Four remaining variants
// ---------------------------------------------------------------------------
describe("RuleRetirementProposalSchema (AC6)", () => {
    const VALID = {
        type: "rule-retirement",
        id: ULID,
        created_at: ISO,
        rationale: "Rule fires constantly but never catches anything actionable.",
        target_rule_id: ULID_B,
        fire_count_over_window: 23,
        recommended_action: "retire",
    };
    it("happy path — parses a valid rule-retirement proposal", () => {
        const p = parseProposal(VALID);
        expect(p.type).toBe("rule-retirement");
    });
    it("rejects a missing target_rule_id", () => {
        const { target_rule_id: _omit, ...rest } = VALID;
        void _omit;
        expectFileRejected(fileWith(rest));
    });
    it("rejects a malformed target_rule_id (not a ULID)", () => {
        expectFileRejected(fileWith({ ...VALID, target_rule_id: "not-a-ulid" }));
    });
    it("rejects a negative fire_count_over_window", () => {
        expectFileRejected(fileWith({ ...VALID, fire_count_over_window: -1 }));
    });
    it("rejects an unknown recommended_action", () => {
        expectFileRejected(fileWith({ ...VALID, recommended_action: "delete" }));
    });
});
describe("SkillReviseProposalSchema (AC6)", () => {
    const VALID = {
        type: "skill-revise",
        id: ULID,
        created_at: ISO,
        rationale: "Skill is correct but verbose; tightening saves operator tokens.",
        target_skill_path: ".crew/skills/do-x.md",
        revised_body: "# Do X (revised)\n\nShorter, sharper version.",
        version_bump: "minor",
    };
    it("happy path — parses a valid skill-revise proposal", () => {
        const p = parseProposal(VALID);
        expect(p.type).toBe("skill-revise");
    });
    it("rejects a missing revised_body", () => {
        const { revised_body: _omit, ...rest } = VALID;
        void _omit;
        expectFileRejected(fileWith(rest));
    });
    it("rejects an unknown version_bump", () => {
        expectFileRejected(fileWith({ ...VALID, version_bump: "major" }));
    });
    it("rejects a traversal target_skill_path", () => {
        expectFileRejected(fileWith({ ...VALID, target_skill_path: "../escape.md" }));
    });
});
describe("SkillSupersedeProposalSchema (AC6)", () => {
    const VALID = {
        type: "skill-supersede",
        id: ULID,
        created_at: ISO,
        rationale: "Replacement skill consolidates two overlapping concerns.",
        superseded_skill_path: ".crew/skills/old-x.md",
        replacement: {
            proposed_path: ".crew/skills/new-x.md",
            frontmatter_description: "New consolidated skill.",
            body: "# New X\n\n...",
        },
    };
    it("happy path — parses a valid skill-supersede proposal", () => {
        const p = parseProposal(VALID);
        expect(p.type).toBe("skill-supersede");
        if (p.type === "skill-supersede") {
            expect(p.replacement.proposed_path).toBe(".crew/skills/new-x.md");
        }
    });
    it("rejects a missing replacement", () => {
        const { replacement: _omit, ...rest } = VALID;
        void _omit;
        expectFileRejected(fileWith(rest));
    });
    it("rejects a replacement with a traversal proposed_path", () => {
        expectFileRejected(fileWith({
            ...VALID,
            replacement: { ...VALID.replacement, proposed_path: "../bad.md" },
        }));
    });
    it("rejects a replacement with an unknown extra key (.strict)", () => {
        expectFileRejected(fileWith({
            ...VALID,
            replacement: { ...VALID.replacement, extraneous: "key" },
        }));
    });
});
describe("SkillRetireProposalSchema (AC6)", () => {
    const VALID_WITH_DATE = {
        type: "skill-retire",
        id: ULID,
        created_at: ISO,
        rationale: "Skill has not fired in the last six cycles; retire it.",
        target_skill_path: ".crew/skills/old-x.md",
        last_invoked_at: ISO_B,
    };
    const VALID_NULL = {
        ...VALID_WITH_DATE,
        last_invoked_at: null,
    };
    it("happy path — parses a valid skill-retire proposal with a date", () => {
        const p = parseProposal(VALID_WITH_DATE);
        expect(p.type).toBe("skill-retire");
        if (p.type === "skill-retire") {
            expect(p.last_invoked_at).toBe(ISO_B);
        }
    });
    it("happy path — parses last_invoked_at: null (never fired)", () => {
        const p = parseProposal(VALID_NULL);
        expect(p.type).toBe("skill-retire");
        if (p.type === "skill-retire") {
            expect(p.last_invoked_at).toBeNull();
        }
    });
    it("rejects a missing last_invoked_at (must be explicit null)", () => {
        const { last_invoked_at: _omit, ...rest } = VALID_WITH_DATE;
        void _omit;
        expectFileRejected(fileWith(rest));
    });
    it("rejects a non-ISO last_invoked_at string", () => {
        expectFileRejected(fileWith({ ...VALID_WITH_DATE, last_invoked_at: "yesterday" }));
    });
});
// ---------------------------------------------------------------------------
// AC2 / AC8 — Discriminated-union smuggle guard
// ---------------------------------------------------------------------------
describe("discriminator-based field smuggling (AC8)", () => {
    it("rejects a rule proposal carrying a skill-create's proposed_path", () => {
        // `type: "rule"` plus a skill-create-only field. `.strict()` on the rule
        // variant rejects the unknown key.
        expectFileRejected(fileWith({
            type: "rule",
            id: ULID,
            created_at: ISO,
            rationale: "x",
            text: "rule text",
            target_failure_class: "fc",
            recommended_promotion_level: "must",
            // Smuggled skill-create field:
            proposed_path: ".crew/skills/x.md",
        }));
    });
    it("rejects a skill-create proposal carrying a team-change's predicted_impact", () => {
        expectFileRejected(fileWith({
            type: "skill-create",
            id: ULID,
            created_at: ISO,
            rationale: "x",
            proposed_path: ".crew/skills/x.md",
            frontmatter_description: "desc",
            body: "body",
            // Smuggled:
            predicted_impact: { affected_failure_classes: ["x"] },
        }));
    });
});
// ---------------------------------------------------------------------------
// ULID + ISO base guards
// ---------------------------------------------------------------------------
describe("ProposalBase guards", () => {
    const BASE_RULE_VALID = {
        type: "rule",
        id: ULID,
        created_at: ISO,
        rationale: "x",
        text: "t",
        target_failure_class: "fc",
        recommended_promotion_level: "must",
    };
    it("rejects a malformed id (wrong length)", () => {
        expectFileRejected(fileWith({ ...BASE_RULE_VALID, id: "tooShort" }));
    });
    it("rejects a malformed id (lowercase)", () => {
        expectFileRejected(fileWith({ ...BASE_RULE_VALID, id: ULID.toLowerCase() }));
    });
    it("rejects an empty rationale", () => {
        expectFileRejected(fileWith({ ...BASE_RULE_VALID, rationale: "" }));
    });
    it("rejects a non-UTC created_at (offset form)", () => {
        expectFileRejected(fileWith({ ...BASE_RULE_VALID, created_at: "2026-05-28T14:32:11+02:00" }));
    });
    it("rejects a malformed created_at (not ISO)", () => {
        expectFileRejected(fileWith({ ...BASE_RULE_VALID, created_at: "2026-05-28" }));
    });
});
// ---------------------------------------------------------------------------
// AC7 — File-level wrapper
// ---------------------------------------------------------------------------
describe("RetroProposalFileSchema (AC7)", () => {
    it("happy path — empty proposals array round-trips through the parser", () => {
        const file = parseRetroProposalFile({
            iso_timestamp: ISO,
            cycle_window: null,
            proposals: [],
        });
        expect(file.proposals).toEqual([]);
        expect(file.iso_timestamp).toBe(ISO);
        expect(file.cycle_window).toBeNull();
    });
    it("happy path — cycle_window present", () => {
        const file = parseRetroProposalFile({
            iso_timestamp: ISO,
            cycle_window: { from: ISO, to: ISO_B },
            proposals: [],
        });
        expect(file.cycle_window).toEqual({ from: ISO, to: ISO_B });
    });
    it("rejects a missing iso_timestamp", () => {
        expectFileRejected({ cycle_window: null, proposals: [] });
    });
    it("rejects an unknown top-level key (.strict)", () => {
        expectFileRejected({
            iso_timestamp: ISO,
            cycle_window: null,
            proposals: [],
            extra: "key",
        });
    });
    it("rejects a malformed cycle_window (missing 'to')", () => {
        expectFileRejected({
            iso_timestamp: ISO,
            cycle_window: { from: ISO },
            proposals: [],
        });
    });
    it("rejects an unknown key inside cycle_window (.strict)", () => {
        expectFileRejected({
            iso_timestamp: ISO,
            cycle_window: { from: ISO, to: ISO_B, midpoint: ISO },
            proposals: [],
        });
    });
    it("parses a file with a mixed list of proposal types", () => {
        const file = parseRetroProposalFile({
            iso_timestamp: ISO,
            cycle_window: null,
            proposals: [
                {
                    type: "rule",
                    id: ULID,
                    created_at: ISO,
                    rationale: "r1",
                    text: "rule text",
                    target_failure_class: "fc",
                    recommended_promotion_level: "must",
                },
                {
                    type: "team-change",
                    id: ULID_B,
                    created_at: ISO,
                    rationale: "r2",
                    action: "hire",
                    target_role: "qa-specialist",
                    justification: "j",
                    predicted_impact: { affected_failure_classes: ["qa-flake"] },
                },
                {
                    type: "skill-retire",
                    id: ULID_C,
                    created_at: ISO,
                    rationale: "r3",
                    target_skill_path: ".crew/skills/never-fires.md",
                    last_invoked_at: null,
                },
            ],
        });
        expect(file.proposals).toHaveLength(3);
        expect(file.proposals.map((p) => p.type)).toEqual([
            "rule",
            "team-change",
            "skill-retire",
        ]);
    });
    it("schema-level: RetroProposalFileSchema parses identically to the helper", () => {
        // Confirms the helper is a thin wrapper around the schema; no extra
        // validation gets done elsewhere.
        const input = { iso_timestamp: ISO, cycle_window: null, proposals: [] };
        const fromHelper = parseRetroProposalFile(input);
        const fromSchema = RetroProposalFileSchema.parse(input);
        expect(fromHelper).toEqual(fromSchema);
    });
});
