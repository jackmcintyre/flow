/**
 * Durability-routing tests for `writeRetroProposal` and `routeLessonDurability`
 * — Story DR1 / native:01KT6RH6XJFE2E09WMEHJ03JBD.
 *
 * Covers:
 *   AC1 (integration): a retro proposal invocation with lesson routings
 *         produces a file whose body contains "Durability recommendation:"
 *         lines and whose return value carries structured `routedLessons`.
 *   AC2 (unit): pitfall/tool-quirk + failure_class + recurrence > 1 → 'code'.
 *   AC3 (unit): pattern + (roleCount > 1 OR storyCount > 1) + recurrence > 1 → 'skill'.
 *   AC4 (unit): one-off judgment call (no matching rule) → 'note'.
 *
 * The existing `__tests__/write-retro-proposal.test.ts` covers write-path
 * mechanics (collision, path-traversal, round-trip). This file focuses on
 * the routing heuristic and the integration of routing output into the
 * proposal artifact.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  routeLessonDurability,
  writeRetroProposal,
  type LessonRoutingInput,
} from "./write-retro-proposal.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ISO = "2026-06-04T10:00:00.000Z";
const ULID_A = "01HZRETR0000000000000000A1";

// ---------------------------------------------------------------------------
// Tmpdir helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-routing-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

// ---------------------------------------------------------------------------
// AC2: code routing
// ---------------------------------------------------------------------------

describe("routeLessonDurability — 'code' routing (AC2)", () => {
  it("routes a pitfall with failure_class and recurrence > 1 to 'code'", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "pitfall",
        text: "Always validate the timestamp before path-forming.",
        failure_class: "path-traversal",
      },
      recurrence: 3,
    };
    const result = routeLessonDurability(input);
    expect(result.tier).toBe("code");
    expect(result.reason).toContain("stable mechanical shape");
    expect(result.reason).toContain("guard makes it impossible");
  });

  it("routes a tool-quirk with failure_class and recurrence > 1 to 'code'", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "tool-quirk",
        text: "fs.access inverts the error — ENOENT means safe to write.",
        failure_class: "fs-access-inversion",
      },
      recurrence: 2,
    };
    const result = routeLessonDurability(input);
    expect(result.tier).toBe("code");
  });

  it("does NOT route a pitfall to 'code' when recurrence is exactly 1 (first occurrence)", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "pitfall",
        text: "Watch out for YAML stringify ordering.",
        failure_class: "yaml-ordering",
      },
      recurrence: 1,
    };
    const result = routeLessonDurability(input);
    // recurrence == 1 → falls through to 'note'
    expect(result.tier).toBe("note");
  });

  it("does NOT route a pitfall to 'code' when failure_class is absent", () => {
    // pitfall without failure_class should fall through to 'note'
    // (LessonSchema enforces failure_class for pitfall, but routing heuristic
    //  checks independently)
    const input: LessonRoutingInput = {
      // Cast to bypass the LessonSchema superRefine for this unit test
      lesson: {
        kind: "pitfall" as const,
        text: "A pitfall without a failure class.",
        // no failure_class
      } as Parameters<typeof routeLessonDurability>[0]["lesson"],
      recurrence: 3,
    };
    const result = routeLessonDurability(input);
    expect(result.tier).toBe("note");
  });
});

// ---------------------------------------------------------------------------
// AC3: skill routing
// ---------------------------------------------------------------------------

describe("routeLessonDurability — 'skill' routing (AC3)", () => {
  it("routes a pattern with roleCount > 1 and recurrence > 1 to 'skill'", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "pattern",
        text: "Always run getStatus before claiming a story.",
      },
      recurrence: 2,
      roleCount: 3,
      storyCount: 1,
    };
    const result = routeLessonDurability(input);
    expect(result.tier).toBe("skill");
    expect(result.reason).toContain("multiple roles or stories");
    expect(result.reason).toContain("shared skill makes it reusable");
  });

  it("routes a pattern with storyCount > 1 and recurrence > 1 to 'skill'", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "pattern",
        text: "Pre-flight check: read the manifest before coding.",
      },
      recurrence: 2,
      roleCount: 1,
      storyCount: 4,
    };
    const result = routeLessonDurability(input);
    expect(result.tier).toBe("skill");
  });

  it("does NOT route a pattern to 'skill' when recurrence is exactly 1", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "pattern",
        text: "Use the deterministic seam pattern.",
      },
      recurrence: 1,
      roleCount: 2,
      storyCount: 2,
    };
    const result = routeLessonDurability(input);
    // recurrence == 1 → falls through to 'note'
    expect(result.tier).toBe("note");
  });

  it("does NOT route a pattern to 'skill' when both roleCount and storyCount are 1", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "pattern",
        text: "A single-role, single-story pattern.",
      },
      recurrence: 5,
      roleCount: 1,
      storyCount: 1,
    };
    const result = routeLessonDurability(input);
    // cross-role/story condition not met → 'note'
    expect(result.tier).toBe("note");
  });
});

// ---------------------------------------------------------------------------
// AC4: note routing (all other cases)
// ---------------------------------------------------------------------------

describe("routeLessonDurability — 'note' routing (AC4)", () => {
  it("routes a one-off discipline lesson (any kind, no failure_class, recurrence == 1) to 'note'", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "discipline",
        text: "Check the spec carefully before estimating complexity.",
      },
      recurrence: 1,
    };
    const result = routeLessonDurability(input);
    expect(result.tier).toBe("note");
    expect(result.reason).toContain("one-off judgment call");
    expect(result.reason).toContain("note is the right home");
  });

  it("routes a pitfall with recurrence == 1 to 'note'", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "pitfall",
        text: "Watch out for race conditions in concurrent writes.",
        failure_class: "race-condition",
      },
      recurrence: 1,
    };
    const result = routeLessonDurability(input);
    expect(result.tier).toBe("note");
  });

  it("routes a tool-quirk without failure_class to 'note' even at high recurrence", () => {
    // tool-quirk + no failure_class → can't apply Rule 1 → falls through to 'note'
    const input: LessonRoutingInput = {
      lesson: {
        kind: "tool-quirk",
        text: "The YAML library sorts keys alphabetically by default.",
        // no failure_class
      },
      recurrence: 10,
    };
    const result = routeLessonDurability(input);
    expect(result.tier).toBe("note");
  });

  it("routes a single-role single-story pattern with high recurrence to 'note'", () => {
    const input: LessonRoutingInput = {
      lesson: {
        kind: "pattern",
        text: "This pattern was observed once by one role.",
      },
      recurrence: 5,
      // roleCount and storyCount both default to 1 when omitted
    };
    const result = routeLessonDurability(input);
    expect(result.tier).toBe("note");
  });
});

// ---------------------------------------------------------------------------
// AC1: integration — writeRetroProposal embeds routing in markdown + result
// ---------------------------------------------------------------------------

describe("writeRetroProposal — durability routing integration (AC1)", () => {
  const PERSONA_APPEND_PROPOSAL = {
    type: "persona-append",
    id: ULID_A,
    created_at: ISO,
    rationale: "Recurring lesson that should be baked into the dev role.",
    target_role: "generalist-dev",
    lesson: "Always read the manifest before coding.",
  };

  it("embeds Durability recommendation lines in the markdown body for each routed lesson", async () => {
    const lessonRoutings: LessonRoutingInput[] = [
      {
        lesson: {
          kind: "pitfall",
          text: "Always validate timestamp before path-forming.",
          failure_class: "path-traversal",
        },
        recurrence: 3,
      },
      {
        lesson: {
          kind: "pattern",
          text: "Run getStatus pre-flight before every claim.",
        },
        recurrence: 2,
        roleCount: 2,
        storyCount: 1,
      },
    ];

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [PERSONA_APPEND_PROPOSAL],
      lessonRoutings,
    });

    // Structured result carries routedLessons.
    expect(result.routedLessons).toHaveLength(2);
    expect(result.routedLessons[0]!.recommendation.tier).toBe("code");
    expect(result.routedLessons[1]!.recommendation.tier).toBe("skill");

    // The on-disk markdown body contains the recommendation lines.
    const raw = await fs.readFile(result.absPath, "utf8");

    // "Durability recommendations" section header present.
    expect(raw).toContain("## Durability recommendations");

    // Each lesson appears with its recommendation.
    expect(raw).toContain("**Lesson:** Always validate timestamp before path-forming.");
    expect(raw).toContain("**Durability recommendation:** code —");
    expect(raw).toContain("**Lesson:** Run getStatus pre-flight before every claim.");
    expect(raw).toContain("**Durability recommendation:** skill —");
  });

  it("returns empty routedLessons when no lessonRoutings are provided (backward compat)", async () => {
    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [],
    });

    expect(result.routedLessons).toEqual([]);

    // No durability section in the markdown.
    const raw = await fs.readFile(result.absPath, "utf8");
    expect(raw).not.toContain("## Durability recommendations");
  });

  it("every recurring lesson carries both a tier and a plain-language reason (AC1 contract)", async () => {
    const lessonRoutings: LessonRoutingInput[] = [
      // code-routed
      {
        lesson: {
          kind: "tool-quirk",
          text: "SIGTERM cascade hits both MCPs on subagent exit.",
          failure_class: "mcp-cascade-sigterm",
        },
        recurrence: 4,
      },
      // skill-routed
      {
        lesson: {
          kind: "pattern",
          text: "Use deterministic seams for load-bearing decisions.",
        },
        recurrence: 3,
        roleCount: 1,
        storyCount: 3,
      },
      // note-routed
      {
        lesson: {
          kind: "discipline",
          text: "Double-check the merge target before opening a PR.",
        },
        recurrence: 1,
      },
    ];

    const result = await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [],
      lessonRoutings,
    });

    expect(result.routedLessons).toHaveLength(3);

    for (const routed of result.routedLessons) {
      // Every lesson carries a tier.
      expect(["note", "skill", "code"]).toContain(routed.recommendation.tier);
      // Every lesson carries a non-empty plain-language reason.
      expect(routed.recommendation.reason.length).toBeGreaterThan(0);
      // The lesson text is preserved for correlation.
      expect(routed.lessonText.length).toBeGreaterThan(0);
    }

    // Verify the three tiers are all represented.
    const tiers = result.routedLessons.map((r) => r.recommendation.tier);
    expect(tiers).toContain("code");
    expect(tiers).toContain("skill");
    expect(tiers).toContain("note");
  });
});
