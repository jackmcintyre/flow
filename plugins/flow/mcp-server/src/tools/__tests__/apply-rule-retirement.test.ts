/**
 * `rule-retirement`-kind apply-handler + production-gate tests — Story 6.6 AC4.
 *
 * AC4: accepting a `rule-retirement` proposal:
 *   - For `recommended_action: retire`: removes the rule matching `target_rule_id`
 *     from `docs/discipline-rules.yaml`.
 *   - For `recommended_action: relax`: demotes the rule's `level` to `advisory`.
 *   - Either way: regenerates `docs/standards.md` to match the updated registry.
 *   - Returns both changed paths.
 *   - Comments on untouched rules survive.
 *   - The gate commits both files plus the proposal stamp in one commit.
 *   - An unknown `target_rule_id` raises `RuleNotFoundError` with no mutation.
 *   - Retiring the last rule raises `RetirementWouldEmptyRegistryError` before any write.
 *
 * Mirror of `apply-rule-proposal.test.ts` (Story 6.5) — same tmpRoot pattern,
 * same fake git seam, same telemetry reader.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { acceptProposal } from "../accept-proposal.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { makeRuleRetirementApplyHandler } from "../../lib/apply-rule-retirement.js";
import {
  parseRuleRegistry,
  DisciplineRuleSchema,
} from "../../schemas/discipline-rules.js";
import { parseRetroProposalFile } from "../../schemas/retro-proposal.js";
import {
  RuleNotFoundError,
  RetirementWouldEmptyRegistryError,
} from "../../errors.js";
import type { gitCommit as gitCommitType } from "../../lib/git.js";
import type { RetroProposal } from "../../schemas/retro-proposal.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ULID_PROP_RETIRE  = "01HZRETR0000000000000000E5";
const ULID_PROP_RELAX   = "01HZRETR0000000000000000F6";
const ULID_PROP_LAST    = "01HZRETR0000000000000000G7";
const ULID_PROP_MISSING = "01HZRETR0000000000000000H8";

// Rule ids (in the registry fixture) — 26-char valid Crockford base32 ULIDs.
// Valid chars: 0-9, A-H, J-N, P-T, V-Z (Crockford base32 excludes I, L, O, U).
const RULE_ID_A    = "01HZRETR0000000000000000A5";  // handoff-grammar — will be retired
const RULE_ID_B    = "01HZRETR0000000000000000B6";  // rubber-stamp    — will be relaxed
const RULE_ID_ONLY = "01HZRETR0000000000000000C7";  // only-class      — for last-rule guard

const ISO = "2026-05-28T14:32:11.123Z";
const FIXED_NOW = new Date("2026-05-31T10:00:00.000Z");

const REGISTRY_REL = "docs/discipline-rules.yaml";

// A seeded registry with two rules + human-authored comments.
const SEEDED_TWO_RULES = `# Discipline rules — do not hand-delete.
rules:
  # Guards handoff-grammar drift.
  - id: ${RULE_ID_A}
    text: Dev MUST emit the handoff phrase verbatim.
    target_failure_class: handoff-grammar
    introduced_at: 2026-05-20T10:00:00.000Z
    level: must
  # Guards rubber-stamp behaviour.
  - id: ${RULE_ID_B}
    text: Reviewer MUST verify every AC built before approving.
    target_failure_class: rubber-stamp
    introduced_at: 2026-05-21T10:00:00.000Z
    level: must
`;

// A seeded registry with only ONE rule (for the last-rule guard test).
const SEEDED_ONE_RULE = `# Discipline rules — single rule.
rules:
  - id: ${RULE_ID_ONLY}
    text: The only rule.
    target_failure_class: only-class
    introduced_at: 2026-05-20T10:00:00.000Z
    level: must
`;

// A minimal standards.md so lookupStandards doesn't throw StandardsDocMissingError.
// Generated via yamlStringify to ensure correct YAML quoting of colons in values.
// Used with SEEDED_TWO_RULES (which has handoff-grammar + rubber-stamp rules).
const MINIMAL_STANDARDS = yamlStringify(
  {
    version: "1.0.0",
    updated: "2026-05-20T10:00:00.000Z",
    criteria: [
      {
        name: "handoff-grammar",
        what: "Dev MUST emit the handoff phrase verbatim.",
        check: "Inspect the diff for handoff-grammar; flag any hunk that exhibits it.",
        anti_criterion: "The failure this rule guards against: handoff-grammar.",
      },
    ],
  },
  { lineWidth: 0 },
);

// A minimal standards.md for use with SEEDED_ONE_RULE (only-class).
// The divergence guard requires the doc's criteria to match the registry projection.
const MINIMAL_STANDARDS_ONE_RULE = yamlStringify(
  {
    version: "1.0.0",
    updated: "2026-05-20T10:00:00.000Z",
    criteria: [
      {
        name: "only-class",
        what: "The only rule.",
        check: "Inspect the diff for only-class; flag any hunk that exhibits it.",
        anti_criterion: "The failure this rule guards against: only-class.",
      },
    ],
  },
  { lineWidth: 0 },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-rule-retirement-"));
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

async function seedStandards(contents: string): Promise<void> {
  const abs = path.join(tmpRoot, "docs", "standards.md");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}

async function readRegistry(): Promise<string> {
  return fs.readFile(path.join(tmpRoot, REGISTRY_REL), "utf8");
}

async function readStandards(): Promise<string> {
  return fs.readFile(path.join(tmpRoot, "docs", "standards.md"), "utf8");
}

function makeFakeGitCommit(sha = "aabbccddeeff00112233445566778899aabbccdd") {
  const calls: Array<{ paths: readonly string[]; message: string }> = [];
  const impl = (async (args: { paths: readonly string[]; message: string }) => {
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

/** Build a rule-retirement proposal object. */
function retirementProposalObj(
  id: string,
  targetRuleId: string,
  action: "retire" | "relax",
  opts: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "rule-retirement",
    id,
    created_at: ISO,
    rationale: "Rule has not fired in observed window.",
    target_rule_id: targetRuleId,
    fire_count_over_window: 0,
    recommended_action: action,
    ...opts,
  };
}

function retirementProposal(
  id: string,
  targetRuleId: string,
  action: "retire" | "relax",
  opts: Partial<Record<string, unknown>> = {},
): RetroProposal {
  return retirementProposalObj(id, targetRuleId, action, opts) as unknown as RetroProposal;
}

// ---------------------------------------------------------------------------
// Direct handler tests: retire
// ---------------------------------------------------------------------------

describe("makeRuleRetirementApplyHandler — retire (AC4)", () => {
  it("removes the target rule, preserving the other rule + comments", async () => {
    await seedRegistry(SEEDED_TWO_RULES);
    await seedStandards(MINIMAL_STANDARDS);
    const handler = makeRuleRetirementApplyHandler({ standardsNow: () => FIXED_NOW });

    const result = await handler.apply(
      retirementProposal(ULID_PROP_RETIRE, RULE_ID_A, "retire"),
      { targetRepoRoot: tmpRoot, role: "operator" },
    );

    // Returns both changed paths.
    expect(result.changedPaths).toContain(REGISTRY_REL);
    expect(result.changedPaths).toContain("docs/standards.md");
    expect(result.changedPaths).toHaveLength(2);

    const after = await readRegistry();
    const { data } = parseRuleRegistry(after);

    // Only rubber-stamp rule remains.
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0]!.id).toBe(RULE_ID_B);
    expect(data.rules[0]!.target_failure_class).toBe("rubber-stamp");

    // handoff-grammar rule is gone.
    expect(data.rules.find((r) => r.id === RULE_ID_A)).toBeUndefined();

    // Comments on the untouched rule survive.
    expect(after).toContain("# Guards rubber-stamp behaviour.");
    expect(after).toContain("# Discipline rules — do not hand-delete.");

    // The handler does NOT commit.
    await expect(fs.access(path.join(tmpRoot, ".git"))).rejects.toThrow();
  });

  it("regenerates docs/standards.md to match the updated registry", async () => {
    await seedRegistry(SEEDED_TWO_RULES);
    await seedStandards(MINIMAL_STANDARDS);
    const handler = makeRuleRetirementApplyHandler({ standardsNow: () => FIXED_NOW });

    await handler.apply(
      retirementProposal(ULID_PROP_RETIRE, RULE_ID_A, "retire"),
      { targetRepoRoot: tmpRoot, role: "operator" },
    );

    const standards = await readStandards();
    // The regenerated standards should only contain the rubber-stamp criterion.
    expect(standards).toContain("rubber-stamp");
    expect(standards).not.toContain("handoff-grammar");
  });

  it("previewDiff renders a diff and writes nothing", async () => {
    await seedRegistry(SEEDED_TWO_RULES);
    const before = await readRegistry();
    const handler = makeRuleRetirementApplyHandler();
    const diff = await handler.previewDiff(
      retirementProposal(ULID_PROP_RETIRE, RULE_ID_A, "retire"),
      { targetRepoRoot: tmpRoot, role: "operator" },
    );
    expect(diff).toContain("handoff-grammar");
    expect(diff).toContain("retire");
    expect(diff.length).toBeGreaterThan(0);
    // Registry byte-identical after a preview.
    expect(await readRegistry()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Direct handler tests: relax
// ---------------------------------------------------------------------------

describe("makeRuleRetirementApplyHandler — relax (AC4)", () => {
  it("demotes the target rule's level to advisory, leaving other rules intact", async () => {
    await seedRegistry(SEEDED_TWO_RULES);
    await seedStandards(MINIMAL_STANDARDS);
    const handler = makeRuleRetirementApplyHandler({ standardsNow: () => FIXED_NOW });

    const result = await handler.apply(
      retirementProposal(ULID_PROP_RELAX, RULE_ID_B, "relax"),
      { targetRepoRoot: tmpRoot, role: "operator" },
    );

    expect(result.changedPaths).toContain(REGISTRY_REL);
    expect(result.changedPaths).toContain("docs/standards.md");

    const after = await readRegistry();
    const { data } = parseRuleRegistry(after);

    // Both rules still present.
    expect(data.rules).toHaveLength(2);

    const relaxed = data.rules.find((r) => r.id === RULE_ID_B)!;
    expect(relaxed.level).toBe("advisory");

    // Other rule is untouched.
    const untouched = data.rules.find((r) => r.id === RULE_ID_A)!;
    expect(untouched.level).toBe("must");

    // Comments survive.
    expect(after).toContain("# Guards handoff-grammar drift.");
    expect(after).toContain("# Guards rubber-stamp behaviour.");
    expect(after).toContain("# Discipline rules — do not hand-delete.");
  });

  it("all rules in the registry pass DisciplineRuleSchema after a relax", async () => {
    await seedRegistry(SEEDED_TWO_RULES);
    await seedStandards(MINIMAL_STANDARDS);
    const handler = makeRuleRetirementApplyHandler({ standardsNow: () => FIXED_NOW });
    await handler.apply(
      retirementProposal(ULID_PROP_RELAX, RULE_ID_B, "relax"),
      { targetRepoRoot: tmpRoot, role: "operator" },
    );

    const { data } = parseRuleRegistry(await readRegistry());
    for (const rule of data.rules) {
      expect(() => DisciplineRuleSchema.parse(rule)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("makeRuleRetirementApplyHandler — error cases (AC4)", () => {
  it("raises RuleNotFoundError when target_rule_id does not match any rule — no mutation (AC4)", async () => {
    await seedRegistry(SEEDED_TWO_RULES);
    await seedStandards(MINIMAL_STANDARDS);
    const beforeRegistry = await readRegistry();
    const handler = makeRuleRetirementApplyHandler({ standardsNow: () => FIXED_NOW });

    // Use a valid ULID that is not in the registry.
    const NON_EXISTENT_RULE_ID = "01HZRETR0000000000000000Z9";
    await expect(
      handler.apply(
        retirementProposal(ULID_PROP_MISSING, NON_EXISTENT_RULE_ID, "retire"),
        { targetRepoRoot: tmpRoot, role: "operator" },
      ),
    ).rejects.toBeInstanceOf(RuleNotFoundError);

    // Registry is byte-identical — no mutation.
    expect(await readRegistry()).toBe(beforeRegistry);
  });

  it("RuleNotFoundError carries the missing rule id (AC4)", async () => {
    await seedRegistry(SEEDED_TWO_RULES);
    await seedStandards(MINIMAL_STANDARDS);
    const handler = makeRuleRetirementApplyHandler();
    const MISSING_ID = "01HZRETR0000000000000000Z9";

    await handler
      .apply(
        retirementProposal(ULID_PROP_MISSING, MISSING_ID, "retire"),
        { targetRepoRoot: tmpRoot, role: "operator" },
      )
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(RuleNotFoundError);
        const e = err as RuleNotFoundError;
        expect(e.targetRuleId).toBe(MISSING_ID);
      });
  });

  it("raises RetirementWouldEmptyRegistryError when retiring the last rule — no mutation (AC4)", async () => {
    await seedRegistry(SEEDED_ONE_RULE);
    // Use the one-rule-aligned standards doc (only-class criterion) so the
    // divergence guard does not fire before the retirement guard.
    await seedStandards(MINIMAL_STANDARDS_ONE_RULE);
    const beforeRegistry = await readRegistry();
    const handler = makeRuleRetirementApplyHandler({ standardsNow: () => FIXED_NOW });

    await expect(
      handler.apply(
        retirementProposal(ULID_PROP_LAST, RULE_ID_ONLY, "retire"),
        { targetRepoRoot: tmpRoot, role: "operator" },
      ),
    ).rejects.toBeInstanceOf(RetirementWouldEmptyRegistryError);

    // Registry is byte-identical — no mutation.
    expect(await readRegistry()).toBe(beforeRegistry);
  });

  it("relax on the last rule is allowed (only retire is blocked)", async () => {
    await seedRegistry(SEEDED_ONE_RULE);
    // Use the one-rule-aligned standards doc (only-class criterion) so the
    // divergence guard does not fire and the relax can proceed.
    await seedStandards(MINIMAL_STANDARDS_ONE_RULE);
    const handler = makeRuleRetirementApplyHandler({ standardsNow: () => FIXED_NOW });

    // relax should succeed even for the last rule.
    const result = await handler.apply(
      retirementProposal(ULID_PROP_RELAX, RULE_ID_ONLY, "relax"),
      { targetRepoRoot: tmpRoot, role: "operator" },
    );
    expect(result.changedPaths).toHaveLength(2);

    const { data } = parseRuleRegistry(await readRegistry());
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0]!.level).toBe("advisory");
  });
});

// ---------------------------------------------------------------------------
// Production gate: rule-retirement handler registered (AC4 + AC5)
// ---------------------------------------------------------------------------

describe("acceptProposal production gate — rule-retirement handler registered (AC4)", () => {
  it("preview renders a diff and mutates nothing; confirm removes rule + commits both files + stamps + one event", async () => {
    await seedRegistry(SEEDED_TWO_RULES);
    await seedStandards(MINIMAL_STANDARDS);
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [retirementProposalObj(ULID_PROP_RETIRE, RULE_ID_A, "retire")],
    });
    const registryBefore = await readRegistry();
    const proposalBefore = await readProposalFile(ISO);
    const git = makeFakeGitCommit();

    // --- PREVIEW ---
    const preview = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_PROP_RETIRE,
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });
    expect(preview.status).toBe("preview");
    if (preview.status === "preview") {
      expect(preview.type).toBe("rule-retirement");
      expect(preview.diff.length).toBeGreaterThan(0);
    }
    // Preview mutated nothing.
    expect(await readRegistry()).toBe(registryBefore);
    expect((await readProposalFile(ISO)).raw).toBe(proposalBefore.raw);
    expect(git.calls).toHaveLength(0);
    expect(await readTelemetryEvents()).toHaveLength(0);

    // --- CONFIRM ---
    const confirmed = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_PROP_RETIRE,
      confirm: true,
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });
    expect(confirmed.status).toBe("applied");

    // Registry changed — RULE_ID_A is gone.
    const registryAfter = await readRegistry();
    expect(registryAfter).not.toBe(registryBefore);
    const { data } = parseRuleRegistry(registryAfter);
    expect(data.rules.find((r) => r.id === RULE_ID_A)).toBeUndefined();
    expect(data.rules.find((r) => r.id === RULE_ID_B)).toBeDefined();

    // Comment on the surviving rule survives.
    expect(registryAfter).toContain("# Discipline rules — do not hand-delete.");
    expect(registryAfter).toContain("# Guards rubber-stamp behaviour.");

    // Exactly ONE commit carrying BOTH the registry and the proposal file.
    expect(git.calls).toHaveLength(1);
    const committed = git.calls[0]!;
    expect(committed.paths).toContain(REGISTRY_REL);
    expect(committed.paths).toContain("docs/standards.md");
    expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);

    // Proposal stamped applied.
    const after = await readProposalFile(ISO);
    expect(after.file.proposals[0]!.applied).toBeDefined();

    // Exactly one telemetry event.
    const events = await readTelemetryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("retro.proposal.applied");
    expect(events[0]!.data).toMatchObject({
      id: ULID_PROP_RETIRE,
      proposal_type: "rule-retirement",
    });
  });

  it("idempotent: second confirm on an already-applied retirement no-ops", async () => {
    await seedRegistry(SEEDED_TWO_RULES);
    await seedStandards(MINIMAL_STANDARDS);
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [retirementProposalObj(ULID_PROP_RELAX, RULE_ID_B, "relax")],
    });
    const git = makeFakeGitCommit();

    // First apply.
    const first = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_PROP_RELAX,
      confirm: true,
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });
    expect(first.status).toBe("applied");
    const registryAfterFirst = await readRegistry();

    // Second confirm on the SAME id.
    const second = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_PROP_RELAX,
      confirm: true,
      gitCommitImpl: git.impl,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(second.status).toBe("already-applied");

    // Registry byte-identical, no second commit.
    expect(await readRegistry()).toBe(registryAfterFirst);
    expect(git.calls).toHaveLength(1);
    expect(await readTelemetryEvents()).toHaveLength(1);
  });
});
