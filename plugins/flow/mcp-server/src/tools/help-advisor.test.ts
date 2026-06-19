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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { advise, getHelpAdvice, renderHelpAdvice } from "./help-advisor.js";
import type { HelpAdvice } from "./help-advisor.js";
import { atomicWriteFile } from "../lib/managed-fs.js";

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

// ---------------------------------------------------------------------------
// getHelpAdvice — integration against a real filesystem
//
// The pure-function suites above cover the priority ladder and renderer. These
// tests drive the public `getHelpAdvice` end-to-end against tmpdir fixtures so
// the state readers (team presence + backlog summary) are exercised against the
// actual on-disk shapes the advisor reads in a live project — the same strategy
// as list-claimable-todos.test.ts. This is what makes each AC's "Given a project
// in state X" clause real rather than simulated through a hand-built snapshot.
// ---------------------------------------------------------------------------

describe("getHelpAdvice — live project state (filesystem)", () => {
  let tmpRoot: string;

  async function makeStateDirs(): Promise<void> {
    for (const state of ["to-do", "in-progress", "done", "blocked"]) {
      await fs.mkdir(path.join(tmpRoot, ".flow", "state", state), { recursive: true });
    }
  }

  function manifestYaml(
    ref: string,
    opts: { ready?: boolean; status?: string; withdrawn?: boolean; depends_on?: string[] } = {},
  ): string {
    return yamlStringify(
      {
        ref,
        status: opts.status ?? "to-do",
        adapter: "native",
        source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
        source_hash: "a".repeat(64),
        depends_on: opts.depends_on ?? [],
        acceptance_criteria: [
          { text: "Given something, when something, then something works.", kind: "integration" },
        ],
        title: `Story ${ref}`,
        narrative: "As a user, I want something so that I can use it.",
        withdrawn: opts.withdrawn ?? false,
        ready: opts.ready ?? false,
      },
      { lineWidth: 0 },
    );
  }

  async function writeManifest(
    state: string,
    ref: string,
    opts?: Parameters<typeof manifestYaml>[1],
  ): Promise<void> {
    const p = path.join(tmpRoot, ".flow", "state", state, `${ref}.yaml`);
    await atomicWriteFile(p, manifestYaml(ref, opts));
  }

  async function hireRole(role: string): Promise<void> {
    await fs.mkdir(path.join(tmpRoot, "team", role), { recursive: true });
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-help-advisor-"));
    await makeStateDirs();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // AC2 — no team set up yet
  it("no team directory at all → recommends setting up a team (/flow:hire)", async () => {
    // No team/ dir, empty backlog.
    const advice = await getHelpAdvice({ targetRepoRoot: tmpRoot });
    expect(advice.situation).toBe("no-team");
    expect(advice.command).toBe("/flow:hire");
  });

  it("team dir exists but holds only skip dirs / hidden / non-dir entries → still no team", async () => {
    await fs.mkdir(path.join(tmpRoot, "team", "custom"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "team", "_archived"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "team", ".hidden"), { recursive: true });
    await atomicWriteFile(path.join(tmpRoot, "team", "README.md"), "not a role");
    const advice = await getHelpAdvice({ targetRepoRoot: tmpRoot });
    expect(advice.situation).toBe("no-team");
  });

  // AC4 — parked drafts not yet approved
  it("team hired + a parked (not-ready) draft → recommends approving via /flow:ready", async () => {
    await hireRole("planner");
    await writeManifest("to-do", "native:01HZHELP000000000000000001", { ready: false });
    const advice = await getHelpAdvice({ targetRepoRoot: tmpRoot });
    expect(advice.situation).toBe("parked-drafts");
    expect(advice.command).toBe("/flow:ready");
  });

  it("a withdrawn to-do item is ignored (not counted as a parked draft)", async () => {
    await hireRole("planner");
    await writeManifest("to-do", "native:01HZHELP000000000000000099", {
      ready: false,
      withdrawn: true,
    });
    const advice = await getHelpAdvice({ targetRepoRoot: tmpRoot });
    // Withdrawn item is filtered by isClaimable → backlog reads as empty.
    expect(advice.situation).toBe("backlog-empty");
  });

  // AC3 — approved work waiting, nothing building
  it("team + a ready story whose deps are all done → recommends starting a run (/flow:run)", async () => {
    await hireRole("planner");
    await writeManifest("done", "native:01HZHELP0000000000000000DEP");
    await writeManifest("to-do", "native:01HZHELP000000000000000002", {
      ready: true,
      depends_on: ["native:01HZHELP0000000000000000DEP"],
    });
    const advice = await getHelpAdvice({ targetRepoRoot: tmpRoot });
    expect(advice.situation).toBe("approved-and-idle");
    expect(advice.command).toBe("/flow:run");
  });

  it("a ready story with an unmet dependency is neither claimable nor parked → backlog-empty", async () => {
    await hireRole("planner");
    // dep manifest is NOT in done/ → depsReady false.
    await writeManifest("to-do", "native:01HZHELP000000000000000003", {
      ready: true,
      depends_on: ["native:01HZHELP0000000000000MISSING"],
    });
    const advice = await getHelpAdvice({ targetRepoRoot: tmpRoot });
    expect(advice.situation).toBe("backlog-empty");
    expect(advice.command).toBe("/flow:plan");
  });

  // work-in-progress
  it("an in-progress build (snapshot sidecar ignored) → recommends checking the dashboard", async () => {
    await hireRole("planner");
    await writeManifest("in-progress", "native:01HZHELP000000000000000004", {
      status: "in-progress",
    });
    // A snapshot sidecar must NOT be counted as a second in-progress story.
    await atomicWriteFile(
      path.join(
        tmpRoot,
        ".flow",
        "state",
        "in-progress",
        "native:01HZHELP000000000000000004.snapshot.yaml",
      ),
      "snapshot: true\n",
    );
    const advice = await getHelpAdvice({ targetRepoRoot: tmpRoot });
    expect(advice.situation).toBe("work-in-progress");
    expect(advice.command).toBe("/flow:dashboard");
  });

  // backlog-empty (team present, nothing queued)
  it("team hired, empty backlog → recommends planning new work (/flow:plan)", async () => {
    await hireRole("planner");
    const advice = await getHelpAdvice({ targetRepoRoot: tmpRoot });
    expect(advice.situation).toBe("backlog-empty");
    expect(advice.command).toBe("/flow:plan");
  });

  it("missing .flow/state directories entirely → reads as empty backlog, not an error", async () => {
    // Fresh repo: team hired but no .flow/state tree yet.
    await fs.rm(path.join(tmpRoot, ".flow"), { recursive: true, force: true });
    await hireRole("planner");
    const advice = await getHelpAdvice({ targetRepoRoot: tmpRoot });
    expect(advice.situation).toBe("backlog-empty");
  });
});
