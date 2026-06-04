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
