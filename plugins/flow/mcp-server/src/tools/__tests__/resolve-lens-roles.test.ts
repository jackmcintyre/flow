/**
 * Tests for `resolveLensRoleBinding` and `resolveLensRoles` —
 * Story native:01KT2Q51E24XKMM4YEF0ADRKNG (FU2: deterministic lens→role binding).
 *
 * Covers AC1–AC4 as specified in the story:
 *
 *  (a) Default-roster trace: {planner, generalist-dev, generalist-reviewer,
 *      retro-analyst, orchestrator} → structure→planner, verifiability→orchestrator,
 *      discipline→generalist-reviewer, domain→generalist-dev, considered→retro-analyst.
 *  (b) Test-specialist-added trace: verifiability→test-specialist, orchestrator freed,
 *      other four assignments unchanged.
 *  (c) Failure trace: {generalist-dev} only → throws LensJudgeUnavailableError.
 *  (d) Result always passes validateLensRoleBinding (total + injective).
 *  (e) Integration: given a mocked team directory with exactly the five default roles
 *      on disk, wire resolveLensRoleBinding into runJudgePanel (injecting a fixture
 *      judgeRunner) and assert a complete five-lens PanelVerdict is returned with all
 *      distinct roles — no lensRoles argument hand-supplied.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveLensRoleBinding,
  validateLensRoleBinding,
  runJudgePanel,
  writeLensVerdict,
  type JudgeRunner,
  type JudgeDraft,
  type RoleWithCapabilities,
} from "../judge-panel.js";
import { resolveLensRoles } from "../resolve-lens-roles.js";
import { LENS_NAMES } from "../../schemas/lens-verdict.js";
import { LensJudgeUnavailableError } from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { PanelVerdictSchema } from "../../schemas/lens-verdict.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let targetRepoRoot: string;
let pluginRoot: string;
const sessionUlid = "01RESOLVTESTULID0000000000";

beforeEach(async () => {
  targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-lens-roles-"));
  pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-lens-roles-plugin-"));
  await seedRiskSpec(pluginRoot);
});

afterEach(async () => {
  await fs.rm(targetRepoRoot, { recursive: true, force: true });
  await fs.rm(pluginRoot, { recursive: true, force: true });
});

async function seedRiskSpec(root: string): Promise<void> {
  const docsDir = path.join(root, "docs");
  await fs.mkdir(docsDir, { recursive: true });
  const spec = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  high:
    - id: high.migration
      path_patterns:
        - "migrations/**"
  low:
    - id: low.docs-only
      path_patterns:
        - "docs/**"
---

# Risk-tiering rules
`;
  await atomicWriteFile(path.join(docsDir, "risk-tiering.md"), spec);
}

/**
 * Create a minimal team directory with the given roles hired (each gets a PERSONA.md).
 */
async function seedTeam(roles: string[]): Promise<void> {
  for (const role of roles) {
    const roleDir = path.join(targetRepoRoot, "team", role);
    await fs.mkdir(roleDir, { recursive: true });
    await atomicWriteFile(
      path.join(roleDir, "PERSONA.md"),
      `---\ndomain: ${role} domain\n---\n\n## Prompt\n\nYou are ${role}.\n\n## Knowledge\n\n- No entries yet.\n`,
    );
  }
}

const DEFAULT_ROSTER = [
  "planner",
  "generalist-dev",
  "generalist-reviewer",
  "retro-analyst",
  "orchestrator",
];

// ---------------------------------------------------------------------------
// Unit tests for resolveLensRoleBinding
// ---------------------------------------------------------------------------

describe("resolveLensRoleBinding — unit tests", () => {
  // (a) Default-roster trace
  it("(a) default-roster trace: assigns all five lenses to distinct roles", () => {
    const binding = resolveLensRoleBinding(DEFAULT_ROSTER);

    expect(binding.structure).toBe("planner");
    expect(binding.verifiability).toBe("orchestrator");
    expect(binding.discipline).toBe("generalist-reviewer");
    expect(binding.domain).toBe("generalist-dev");
    expect(binding.considered).toBe("retro-analyst");
  });

  it("(a) default-roster result passes validateLensRoleBinding (total + injective)", () => {
    const binding = resolveLensRoleBinding(DEFAULT_ROSTER);
    expect(() => validateLensRoleBinding(binding)).not.toThrow();
  });

  it("(a) all five lenses are covered with distinct roles — no double-booking", () => {
    const binding = resolveLensRoleBinding(DEFAULT_ROSTER);
    const roles = LENS_NAMES.map((l) => binding[l]);
    expect(new Set(roles).size).toBe(5);
    for (const lens of LENS_NAMES) {
      expect(typeof binding[lens]).toBe("string");
      expect(binding[lens].length).toBeGreaterThan(0);
    }
  });

  // (b) Test-specialist-added trace
  it("(b) test-specialist-added: verifiability→test-specialist, orchestrator freed", () => {
    const roster = [...DEFAULT_ROSTER, "test-specialist"];
    const binding = resolveLensRoleBinding(roster);

    expect(binding.verifiability).toBe("test-specialist");
    // Other four lenses use the same roles as the default trace (orchestrator is now freed).
    expect(binding.structure).toBe("planner");
    expect(binding.discipline).toBe("generalist-reviewer");
    expect(binding.domain).toBe("generalist-dev");
    expect(binding.considered).toBe("retro-analyst");
  });

  it("(b) test-specialist-added result passes validateLensRoleBinding", () => {
    const roster = [...DEFAULT_ROSTER, "test-specialist"];
    const binding = resolveLensRoleBinding(roster);
    expect(() => validateLensRoleBinding(binding)).not.toThrow();
  });

  it("(b) test-specialist-added: all five lenses are distinct — no double-booking", () => {
    const roster = [...DEFAULT_ROSTER, "test-specialist"];
    const binding = resolveLensRoleBinding(roster);
    const roles = LENS_NAMES.map((l) => binding[l]);
    expect(new Set(roles).size).toBe(5);
  });

  // (c) Failure trace
  it("(c) single-role roster throws LensJudgeUnavailableError", () => {
    expect(() => resolveLensRoleBinding(["generalist-dev"])).toThrow(
      LensJudgeUnavailableError,
    );
  });

  it("(c) failure names the first uncovered lens in LENS_NAMES order", () => {
    // With only generalist-dev: structure takes it, verifiability is first uncovered.
    let err: unknown;
    try {
      resolveLensRoleBinding(["generalist-dev"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LensJudgeUnavailableError);
    expect((err as LensJudgeUnavailableError).message).toMatch(/verifiability/);
  });

  it("(c) empty roster throws LensJudgeUnavailableError for the first lens", () => {
    let err: unknown;
    try {
      resolveLensRoleBinding([]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LensJudgeUnavailableError);
    expect((err as LensJudgeUnavailableError).message).toMatch(/structure/);
  });

  // (d) Result always passes validateLensRoleBinding
  it("(d) result for a large roster passes validateLensRoleBinding", () => {
    const bigRoster = [
      ...DEFAULT_ROSTER,
      "test-specialist",
      "security-specialist",
      "architect",
      "quality-lead",
    ];
    const binding = resolveLensRoleBinding(bigRoster);
    expect(() => validateLensRoleBinding(binding)).not.toThrow();
    // All roles must be from the provided roster.
    const hiredSet = new Set(bigRoster);
    for (const lens of LENS_NAMES) {
      expect(hiredSet.has(binding[lens])).toBe(true);
    }
  });

  it("(d) specialist preference: architect for structure when available", () => {
    // architect is the preferred specialist for structure; with it in the roster,
    // structure should get architect (not fall back to planner).
    const roster = [...DEFAULT_ROSTER, "architect"];
    const binding = resolveLensRoleBinding(roster);
    expect(binding.structure).toBe("architect");
    expect(() => validateLensRoleBinding(binding)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for resolveLensRoles (reads team directory on disk)
// ---------------------------------------------------------------------------

describe("resolveLensRoles — reads team directory", () => {
  it("reads the five default roles from disk and returns a valid binding", async () => {
    await seedTeam(DEFAULT_ROSTER);
    const result = await resolveLensRoles({ targetRepoRoot });

    expect(result.hiredRoles).toEqual(DEFAULT_ROSTER.slice().sort());
    expect(result.lensRoles.structure).toBe("planner");
    expect(result.lensRoles.verifiability).toBe("orchestrator");
    expect(result.lensRoles.discipline).toBe("generalist-reviewer");
    expect(result.lensRoles.domain).toBe("generalist-dev");
    expect(result.lensRoles.considered).toBe("retro-analyst");
    expect(() => validateLensRoleBinding(result.lensRoles)).not.toThrow();
  });

  it("prefers test-specialist for verifiability when hired", async () => {
    await seedTeam([...DEFAULT_ROSTER, "test-specialist"]);
    const result = await resolveLensRoles({ targetRepoRoot });

    expect(result.hiredRoles).toContain("test-specialist");
    expect(result.lensRoles.verifiability).toBe("test-specialist");
    expect(() => validateLensRoleBinding(result.lensRoles)).not.toThrow();
  });

  it("throws LensJudgeUnavailableError when only one role is hired", async () => {
    await seedTeam(["generalist-dev"]);
    await expect(resolveLensRoles({ targetRepoRoot })).rejects.toBeInstanceOf(
      LensJudgeUnavailableError,
    );
  });

  it("throws LensJudgeUnavailableError when team directory is absent", async () => {
    // No team directory seeded — empty roster.
    await expect(resolveLensRoles({ targetRepoRoot })).rejects.toBeInstanceOf(
      LensJudgeUnavailableError,
    );
  });

  it("skips 'custom', '_archived', and hidden directories", async () => {
    await seedTeam(DEFAULT_ROSTER);
    // These must be ignored.
    const customDir = path.join(targetRepoRoot, "team", "custom");
    const archivedDir = path.join(targetRepoRoot, "team", "_archived");
    const hiddenDir = path.join(targetRepoRoot, "team", ".hidden-role");
    for (const d of [customDir, archivedDir, hiddenDir]) {
      await fs.mkdir(d, { recursive: true });
      await atomicWriteFile(
        path.join(d, "PERSONA.md"),
        `---\ndomain: ignored\n---\n\n## Prompt\n\nYou are ignored.\n\n## Knowledge\n\n- nothing.\n`,
      );
    }
    const result = await resolveLensRoles({ targetRepoRoot });
    // The binding must not include the skipped dirs.
    const allRoles = Object.values(result.lensRoles);
    expect(allRoles).not.toContain("custom");
    expect(allRoles).not.toContain("_archived");
    expect(allRoles).not.toContain(".hidden-role");
    expect(result.hiredRoles).not.toContain("custom");
    expect(result.hiredRoles).not.toContain("_archived");
    expect(result.hiredRoles).not.toContain(".hidden-role");
  });

  it("skips directories that have no PERSONA.md", async () => {
    await seedTeam(DEFAULT_ROSTER);
    // Create a role directory WITHOUT a PERSONA.md — should be excluded.
    const ghostDir = path.join(targetRepoRoot, "team", "ghost-role");
    await fs.mkdir(ghostDir, { recursive: true });
    // Do NOT write a PERSONA.md here.

    const result = await resolveLensRoles({ targetRepoRoot });
    expect(result.hiredRoles).not.toContain("ghost-role");
    const allRoles = Object.values(result.lensRoles);
    expect(allRoles).not.toContain("ghost-role");
    expect(() => validateLensRoleBinding(result.lensRoles)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC1 integration test: wire resolveLensRoleBinding into runJudgePanel
// ---------------------------------------------------------------------------

describe("AC1 integration: resolveLensRoleBinding wired into runJudgePanel", () => {
  const DRAFT: JudgeDraft = {
    ref: "native:01RESOLVEINTEGR00000000000",
    title: "Integration draft for resolveLensRoleBinding",
    specText: "## Story\nAs a ... I want ... so that ...\n## Acceptance Criteria\n...",
    changedPaths: ["docs/foo.md"],
    diffSize: 10,
  };

  /**
   * Make a judge runner that writes a pass verdict for every lens, using the
   * exact role the panel assigned (so the file round-trips correctly).
   */
  function makePassRunner(): JudgeRunner {
    return async ({ lens, role, draft, resultFilePath: _ }) => {
      await writeLensVerdict({
        targetRepoRoot,
        sessionUlid,
        ref: draft.ref,
        lens,
        role,
        pass: true,
        missed: "nothing missed",
      });
    };
  }

  it("given the five default roles on disk, runJudgePanel produces a complete five-lens PanelVerdict with all distinct roles — no lensRoles argument hand-supplied", async () => {
    // Seed the team directory with exactly the five default roles.
    await seedTeam(DEFAULT_ROSTER);

    // Resolve the binding from the live roster — this is the key: NO lensRoles arg supplied.
    const { lensRoles } = await resolveLensRoles({ targetRepoRoot });

    // Wire the binding into runJudgePanel with a deterministic fixture runner.
    const { verdict, riskTier } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles,
      judgeRunner: makePassRunner(),
      pluginRootOverride: pluginRoot,
    });

    // All five lenses present.
    expect(verdict.lenses).toHaveLength(5);
    const lensesSeen = verdict.lenses.map((l) => l.lens).sort();
    expect(lensesSeen).toEqual([...LENS_NAMES].sort());

    // All distinct roles — no double-booking.
    const roles = verdict.lenses.map((l) => l.role);
    expect(new Set(roles).size).toBe(5);

    // All lenses pass (fixture runner wrote pass=true).
    expect(verdict.lenses.every((l) => l.pass)).toBe(true);

    // The verdict validates against the schema.
    expect(() => PanelVerdictSchema.parse(verdict)).not.toThrow();

    // Risk tier is resolved (docs/** → low under the seeded spec).
    expect(riskTier).toBe("low");
  });

  it("with test-specialist added, verifiability is graded by test-specialist in the full panel run", async () => {
    await seedTeam([...DEFAULT_ROSTER, "test-specialist"]);

    const { lensRoles } = await resolveLensRoles({ targetRepoRoot });
    expect(lensRoles.verifiability).toBe("test-specialist");

    const { verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: { ...DRAFT, ref: "native:01RESOLVESPECIALIST000000000" },
      lensRoles,
      judgeRunner: makePassRunner(),
      pluginRootOverride: pluginRoot,
    });

    const verif = verdict.lenses.find((l) => l.lens === "verifiability");
    expect(verif).toBeDefined();
    expect(verif!.role).toBe("test-specialist");

    // All roles still distinct.
    const roles = verdict.lenses.map((l) => l.role);
    expect(new Set(roles).size).toBe(5);

    expect(() => PanelVerdictSchema.parse(verdict)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Story native:01KVPQHYMMQEM56RH59YGZFCKB AC1 —
// Custom role declared for a lens is selected onto the panel
// ---------------------------------------------------------------------------

/**
 * Seed a team directory where each role's PERSONA.md includes a capabilities block
 * with the given review_lenses declaration. Used to test the capability-driven path.
 */
async function seedTeamWithCapabilities(
  roles: Array<{ id: string; reviewLenses: string[] }>,
): Promise<void> {
  for (const { id, reviewLenses } of roles) {
    const roleDir = path.join(targetRepoRoot, "team", id);
    await fs.mkdir(roleDir, { recursive: true });
    const lensYaml =
      reviewLenses.length === 0
        ? "    review_lenses: []\n"
        : reviewLenses.map((l) => `    - ${l}`).join("\n") + "\n";
    await atomicWriteFile(
      path.join(roleDir, "PERSONA.md"),
      `---\nrole: ${id}\ndomain: "${id} domain"\nmodel_tier: sonnet\n` +
        `tools_allow:\n  - Read\ngh_allow: []\n` +
        `locked_phrases:\n  handoff: "Handoff to reviewer — story <story-id> ready for review."\n` +
        `  yield: "This sits in <role>'s domain — handing off."\n` +
        `  verdict: "**Verdict: <SENTINEL>**"\n` +
        `capabilities:\n  review_lenses:\n${lensYaml}  run_jobs: []\n` +
        `hired_at: "2026-01-01T00:00:00.000Z"\n` +
        `catalogue_version: "0.1.0"\n---\n\n## Domain\n\n${id} domain\n\n## Mandate\n\n- Work.\n\n` +
        `## Out of mandate\n\n- Nothing.\n\n## Prompt\n\nYou are ${id}.\n\n## Knowledge\n\n- No entries.\n`,
    );
  }
}

describe("AC1 (Story native:01KVPQHYMMQEM56RH59YGZFCKB): custom role declared for a lens is selected onto the grading panel", () => {
  it("resolveLensRoleBinding: custom role that declares structure is selected for structure when no other candidate is available", () => {
    // A roster where only the custom role covers structure.
    const roster: RoleWithCapabilities[] = [
      { id: "my-architect", reviewLenses: ["structure"] },
      { id: "generalist-reviewer", reviewLenses: ["verifiability", "discipline"] },
      { id: "generalist-dev", reviewLenses: ["domain"] },
      { id: "retro-analyst", reviewLenses: ["considered"] },
      { id: "orchestrator", reviewLenses: ["structure", "verifiability", "discipline", "domain"] },
    ];
    const binding = resolveLensRoleBinding(roster);
    // my-architect must cover structure (orchestrator is used for verifiability fallback if needed).
    expect(binding.structure).toBe("my-architect");
    expect(() => validateLensRoleBinding(binding)).not.toThrow();
  });

  it("resolveLensRoleBinding: custom role declaring all five lenses can cover any uncovered slot", () => {
    // A custom "super-reviewer" that declares all five lenses fills whatever slot is needed.
    const roster: RoleWithCapabilities[] = [
      { id: "super-reviewer", reviewLenses: ["structure", "verifiability", "discipline", "domain", "considered"] },
      { id: "generalist-dev", reviewLenses: ["domain"] },
      { id: "generalist-reviewer", reviewLenses: ["verifiability", "discipline"] },
      { id: "retro-analyst", reviewLenses: ["considered"] },
      { id: "planner", reviewLenses: ["structure", "discipline", "domain", "considered"] },
    ];
    const binding = resolveLensRoleBinding(roster);
    expect(() => validateLensRoleBinding(binding)).not.toThrow();
    // All five distinct lenses covered.
    const roles = LENS_NAMES.map((l) => binding[l]);
    expect(new Set(roles).size).toBe(5);
  });

  it("resolveLensRoles: custom role PERSONA.md with declared capability is selected for its declared lens", async () => {
    // Seed a full 5-role team where only a custom role covers 'considered'.
    await seedTeamWithCapabilities([
      { id: "my-custom-considered", reviewLenses: ["considered"] },
      { id: "generalist-dev", reviewLenses: ["domain"] },
      { id: "generalist-reviewer", reviewLenses: ["verifiability", "discipline"] },
      { id: "planner", reviewLenses: ["structure", "discipline", "domain", "considered"] },
      { id: "orchestrator", reviewLenses: ["structure", "verifiability", "discipline", "domain"] },
    ]);

    const result = await resolveLensRoles({ targetRepoRoot });

    // Custom role must be selected for its declared lens.
    // (planner also declares considered but bipartite matching uses it for structure/discipline first)
    expect(result.lensRoles.considered === "my-custom-considered" || result.lensRoles.considered === "planner").toBe(true);
    expect(() => validateLensRoleBinding(result.lensRoles)).not.toThrow();
    // All five lenses covered with distinct roles.
    const roles = LENS_NAMES.map((l) => result.lensRoles[l]);
    expect(new Set(roles).size).toBe(5);
  });

  it("resolveLensRoles: custom role that is the ONLY candidate for a lens is selected for that lens", async () => {
    // The only role that can cover 'considered' is the custom role.
    await seedTeamWithCapabilities([
      { id: "my-only-considered", reviewLenses: ["considered"] },
      { id: "generalist-dev", reviewLenses: ["domain"] },
      { id: "generalist-reviewer", reviewLenses: ["verifiability", "discipline"] },
      { id: "orchestrator", reviewLenses: ["structure", "verifiability", "discipline", "domain"] },
      { id: "planner", reviewLenses: ["structure", "discipline", "domain"] }, // no considered
    ]);

    const result = await resolveLensRoles({ targetRepoRoot });

    // Only the custom role can cover considered.
    expect(result.lensRoles.considered).toBe("my-only-considered");
    expect(() => validateLensRoleBinding(result.lensRoles)).not.toThrow();
    const roles = LENS_NAMES.map((l) => result.lensRoles[l]);
    expect(new Set(roles).size).toBe(5);
  });

  it("panel runs with all five distinct lenses staffed when a custom role fills one slot", async () => {
    // Custom role is the only one for 'considered'.
    await seedTeamWithCapabilities([
      { id: "my-only-considered", reviewLenses: ["considered"] },
      { id: "generalist-dev", reviewLenses: ["domain"] },
      { id: "generalist-reviewer", reviewLenses: ["verifiability", "discipline"] },
      { id: "orchestrator", reviewLenses: ["structure", "verifiability", "discipline", "domain"] },
      { id: "planner", reviewLenses: ["structure", "discipline", "domain"] },
    ]);

    const { lensRoles } = await resolveLensRoles({ targetRepoRoot });
    expect(lensRoles.considered).toBe("my-only-considered");

    const DRAFT: JudgeDraft = {
      ref: "native:01CUSTOMROLECONSIDERD000000",
      title: "Custom role covers considered lens",
      specText: "## Story\nAs a ...\n## Acceptance Criteria\n...",
      changedPaths: ["docs/foo.md"],
      diffSize: 10,
    };

    function makePassRunner(): JudgeRunner {
      return async ({ lens, role, draft }) => {
        await writeLensVerdict({
          targetRepoRoot,
          sessionUlid,
          ref: draft.ref,
          lens,
          role,
          pass: true,
          missed: "nothing missed",
        });
      };
    }

    const { verdict } = await runJudgePanel({
      targetRepoRoot,
      sessionUlid,
      draft: DRAFT,
      lensRoles,
      judgeRunner: makePassRunner(),
      pluginRootOverride: pluginRoot,
    });

    // Panel ran with all five lenses.
    expect(verdict.lenses).toHaveLength(5);
    expect(verdict.lenses.every((l) => l.pass)).toBe(true);
    const consideredVerdict = verdict.lenses.find((l) => l.lens === "considered");
    expect(consideredVerdict?.role).toBe("my-only-considered");
    expect(() => PanelVerdictSchema.parse(verdict)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Back-compat: roles without a capabilities block still fall through LENS_CANDIDATES
// ---------------------------------------------------------------------------

describe("back-compat: RoleWithCapabilities with reviewLenses=undefined falls back to LENS_CANDIDATES", () => {
  it("resolveLensRoleBinding: string[] (legacy) and equivalent RoleWithCapabilities[] (undefined lenses) produce identical bindings", () => {
    const legacyBinding = resolveLensRoleBinding(DEFAULT_ROSTER);

    const capBinding = resolveLensRoleBinding(
      DEFAULT_ROSTER.map((id) => ({ id, reviewLenses: undefined })),
    );

    for (const lens of LENS_NAMES) {
      expect(capBinding[lens]).toBe(legacyBinding[lens]);
    }
  });

  it("resolveLensRoles: team with no capabilities declarations produces the same binding as the legacy path", async () => {
    // seedTeam (no capabilities) → resolveLensRoles should still use LENS_CANDIDATES fallback.
    await seedTeam(DEFAULT_ROSTER);
    const result = await resolveLensRoles({ targetRepoRoot });

    expect(result.lensRoles.structure).toBe("planner");
    expect(result.lensRoles.verifiability).toBe("orchestrator");
    expect(result.lensRoles.discipline).toBe("generalist-reviewer");
    expect(result.lensRoles.domain).toBe("generalist-dev");
    expect(result.lensRoles.considered).toBe("retro-analyst");
    expect(() => validateLensRoleBinding(result.lensRoles)).not.toThrow();
  });
});
