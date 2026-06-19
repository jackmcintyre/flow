/**
 * Wiring tests for unhire-via-/flow:hire — Story native:01KVFAAPMZWNK8838CMP4SNNC4.
 *
 * This story is pure wiring: it connects the already-built `unhirePersona`
 * tool (Story native:01KVF66HWKXCM7GYNRR9YJFKB2) into the hiring-manager
 * conversation's re-entry flow. No new core machinery.
 *
 * Three acceptance criteria:
 *
 *  AC1 (integration) — Given I have re-opened the team-management conversation
 *      and the team list shows a role I no longer want, When I say to unhire
 *      that role, Then that role is set aside, the displayed team list updates
 *      to show it gone, and I am shown the team-management options again.
 *
 *  AC2 — Given unhiring the role I named would leave the quality-grading panel
 *      unable to staff its reviewers, When I ask to unhire it, Then the
 *      conversation shows me the refusal explanation, the team is left exactly
 *      as it was, and I am shown the team-management options again.
 *
 *  AC3 — Given I name a role that is not currently on the team, When I ask to
 *      unhire it, Then the conversation tells me there is nothing to remove and
 *      leaves the team unchanged.
 *
 * Approach: the subagent owns re-entry actions per the catalogue prompt, so
 * these tests verify the two preconditions that make the subagent's actions
 * correct — the allowlist grant and the prose wiring — plus the tool-layer
 * behaviour for each of the three paths (success / guard-refusal / not-hired).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getPluginRoot } from "../../lib/plugin-root.js";
import { loadRolePermissions } from "../../state/load-role-permissions.js";
import { parseCatalogueRole } from "../../lib/markdown-frontmatter.js";
import { instantiatePersona } from "../instantiate-persona.js";
import { unhirePersona } from "../unhire-persona.js";
import {
  RoleNotHiredError,
  UnhireBelowJudgeMinimumError,
} from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

const FIXED_CLOCK = () => new Date("2026-06-19T12:00:00.000Z");
const FIXED_VERSION = "0.1.0";

/** Minimal five-role default roster — satisfies the judge panel. */
const DEFAULT_ROSTER = [
  "planner",
  "generalist-dev",
  "generalist-reviewer",
  "retro-analyst",
  "orchestrator",
] as const;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "flow-unhire-wiring-"),
  );
  // Minimal .flow config so managed-fs context is valid.
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\n",
  );
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Hire every role in a list via instantiatePersona. */
async function hireRoles(roles: readonly string[]): Promise<void> {
  for (const role of roles) {
    await instantiatePersona({
      pluginRoot: getPluginRoot(),
      targetRepoRoot: tmpRoot,
      role,
      clock: FIXED_CLOCK,
      pluginVersion: FIXED_VERSION,
    });
  }
}

/** List roles that currently have a live PERSONA.md under team/. */
async function liveRoles(): Promise<string[]> {
  const teamDir = path.join(tmpRoot, "team");
  let entries: string[];
  try {
    entries = await fs.readdir(teamDir);
  } catch {
    return [];
  }
  const SKIP = new Set(["custom", "_archived"]);
  const live: string[] = [];
  for (const e of entries) {
    if (SKIP.has(e) || e.startsWith(".")) continue;
    try {
      await fs.access(path.join(teamDir, e, "PERSONA.md"));
      live.push(e);
    } catch {
      /* not hired */
    }
  }
  return live.sort();
}

// ---------------------------------------------------------------------------
// Precondition 1 — allowlist grants unhirePersona
// (Ensures the subagent CAN call the tool from inside the conversation.)
// ---------------------------------------------------------------------------
describe("Precondition — hiring-manager allowlist grants unhirePersona (AC1 enabler)", () => {
  it("tools_allow includes unhirePersona", async () => {
    const perms = await loadRolePermissions({
      pluginRoot: getPluginRoot(),
      role: "hiring-manager",
    });
    expect([...perms.tools_allow]).toContain("unhirePersona");
  });
});

// ---------------------------------------------------------------------------
// Precondition 2 — catalogue prose wires the unhire response to the tool
// (Ensures the subagent KNOWS to call the tool and surface the right text.)
// ---------------------------------------------------------------------------
describe("Precondition — catalogue Prompt prose wires unhire re-entry (AC1/AC2/AC3 enabler)", () => {
  it("Prompt contains instruction to call unhirePersona on unhire response", async () => {
    const cataloguePath = path.join(
      getPluginRoot(),
      "catalogue",
      "hiring-manager.md",
    );
    const raw = await fs.readFile(cataloguePath, "utf8");
    const cat = parseCatalogueRole(raw, cataloguePath);
    const prompt = cat.sections.Prompt;

    // The Prompt must reference the tool by name.
    expect(prompt).toContain("unhirePersona");
  });

  it("Prompt describes the success path: role set aside, re-show options", async () => {
    const cataloguePath = path.join(
      getPluginRoot(),
      "catalogue",
      "hiring-manager.md",
    );
    const raw = await fs.readFile(cataloguePath, "utf8");
    const cat = parseCatalogueRole(raw, cataloguePath);
    const prompt = cat.sections.Prompt;

    // Probe for the success-path re-entry options re-prompt.
    expect(prompt).toContain(
      "Hire one more (specify catalogue role id), unhire {role}, view-persona {role}, or done.",
    );
    // The success path description must mention "archived".
    expect(prompt).toMatch(/archived/i);
  });

  it("Prompt describes the guard-refusal path: surface verbatim, team unchanged", async () => {
    const cataloguePath = path.join(
      getPluginRoot(),
      "catalogue",
      "hiring-manager.md",
    );
    const raw = await fs.readFile(cataloguePath, "utf8");
    const cat = parseCatalogueRole(raw, cataloguePath);
    const prompt = cat.sections.Prompt;

    // Guard error class name must appear so the subagent knows which error to handle.
    expect(prompt).toContain("UnhireBelowJudgeMinimumError");
    // Instruction to surface the error VERBATIM.
    expect(prompt).toMatch(/VERBATIM/i);
  });

  it("Prompt describes the not-on-team path: nothing to remove", async () => {
    const cataloguePath = path.join(
      getPluginRoot(),
      "catalogue",
      "hiring-manager.md",
    );
    const raw = await fs.readFile(cataloguePath, "utf8");
    const cat = parseCatalogueRole(raw, cataloguePath);
    const prompt = cat.sections.Prompt;

    // Not-on-team error class name.
    expect(prompt).toContain("RoleNotHiredError");
  });
});

// ---------------------------------------------------------------------------
// AC1 — success path: role set aside, team shrinks, options re-shown
// ---------------------------------------------------------------------------
describe("AC1 — unhirePersona success path: role archived and team shrinks", () => {
  it("unhires a removable role from a 6-role roster (5 defaults + a specialist)", async () => {
    // With exactly the 5-role default roster, the bipartite matcher cannot
    // spare any role — ALL five are needed to staff the five distinct lens
    // slots. Adding a 6th role (test-specialist) breaks the deadlock and
    // makes that specialist safely removable.
    await hireRoles(DEFAULT_ROSTER);
    // Hire one extra specialist so removing it leaves the panel intact.
    await instantiatePersona({
      pluginRoot: getPluginRoot(),
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: FIXED_CLOCK,
      pluginVersion: FIXED_VERSION,
    });

    const before = await liveRoles();
    expect(before).toContain("test-specialist");
    expect(before).toHaveLength(6);

    const result = await unhirePersona({
      targetRepoRoot: tmpRoot,
      role: "test-specialist",
      clock: FIXED_CLOCK,
    });

    expect(result.status).toBe("archived");
    if (result.status === "archived") {
      expect(result.archivedPath).toContain("_archived");
      expect(result.archivedAt).toBe("2026-06-19T12:00:00.000Z");
    }

    const after = await liveRoles();
    expect(after).not.toContain("test-specialist");
    // All default-roster roles remain.
    for (const role of DEFAULT_ROSTER) {
      expect(after).toContain(role);
    }
    expect(after).toHaveLength(5);

    // The archived PERSONA.md exists.
    const archivedPath = path.join(
      tmpRoot,
      "team",
      "_archived",
      "test-specialist",
      "PERSONA.md",
    );
    const archivedContent = await fs.readFile(archivedPath, "utf8");
    expect(archivedContent).toContain("archived_at");
  });
});

// ---------------------------------------------------------------------------
// AC2 — guard-refusal path: UnhireBelowJudgeMinimumError, team unchanged
// ---------------------------------------------------------------------------
describe("AC2 — guard-refusal path: refuses and leaves team unchanged", () => {
  it("throws UnhireBelowJudgeMinimumError when removal would break the judge panel", async () => {
    // Hire only generalist-reviewer and generalist-dev — a two-role team that
    // already cannot fully staff five distinct lens slots on its own; removing
    // any of them makes it worse.
    await hireRoles(["generalist-reviewer", "generalist-dev"]);

    const before = await liveRoles();
    expect(before).toHaveLength(2);

    await expect(
      unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "generalist-reviewer",
        clock: FIXED_CLOCK,
      }),
    ).rejects.toThrowError(UnhireBelowJudgeMinimumError);

    // Team unchanged.
    const after = await liveRoles();
    expect(after).toEqual(before);
  });

  it("error message names the unstaffed lens", async () => {
    await hireRoles(["generalist-reviewer", "generalist-dev"]);

    let errorMessage = "";
    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "generalist-reviewer",
        clock: FIXED_CLOCK,
      });
    } catch (err) {
      if (err instanceof UnhireBelowJudgeMinimumError) {
        errorMessage = err.message;
      } else {
        throw err;
      }
    }

    expect(errorMessage).toMatch(/quality-grading panel/i);
    expect(errorMessage).toMatch(/lens/i);
    // Error names the problematic role.
    expect(errorMessage).toContain("generalist-reviewer");
  });
});

// ---------------------------------------------------------------------------
// AC3 — not-on-team path: RoleNotHiredError, team unchanged
// ---------------------------------------------------------------------------
describe("AC3 — not-on-team path: RoleNotHiredError and team unchanged", () => {
  it("throws RoleNotHiredError for a role never hired", async () => {
    await hireRoles(DEFAULT_ROSTER);

    await expect(
      unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "security-specialist",
        clock: FIXED_CLOCK,
      }),
    ).rejects.toThrowError(RoleNotHiredError);
  });

  it("team is unchanged when unhire is refused for a missing role", async () => {
    await hireRoles(DEFAULT_ROSTER);
    const before = await liveRoles();

    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "security-specialist",
        clock: FIXED_CLOCK,
      });
    } catch {
      /* expected */
    }

    const after = await liveRoles();
    expect(after).toEqual(before);
  });

  it("error message identifies the missing role", async () => {
    await hireRoles(DEFAULT_ROSTER);

    let errorMessage = "";
    try {
      await unhirePersona({
        targetRepoRoot: tmpRoot,
        role: "security-specialist",
        clock: FIXED_CLOCK,
      });
    } catch (err) {
      if (err instanceof RoleNotHiredError) {
        errorMessage = err.message;
      } else {
        throw err;
      }
    }

    expect(errorMessage).toContain("security-specialist");
    expect(errorMessage).toMatch(/not on the active team/i);
  });
});
