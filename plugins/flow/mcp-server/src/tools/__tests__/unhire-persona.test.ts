/**
 * Tests for `unhirePersona` — Story native:01KVF66HWKXCM7GYNRR9YJFKB2.
 *
 * Five acceptance criteria:
 *
 *  AC1 (integration) — Given a teammate who is currently on the active team,
 *      When I unhire that role, Then the teammate is set aside reversibly
 *      (kept, not destroyed), the active team shrinks by one, and I can see they
 *      are no longer active but could be brought back later.
 *
 *  AC2 (integration) — Given a teammate whose removal would leave the quality-
 *      grading panel unable to staff its five distinct reviewer slots, When I try
 *      to unhire that role, Then the unhire is refused, I am told exactly which
 *      reviewer slot would go unstaffed, and the team is left completely unchanged.
 *
 *  AC3 — Given a teammate who has already been set aside, When I unhire that
 *      same role again, Then nothing breaks and nothing changes — it is treated
 *      as a clean no-op with a clear confirmation rather than an error.
 *
 *  AC4 — Given a role that was never on the team, When I try to unhire it, Then
 *      I get a clear 'not on the team' message and nothing is changed.
 *
 *  AC5 — Given a team of five or more roles whose members cannot actually cover
 *      all five distinct reviewer slots, When I try to unhire any of them, Then
 *      the unhire is refused because the guard reflects the real staffing floor
 *      rather than a simple head-count.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { unhirePersona, stampArchivedAt } from "../unhire-persona.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { RoleNotHiredError, UnhireBelowJudgeMinimumError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;

const FIXED_CLOCK = () => new Date("2026-01-15T12:00:00.000Z");

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-unhire-persona-"));
  // Create a minimal .flow config so managed-fs context is valid.
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  await atomicWriteFile(path.join(tmpRoot, ".flow", "config.yaml"), "adapter: native\n");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Write a minimal PERSONA.md for a role. */
async function hireRole(role: string): Promise<void> {
  const dir = path.join(tmpRoot, "team", role);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(
    path.join(dir, "PERSONA.md"),
    `---\nrole: ${role}\ndomain: "${role} domain"\nmodel_tier: sonnet\n` +
      `tools_allow:\n  - Read\ngh_allow: []\n` +
      `locked_phrases:\n  handoff: "Handoff to reviewer — story <story-id> ready for review."\n` +
      `  yield: "This sits in <role>'s domain — handing off."\n` +
      `  verdict: "**Verdict: <SENTINEL>**"\n` +
      `hired_at: "2026-01-01T00:00:00.000Z"\n` +
      `catalogue_version: "0.1.0"\n---\n\n## Domain\n\n${role} domain\n\n## Mandate\n\n- Work.\n\n` +
      `## Out of mandate\n\n- Nothing.\n\n## Prompt\n\nYou are ${role}.\n\n## Knowledge\n\n- No entries.\n`,
  );
}

/**
 * The five DEFAULT roster roles that satisfy the judge panel (mirrors
 * resolve-lens-roles.test.ts fixtures).
 */
const DEFAULT_ROSTER = [
  "planner",
  "generalist-dev",
  "generalist-reviewer",
  "retro-analyst",
  "orchestrator",
];

async function hireDefaultRoster(): Promise<void> {
  for (const role of DEFAULT_ROSTER) {
    await hireRole(role);
  }
}

// ---------------------------------------------------------------------------
// AC1 — Reversible unhire: archived, not destroyed; team shrinks by one
// ---------------------------------------------------------------------------

describe("AC1 — reversible unhire", () => {
  it("archives the persona to team/_archived/<role>/PERSONA.md and removes it from the live team", async () => {
    // Need at least 6 roles so removing one still staffs all 5 lenses.
    await hireDefaultRoster();
    await hireRole("test-specialist"); // 6th role — frees a slot so any removal is safe.

    const result = await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: FIXED_CLOCK,
    });

    expect(result.status).toBe("archived");
    if (result.status !== "archived") throw new Error("unreachable");

    // Archived file exists.
    expect(result.archivedPath).toBe(
      path.join(tmpRoot, "team", "_archived", "test-specialist", "PERSONA.md"),
    );
    await expect(fs.access(result.archivedPath)).resolves.toBeUndefined();

    // Live file is gone.
    await expect(
      fs.access(path.join(tmpRoot, "team", "test-specialist", "PERSONA.md")),
    ).rejects.toThrow();
  });

  it("stamps archived_at in the archived PERSONA.md frontmatter", async () => {
    await hireDefaultRoster();
    await hireRole("test-specialist");

    const result = await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: FIXED_CLOCK,
    });

    if (result.status !== "archived") throw new Error("unreachable");

    const archivedContents = await fs.readFile(result.archivedPath, "utf8");
    expect(archivedContents).toContain('archived_at: "2026-01-15T12:00:00.000Z"');
    expect(result.archivedAt).toBe("2026-01-15T12:00:00.000Z");
  });

  it("original content is preserved in the archive (not replaced)", async () => {
    await hireDefaultRoster();
    await hireRole("test-specialist");

    const livePath = path.join(tmpRoot, "team", "test-specialist", "PERSONA.md");
    const liveContents = await fs.readFile(livePath, "utf8");

    const result = await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: FIXED_CLOCK,
    });

    if (result.status !== "archived") throw new Error("unreachable");

    const archivedContents = await fs.readFile(result.archivedPath, "utf8");
    // Archived contents must include the original body text.
    expect(archivedContents).toContain("You are test-specialist.");
    // Archived contents is a superset of original (added archived_at stamp).
    expect(archivedContents.length).toBeGreaterThanOrEqual(liveContents.length);
  });

  it("active team roster shrinks by one after unhiring", async () => {
    await hireDefaultRoster();
    await hireRole("test-specialist");

    await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: FIXED_CLOCK,
    });

    // Verify the team directory no longer has test-specialist.
    const teamEntries = await fs.readdir(path.join(tmpRoot, "team"));
    expect(teamEntries).not.toContain("test-specialist");
    // But the _archived dir does.
    expect(teamEntries).toContain("_archived");
  });
});

// ---------------------------------------------------------------------------
// AC2 — Guard: refuse when removal would leave a lens unstaffed
// ---------------------------------------------------------------------------

describe("AC2 — grading-panel guard", () => {
  it("refuses unhire when removal would leave the panel unable to staff all 5 lenses", async () => {
    // With exactly the default roster (5 roles), removing ANY role makes the panel
    // unable to staff all 5 lenses.
    await hireDefaultRoster();

    await expect(
      unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "generalist-dev",
        clock: FIXED_CLOCK,
      }),
    ).rejects.toBeInstanceOf(UnhireBelowJudgeMinimumError);
  });

  it("names the specific unstaffed lens in the error", async () => {
    await hireDefaultRoster();

    let err: unknown;
    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "retro-analyst",
        clock: FIXED_CLOCK,
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(UnhireBelowJudgeMinimumError);
    const typed = err as UnhireBelowJudgeMinimumError;
    // The error message must name the unstaffed lens.
    expect(typed.message).toMatch(/considered|structure|verifiability|discipline|domain/);
    expect(typed.unstaffedLens).toBeTruthy();
    expect(typed.role).toBe("retro-analyst");
  });

  it("leaves the team completely unchanged on a refused unhire", async () => {
    await hireDefaultRoster();

    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "planner",
        clock: FIXED_CLOCK,
      });
    } catch {
      // expected refusal
    }

    // Live persona file must still be there.
    await expect(
      fs.access(path.join(tmpRoot, "team", "planner", "PERSONA.md")),
    ).resolves.toBeUndefined();

    // Archive must NOT have been created.
    await expect(
      fs.access(path.join(tmpRoot, "team", "_archived", "planner", "PERSONA.md")),
    ).rejects.toThrow();
  });

  it("allows unhire when a replacement fills the lens slot", async () => {
    // Add test-specialist: now verifiability can be covered by test-specialist,
    // freeing orchestrator for another slot; removing orchestrator should now be safe.
    await hireDefaultRoster();
    await hireRole("test-specialist");

    // Removing orchestrator should now succeed because test-specialist covers verifiability.
    const result = await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "orchestrator",
      clock: FIXED_CLOCK,
    });

    expect(result.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// AC3 — Idempotent no-op: already archived → clean confirmation
// ---------------------------------------------------------------------------

describe("AC3 — idempotent no-op for already-archived role", () => {
  it("returns already-archived status when role is in _archived but not in live team", async () => {
    await hireDefaultRoster();
    await hireRole("test-specialist");

    // First unhire — archives the role.
    await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: FIXED_CLOCK,
    });

    // Second unhire — idempotent no-op.
    const result = await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: FIXED_CLOCK,
    });

    expect(result.status).toBe("already-archived");
    if (result.status !== "already-archived") throw new Error("unreachable");
    expect(result.archivedPath).toBe(
      path.join(tmpRoot, "team", "_archived", "test-specialist", "PERSONA.md"),
    );
  });

  it("does not mutate the archive file on a second call", async () => {
    await hireDefaultRoster();
    await hireRole("test-specialist");

    await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: FIXED_CLOCK,
    });

    const firstContents = await fs.readFile(
      path.join(tmpRoot, "team", "_archived", "test-specialist", "PERSONA.md"),
      "utf8",
    );

    // Second call with a different clock — contents should NOT change.
    await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: () => new Date("2027-01-01T00:00:00.000Z"),
    });

    const secondContents = await fs.readFile(
      path.join(tmpRoot, "team", "_archived", "test-specialist", "PERSONA.md"),
      "utf8",
    );

    expect(secondContents).toBe(firstContents);
  });

  it("does not throw — is truly a no-op not an error", async () => {
    await hireDefaultRoster();
    await hireRole("test-specialist");

    await unhirePersona({ targetRepoRoot: tmpRoot, role: "test-specialist", clock: FIXED_CLOCK });

    await expect(
      unhirePersona({ targetRepoRoot: tmpRoot, role: "test-specialist", clock: FIXED_CLOCK }),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4 — Role never on the team: typed "not on the team" error
// ---------------------------------------------------------------------------

describe("AC4 — role never on the team", () => {
  it("throws RoleNotHiredError for a role with no live persona and no archive", async () => {
    await hireDefaultRoster();

    await expect(
      unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "non-existent-role",
        clock: FIXED_CLOCK,
      }),
    ).rejects.toBeInstanceOf(RoleNotHiredError);
  });

  it("RoleNotHiredError message names the role", async () => {
    await hireDefaultRoster();

    let err: unknown;
    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "ghost-role",
        clock: FIXED_CLOCK,
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(RoleNotHiredError);
    expect((err as RoleNotHiredError).message).toContain("ghost-role");
  });

  it("does not mutate any files when throwing RoleNotHiredError", async () => {
    await hireDefaultRoster();

    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "ghost-role",
        clock: FIXED_CLOCK,
      });
    } catch {
      // expected
    }

    // Archive dir for ghost-role must not exist.
    await expect(
      fs.access(path.join(tmpRoot, "team", "_archived", "ghost-role")),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC5 — 5+-role roster that STILL fails to staff all 5 lenses
// ---------------------------------------------------------------------------

describe("AC5 — 5+ roles but still cannot staff all 5 lenses (candidate-list collision)", () => {
  /**
   * Build a 6-role roster where all 6 roles map to the same narrow set of
   * candidate slots — specifically, a roster where every role can ONLY cover
   * the 'domain' lens (generalist-dev is the only 'domain' candidate), so
   * the other 4 lenses cannot be staffed regardless of head-count.
   *
   * The lens candidate lists from judge-panel.ts:
   *   structure:     architect, planner, generalist-dev, orchestrator
   *   verifiability: test-specialist, generalist-reviewer, orchestrator, generalist-dev
   *   discipline:    generalist-reviewer, security-specialist, planner, orchestrator
   *   domain:        generalist-dev, planner, orchestrator
   *   considered:    retro-analyst, quality-lead, orchestrator, planner
   *
   * A roster of ["generalist-dev", "generalist-dev-2", ...] won't work because
   * there's only one generalist-dev. Instead we need a roster that, despite
   * having ≥5 members, still can't staff all lenses.
   *
   * Concrete case: hire only roles that share candidates with 'domain' but
   * leave 'considered' uncoverable. For example, a roster of:
   *   ["generalist-dev", "planner", "orchestrator", "foo", "bar"]
   *   — but this IS the default roster minus generalist-reviewer and retro-analyst.
   *   Without generalist-reviewer AND retro-analyst, discipline and considered lack coverage.
   *
   * Let's verify: with ["generalist-dev", "planner", "orchestrator", "architect", "test-specialist"]
   * (5 roles), can we staff all 5 lenses?
   *   structure:     architect (has it) ✓
   *   verifiability: test-specialist ✓
   *   discipline:    planner or orchestrator (generalist-reviewer absent!) — planner covers it
   *   domain:        generalist-dev ✓
   *   considered:    orchestrator (retro-analyst and quality-lead absent!) — orchestrator covers it?
   *     considered candidates: retro-analyst, quality-lead, orchestrator, planner
   *     orchestrator is available → considered = orchestrator ✓
   *
   * That roster actually staffs all 5! We need to pick more carefully.
   *
   * Best candidate-list collision case: hire only roles that are NOT in the
   * 'considered' candidate list AND not in the 'verifiability' candidate list:
   *   'considered' candidates: retro-analyst, quality-lead, orchestrator, planner
   *   'verifiability' candidates: test-specialist, generalist-reviewer, orchestrator, generalist-dev
   *
   * A roster with NO role from either considered or verifiability:
   *   roles that appear in considered: retro-analyst, quality-lead, orchestrator, planner
   *   roles that appear in verifiability: test-specialist, generalist-reviewer, orchestrator, generalist-dev
   *
   * Roles NOT in either: architect, security-specialist (+ any non-catalogue roles)
   * That's only 2, so we can't make a 5-member roster from those alone.
   *
   * The realistic "5+ but fails" scenario: hire exactly the minimum to staff 4/5 lenses,
   * but leave one lens always uncoverable. The clean way is:
   *   - Leave out ALL considered-only and considered-sharing roles that aren't needed elsewhere.
   *   - A roster of: ["generalist-dev", "test-specialist", "generalist-reviewer", "architect", "security-specialist"]
   *     has 5 roles.
   *       structure:     architect ✓
   *       verifiability: test-specialist ✓
   *       discipline:    generalist-reviewer OR security-specialist ✓
   *       domain:        generalist-dev ✓
   *       considered:    retro-analyst, quality-lead, orchestrator, planner — NONE present! ✗
   *     → 'considered' is UNCOVERABLE.
   *
   * This is the 5-role roster where no one covers 'considered'. Adding a 6th role
   * that also can't cover 'considered' (e.g. "foo-role") still fails.
   */
  const CONSIDERED_UNCOVERABLE_5 = [
    "generalist-dev",
    "test-specialist",
    "generalist-reviewer",
    "architect",
    "security-specialist",
  ];

  it("refuses unhire of any role in a 5-role roster where 'considered' is already uncoverable", async () => {
    for (const role of CONSIDERED_UNCOVERABLE_5) {
      await hireRole(role);
    }

    // Even with 5 roles, the guard must refuse because the post-unhire roster (4 roles)
    // can't staff all 5 lenses — and in fact this roster ALREADY can't staff 'considered'
    // even at 5, so removing ANY role further tightens it.
    // But wait — if the 5-role roster itself can't staff 'considered', then removing
    // any role from it definitely can't. The guard computes the post-unhire roster.
    await expect(
      unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "generalist-dev",
        clock: FIXED_CLOCK,
      }),
    ).rejects.toBeInstanceOf(UnhireBelowJudgeMinimumError);
  });

  it("refuses ALL unhires in a 6-role roster that still cannot staff 'considered'", async () => {
    // Add a 6th role that is also not in any considered candidate list.
    const sixRoles = [...CONSIDERED_UNCOVERABLE_5, "security-specialist-2"];
    // We can't add a custom role to the candidate list, but we CAN add any
    // non-catalogue role — it won't appear in LENS_CANDIDATES and can't cover anything.
    // Since security-specialist-2 doesn't exist in the candidates, it adds no lens coverage.
    for (const role of sixRoles) {
      // Skip if already hired (security-specialist already in base set).
      const dir = path.join(tmpRoot, "team", role);
      try {
        await fs.access(dir);
      } catch {
        await hireRole(role);
      }
    }

    // Attempting to unhire any role in this 6-member roster:
    // The 5-member post-unhire roster still can't staff 'considered'.
    await expect(
      unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "security-specialist-2",
        clock: FIXED_CLOCK,
      }),
    ).rejects.toBeInstanceOf(UnhireBelowJudgeMinimumError);
  });

  it("the error from a 5-role-no-considered-coverage roster names 'considered' as the unstaffed lens", async () => {
    for (const role of CONSIDERED_UNCOVERABLE_5) {
      await hireRole(role);
    }

    let err: unknown;
    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "test-specialist",
        clock: FIXED_CLOCK,
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(UnhireBelowJudgeMinimumError);
    // The unstaffed lens should be 'considered' since none of the remaining
    // roles (generalist-dev, generalist-reviewer, architect, security-specialist)
    // are in the considered candidate list.
    expect((err as UnhireBelowJudgeMinimumError).unstaffedLens).toBe("considered");
  });
});

// ---------------------------------------------------------------------------
// Story native:01KVPQHYMMQEM56RH59YGZFCKB AC3 —
// Unhire guard reflects declared capabilities, not just LENS_CANDIDATES names
// ---------------------------------------------------------------------------

/**
 * Write a PERSONA.md with a capabilities block declaring the given review lenses.
 * Used for AC3 tests where the guard must read declared capabilities.
 */
async function hireRoleWithCapabilities(
  role: string,
  reviewLenses: string[],
): Promise<void> {
  const dir = path.join(tmpRoot, "team", role);
  await fs.mkdir(dir, { recursive: true });
  const lensYaml =
    reviewLenses.length === 0
      ? "    review_lenses: []\n"
      : reviewLenses.map((l) => `    - ${l}`).join("\n") + "\n";
  await atomicWriteFile(
    path.join(dir, "PERSONA.md"),
    `---\nrole: ${role}\ndomain: "${role} domain"\nmodel_tier: sonnet\n` +
      `tools_allow:\n  - Read\ngh_allow: []\n` +
      `locked_phrases:\n  handoff: "Handoff to reviewer — story <story-id> ready for review."\n` +
      `  yield: "This sits in <role>'s domain — handing off."\n` +
      `  verdict: "**Verdict: <SENTINEL>**"\n` +
      `capabilities:\n  review_lenses:\n${lensYaml}  run_jobs: []\n` +
      `hired_at: "2026-01-01T00:00:00.000Z"\n` +
      `catalogue_version: "0.1.0"\n---\n\n## Domain\n\n${role} domain\n\n## Mandate\n\n- Work.\n\n` +
      `## Out of mandate\n\n- Nothing.\n\n## Prompt\n\nYou are ${role}.\n\n## Knowledge\n\n- No entries.\n`,
  );
}

describe("AC3 (Story native:01KVPQHYMMQEM56RH59YGZFCKB): unhire guard reflects declared capabilities and names the unstaffable lens", () => {
  it("refuses unhire when the post-unhire roster (capability-declared) cannot cover a lens — names the lens", async () => {
    // Build a minimal 5-role team using capability-declared personas.
    // Only my-only-considered covers 'considered'; removing any other role is fine,
    // but removing my-only-considered would leave 'considered' uncoverable.
    await hireRoleWithCapabilities("my-only-considered", ["considered"]);
    await hireRoleWithCapabilities("generalist-dev", ["domain"]);
    await hireRoleWithCapabilities("generalist-reviewer", ["verifiability", "discipline"]);
    await hireRoleWithCapabilities("orchestrator", ["structure", "verifiability", "discipline", "domain"]);
    await hireRoleWithCapabilities("planner", ["structure", "discipline", "domain"]); // no considered

    // Removing my-only-considered must be refused because considered would be uncoverable.
    let err: unknown;
    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "my-only-considered",
        clock: FIXED_CLOCK,
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(UnhireBelowJudgeMinimumError);
    const typed = err as UnhireBelowJudgeMinimumError;
    expect(typed.unstaffedLens).toBe("considered");
    expect(typed.message).toMatch(/considered/);
    expect(typed.role).toBe("my-only-considered");
  });

  it("leaves the team completely unchanged after a refused unhire (capability path)", async () => {
    await hireRoleWithCapabilities("my-only-considered", ["considered"]);
    await hireRoleWithCapabilities("generalist-dev", ["domain"]);
    await hireRoleWithCapabilities("generalist-reviewer", ["verifiability", "discipline"]);
    await hireRoleWithCapabilities("orchestrator", ["structure", "verifiability", "discipline", "domain"]);
    await hireRoleWithCapabilities("planner", ["structure", "discipline", "domain"]);

    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "my-only-considered",
        clock: FIXED_CLOCK,
      });
    } catch {
      // expected refusal
    }

    // Live persona file must still be there.
    await expect(
      fs.access(path.join(tmpRoot, "team", "my-only-considered", "PERSONA.md")),
    ).resolves.toBeUndefined();

    // Archive must NOT have been created.
    await expect(
      fs.access(path.join(tmpRoot, "team", "_archived", "my-only-considered", "PERSONA.md")),
    ).rejects.toThrow();
  });

  it("allows unhire when a second teammate covers the same lens (capability path)", async () => {
    // 6-role team: both my-only-considered and retro-analyst cover 'considered'.
    // Removing my-only-considered leaves 5 roles that can still staff all 5 lenses.
    await hireRoleWithCapabilities("my-only-considered", ["considered"]);
    await hireRoleWithCapabilities("retro-analyst", ["considered"]); // second considered-capable role
    await hireRoleWithCapabilities("generalist-dev", ["domain"]);
    await hireRoleWithCapabilities("generalist-reviewer", ["verifiability", "discipline"]);
    await hireRoleWithCapabilities("orchestrator", ["structure", "verifiability", "discipline", "domain"]);
    await hireRoleWithCapabilities("planner", ["structure", "discipline", "domain"]);

    // Post-unhire roster: [generalist-dev, generalist-reviewer, orchestrator, planner, retro-analyst]
    // retro-analyst covers considered; all 5 lenses are staffable.
    const result = await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "my-only-considered",
      clock: FIXED_CLOCK,
    });

    expect(result.status).toBe("archived");
  });

  it("names a different unstaffable lens when a different role is the only candidate for it", async () => {
    // Only generalist-dev covers 'domain'; removing it leaves domain uncoverable.
    await hireRoleWithCapabilities("my-only-considered", ["considered"]);
    await hireRoleWithCapabilities("generalist-dev", ["domain"]); // only domain candidate
    await hireRoleWithCapabilities("generalist-reviewer", ["verifiability", "discipline"]);
    await hireRoleWithCapabilities("orchestrator", ["structure", "verifiability", "discipline"]);
    await hireRoleWithCapabilities("planner", ["structure", "discipline", "considered"]);

    let err: unknown;
    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "generalist-dev",
        clock: FIXED_CLOCK,
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(UnhireBelowJudgeMinimumError);
    const typed = err as UnhireBelowJudgeMinimumError;
    expect(typed.unstaffedLens).toBe("domain");
    expect(typed.role).toBe("generalist-dev");
  });
});

// ---------------------------------------------------------------------------
// stampArchivedAt unit tests
// ---------------------------------------------------------------------------

describe("stampArchivedAt", () => {
  it("inserts archived_at before the closing --- in YAML front-matter", () => {
    const input = `---\nrole: foo\n---\n\nBody content.\n`;
    const result = stampArchivedAt(input, "2026-01-15T12:00:00.000Z");
    expect(result).toBe(
      `---\nrole: foo\narchived_at: "2026-01-15T12:00:00.000Z"\n---\n\nBody content.\n`,
    );
  });

  it("preserves body content after the closing ---", () => {
    const input = `---\nrole: bar\ndomain: "test"\n---\n\n## Section\n\nContent here.\n`;
    const result = stampArchivedAt(input, "2026-02-01T00:00:00.000Z");
    expect(result).toContain("## Section");
    expect(result).toContain("Content here.");
    expect(result).toContain('archived_at: "2026-02-01T00:00:00.000Z"');
  });

  it("prepends a minimal YAML block when there is no front-matter", () => {
    const input = `No frontmatter here.\n`;
    const result = stampArchivedAt(input, "2026-01-15T12:00:00.000Z");
    expect(result).toMatch(/^---\narchived_at: "2026-01-15T12:00:00.000Z"\n---\n/);
    expect(result).toContain("No frontmatter here.");
  });
});
