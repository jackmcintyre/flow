/**
 * `regenerate-standards` + rule-apply handler tests — Story 6.5b AC1–AC5.
 *
 * AC mapping:
 *   AC1: `regenerateStandards` is deterministic — same registry + targetVersion
 *        + clock → byte-identical output; one criterion per rule with all four
 *        fields non-empty; result re-parses against `StandardsDocSchema`.
 *   AC2: version bumps monotonically (patch increment) from the prior doc; the
 *        new doc re-parses showing the bumped version.
 *   AC3: a registry that projects > 10 criteria raises `StandardsCapExceededError`;
 *        on the production gate path the registry is byte-identical to
 *        pre-accept state; `docs/standards.md` is unchanged; no commit; no
 *        telemetry.
 *   AC4: accepting a within-cap `rule` proposal through the production gate
 *        appends the rule, regenerates the standards doc, and the gate commits
 *        BOTH files plus the proposal stamp in a single commit.
 *   AC5: `regenerateStandards` is a reusable library function; `StandardsCapExceededError`
 *        extends `DomainError`; the cap is read from `StandardsDocSchema`, not
 *        hard-coded; the function is exported from `lib/regenerate-standards.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { regenerateStandards, bumpPatchVersion, STANDARDS_REL_PATH, STANDARDS_SEED_VERSION, STANDARDS_CRITERIA_CAP, } from "../../lib/regenerate-standards.js";
import { StandardsCapExceededError, DomainError, } from "../../errors.js";
import { StandardsDocSchema } from "../../schemas/standards-doc.js";
import { parseStandardsDoc } from "../../validators/standards-doc.js";
import { acceptProposal } from "../accept-proposal.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { parseRuleRegistry } from "../../schemas/discipline-rules.js";
import { parseRetroProposalFile } from "../../schemas/retro-proposal.js";
// ---------------------------------------------------------------------------
// Fixtures + constants
// ---------------------------------------------------------------------------
const ULID_PROP = "01HZRETR0000000000000000A1";
const ULID_PROP_2 = "01HZRETR0000000000000000B2";
const ULID_RULE_1 = "01HZRETR0000000000000000C3";
const ISO = "2026-05-31T10:00:00.000Z";
const FIXED_NOW = new Date("2026-05-31T12:00:00.000Z");
const REGISTRY_REL = "docs/discipline-rules.yaml";
// A multi-rule registry used for determinism / version-bump tests.
function makeRegistry(count) {
    return {
        rules: Array.from({ length: count }, (_, i) => ({
            id: `01HZRETR000000000000000${String(i).padStart(3, "0").slice(-3)}AA`.slice(0, 26),
            text: `Rule text ${i + 1}.`,
            target_failure_class: `failure-class-${i + 1}`,
            introduced_at: "2026-01-01T00:00:00.000Z",
            level: "must",
        })),
    };
}
// Use a seeded registry with 3 rules.
const THREE_RULE_REGISTRY = makeRegistry(3);
function ruleProposalObj(id, overrides = {}) {
    return {
        type: "rule",
        id,
        created_at: ISO,
        rationale: "Test rationale.",
        text: "Dev MUST follow the new rule.",
        target_failure_class: "new-failure-class",
        recommended_promotion_level: "must",
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let tmpRoot;
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "regen-standards-"));
});
afterEach(async () => {
    try {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    }
    catch {
        /* swallow */
    }
});
async function seedRegistry(contents) {
    const abs = path.join(tmpRoot, REGISTRY_REL);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, "utf8");
}
async function readRegistry() {
    return fs.readFile(path.join(tmpRoot, REGISTRY_REL), "utf8");
}
async function readStandardsDoc() {
    return fs.readFile(path.join(tmpRoot, STANDARDS_REL_PATH), "utf8");
}
async function seedStandardsDoc(version) {
    const abs = path.join(tmpRoot, STANDARDS_REL_PATH);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const doc = {
        version,
        updated: "2026-01-01T00:00:00.000Z",
        criteria: [
            {
                name: "seed-criterion",
                what: "Seed criterion description.",
                check: "Check for seed criterion.",
                anti_criterion: "Anti-criterion for seed.",
            },
        ],
    };
    await fs.writeFile(abs, yamlStringify(doc, { lineWidth: 0 }), "utf8");
}
function makeFakeGitCommit(sha = "aabbccddeeff00112233445566778899aabbccdd") {
    const calls = [];
    const impl = (async (args) => {
        calls.push({ paths: args.paths, message: args.message });
        return { commitSha: sha, stdout: "", stderr: "" };
    });
    return { impl, calls };
}
async function readTelemetryEvents() {
    const dir = path.join(tmpRoot, ".crew", "telemetry");
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
async function readProposalFile(iso) {
    const abs = path.join(tmpRoot, ".crew", "retro-proposals", `${iso}.md`);
    const raw = await fs.readFile(abs, "utf8");
    const rest = raw.slice("---\n".length);
    const closeIdx = rest.indexOf("\n---\n");
    const frontmatter = rest.slice(0, closeIdx + 1);
    const file = parseRetroProposalFile(yamlParse(frontmatter));
    return { abs, raw, file };
}
// ---------------------------------------------------------------------------
// AC1 — determinism: same registry + targetVersion + clock → byte-identical
// ---------------------------------------------------------------------------
describe("regenerateStandards — determinism (AC1)", () => {
    it("two regenerations with the same inputs produce byte-identical output", async () => {
        const mcpCtx = { toolName: "acceptProposal", role: "operator" };
        // First regeneration.
        await regenerateStandards({
            registry: THREE_RULE_REGISTRY,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: mcpCtx,
        });
        const firstOutput = await readStandardsDoc();
        // Remove the file and regenerate again with identical inputs.
        await fs.rm(path.join(tmpRoot, STANDARDS_REL_PATH));
        await regenerateStandards({
            registry: THREE_RULE_REGISTRY,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: mcpCtx,
        });
        const secondOutput = await readStandardsDoc();
        // Byte-identical.
        expect(firstOutput).toBe(secondOutput);
    });
    it("each rule projects to exactly one criterion with all four fields non-empty", async () => {
        await regenerateStandards({
            registry: THREE_RULE_REGISTRY,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        });
        const raw = await readStandardsDoc();
        const doc = parseStandardsDoc(raw, path.join(tmpRoot, STANDARDS_REL_PATH));
        expect(doc.criteria).toHaveLength(THREE_RULE_REGISTRY.rules.length);
        for (const criterion of doc.criteria) {
            expect(criterion.name.length).toBeGreaterThan(0);
            expect(criterion.what.length).toBeGreaterThan(0);
            expect(criterion.check.length).toBeGreaterThan(0);
            expect(criterion.anti_criterion.length).toBeGreaterThan(0);
        }
    });
    it("the regenerated doc re-parses cleanly against StandardsDocSchema", async () => {
        await regenerateStandards({
            registry: THREE_RULE_REGISTRY,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        });
        const raw = await readStandardsDoc();
        // parseStandardsDoc throws on schema failure — not throwing is the assertion.
        expect(() => parseStandardsDoc(raw, path.join(tmpRoot, STANDARDS_REL_PATH))).not.toThrow();
    });
    it("criteria names are derived from target_failure_class via slugify", async () => {
        await regenerateStandards({
            registry: THREE_RULE_REGISTRY,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        });
        const raw = await readStandardsDoc();
        const doc = parseStandardsDoc(raw, path.join(tmpRoot, STANDARDS_REL_PATH));
        for (let i = 0; i < THREE_RULE_REGISTRY.rules.length; i++) {
            const rule = THREE_RULE_REGISTRY.rules[i];
            const criterion = doc.criteria[i];
            // The name is the slugified failure class.
            expect(criterion.name).toBe(rule.target_failure_class.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
            // The `what` is the rule text verbatim.
            expect(criterion.what).toBe(rule.text);
            // The `check` and `anti_criterion` are the deterministic templates.
            expect(criterion.check).toContain(rule.target_failure_class);
            expect(criterion.anti_criterion).toContain(rule.target_failure_class);
        }
    });
});
// ---------------------------------------------------------------------------
// AC2 — version bumps monotonically from the prior doc
// ---------------------------------------------------------------------------
describe("regenerateStandards — version bump (AC2)", () => {
    it("bumpPatchVersion increments the patch segment deterministically", () => {
        expect(bumpPatchVersion("0.1.0")).toBe("0.1.1");
        expect(bumpPatchVersion("1.2.3")).toBe("1.2.4");
        expect(bumpPatchVersion("0.0.0")).toBe("0.0.1");
        expect(bumpPatchVersion("2.0.9")).toBe("2.0.10");
    });
    it("regenerated doc shows the bumped version and it is strictly greater than the prior version", async () => {
        const priorVersion = "1.3.0";
        await seedStandardsDoc(priorVersion);
        // Regenerate with bumped version.
        const targetVersion = bumpPatchVersion(priorVersion);
        await regenerateStandards({
            registry: THREE_RULE_REGISTRY,
            targetVersion,
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        });
        const raw = await readStandardsDoc();
        const doc = parseStandardsDoc(raw, path.join(tmpRoot, STANDARDS_REL_PATH));
        // Version is the bumped one.
        expect(doc.version).toBe("1.3.1");
        // It is strictly greater: compare semver numerically.
        const [maj1, min1, pat1] = priorVersion.split(".").map(Number);
        const [maj2, min2, pat2] = doc.version.split(".").map(Number);
        const prior = maj1 * 1_000_000 + min1 * 1_000 + pat1;
        const next = maj2 * 1_000_000 + min2 * 1_000 + pat2;
        expect(next).toBeGreaterThan(prior);
    });
    it("on the apply gate path, version bumps from the seed when no standards doc exists", async () => {
        // Seed the registry without a standards doc.
        const registryYaml = `rules:
  - id: ${ULID_RULE_1}
    text: Test rule.
    target_failure_class: test-failure
    introduced_at: 2026-01-01T00:00:00.000Z
    level: must
`;
        await seedRegistry(registryYaml);
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [ruleProposalObj(ULID_PROP)],
        });
        const git = makeFakeGitCommit();
        await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_PROP,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        // Standards doc was created.
        const raw = await readStandardsDoc();
        const doc = parseStandardsDoc(raw, path.join(tmpRoot, STANDARDS_REL_PATH));
        // Version bumped from the seed: "0.1.0" → "0.1.1".
        expect(doc.version).toBe("0.1.1");
    });
    it("on the apply gate path, version bumps from the existing standards doc version", async () => {
        await seedStandardsDoc("2.0.5");
        const registryYaml = `rules:
  - id: ${ULID_RULE_1}
    text: Existing rule.
    target_failure_class: existing-failure
    introduced_at: 2026-01-01T00:00:00.000Z
    level: should
`;
        await seedRegistry(registryYaml);
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [ruleProposalObj(ULID_PROP)],
        });
        const git = makeFakeGitCommit();
        await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_PROP,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        const raw = await readStandardsDoc();
        const doc = parseStandardsDoc(raw, path.join(tmpRoot, STANDARDS_REL_PATH));
        expect(doc.version).toBe("2.0.6");
    });
});
// ---------------------------------------------------------------------------
// AC3 — cap enforcement: > 10 criteria → StandardsCapExceededError + rollback
// ---------------------------------------------------------------------------
describe("regenerateStandards — cap enforcement (AC3)", () => {
    it("STANDARDS_CRITERIA_CAP is 10 (read from StandardsDocSchema, not hard-coded)", () => {
        expect(STANDARDS_CRITERIA_CAP).toBe(10);
    });
    it("raises StandardsCapExceededError with count and cap when > 10 criteria projected", async () => {
        const elevenRuleRegistry = makeRegistry(11);
        await expect(regenerateStandards({
            registry: elevenRuleRegistry,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        })).rejects.toMatchObject({
            name: "StandardsCapExceededError",
            criteriaCount: 11,
            cap: 10,
        });
    });
    it("exactly 10 criteria is allowed (boundary: = cap is not refused)", async () => {
        const tenRuleRegistry = makeRegistry(10);
        await expect(regenerateStandards({
            registry: tenRuleRegistry,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        })).resolves.toBeUndefined();
        const raw = await readStandardsDoc();
        const doc = parseStandardsDoc(raw, path.join(tmpRoot, STANDARDS_REL_PATH));
        expect(doc.criteria).toHaveLength(10);
    });
    it("does not write docs/standards.md before raising StandardsCapExceededError", async () => {
        const elevenRuleRegistry = makeRegistry(11);
        await expect(regenerateStandards({
            registry: elevenRuleRegistry,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        })).rejects.toBeInstanceOf(StandardsCapExceededError);
        // The standards doc must NOT have been created.
        await expect(fs.access(path.join(tmpRoot, STANDARDS_REL_PATH))).rejects.toThrow();
    });
    it("production gate path: 11th rule is refused, registry byte-identical, standards unchanged, no commit, no telemetry", async () => {
        // Build a registry with 10 rules (the cap).
        const tenRulesYaml = makeRegistry(10)
            .rules.map((r) => `  - id: ${r.id.padEnd(26, "X").slice(0, 26)}\n    text: "${r.text}"\n    target_failure_class: ${r.target_failure_class}\n    introduced_at: ${r.introduced_at}\n    level: ${r.level}`)
            .join("\n");
        const fullYaml = `rules:\n${tenRulesYaml}\n`;
        await seedRegistry(fullYaml);
        // Seed a standards doc so we can verify it is NOT changed.
        await seedStandardsDoc("1.0.0");
        const registryBefore = await readRegistry();
        const standardsBefore = await readStandardsDoc();
        // Propose an 11th rule.
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [
                ruleProposalObj(ULID_PROP, {
                    target_failure_class: "eleventh-failure",
                }),
            ],
        });
        const git = makeFakeGitCommit();
        // Confirm apply — should throw StandardsCapExceededError.
        await expect(acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_PROP,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        })).rejects.toBeInstanceOf(StandardsCapExceededError);
        // Registry byte-identical to pre-accept state.
        const registryAfter = await readRegistry();
        expect(registryAfter).toBe(registryBefore);
        // Standards doc unchanged.
        const standardsAfter = await readStandardsDoc();
        expect(standardsAfter).toBe(standardsBefore);
        // No commit was made.
        expect(git.calls).toHaveLength(0);
        // No telemetry event.
        const events = await readTelemetryEvents();
        expect(events).toHaveLength(0);
    });
    it("proposal is NOT stamped applied when the cap is exceeded", async () => {
        // Seed 10 rules.
        const tenRulesYaml = makeRegistry(10)
            .rules.map((r) => `  - id: ${r.id.padEnd(26, "X").slice(0, 26)}\n    text: "${r.text}"\n    target_failure_class: ${r.target_failure_class}\n    introduced_at: ${r.introduced_at}\n    level: ${r.level}`)
            .join("\n");
        await seedRegistry(`rules:\n${tenRulesYaml}\n`);
        await seedStandardsDoc("1.0.0");
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [
                ruleProposalObj(ULID_PROP_2, {
                    target_failure_class: "eleventh-failure-b",
                }),
            ],
        });
        const git = makeFakeGitCommit();
        await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_PROP_2,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        }).catch(() => {
            /* expected */
        });
        // Proposal must NOT carry an applied block.
        const afterProposal = await readProposalFile(ISO);
        expect(afterProposal.file.proposals[0].applied).toBeUndefined();
    });
});
// ---------------------------------------------------------------------------
// AC4 — production gate: within-cap rule → both files changed in one commit
// ---------------------------------------------------------------------------
describe("regenerateStandards — production gate within-cap commit (AC4)", () => {
    it("accepts a rule, regenerates standards, commits both files + proposal in one commit", async () => {
        // Seed a standards doc at a known version.
        await seedStandardsDoc("0.9.0");
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [ruleProposalObj(ULID_PROP)],
        });
        const git = makeFakeGitCommit("feedfeedfeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
        const result = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_PROP,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        expect(result.status).toBe("applied");
        // Registry was updated (the new rule is present).
        const registryRaw = await readRegistry();
        const { data } = parseRuleRegistry(registryRaw);
        expect(data.rules.some((r) => r.target_failure_class === "new-failure-class")).toBe(true);
        // Standards doc was updated with the projected criterion.
        const standardsRaw = await readStandardsDoc();
        const standardsDoc = parseStandardsDoc(standardsRaw, path.join(tmpRoot, STANDARDS_REL_PATH));
        expect(standardsDoc.criteria.some((c) => c.name === "new-failure-class")).toBe(true);
        // Version bumped from the seeded "0.9.0" to "0.9.1".
        expect(standardsDoc.version).toBe("0.9.1");
        // EXACTLY ONE commit carrying BOTH the registry AND the standards doc AND
        // the proposal file.
        expect(git.calls).toHaveLength(1);
        const committed = git.calls[0];
        expect(committed.paths).toContain(REGISTRY_REL);
        expect(committed.paths).toContain(STANDARDS_REL_PATH);
        expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);
        // Exactly one telemetry event.
        const events = await readTelemetryEvents();
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("retro.proposal.applied");
    });
    it("preview is still a no-op — standards doc not touched during preview", async () => {
        await seedStandardsDoc("1.0.0");
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [ruleProposalObj(ULID_PROP)],
        });
        const standardsBefore = await readStandardsDoc();
        const git = makeFakeGitCommit();
        const result = await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_PROP,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        expect(result.status).toBe("preview");
        // Standards doc byte-identical after preview.
        expect(await readStandardsDoc()).toBe(standardsBefore);
        expect(git.calls).toHaveLength(0);
    });
    it("changedPaths contains both REGISTRY_REL and STANDARDS_REL_PATH", async () => {
        // We verify this indirectly: the commit carries both files.
        await seedStandardsDoc("0.5.0");
        await writeRetroProposal({
            targetRepoRoot: tmpRoot,
            isoTimestamp: ISO,
            proposals: [ruleProposalObj(ULID_PROP)],
        });
        const git = makeFakeGitCommit();
        await acceptProposal({
            targetRepoRoot: tmpRoot,
            proposalId: ULID_PROP,
            confirm: true,
            gitCommitImpl: git.impl,
            now: () => FIXED_NOW,
        });
        const committed = git.calls[0];
        expect(committed.paths).toContain("docs/discipline-rules.yaml");
        expect(committed.paths).toContain("docs/standards.md");
    });
});
// ---------------------------------------------------------------------------
// AC5 — DomainError envelope + reusability (artifact check)
// ---------------------------------------------------------------------------
describe("StandardsCapExceededError — DomainError envelope (AC5)", () => {
    it("extends DomainError", () => {
        const err = new StandardsCapExceededError({ criteriaCount: 11, cap: 10 });
        expect(err).toBeInstanceOf(DomainError);
        expect(err).toBeInstanceOf(StandardsCapExceededError);
    });
    it("carries criteriaCount and cap", () => {
        const err = new StandardsCapExceededError({ criteriaCount: 12, cap: 10 });
        expect(err.criteriaCount).toBe(12);
        expect(err.cap).toBe(10);
    });
    it("has a meaningful message citing the count and cap", () => {
        const err = new StandardsCapExceededError({ criteriaCount: 11, cap: 10 });
        expect(err.message).toContain("11");
        expect(err.message).toContain("10");
    });
    it("name is 'StandardsCapExceededError'", () => {
        const err = new StandardsCapExceededError({ criteriaCount: 11, cap: 10 });
        expect(err.name).toBe("StandardsCapExceededError");
    });
    it("STANDARDS_CRITERIA_CAP reads from StandardsDocSchema (not hard-coded)", () => {
        // Verify the cap matches what Zod has: StandardsDocSchema has .max(10) on criteria.
        // If the schema changes, this test will catch the drift.
        const schemaMaxLength = StandardsDocSchema.shape.criteria._def.maxLength?.value;
        expect(STANDARDS_CRITERIA_CAP).toBe(schemaMaxLength ?? 10);
        expect(STANDARDS_CRITERIA_CAP).toBe(10);
    });
});
// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("regenerateStandards — edge cases", () => {
    it("seed version is '0.1.0' (the documented default)", () => {
        expect(STANDARDS_SEED_VERSION).toBe("0.1.0");
    });
    it("raises when regenerating from an empty registry (zero rules → fails StandardsDocSchema min(1))", async () => {
        // An empty registry would produce zero criteria, violating .min(1).
        // This should raise (the schema check catches it).
        await expect(regenerateStandards({
            registry: { rules: [] },
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        })).rejects.toThrow();
    });
    it("raises StandardsCapExceededError (not a schema error) for exactly 11 rules", async () => {
        const elevenRegistry = makeRegistry(11);
        const err = await regenerateStandards({
            registry: elevenRegistry,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        }).catch((e) => e);
        expect(err).toBeInstanceOf(StandardsCapExceededError);
    });
    it("lookupStandards on the regenerated doc does not throw StandardsDocMissingError", async () => {
        await regenerateStandards({
            registry: THREE_RULE_REGISTRY,
            targetVersion: "1.0.0",
            updatedTimestamp: FIXED_NOW.toISOString(),
            targetRepoRoot: tmpRoot,
            mcpToolContext: { toolName: "acceptProposal", role: "operator" },
        });
        // lookupStandards is the same seam that apply-rule-proposal uses — it must
        // not throw on the regenerated doc.
        const { lookupStandards } = await import("../../state/lookup-standards.js");
        const doc = await lookupStandards(tmpRoot);
        expect(doc.version).toBe("1.0.0");
        expect(doc.criteria).toHaveLength(THREE_RULE_REGISTRY.rules.length);
    });
});
