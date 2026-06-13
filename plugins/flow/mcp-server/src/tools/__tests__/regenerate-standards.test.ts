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
import {
  regenerateStandards,
  bumpPatchVersion,
  STANDARDS_REL_PATH,
  STANDARDS_SEED_VERSION,
  STANDARDS_CRITERIA_CAP,
} from "../../lib/regenerate-standards.js";
import {
  StandardsCapExceededError,
  DomainError,
} from "../../errors.js";
import { StandardsDocSchema } from "../../schemas/standards-doc.js";
import { parseStandardsDoc } from "../../validators/standards-doc.js";
import { acceptProposal } from "../accept-proposal.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { parseRuleRegistry } from "../../schemas/discipline-rules.js";
import { parseRetroProposalFile } from "../../schemas/retro-proposal.js";
import type { gitCommit as gitCommitType } from "../../lib/git.js";
import type { DisciplineRulesFile } from "../../schemas/discipline-rules.js";

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
function makeRegistry(count: number): DisciplineRulesFile {
  return {
    rules: Array.from({ length: count }, (_, i) => ({
      id: `01HZRETR000000000000000${String(i).padStart(3, "0").slice(-3)}AA`.slice(0, 26) as string,
      text: `Rule text ${i + 1}.`,
      target_failure_class: `failure-class-${i + 1}`,
      introduced_at: "2026-01-01T00:00:00.000Z",
      level: "must" as const,
    })),
  };
}

// Use a seeded registry with 3 rules.
const THREE_RULE_REGISTRY = makeRegistry(3);

function ruleProposalObj(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
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

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "regen-standards-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

async function seedRegistry(contents: string): Promise<void> {
  const abs = path.join(tmpRoot, REGISTRY_REL);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}

async function readRegistry(): Promise<string> {
  return fs.readFile(path.join(tmpRoot, REGISTRY_REL), "utf8");
}

async function readStandardsDoc(): Promise<string> {
  return fs.readFile(path.join(tmpRoot, STANDARDS_REL_PATH), "utf8");
}

async function seedStandardsDoc(
  version: string,
  criterionName = "seed-criterion",
): Promise<void> {
  const abs = path.join(tmpRoot, STANDARDS_REL_PATH);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const doc = {
    version,
    updated: "2026-01-01T00:00:00.000Z",
    criteria: [
      {
        name: criterionName,
        what: "Seed criterion description.",
        check: `Inspect the diff for ${criterionName}; flag any hunk that exhibits it.`,
        anti_criterion: `The failure this rule guards against: ${criterionName}.`,
      },
    ],
  };
  await fs.writeFile(abs, yamlStringify(doc, { lineWidth: 0 }), "utf8");
}

function makeFakeGitCommit(sha = "aabbccddeeff00112233445566778899aabbccdd") {
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

async function readTelemetryEvents(): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(tmpRoot, ".flow", "telemetry");
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const events: Array<Record<string, unknown>> = [];
  for (const f of files.filter((x) => x.endsWith(".jsonl")).sort()) {
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

async function readProposalFile(iso: string) {
  const abs = path.join(tmpRoot, ".flow", "retro-proposals", `${iso}.md`);
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
    expect(() =>
      parseStandardsDoc(raw, path.join(tmpRoot, STANDARDS_REL_PATH)),
    ).not.toThrow();
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
      const rule = THREE_RULE_REGISTRY.rules[i]!;
      const criterion = doc.criteria[i]!;
      // The name is the slugified failure class.
      expect(criterion.name).toBe(
        rule.target_failure_class.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      );
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
    const prior = maj1! * 1_000_000 + min1! * 1_000 + pat1!;
    const next = maj2! * 1_000_000 + min2! * 1_000 + pat2!;
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
    // The standards doc must have criteria consistent with the registry that will
    // exist when acceptProposal runs — the divergence guard fires otherwise.
    await seedStandardsDoc("2.0.5", "existing-failure");
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
    await expect(
      regenerateStandards({
        registry: elevenRuleRegistry,
        targetVersion: "1.0.0",
        updatedTimestamp: FIXED_NOW.toISOString(),
        targetRepoRoot: tmpRoot,
        mcpToolContext: { toolName: "acceptProposal", role: "operator" },
      }),
    ).rejects.toMatchObject({
      name: "StandardsCapExceededError",
      criteriaCount: 11,
      cap: 10,
    });
  });

  it("exactly 10 criteria is allowed (boundary: = cap is not refused)", async () => {
    const tenRuleRegistry = makeRegistry(10);
    await expect(
      regenerateStandards({
        registry: tenRuleRegistry,
        targetVersion: "1.0.0",
        updatedTimestamp: FIXED_NOW.toISOString(),
        targetRepoRoot: tmpRoot,
        mcpToolContext: { toolName: "acceptProposal", role: "operator" },
      }),
    ).resolves.toBeUndefined();

    const raw = await readStandardsDoc();
    const doc = parseStandardsDoc(raw, path.join(tmpRoot, STANDARDS_REL_PATH));
    expect(doc.criteria).toHaveLength(10);
  });

  it("does not write docs/standards.md before raising StandardsCapExceededError", async () => {
    const elevenRuleRegistry = makeRegistry(11);
    await expect(
      regenerateStandards({
        registry: elevenRuleRegistry,
        targetVersion: "1.0.0",
        updatedTimestamp: FIXED_NOW.toISOString(),
        targetRepoRoot: tmpRoot,
        mcpToolContext: { toolName: "acceptProposal", role: "operator" },
      }),
    ).rejects.toBeInstanceOf(StandardsCapExceededError);

    // The standards doc must NOT have been created.
    await expect(
      fs.access(path.join(tmpRoot, STANDARDS_REL_PATH)),
    ).rejects.toThrow();
  });

  it("production gate path: 11th rule is refused, registry byte-identical, standards unchanged, no commit, no telemetry", async () => {
    // Build a registry with 10 rules (the cap).
    const tenRulesYaml = makeRegistry(10)
      .rules.map(
        (r) =>
          `  - id: ${r.id.padEnd(26, "X").slice(0, 26)}\n    text: "${r.text}"\n    target_failure_class: ${r.target_failure_class}\n    introduced_at: ${r.introduced_at}\n    level: ${r.level}`,
      )
      .join("\n");
    const fullYaml = `rules:\n${tenRulesYaml}\n`;

    await seedRegistry(fullYaml);
    // Seed a standards doc so we can verify it is NOT changed.
    // Use a criterion name that is projected by the 10-rule registry so the
    // divergence guard passes (it guards against orphan criteria, not cap).
    await seedStandardsDoc("1.0.0", "failure-class-1");

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
    await expect(
      acceptProposal({
        targetRepoRoot: tmpRoot,
        proposalId: ULID_PROP,
        confirm: true,
        gitCommitImpl: git.impl,
        now: () => FIXED_NOW,
      }),
    ).rejects.toBeInstanceOf(StandardsCapExceededError);

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
      .rules.map(
        (r) =>
          `  - id: ${r.id.padEnd(26, "X").slice(0, 26)}\n    text: "${r.text}"\n    target_failure_class: ${r.target_failure_class}\n    introduced_at: ${r.introduced_at}\n    level: ${r.level}`,
      )
      .join("\n");
    await seedRegistry(`rules:\n${tenRulesYaml}\n`);
    await seedStandardsDoc("1.0.0", "failure-class-1");

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
    expect(afterProposal.file.proposals[0]!.applied).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC4 — production gate: within-cap rule → both files changed in one commit
// ---------------------------------------------------------------------------

describe("regenerateStandards — production gate within-cap commit (AC4)", () => {
  it("accepts a rule, regenerates standards, commits both files + proposal in one commit", async () => {
    // Seed a registry with a prior rule so the existing standards doc is consistent
    // with the registry (divergence guard requires this alignment).
    const priorRuleYaml = `rules:
  - id: 01HZRETR0000000000000000P1
    text: Prior rule text.
    target_failure_class: prior-rule
    introduced_at: 2026-01-01T00:00:00.000Z
    level: must
`;
    await seedRegistry(priorRuleYaml);
    // Seed a standards doc at a known version, consistent with the prior registry.
    await seedStandardsDoc("0.9.0", "prior-rule");

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
    const committed = git.calls[0]!;
    expect(committed.paths).toContain(REGISTRY_REL);
    expect(committed.paths).toContain(STANDARDS_REL_PATH);
    expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);

    // Exactly one telemetry event.
    const events = await readTelemetryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("retro.proposal.applied");
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
    // Seed a registry so the standards doc has a consistent criterion (divergence guard).
    const priorRuleYaml = `rules:
  - id: 01HZRETR0000000000000000Q2
    text: Prior rule text.
    target_failure_class: prior-rule
    introduced_at: 2026-01-01T00:00:00.000Z
    level: must
`;
    await seedRegistry(priorRuleYaml);
    await seedStandardsDoc("0.5.0", "prior-rule");
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

    const committed = git.calls[0]!;
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
    const schemaMaxLength = (
      StandardsDocSchema.shape.criteria._def as unknown as {
        maxLength?: { value: number };
      }
    ).maxLength?.value;
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
    await expect(
      regenerateStandards({
        registry: { rules: [] },
        targetVersion: "1.0.0",
        updatedTimestamp: FIXED_NOW.toISOString(),
        targetRepoRoot: tmpRoot,
        mcpToolContext: { toolName: "acceptProposal", role: "operator" },
      }),
    ).rejects.toThrow();
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

// ---------------------------------------------------------------------------
// AC4 (Story native:01KTZ7TAR2W5KDYY9Y4CX1P21R) — retiring a rule drops
// exactly its criterion; every other criterion survives intact.
// ---------------------------------------------------------------------------

// The four hand-authored reviewer criteria as seeded in docs/discipline-rules.yaml.
const SEEDED_REVIEWER_CRITERIA_REGISTRY: DisciplineRulesFile = {
  rules: [
    {
      id: "01KTZDPZ5RXA5XENR9WS32797W",
      text: "The PR's diff implements only what the story's acceptance criteria require.",
      target_failure_class: "story-aligned",
      introduced_at: "2026-05-27T00:00:00.000Z",
      level: "must",
      criterion_name: "story-aligned",
      criterion_check: "Map each diff hunk to one or more ACs; flag any hunk that maps to none.",
      criterion_anti: "Scope creep: refactors or rewrites that the story did not request.",
    },
    {
      id: "01KTZDPZ5TCJHM4PM6JH7WRHYP",
      text: "Every AC has at least one assertion in the test suite that fails when the AC behaviour is removed.",
      target_failure_class: "tests-cover-acs",
      introduced_at: "2026-05-27T00:00:00.000Z",
      level: "must",
      criterion_name: "tests-cover-acs",
      criterion_check: "Inspect the new/changed test files; trace each AC to a named test.",
      criterion_anti: "Tests that only exercise happy paths without asserting the AC's specific behaviour.",
    },
    {
      id: "01KTZDPZ5TXX3HYAESH5523RA3",
      text: "No code path writes to canonical-state paths (manifests, personas, registry, telemetry) except through MCP tools.",
      target_failure_class: "no-canonical-fs-writes-outside-mcp",
      introduced_at: "2026-05-27T00:00:00.000Z",
      level: "must",
      criterion_name: "no-canonical-fs-writes-outside-mcp",
      criterion_check: "Grep the diff for raw fs.writeFile/fs.writeFileSync; any hit under a canonical path is a fail.",
      criterion_anti: "Direct fs.write to .flow/state, telemetry, or docs/standards.md.",
    },
    {
      id: "01KTZDPZ5T3BC966K28E8J62MC",
      text: "Every named failure mode in the diff throws a DomainError subclass; uncaught throws are bugs.",
      target_failure_class: "errors-are-typed",
      introduced_at: "2026-05-27T00:00:00.000Z",
      level: "must",
      criterion_name: "errors-are-typed",
      criterion_check: "Inspect new throw sites; assert they throw a class extending DomainError with a one-line user-facing message.",
      criterion_anti: "throw new Error('...') or returning {error: '...'} envelopes for known failures.",
    },
  ],
};

describe("regenerateStandards — reviewer criteria seeding (AC4+AC5 of Story native:01KTZ7TAR2W5KDYY9Y4CX1P21R)", () => {
  it("AC4: retiring one rule drops exactly its criterion; every other criterion name and text survives intact", async () => {
    // Start with all four seeded reviewer criteria.
    await regenerateStandards({
      registry: SEEDED_REVIEWER_CRITERIA_REGISTRY,
      targetVersion: "0.1.1",
      updatedTimestamp: FIXED_NOW.toISOString(),
      targetRepoRoot: tmpRoot,
      mcpToolContext: { toolName: "acceptProposal", role: "operator" },
    });

    // Retire the second rule (tests-cover-acs).
    const registryAfterRetire: DisciplineRulesFile = {
      rules: SEEDED_REVIEWER_CRITERIA_REGISTRY.rules.filter(
        (r) => r.id !== "01KTZDPZ5TCJHM4PM6JH7WRHYP",
      ),
    };

    await regenerateStandards({
      registry: registryAfterRetire,
      targetVersion: "0.1.2",
      updatedTimestamp: FIXED_NOW.toISOString(),
      targetRepoRoot: tmpRoot,
      mcpToolContext: { toolName: "acceptProposal", role: "operator" },
    });

    const { lookupStandards } = await import("../../state/lookup-standards.js");
    const doc = await lookupStandards(tmpRoot);

    // Exactly 3 criteria remain.
    expect(doc.criteria).toHaveLength(3);

    // The retired criterion is gone.
    const criteriaNames = doc.criteria.map((c) => c.name);
    expect(criteriaNames).not.toContain("tests-cover-acs");

    // The other three survive with their hand-authored wording.
    expect(criteriaNames).toContain("story-aligned");
    expect(criteriaNames).toContain("no-canonical-fs-writes-outside-mcp");
    expect(criteriaNames).toContain("errors-are-typed");

    // The wording for one of the surviving criteria is preserved byte-for-byte.
    const storyAligned = doc.criteria.find((c) => c.name === "story-aligned")!;
    expect(storyAligned.what).toBe(
      "The PR's diff implements only what the story's acceptance criteria require.",
    );
    expect(storyAligned.check).toBe(
      "Map each diff hunk to one or more ACs; flag any hunk that maps to none.",
    );
    expect(storyAligned.anti_criterion).toBe(
      "Scope creep: refactors or rewrites that the story did not request.",
    );
  });

  it("AC5: seeding never duplicates an entry — if a criterion name already matches a registry rule, regeneration produces exactly one entry per name", async () => {
    // Simulate a scenario where we regenerate with the full 4-rule seeded registry twice
    // (e.g. an operator attempts to re-apply the same rule proposal a second time).
    // The regeneration must produce exactly 4 criteria — no duplicates.
    for (let i = 0; i < 2; i++) {
      await regenerateStandards({
        registry: SEEDED_REVIEWER_CRITERIA_REGISTRY,
        targetVersion: `0.1.${i + 1}`,
        updatedTimestamp: FIXED_NOW.toISOString(),
        targetRepoRoot: tmpRoot,
        mcpToolContext: { toolName: "acceptProposal", role: "operator" },
      });
    }

    const { lookupStandards } = await import("../../state/lookup-standards.js");
    const doc = await lookupStandards(tmpRoot);

    // Must be exactly 4 criteria — pure projection of 4 rules, no duplicates.
    expect(doc.criteria).toHaveLength(4);

    // Each name appears exactly once.
    const names = doc.criteria.map((c) => c.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(4);

    // All four expected names are present.
    expect(uniqueNames).toContain("story-aligned");
    expect(uniqueNames).toContain("tests-cover-acs");
    expect(uniqueNames).toContain("no-canonical-fs-writes-outside-mcp");
    expect(uniqueNames).toContain("errors-are-typed");
  });

  it("AC4+AC5: seeded registry projects with the hand-authored criterion_name overrides (not slugified fallbacks)", async () => {
    await regenerateStandards({
      registry: SEEDED_REVIEWER_CRITERIA_REGISTRY,
      targetVersion: "0.1.1",
      updatedTimestamp: FIXED_NOW.toISOString(),
      targetRepoRoot: tmpRoot,
      mcpToolContext: { toolName: "acceptProposal", role: "operator" },
    });

    const { lookupStandards } = await import("../../state/lookup-standards.js");
    const doc = await lookupStandards(tmpRoot);

    // All four hand-authored criterion names are present (not the slugified defaults).
    const names = doc.criteria.map((c) => c.name);
    expect(names).toContain("story-aligned");
    expect(names).toContain("tests-cover-acs");
    expect(names).toContain("no-canonical-fs-writes-outside-mcp");
    expect(names).toContain("errors-are-typed");

    // The check and anti_criterion fields use the hand-authored overrides.
    const errorsAreTyped = doc.criteria.find((c) => c.name === "errors-are-typed")!;
    expect(errorsAreTyped.check).toBe(
      "Inspect new throw sites; assert they throw a class extending DomainError with a one-line user-facing message.",
    );
    expect(errorsAreTyped.anti_criterion).toBe(
      "throw new Error('...') or returning {error: '...'} envelopes for known failures.",
    );
  });
});
