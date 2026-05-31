/**
 * `rule`-kind apply-handler + production-gate tests — Story 6.5 AC2–AC5.
 *
 * AC2: the handler appends the rule with all five fields, prior rule + comment
 *      unchanged, id a valid ULID, introduced_at a valid ISO-8601, changedPaths
 *      exactly ["docs/discipline-rules.yaml"], and it makes no commit of its own.
 * AC3: after an apply, re-parsing the registry validates cleanly; every rule
 *      satisfies the schema.
 * AC4: driving the REAL `acceptProposal` gate (no injected handler — the
 *      production registry now carries the rule handler) through preview +
 *      confirm renders a diff in preview, mutates nothing on preview, and on
 *      confirm appends + commits the registry together with the proposal stamp
 *      in one commit, stamps the proposal applied, and emits one telemetry event.
 * AC5: re-running the gate on an already-applied rule proposal no-ops — the
 *      registry is byte-identical, no second commit, the gate reports
 *      already-applied — even though the handler is now real.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { acceptProposal } from "../accept-proposal.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { makeRuleApplyHandler } from "../../lib/apply-rule-proposal.js";
import {
  parseRuleRegistry,
  DisciplineRuleSchema,
} from "../../schemas/discipline-rules.js";
import { parseRetroProposalFile } from "../../schemas/retro-proposal.js";
import type { gitCommit as gitCommitType } from "../../lib/git.js";
import type { RetroProposal } from "../../schemas/retro-proposal.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ULID_PROP = "01HZRETR0000000000000000A1";
const ULID_PROP_2 = "01HZRETR0000000000000000B2";
const ULID_EXISTING_RULE = "01HZRETR0000000000000000C3";
const MINTED_ULID = "01HZRETR0000000000000000D4";

const ISO = "2026-05-28T14:32:11.123Z";
const FIXED_NOW = new Date("2026-05-31T10:00:00.000Z");
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function ruleProposalObj(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "rule",
    id,
    created_at: ISO,
    rationale: "Repeated rubber-stamp fires across recent cycles.",
    text: "Reviewer MUST verify every AC built before approving.",
    target_failure_class: "rubber-stamp",
    recommended_promotion_level: "must",
    ...overrides,
  };
}

// A seeded registry carrying ONE prior rule and a human-authored comment.
const SEEDED_REGISTRY = `# Discipline rules — do not hand-delete.
rules:
  # Guards handoff-grammar drift.
  - id: ${ULID_EXISTING_RULE}
    text: Dev MUST emit the handoff phrase verbatim.
    target_failure_class: handoff-grammar
    introduced_at: 2026-05-20T10:00:00.000Z
    level: must
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apply-rule-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

const REGISTRY_REL = "docs/discipline-rules.yaml";

async function seedRegistry(contents: string): Promise<void> {
  const abs = path.join(tmpRoot, REGISTRY_REL);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}

async function readRegistry(): Promise<string> {
  return fs.readFile(path.join(tmpRoot, REGISTRY_REL), "utf8");
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
  const dir = path.join(tmpRoot, ".crew", "telemetry");
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
  const abs = path.join(tmpRoot, ".crew", "retro-proposals", `${iso}.md`);
  const raw = await fs.readFile(abs, "utf8");
  const rest = raw.slice("---\n".length);
  const closeIdx = rest.indexOf("\n---\n");
  const frontmatter = rest.slice(0, closeIdx + 1);
  const file = parseRetroProposalFile(yamlParse(frontmatter));
  return { abs, raw, file };
}

// A proposal object cast to RetroProposal for direct-handler tests.
function ruleProposal(id: string, overrides = {}): RetroProposal {
  return ruleProposalObj(id, overrides) as unknown as RetroProposal;
}

// ---------------------------------------------------------------------------
// AC2 — direct handler: appends rule, comment + prior rule survive, no commit
// ---------------------------------------------------------------------------

describe("makeRuleApplyHandler — append against a seeded registry (AC2)", () => {
  it("appends a new rule with all five fields, preserving the prior rule + comment", async () => {
    await seedRegistry(SEEDED_REGISTRY);
    const handler = makeRuleApplyHandler({
      now: () => FIXED_NOW,
      mintUlid: () => MINTED_ULID,
    });

    const result = await handler.apply(ruleProposal(ULID_PROP), {
      targetRepoRoot: tmpRoot,
      role: "operator",
    });

    // Returns both changed paths: the registry and the regenerated standards doc.
    expect(result.changedPaths).toContain(REGISTRY_REL);
    expect(result.changedPaths).toContain("docs/standards.md");
    expect(result.changedPaths).toHaveLength(2);

    const after = await readRegistry();
    const { data } = parseRuleRegistry(after);

    // Two rules now: the prior one + the appended one.
    expect(data.rules).toHaveLength(2);

    const prior = data.rules.find(
      (r) => r.target_failure_class === "handoff-grammar",
    )!;
    expect(prior.id).toBe(ULID_EXISTING_RULE);
    expect(prior.text).toBe("Dev MUST emit the handoff phrase verbatim.");
    expect(prior.introduced_at).toBe("2026-05-20T10:00:00.000Z");
    expect(prior.level).toBe("must");

    const added = data.rules.find(
      (r) => r.target_failure_class === "rubber-stamp",
    )!;
    expect(added.id).toBe(MINTED_ULID);
    expect(added.text).toBe(
      "Reviewer MUST verify every AC built before approving.",
    );
    expect(added.level).toBe("must");
    expect(added.introduced_at).toBe(FIXED_NOW.toISOString());

    // All five fields: id (ULID), text, target_failure_class, introduced_at (ISO), level.
    expect(ULID_RE.test(added.id)).toBe(true);
    expect(Number.isNaN(Date.parse(added.introduced_at))).toBe(false);

    // The human-authored comment survives.
    expect(after).toContain("# Discipline rules — do not hand-delete.");
    expect(after).toContain("# Guards handoff-grammar drift.");
  });

  it("creates the registry from absent and writes through the managed-fs guard (no commit)", async () => {
    // No registry seeded — absent file path.
    const handler = makeRuleApplyHandler({
      now: () => FIXED_NOW,
      mintUlid: () => MINTED_ULID,
    });
    const result = await handler.apply(ruleProposal(ULID_PROP), {
      targetRepoRoot: tmpRoot,
      role: "operator",
    });
    // Returns both changed paths: the registry and the regenerated standards doc.
    expect(result.changedPaths).toContain(REGISTRY_REL);
    expect(result.changedPaths).toContain("docs/standards.md");
    expect(result.changedPaths).toHaveLength(2);

    const { data } = parseRuleRegistry(await readRegistry());
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0]!.id).toBe(MINTED_ULID);

    // The handler does NOT commit — no .git anywhere; the gate owns the commit.
    await expect(fs.access(path.join(tmpRoot, ".git"))).rejects.toThrow();
  });

  it("edits in place on a duplicate target_failure_class rather than appending", async () => {
    await seedRegistry(SEEDED_REGISTRY);
    const handler = makeRuleApplyHandler({
      now: () => FIXED_NOW,
      mintUlid: () => MINTED_ULID,
    });
    // A proposal for the SAME failure class as the seeded rule.
    await handler.apply(
      ruleProposal(ULID_PROP, {
        text: "Dev MUST emit the handoff phrase verbatim — and only that.",
        target_failure_class: "handoff-grammar",
        recommended_promotion_level: "should",
      }),
      { targetRepoRoot: tmpRoot, role: "operator" },
    );

    const { data } = parseRuleRegistry(await readRegistry());
    // Still exactly one rule for that class — edited, not duplicated.
    expect(data.rules).toHaveLength(1);
    const edited = data.rules[0]!;
    expect(edited.target_failure_class).toBe("handoff-grammar");
    expect(edited.text).toBe(
      "Dev MUST emit the handoff phrase verbatim — and only that.",
    );
    expect(edited.level).toBe("should");
    // id + introduced_at are preserved on an edit.
    expect(edited.id).toBe(ULID_EXISTING_RULE);
    expect(edited.introduced_at).toBe("2026-05-20T10:00:00.000Z");
  });

  it("previewDiff renders a diff and writes nothing", async () => {
    await seedRegistry(SEEDED_REGISTRY);
    const before = await readRegistry();
    const handler = makeRuleApplyHandler();
    const diff = await handler.previewDiff(ruleProposal(ULID_PROP), {
      targetRepoRoot: tmpRoot,
      role: "operator",
    });
    expect(diff).toContain("rubber-stamp");
    expect(diff.length).toBeGreaterThan(0);
    // Registry byte-identical after a preview.
    expect(await readRegistry()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AC3 — re-parse after apply: schema validates cleanly
// ---------------------------------------------------------------------------

describe("makeRuleApplyHandler — re-parse validates (AC3)", () => {
  it("after an apply, every rule satisfies DisciplineRuleSchema", async () => {
    await seedRegistry(SEEDED_REGISTRY);
    const handler = makeRuleApplyHandler({
      now: () => FIXED_NOW,
      mintUlid: () => MINTED_ULID,
    });
    await handler.apply(ruleProposal(ULID_PROP), {
      targetRepoRoot: tmpRoot,
      role: "operator",
    });

    // Re-parse through the new parser — no throw.
    const { data } = parseRuleRegistry(await readRegistry());
    expect(data.rules.length).toBeGreaterThan(0);
    for (const rule of data.rules) {
      expect(() => DisciplineRuleSchema.parse(rule)).not.toThrow();
      expect(rule.id.length).toBeGreaterThan(0);
      expect(rule.text.length).toBeGreaterThan(0);
      expect(rule.target_failure_class.length).toBeGreaterThan(0);
      expect(rule.introduced_at.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — drive the REAL production gate (no injected handler) preview + confirm
// ---------------------------------------------------------------------------

describe("acceptProposal production gate — rule handler registered (AC4)", () => {
  it("preview renders a diff and mutates nothing; confirm appends + commits both files + stamps + one event", async () => {
    await seedRegistry(SEEDED_REGISTRY);
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposalObj(ULID_PROP)],
    });
    const registryBefore = await readRegistry();
    const proposalBefore = await readProposalFile(ISO);
    const git = makeFakeGitCommit();

    // --- PREVIEW (no handlers injection → production registry, which now has rule) ---
    const preview = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_PROP,
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });
    expect(preview.status).toBe("preview");
    if (preview.status === "preview") {
      expect(preview.type).toBe("rule");
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
      proposalId: ULID_PROP,
      confirm: true,
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });
    expect(confirmed.status).toBe("applied");

    // Registry changed on confirm — the new rule is present, comment survives.
    const registryAfter = await readRegistry();
    expect(registryAfter).not.toBe(registryBefore);
    expect(registryAfter).toContain("# Discipline rules — do not hand-delete.");
    const { data } = parseRuleRegistry(registryAfter);
    expect(data.rules.some((r) => r.target_failure_class === "rubber-stamp")).toBe(
      true,
    );

    // Exactly ONE commit carrying BOTH the registry and the proposal file.
    expect(git.calls).toHaveLength(1);
    const committed = git.calls[0]!;
    expect(committed.paths).toContain(REGISTRY_REL);
    expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);

    // Proposal stamped applied.
    const after = await readProposalFile(ISO);
    expect(after.file.proposals[0]!.applied).toBeDefined();

    // Exactly one telemetry event.
    const events = await readTelemetryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("retro.proposal.applied");
    expect(events[0]!.data).toMatchObject({
      id: ULID_PROP,
      proposal_type: "rule",
    });
  });
});

// ---------------------------------------------------------------------------
// AC5 — idempotent re-run against a real handler
// ---------------------------------------------------------------------------

describe("acceptProposal production gate — idempotent re-run (AC5)", () => {
  it("a second confirm on an already-applied rule proposal no-ops with a real handler behind it", async () => {
    await seedRegistry(SEEDED_REGISTRY);
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposalObj(ULID_PROP_2)],
    });
    const git = makeFakeGitCommit();

    // First apply.
    const first = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_PROP_2,
      confirm: true,
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });
    expect(first.status).toBe("applied");
    const registryAfterFirst = await readRegistry();

    // Second confirm on the SAME id.
    const second = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_PROP_2,
      confirm: true,
      gitCommitImpl: git.impl,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(second.status).toBe("already-applied");

    // Registry byte-identical to its post-first-apply state.
    expect(await readRegistry()).toBe(registryAfterFirst);

    // No second commit, no second telemetry event.
    expect(git.calls).toHaveLength(1);
    expect(await readTelemetryEvents()).toHaveLength(1);
  });
});
