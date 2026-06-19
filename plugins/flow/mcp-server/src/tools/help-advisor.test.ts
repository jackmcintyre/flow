/**
 * Story native:01KVEHE5XNBHKVVZ624GPAW9FF — context-aware next-action advisor
 * (/flow:help).
 *
 * AC1: Given a project in any state, the operator gets a short, situation-aware
 *   recommendation grounded in live state — NOT a static command reference.
 * AC2: No team → first step is set up a team, points to /flow:hire.
 * AC3: Approved work waiting, nothing building → recommends /flow:run.
 * AC4: Parked drafts not yet approved → recommends /flow:ready before anything else.
 *
 * All ACs are exercised against `advise()` and `renderHelpAdvice()` — pure
 * functions with no IO. This is the same test strategy as `get-team-snapshot.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { advise, renderHelpAdvice } from "./help-advisor.js";
import type { HelpAdvice } from "./help-advisor.js";

// ---------------------------------------------------------------------------
// Helper — build a minimal snapshot for the pure `advise` function
// ---------------------------------------------------------------------------

interface Snapshot {
  hasTeam: boolean;
  readyAndClaimable: number;
  parkedDrafts: number;
  inProgressCount: number;
}

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    hasTeam: true,
    readyAndClaimable: 0,
    parkedDrafts: 0,
    inProgressCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 — situation-aware, not static
// ---------------------------------------------------------------------------

describe("AC1 — advice is situation-aware, not a static listing", () => {
  it("different project states produce different recommendations", () => {
    const noTeam = advise(snap({ hasTeam: false }));
    const withApprovedWork = advise(snap({ readyAndClaimable: 2 }));
    const withParkedDrafts = advise(snap({ parkedDrafts: 3 }));

    // All three must differ — a static listing would return the same text for all.
    expect(noTeam.recommendation).not.toEqual(withApprovedWork.recommendation);
    expect(noTeam.recommendation).not.toEqual(withParkedDrafts.recommendation);
    expect(withApprovedWork.recommendation).not.toEqual(withParkedDrafts.recommendation);
  });

  it("the rendered output includes the recommended command so the operator knows what to run", () => {
    const advice = advise(snap({ readyAndClaimable: 1 }));
    const output = renderHelpAdvice(advice);

    // The rendered block must mention the command in the header line.
    expect(output).toContain(advice.command);
  });

  it("renderHelpAdvice produces a compact block — a header line + blank + recommendation", () => {
    const advice: HelpAdvice = {
      situation: "backlog-empty",
      recommendation: "Run /flow:plan to author the next batch of stories.",
      command: "/flow:plan",
    };
    const output = renderHelpAdvice(advice);
    const lines = output.split("\n");

    // Line 0: header containing the command.
    expect(lines[0]).toContain("/flow:plan");
    // Line 1: blank separator.
    expect(lines[1]).toBe("");
    // Line 2: recommendation text.
    expect(lines[2]).toBe("Run /flow:plan to author the next batch of stories.");
    // No trailing newline in the rendered string.
    expect(output).not.toMatch(/\n$/);
  });
});

// ---------------------------------------------------------------------------
// AC2 — no team → set up a team
// ---------------------------------------------------------------------------

describe("AC2 — no team set up yet", () => {
  it("situation is 'no-team' when hasTeam is false", () => {
    const advice = advise(snap({ hasTeam: false }));
    expect(advice.situation).toBe("no-team");
  });

  it("command points to /flow:hire", () => {
    const advice = advise(snap({ hasTeam: false }));
    expect(advice.command).toBe("/flow:hire");
  });

  it("recommendation mentions setting up a team", () => {
    const advice = advise(snap({ hasTeam: false }));
    expect(advice.recommendation.toLowerCase()).toContain("team");
  });

  it("recommendation mentions /flow:hire", () => {
    const advice = advise(snap({ hasTeam: false }));
    expect(advice.recommendation).toContain("/flow:hire");
  });

  it("no-team takes priority over parked drafts (team first, then backlog)", () => {
    // Even if parked drafts exist, no-team wins because you can't judge stories
    // without a team.
    const advice = advise(snap({ hasTeam: false, parkedDrafts: 5 }));
    expect(advice.situation).toBe("no-team");
  });

  it("no-team takes priority over approved work (team first)", () => {
    const advice = advise(snap({ hasTeam: false, readyAndClaimable: 2 }));
    expect(advice.situation).toBe("no-team");
  });
});

// ---------------------------------------------------------------------------
// AC3 — approved work waiting, nothing building → start a run
// ---------------------------------------------------------------------------

describe("AC3 — approved work waiting, nothing currently building", () => {
  it("situation is 'approved-and-idle' when there is approved work and nothing in progress", () => {
    const advice = advise(snap({ readyAndClaimable: 1 }));
    expect(advice.situation).toBe("approved-and-idle");
  });

  it("command points to /flow:run", () => {
    const advice = advise(snap({ readyAndClaimable: 3 }));
    expect(advice.command).toBe("/flow:run");
  });

  it("recommendation mentions starting a run", () => {
    const advice = advise(snap({ readyAndClaimable: 1 }));
    expect(advice.recommendation.toLowerCase()).toMatch(/run|build/);
  });

  it("recommendation includes the story count when one story is approved", () => {
    const advice = advise(snap({ readyAndClaimable: 1 }));
    expect(advice.recommendation).toContain("1 story");
  });

  it("recommendation includes the story count when multiple stories are approved", () => {
    const advice = advise(snap({ readyAndClaimable: 4 }));
    expect(advice.recommendation).toContain("4 stories");
  });

  it("approved-and-idle requires inProgressCount to be 0 (if work is in progress it is not idle)", () => {
    // When in-progress work exists alongside approved work, the project is NOT
    // idle — the work-in-progress situation wins at the next priority level.
    const advice = advise(snap({ readyAndClaimable: 2, inProgressCount: 1 }));
    expect(advice.situation).toBe("work-in-progress");
  });
});

// ---------------------------------------------------------------------------
// AC4 — parked drafts not yet approved
// ---------------------------------------------------------------------------

describe("AC4 — parked drafts waiting for approval", () => {
  it("situation is 'parked-drafts' when there are un-approved items and nothing else is actionable", () => {
    const advice = advise(snap({ parkedDrafts: 2 }));
    expect(advice.situation).toBe("parked-drafts");
  });

  it("command points to /flow:ready", () => {
    const advice = advise(snap({ parkedDrafts: 1 }));
    expect(advice.command).toBe("/flow:ready");
  });

  it("recommendation mentions approving the drafts before building", () => {
    const advice = advise(snap({ parkedDrafts: 2 }));
    expect(advice.recommendation.toLowerCase()).toMatch(/approv|judge|ready/);
  });

  it("recommendation includes the draft count when one draft is parked", () => {
    const advice = advise(snap({ parkedDrafts: 1 }));
    expect(advice.recommendation).toContain("1 draft");
  });

  it("recommendation includes the draft count when multiple drafts are parked", () => {
    const advice = advise(snap({ parkedDrafts: 5 }));
    expect(advice.recommendation).toContain("5 drafts");
  });

  it("parked-drafts takes priority over approved-and-idle when BOTH exist", () => {
    // Parked drafts should be resolved before starting more work — we want
    // the operator to judge existing stories before queuing more.
    // However: if there is ALSO approved-and-claimable work, the advisor
    // should still tell the operator to approve the parked ones first because
    // they may become the NEXT thing to build once approved.
    // Per AC4: "recommends getting those drafts judged and approved before anything else".
    const advice = advise(snap({ parkedDrafts: 3, readyAndClaimable: 1 }));
    expect(advice.situation).toBe("parked-drafts");
  });

  it("parked-drafts situation does NOT fire when work is already in progress (run is already underway)", () => {
    // When in-progress work is running, the operator should focus on that rather
    // than jumping to /flow:ready mid-run. The work-in-progress situation covers this.
    const advice = advise(snap({ parkedDrafts: 2, inProgressCount: 1 }));
    expect(advice.situation).toBe("work-in-progress");
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("all-zeros (empty project with a team) → backlog-empty → plan new work", () => {
    const advice = advise(snap());
    expect(advice.situation).toBe("backlog-empty");
    expect(advice.command).toBe("/flow:plan");
  });

  it("work-in-progress alone (no claimable, no parked) → check on it via /flow:dashboard", () => {
    const advice = advise(snap({ inProgressCount: 2 }));
    expect(advice.situation).toBe("work-in-progress");
    expect(advice.command).toBe("/flow:dashboard");
  });

  it("renderHelpAdvice always starts with 'flow:help'", () => {
    const situations: HelpAdvice["situation"][] = [
      "no-team",
      "parked-drafts",
      "approved-and-idle",
      "work-in-progress",
      "backlog-empty",
    ];
    for (const situation of situations) {
      const advice: HelpAdvice = {
        situation,
        recommendation: "some recommendation",
        command: "/flow:test",
      };
      const output = renderHelpAdvice(advice);
      expect(output).toMatch(/^flow:help/);
    }
  });
});
