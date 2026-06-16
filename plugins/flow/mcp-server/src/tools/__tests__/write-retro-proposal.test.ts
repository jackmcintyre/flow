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
import {
  MalformedRetroProposalError,
  RetroProposalAlreadyExistsError,
} from "../../errors.js";
import { parseRetroProposalFile } from "../../schemas/retro-proposal.js";
import {
  writeRetroProposal,
  routeDurability,
  DURABILITY_REASONS,
  classifySkillChangeTarget,
} from "../write-retro-proposal.js";

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
  proposed_path: ".flow/skills/do-x.md",
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

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-proposal-"));
});

afterEach(async () => {
  // Best-effort cleanup; tolerate ENOENT in case a test consumed the dir.
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

/**
 * Read a written proposal file and split its frontmatter / body.
 * Throws if the on-disk shape doesn't have the expected `---\n...\n---\n\n<body>`
 * structure (which would itself be a regression).
 */
async function readWrittenFile(absPath: string): Promise<{
  frontmatter: string;
  body: string;
  raw: string;
}> {
  const raw = await fs.readFile(absPath, "utf8");
  // Expected shape: `---\n<frontmatter>---\n\n<body>`.
  if (!raw.startsWith("---\n")) {
    throw new Error(
      `written file does not start with '---\\n' frontmatter fence: ${raw.slice(0, 50)}`,
    );
  }
  const rest = raw.slice("---\n".length);
  const closeIdx = rest.indexOf("\n---\n");
  if (closeIdx < 0) {
    throw new Error(
      `written file does not contain a closing '---\\n' fence: ${raw.slice(0, 200)}`,
    );
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

    const expectedPath = path.join(
      tmpRoot,
      ".flow",
      "retro-proposals",
      `${ISO}.md`,
    );
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

    await expect(
      writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: ISO,
        proposals: [TEAM_CHANGE_PROPOSAL],
      }),
    ).rejects.toBeInstanceOf(RetroProposalAlreadyExistsError);

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
    } catch (err) {
      expect(err).toBeInstanceOf(RetroProposalAlreadyExistsError);
      const typed = err as RetroProposalAlreadyExistsError;
      expect(typed.isoTimestamp).toBe(ISO);
      expect(typed.absPath).toBe(
        path.join(tmpRoot, ".flow", "retro-proposals", `${ISO}.md`),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Path-traversal defense (writer boundary)
// ---------------------------------------------------------------------------

describe("writeRetroProposal — path-traversal in isoTimestamp (AC8)", () => {
  it("rejects '../escape' before any filesystem op", async () => {
    await expect(
      writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: "../escape",
        proposals: [],
      }),
    ).rejects.toBeInstanceOf(MalformedRetroProposalError);

    // No directory was created — proves the writer halted before
    // mkdir-p and any filesystem touch.
    await expect(
      fs.access(path.join(tmpRoot, ".flow", "retro-proposals")),
    ).rejects.toThrow();
  });

  it("rejects an empty isoTimestamp", async () => {
    await expect(
      writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: "",
        proposals: [],
      }),
    ).rejects.toBeInstanceOf(MalformedRetroProposalError);
  });

  it("rejects a non-UTC ISO timestamp (offset form)", async () => {
    await expect(
      writeRetroProposal({
        targetRepoRoot: tmpRoot,
        isoTimestamp: "2026-05-28T14:32:11+02:00",
        proposals: [],
      }),
    ).rejects.toBeInstanceOf(MalformedRetroProposalError);
  });

  it("propagates schema rejections for invalid proposals", async () => {
    await expect(
      writeRetroProposal({
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
      }),
    ).rejects.toBeInstanceOf(MalformedRetroProposalError);
  });

  it("propagates schema rejection for a path-traversal in skill-create.proposed_path", async () => {
    await expect(
      writeRetroProposal({
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
      }),
    ).rejects.toBeInstanceOf(MalformedRetroProposalError);
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
    } finally {
      await fs.rm(tmpA, { recursive: true, force: true });
      await fs.rm(tmpB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// routeDurability unit tests (AC2, AC3, AC4)
// ---------------------------------------------------------------------------

describe("routeDurability — AC2: pitfall/tool-quirk + failure_class + recurrence>1 → code", () => {
  it("pitfall kind with failure_class and recurrence 2 → code", () => {
    const result = routeDurability("pitfall", "handoff-grammar", {
      recurrence: 2,
    });
    expect(result.recommendation).toBe("code");
    expect(result.reason).toBe(DURABILITY_REASONS.code);
  });

  it("tool-quirk kind with failure_class and recurrence 3 → code", () => {
    const result = routeDurability("tool-quirk", "mcp-timeout", {
      recurrence: 3,
    });
    expect(result.recommendation).toBe("code");
    expect(result.reason).toBe(DURABILITY_REASONS.code);
  });

  it("pitfall with failure_class but recurrence = 1 → note (not code; needs >1)", () => {
    const result = routeDurability("pitfall", "handoff-grammar", {
      recurrence: 1,
    });
    expect(result.recommendation).toBe("note");
  });

  it("pitfall WITHOUT failure_class and recurrence 2 → note (failure_class required for code)", () => {
    const result = routeDurability("pitfall", undefined, { recurrence: 2 });
    expect(result.recommendation).toBe("note");
  });

  it("pitfall with empty failure_class and recurrence 2 → note", () => {
    // empty string should not trigger code route
    const result = routeDurability("pitfall", "", { recurrence: 2 });
    expect(result.recommendation).toBe("note");
  });
});

describe("routeDurability — AC3: pattern + multi-role/story + recurrence>1 → skill", () => {
  it("pattern kind with role_count 2 and recurrence 2 → skill", () => {
    const result = routeDurability("pattern", undefined, {
      recurrence: 2,
      role_count: 2,
    });
    expect(result.recommendation).toBe("skill");
    expect(result.reason).toBe(DURABILITY_REASONS.skill);
  });

  it("pattern kind with story_count 3 and recurrence 2 → skill", () => {
    const result = routeDurability("pattern", undefined, {
      recurrence: 2,
      story_count: 3,
    });
    expect(result.recommendation).toBe("skill");
    expect(result.reason).toBe(DURABILITY_REASONS.skill);
  });

  it("pattern kind with role_count 1 and story_count 1, recurrence 2 → note (needs >1 spread)", () => {
    const result = routeDurability("pattern", undefined, {
      recurrence: 2,
      role_count: 1,
      story_count: 1,
    });
    expect(result.recommendation).toBe("note");
  });

  it("pattern kind with role_count 2 but recurrence = 1 → note (needs recurrence >1)", () => {
    const result = routeDurability("pattern", undefined, {
      recurrence: 1,
      role_count: 2,
    });
    expect(result.recommendation).toBe("note");
  });

  it("discipline kind with role_count 2 and recurrence 2 → note (only pattern triggers skill)", () => {
    const result = routeDurability("discipline", undefined, {
      recurrence: 2,
      role_count: 2,
    });
    expect(result.recommendation).toBe("note");
  });
});

describe("routeDurability — AC4: observed once / judgment-shaped → note", () => {
  it("any kind with recurrence 1 and no failure_class → note", () => {
    for (const kind of ["pitfall", "pattern", "tool-quirk", "discipline"] as const) {
      const result = routeDurability(kind, undefined, { recurrence: 1 });
      expect(result.recommendation).toBe("note");
      expect(result.reason).toBe(DURABILITY_REASONS.note);
    }
  });

  it("undefined kind with recurrence 1 → note", () => {
    const result = routeDurability(undefined, undefined, { recurrence: 1 });
    expect(result.recommendation).toBe("note");
  });
});

// ---------------------------------------------------------------------------
// writeRetroProposal integration: durability recommendation in proposal
// (AC1 — recurring lesson carries recommendation in body and return value)
// ---------------------------------------------------------------------------

describe("writeRetroProposal — durability recommendation integration (AC1)", () => {
  const PERSONA_ULID = "01HZPERS0000000000000000PA";
  const ISO2 = "2026-06-04T10:00:00.000Z";

  it("persona-append with routing_context gets durability_recommendation in frontmatter, body, and return value", async () => {
    const personaProposal = {
      type: "persona-append",
      id: PERSONA_ULID,
      created_at: ISO2,
      rationale: "Dev forgot to emit the locked phrase twice in a row.",
      target_role: "generalist-dev",
      lesson: "Always emit the locked handoff phrase as the final line.",
      kind: "pitfall",
      failure_class: "handoff-grammar",
      routing_context: {
        recurrence: 2,
      },
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO2,
      proposals: [personaProposal],
    });

    // Return value carries the recommendation.
    expect(result.durabilityRecommendations).toHaveLength(1);
    const rec = result.durabilityRecommendations[0]!;
    expect(rec.proposalId).toBe(PERSONA_ULID);
    expect(rec.recommendation).toBe("code");
    expect(rec.reason).toBe(DURABILITY_REASONS.code);

    // Read back and verify frontmatter round-trips with durability_recommendation.
    const { frontmatter, body } = await readWrittenFile(result.absPath);
    const parsed = parseRetroProposalFile(yamlParse(frontmatter));
    const storedProposal = parsed.proposals[0]!;
    expect(storedProposal.type).toBe("persona-append");
    if (storedProposal.type === "persona-append") {
      expect(storedProposal.durability_recommendation).toEqual({
        recommendation: "code",
        reason: DURABILITY_REASONS.code,
      });
    }

    // Body shows the durability recommendation line.
    expect(body).toContain("**Durability recommendation:** code —");
    expect(body).toContain(DURABILITY_REASONS.code);
  });

  it("persona-append with routing_context for skill route appears correctly", async () => {
    const personaProposal = {
      type: "persona-append",
      id: PERSONA_ULID,
      created_at: ISO2,
      rationale: "Multiple roles run the same pre-flight checklist manually.",
      target_role: "generalist-dev",
      lesson: "Run the pre-flight checklist before every story claim.",
      kind: "pattern",
      routing_context: {
        recurrence: 3,
        role_count: 2,
      },
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO2,
      proposals: [personaProposal],
    });

    expect(result.durabilityRecommendations[0]!.recommendation).toBe("skill");

    const { body } = await readWrittenFile(result.absPath);
    expect(body).toContain("**Durability recommendation:** skill —");
  });

  it("persona-append with routing_context recurrence=1 gets note recommendation", async () => {
    const personaProposal = {
      type: "persona-append",
      id: PERSONA_ULID,
      created_at: ISO2,
      rationale: "One-off edge case seen once.",
      target_role: "generalist-dev",
      lesson: "Check edge case X when Y applies.",
      kind: "discipline",
      routing_context: {
        recurrence: 1,
      },
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO2,
      proposals: [personaProposal],
    });

    expect(result.durabilityRecommendations[0]!.recommendation).toBe("note");

    const { body } = await readWrittenFile(result.absPath);
    expect(body).toContain("**Durability recommendation:** note —");
  });

  it("persona-append WITHOUT routing_context gets no durability_recommendation", async () => {
    const personaProposal = {
      type: "persona-append",
      id: PERSONA_ULID,
      created_at: ISO2,
      rationale: "A lesson with no routing context.",
      target_role: "generalist-dev",
      lesson: "Some lesson.",
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO2,
      proposals: [personaProposal],
    });

    // No routing context → no recommendation in return value or frontmatter.
    expect(result.durabilityRecommendations).toHaveLength(0);

    const { frontmatter, body } = await readWrittenFile(result.absPath);
    const parsed = parseRetroProposalFile(yamlParse(frontmatter));
    const storedProposal = parsed.proposals[0]!;
    if (storedProposal.type === "persona-append") {
      expect(storedProposal.durability_recommendation).toBeUndefined();
    }

    expect(body).not.toContain("Durability recommendation");
  });

  it("non-persona-append proposals produce no durability recommendations", async () => {
    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO2,
      proposals: [RULE_PROPOSAL, SKILL_CREATE_PROPOSAL, TEAM_CHANGE_PROPOSAL],
    });

    expect(result.durabilityRecommendations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// summariseRetroProposal — AC2 (empty cycle) + AC3 (parity with frontmatter)
// (Story native:01KTZGEW6TSC6M84P9KJ7FD96S)
// ---------------------------------------------------------------------------

import { summariseRetroProposal, renderRetroRecommendationsBlock } from "../summarise-retro-proposal.js";

const ISO3 = "2026-06-13T09:00:00.000Z";

describe("summariseRetroProposal — AC2: empty-cycle states no changes", () => {
  it("returns noProposals:true and totalCount:0 for an empty proposals file", async () => {
    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO3,
      proposals: [],
    });

    const summary = await summariseRetroProposal({ absPath });

    expect(summary.absPath).toBe(absPath);
    expect(summary.totalCount).toBe(0);
    expect(summary.noProposals).toBe(true);
    expect(summary.proposals).toHaveLength(0);
  });

  it("produces a summary the skill can render as 'no recommended changes'", async () => {
    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO3,
      proposals: [],
    });

    const summary = await summariseRetroProposal({ absPath });

    // The skill checks noProposals and renders the no-changes statement.
    // Verify the flag is present and truthful (AC2).
    expect(summary.noProposals).toBe(true);
    // proposals array is empty — the skill must not iterate it.
    expect(summary.proposals).toEqual([]);
  });
});

describe("summariseRetroProposal — AC3: parity with frontmatter proposal set", () => {
  const ULID_D = "01HZRETR0000000000000000D4";
  const ULID_E = "01HZRETR0000000000000000E5";
  const ISO4 = "2026-06-13T10:00:00.000Z";

  it("summary proposal set equals the file's frontmatter proposal set (type+id+rationale)", async () => {
    const proposals = [
      {
        type: "rule" as const,
        id: ULID_D,
        created_at: ISO4,
        rationale: "Handoff grammar must be verbatim.",
        text: "Emit handoff phrase verbatim.",
        target_failure_class: "handoff-grammar",
        recommended_promotion_level: "must" as const,
      },
      {
        type: "team-change" as const,
        id: ULID_E,
        created_at: ISO4,
        rationale: "Security patterns keep surfacing.",
        action: "hire" as const,
        target_role: "security-reviewer",
        justification: "Three fires in two cycles.",
        predicted_impact: { affected_failure_classes: ["security-audit"] },
      },
    ];

    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO4,
      proposals,
    });

    const summary = await summariseRetroProposal({ absPath });

    // AC3: the summary's proposal set must equal the file's frontmatter proposal set.
    // Read back the frontmatter directly for comparison.
    const raw = await fs.readFile(absPath, "utf8");
    const { frontmatter } = await readWrittenFile(absPath);
    const fileShape = parseRetroProposalFile(yamlParse(frontmatter));

    expect(summary.totalCount).toBe(fileShape.proposals.length);
    expect(summary.noProposals).toBe(false);
    expect(summary.proposals).toHaveLength(fileShape.proposals.length);

    // Every entry in the summary maps 1:1 to the file's frontmatter proposals.
    for (let i = 0; i < fileShape.proposals.length; i++) {
      const fp = fileShape.proposals[i]!;
      const sp = summary.proposals[i]!;
      expect(sp.type).toBe(fp.type);
      expect(sp.id).toBe(fp.id);
      expect(sp.rationale).toBe(fp.rationale);
    }

    void raw; // suppress unused-variable warning
  });

  it("noProposals is false when proposals list is non-empty", async () => {
    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO4,
      proposals: [
        {
          type: "rule",
          id: ULID_D,
          created_at: ISO4,
          rationale: "A rationale.",
          text: "A rule.",
          target_failure_class: "some-class",
          recommended_promotion_level: "should",
        },
      ],
    });

    const summary = await summariseRetroProposal({ absPath });
    expect(summary.noProposals).toBe(false);
    expect(summary.totalCount).toBe(1);
    expect(summary.proposals[0]!.type).toBe("rule");
    expect(summary.proposals[0]!.rationale).toBe("A rationale.");
  });

  it("throws when absPath does not exist", async () => {
    await expect(
      summariseRetroProposal({
        absPath: path.join(tmpRoot, ".flow", "retro-proposals", "nonexistent.md"),
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Engine-safety classifier unit tests
// (Story native:01KV76P2DW42BPBPT4ZQ0FS63Y — classifySkillChangeTarget)
// ---------------------------------------------------------------------------

describe("classifySkillChangeTarget — classifier unit", () => {
  it("paths under .flow/skills/ are team-owned", () => {
    expect(classifySkillChangeTarget(".flow/skills/foo.md")).toBe("team-owned");
    expect(classifySkillChangeTarget(".flow/skills/nested/bar.md")).toBe("team-owned");
    expect(classifySkillChangeTarget(".flow/skills/abc")).toBe("team-owned");
  });

  it("paths outside .flow/skills/ are engine", () => {
    expect(classifySkillChangeTarget("plugins/flow/catalogue/retro-analyst.md")).toBe("engine");
    expect(classifySkillChangeTarget("plugins/flow/mcp-server/src/tools/foo.ts")).toBe("engine");
    expect(classifySkillChangeTarget(".flow/skills-other/foo.md")).toBe("engine");
    expect(classifySkillChangeTarget(".flow/team/generalist-dev/PERSONA.md")).toBe("engine");
  });

  it("null, undefined, and empty string default to engine (safe side)", () => {
    expect(classifySkillChangeTarget(null)).toBe("engine");
    expect(classifySkillChangeTarget(undefined)).toBe("engine");
    expect(classifySkillChangeTarget("")).toBe("engine");
  });
});

// ---------------------------------------------------------------------------
// Engine-safety: writeRetroProposal intercepts engine-targeted skill proposals
// (Story native:01KV76P2DW42BPBPT4ZQ0FS63Y — AC1/AC2)
// ---------------------------------------------------------------------------

const ISO5 = "2026-06-16T08:00:00.000Z";
const ULID_F = "01HZRETR0000000000000000F6";
const ULID_G = "01HZRETR0000000000000000G7";
const ULID_H = "01HZRETR0000000000000000H8";

describe("writeRetroProposal — AC1: team-owned skill proposals pass through unchanged", () => {
  it("skill-revise targeting .flow/skills/ passes through as skill-revise", async () => {
    const proposal = {
      type: "skill-revise" as const,
      id: ULID_F,
      created_at: ISO5,
      rationale: "Tighten the pre-flight checklist skill.",
      target_skill_path: ".flow/skills/pre-flight-checklist.md",
      revised_body: "# Pre-flight checklist (revised)\n\nShorter version.\n",
      version_bump: "patch" as const,
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO5,
      proposals: [proposal],
    });

    // The proposal must survive as skill-revise — not converted to build-story.
    const { frontmatter } = await readWrittenFile(result.absPath);
    const fileShape = parseRetroProposalFile(yamlParse(frontmatter));
    expect(fileShape.proposals).toHaveLength(1);
    expect(fileShape.proposals[0]!.type).toBe("skill-revise");
    if (fileShape.proposals[0]!.type === "skill-revise") {
      expect(fileShape.proposals[0]!.target_skill_path).toBe(
        ".flow/skills/pre-flight-checklist.md",
      );
    }
  });

  it("skill-create targeting .flow/skills/ passes through as skill-create", async () => {
    const proposal = {
      type: "skill-create" as const,
      id: ULID_F,
      created_at: ISO5,
      rationale: "New skill for operators.",
      proposed_path: ".flow/skills/new-skill.md",
      frontmatter_description: "A new team-owned skill.",
      body: "# New skill\n\nDetails.\n",
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO5,
      proposals: [proposal],
    });

    const { frontmatter } = await readWrittenFile(result.absPath);
    const fileShape = parseRetroProposalFile(yamlParse(frontmatter));
    expect(fileShape.proposals[0]!.type).toBe("skill-create");
  });
});

describe("writeRetroProposal — AC2: engine-targeted skill proposals become build-story", () => {
  it("skill-revise targeting plugins/flow/... is emitted as build-story", async () => {
    const engineSkillRevise = {
      type: "skill-revise" as const,
      id: ULID_G,
      created_at: ISO5,
      rationale: "The retro wants to change a core plugin skill.",
      target_skill_path: "plugins/flow/catalogue/retro-analyst.md",
      revised_body: "# Revised analyst\n\nNew content.\n",
      version_bump: "minor" as const,
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO5,
      proposals: [engineSkillRevise],
    });

    // Must be converted to build-story — never skill-revise.
    const { frontmatter, body } = await readWrittenFile(result.absPath);
    const fileShape = parseRetroProposalFile(yamlParse(frontmatter));
    expect(fileShape.proposals).toHaveLength(1);
    const emitted = fileShape.proposals[0]!;
    expect(emitted.type).toBe("build-story");
    if (emitted.type === "build-story") {
      // Must NOT be one of the approve-and-apply skill types.
      expect(emitted.suggested_title).toContain("build-and-review");
      expect(emitted.skill_change_context).toContain(
        "plugins/flow/catalogue/retro-analyst.md",
      );
    }

    // Body must show it as a build-story, never as an approve-and-apply skill section.
    expect(body).toContain("build-story");
    // The H2 heading must name build-story, not skill-revise — so the type in the
    // proposal heading is build-story, even though skill_change_context prose mentions
    // the original type for provenance (that's fine and expected).
    expect(body).toContain("## Proposal 1 — build-story —");
    expect(body).not.toContain("## Proposal 1 — skill-revise —");
    expect(body).toContain("Queue a build-and-review story");
  });

  it("skill-create targeting an engine path becomes build-story", async () => {
    const engineSkillCreate = {
      type: "skill-create" as const,
      id: ULID_G,
      created_at: ISO5,
      rationale: "Retro wants a new core catalogue entry.",
      proposed_path: "plugins/flow/catalogue/new-role.md",
      frontmatter_description: "New core role",
      body: "# New core role\n\nDetails.\n",
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO5,
      proposals: [engineSkillCreate],
    });

    const { frontmatter } = await readWrittenFile(result.absPath);
    const fileShape = parseRetroProposalFile(yamlParse(frontmatter));
    expect(fileShape.proposals[0]!.type).toBe("build-story");
  });

  it("skill-retire targeting an engine path becomes build-story", async () => {
    const engineSkillRetire = {
      type: "skill-retire" as const,
      id: ULID_G,
      created_at: ISO5,
      rationale: "Retro wants to retire a core catalogue entry.",
      target_skill_path: "plugins/flow/catalogue/old-role.md",
      last_invoked_at: null,
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO5,
      proposals: [engineSkillRetire],
    });

    const { frontmatter } = await readWrittenFile(result.absPath);
    const fileShape = parseRetroProposalFile(yamlParse(frontmatter));
    expect(fileShape.proposals[0]!.type).toBe("build-story");
  });

  it("mixed batch: team-owned passes through, engine becomes build-story", async () => {
    const teamSkill = {
      type: "skill-revise" as const,
      id: ULID_F,
      created_at: ISO5,
      rationale: "Tighten a team skill.",
      target_skill_path: ".flow/skills/checklist.md",
      revised_body: "# Checklist\n\nRevised.\n",
      version_bump: "patch" as const,
    };
    const engineSkill = {
      type: "skill-revise" as const,
      id: ULID_G,
      created_at: ISO5,
      rationale: "Change a plugin catalogue file.",
      target_skill_path: "plugins/flow/catalogue/retro-analyst.md",
      revised_body: "# Analyst (revised)\n\nNew.\n",
      version_bump: "minor" as const,
    };

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO5,
      proposals: [teamSkill, engineSkill],
    });

    const { frontmatter } = await readWrittenFile(result.absPath);
    const fileShape = parseRetroProposalFile(yamlParse(frontmatter));
    expect(fileShape.proposals).toHaveLength(2);
    expect(fileShape.proposals[0]!.type).toBe("skill-revise");
    expect(fileShape.proposals[1]!.type).toBe("build-story");
  });

  it("non-skill proposals (rule, team-change) are not affected by the classifier", async () => {
    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO5,
      proposals: [RULE_PROPOSAL, TEAM_CHANGE_PROPOSAL],
    });

    const { frontmatter } = await readWrittenFile(result.absPath);
    const fileShape = parseRetroProposalFile(yamlParse(frontmatter));
    expect(fileShape.proposals.map((p) => p.type)).toEqual([
      "rule",
      "team-change",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Engine-safety: integration test
// (Story native:01KV76P2DW42BPBPT4ZQ0FS63Y — AC3)
// Integration: a full retro cycle that surfaces a core-machinery skill change
// must surface it ONLY as a build-story recommendation, never approve-and-apply.
// ---------------------------------------------------------------------------

describe("writeRetroProposal — AC3 (integration): engine skill change surfaces as build-story only", () => {
  const ISO6 = "2026-06-16T09:00:00.000Z";

  it("a retro cycle with a core-machinery skill-revise candidate produces only a build-story in the output file", async () => {
    // Simulate what the retro-analyst would produce after seeing a pattern
    // that calls for a change to the shipped plugin catalogue.
    const coreChangeCandidates = [
      {
        type: "rule" as const,
        id: ULID_F,
        created_at: ISO6,
        rationale: "Handoff phrase fires regularly.",
        text: "Always emit the handoff phrase verbatim.",
        target_failure_class: "handoff-grammar",
        recommended_promotion_level: "must" as const,
      },
      {
        // This targets the product's core machinery — must become build-story.
        type: "skill-revise" as const,
        id: ULID_G,
        created_at: ISO6,
        rationale: "The retro-analyst persona needs tightening based on cycle output.",
        target_skill_path: "plugins/flow/catalogue/retro-analyst.md",
        revised_body: "# Retro Analyst (revised)\n\n...\n",
        version_bump: "minor" as const,
      },
      {
        // This also targets core machinery (mcp-server source).
        type: "skill-create" as const,
        id: ULID_H,
        created_at: ISO6,
        rationale: "New core utility skill needed.",
        proposed_path: "plugins/flow/mcp-server/src/tools/new-tool.ts",
        frontmatter_description: "Core utility",
        body: "// Core utility\n",
      },
    ];

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO6,
      proposals: coreChangeCandidates,
    });

    const { frontmatter, body } = await readWrittenFile(result.absPath);
    const fileShape = parseRetroProposalFile(yamlParse(frontmatter));

    // AC3: the two engine-targeted proposals must surface as build-story,
    // never as skill-revise or skill-create (which would dead-end on apply).
    expect(fileShape.proposals).toHaveLength(3);

    const [ruleProposal, engineRevise, engineCreate] = fileShape.proposals;

    // The rule passes through unchanged.
    expect(ruleProposal!.type).toBe("rule");

    // Both engine-targeted skill changes become build-story.
    expect(engineRevise!.type).toBe("build-story");
    expect(engineCreate!.type).toBe("build-story");

    if (engineRevise!.type === "build-story") {
      expect(engineRevise!.skill_change_context).toContain(
        "plugins/flow/catalogue/retro-analyst.md",
      );
      // Suggested title must guide the operator toward the build path.
      expect(engineRevise!.suggested_title).toContain("build-and-review");
    }

    if (engineCreate!.type === "build-story") {
      expect(engineCreate!.skill_change_context).toContain(
        "plugins/flow/mcp-server/src/tools/new-tool.ts",
      );
    }

    // The body must show build-story headings, not approve-and-apply skill headings.
    // (skill_change_context in the body text may reference the original type for
    // provenance — that's expected. The H2 heading is what determines the proposal type.)
    expect(body).not.toContain("## Proposal 2 — skill-revise");
    expect(body).not.toContain("## Proposal 3 — skill-create");
    expect(body).toContain("## Proposal 2 — build-story");
    expect(body).toContain("## Proposal 3 — build-story");
    expect(body).toContain("Queue a build-and-review story");
  });
});

// ---------------------------------------------------------------------------
// renderRetroRecommendationsBlock — run closing summary
// (Story native:01KV7DH3KM2Q2F5ZQ5WX558KHG — AC1 integration + AC2 unit)
// ---------------------------------------------------------------------------

describe("renderRetroRecommendationsBlock — AC1 (integration): pending recommendations surface correctly", () => {
  it("renders a header line naming N change(s), lists each proposal, and points to accept-proposal", () => {
    const pending = [
      { type: "rule", rationale: "Handoff grammar must be verbatim.", id: ULID_A },
      { type: "team-change", rationale: "Security patterns keep surfacing.", id: ULID_B },
    ];

    const block = renderRetroRecommendationsBlock(pending);

    // AC1: operator learns the team reflected and N changes are pending
    expect(block).toContain("the team reflected and is recommending 2 change");
    // Each proposal listed with its kind and one-line rationale
    expect(block).toContain("[rule]");
    expect(block).toContain("Handoff grammar must be verbatim.");
    expect(block).toContain("[team-change]");
    expect(block).toContain("Security patterns keep surfacing.");
    // Pointer to the review step
    expect(block).toContain("/flow:accept-proposal");
  });

  it("uses singular 'change' when exactly 1 proposal is pending", () => {
    const pending = [
      { type: "persona-append", rationale: "One lesson to absorb.", id: ULID_A },
    ];

    const block = renderRetroRecommendationsBlock(pending);

    expect(block).toContain("recommending 1 change for your review");
    expect(block).not.toContain("changes");
    expect(block).toContain("[persona-append]");
    expect(block).toContain("One lesson to absorb.");
    expect(block).toContain("/flow:accept-proposal");
  });

  it("preserves ordering: proposals appear in the same order they are passed in", () => {
    const pending = [
      { type: "rule", rationale: "First.", id: ULID_A },
      { type: "team-change", rationale: "Second.", id: ULID_B },
      { type: "persona-append", rationale: "Third.", id: ULID_C },
    ];

    const block = renderRetroRecommendationsBlock(pending);

    const firstIdx = block.indexOf("First.");
    const secondIdx = block.indexOf("Second.");
    const thirdIdx = block.indexOf("Third.");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});

describe("renderRetroRecommendationsBlock — AC2 (unit): zero-pending case emits nothing-to-review", () => {
  it("returns a single clean line when passed an empty array", () => {
    const block = renderRetroRecommendationsBlock([]);

    // AC2: a single clean 'nothing to review' line
    expect(block).toContain("nothing to review");
    // No list items — no numbering, no bracket notation
    expect(block).not.toMatch(/\d+\.\s+\[/);
    // No pointer to accept-proposal (nothing to act on)
    expect(block).not.toContain("/flow:accept-proposal");
  });

  it("mentions automatic application in the nothing-to-review line", () => {
    const block = renderRetroRecommendationsBlock([]);

    // Operator understands WHY there's nothing to review (auto-applied or none produced)
    expect(block).toContain("applied automatically");
  });
});

describe("renderRetroRecommendationsBlock — reconciliation: absorbed IDs must not appear as pending", () => {
  it("does not include proposals that were auto-absorbed (caller-side filtering contract)", async () => {
    // The workflow filters absorbed IDs before passing to renderRetroRecommendationsBlock.
    // This test asserts the rendering function only shows what it is given — it never
    // re-filters (filtering is the caller's responsibility, keeping the function pure).
    const pending = [
      // Only the non-absorbed one is passed in — the absorbed one is already filtered out
      { type: "rule", rationale: "Pending rule.", id: ULID_A },
    ];

    const block = renderRetroRecommendationsBlock(pending);

    // Only the one pending proposal appears
    expect(block).toContain("[rule]");
    expect(block).toContain("Pending rule.");
    expect(block).not.toContain(ULID_B); // the absorbed ID never leaked in
  });
});

describe("renderRetroRecommendationsBlock — integration with summariseRetroProposal (AC1 end-to-end)", () => {
  const ISO_RUN = "2026-06-17T08:00:00.000Z";
  const ULID_R1 = "01KVRTR000000000000000RR01";
  const ULID_R2 = "01KVRTR000000000000000RR02";
  const ULID_R3 = "01KVRTR000000000000000RR03";

  it("summariseRetroProposal → filter absorbed → renderRetroRecommendationsBlock surfaces only pending entries", async () => {
    // Write a 3-proposal file; simulate auto-absorb taking one of them.
    const proposals = [
      {
        type: "rule" as const,
        id: ULID_R1,
        created_at: ISO_RUN,
        rationale: "Pending rule — was not auto-absorbed.",
        text: "Rule body.",
        target_failure_class: "handoff-grammar",
        recommended_promotion_level: "must" as const,
      },
      {
        type: "team-change" as const,
        id: ULID_R2,
        created_at: ISO_RUN,
        rationale: "Pending team change.",
        action: "hire" as const,
        target_role: "security-reviewer",
        justification: "Three fires.",
        predicted_impact: { affected_failure_classes: ["security"] },
      },
      {
        type: "rule" as const,
        id: ULID_R3,
        created_at: ISO_RUN,
        rationale: "This one was auto-absorbed.",
        text: "Auto-absorbed rule.",
        target_failure_class: "some-class",
        recommended_promotion_level: "should" as const,
      },
    ];

    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO_RUN,
      proposals,
    });

    // Simulate the workflow: summarise then filter absorbed IDs
    const summary = await summariseRetroProposal({ absPath });
    const absorbedIds = new Set([ULID_R3]); // the third was auto-absorbed
    const pendingProposals = summary.proposals.filter((p) => !absorbedIds.has(p.id));

    expect(pendingProposals).toHaveLength(2);

    const block = renderRetroRecommendationsBlock(pendingProposals);

    // AC1: operator sees the header naming 2 pending changes
    expect(block).toContain("recommending 2 change");
    // Both non-absorbed proposals appear
    expect(block).toContain("[rule]");
    expect(block).toContain("Pending rule — was not auto-absorbed.");
    expect(block).toContain("[team-change]");
    expect(block).toContain("Pending team change.");
    // The auto-absorbed proposal must NOT appear in the output
    expect(block).not.toContain("This one was auto-absorbed.");
    // Pointer to accept-proposal
    expect(block).toContain("/flow:accept-proposal");
  });

  it("when all proposals are auto-absorbed, the block is the nothing-to-review line", async () => {
    const proposals = [
      {
        type: "rule" as const,
        id: ULID_R1,
        created_at: ISO_RUN,
        rationale: "A note-tier lesson that was fully auto-absorbed.",
        text: "Auto-absorbed rule.",
        target_failure_class: "some-class",
        recommended_promotion_level: "should" as const,
      },
    ];

    const { absPath } = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      // Use a fresh timestamp to avoid collision with the previous test
      isoTimestamp: "2026-06-17T09:00:00.000Z",
      proposals,
    });

    const summary = await summariseRetroProposal({ absPath });
    // Simulate: all proposals were absorbed
    const absorbedIds = new Set([ULID_R1]);
    const pendingProposals = summary.proposals.filter((p) => !absorbedIds.has(p.id));

    expect(pendingProposals).toHaveLength(0);

    const block = renderRetroRecommendationsBlock(pendingProposals);

    // AC2: single clean nothing-to-review line, no list, no accept-proposal pointer
    expect(block).toContain("nothing to review");
    expect(block).not.toContain("/flow:accept-proposal");
    expect(block).not.toMatch(/\d+\.\s+\[/);
  });
});
