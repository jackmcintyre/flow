/**
 * Story 2.2 AC1–AC4 — per-role permission spec files: catalogue parity,
 * schema validation, reviewer negative-capability, and gh-error-map
 * placeholder.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface
 * tagging rubric; none of Story 2.2's ACs are user-surface (permissions
 * files live behind the MCP dispatcher and gh wrapper from Story 1.4).
 *
 * This file mirrors the discovery / harness shape of `catalogue-shape.test.ts`
 * (Story 2.1) on the catalogue side and reuses `loadRolePermissions`
 * (Story 1.4) on the permissions side. The `splitFrontmatter` helper from
 * `src/lib/markdown-frontmatter.ts` (Story 2.1) is reused to extract
 * `gh_allow` from each catalogue file for set-equality parity checks.
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { loadRolePermissions } from "../src/state/load-role-permissions.js";
import { splitFrontmatter } from "../src/lib/markdown-frontmatter.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_PLUGIN_ROOT = path.resolve(HERE, "..", "..");
const CATALOGUE_DIR = path.join(REAL_PLUGIN_ROOT, "catalogue");
const PERMISSIONS_DIR = path.join(REAL_PLUGIN_ROOT, "permissions");

/**
 * The fixed v1 catalogue roster (mirrors `CATALOGUE_FILES` from
 * `catalogue-shape.test.ts`). Redeclared locally because the Story 2.1
 * test does not export it; if it ever does, switch to the import.
 */
const CATALOGUE_ROLES = [
  "hiring-manager",
  "planner",
  "generalist-dev",
  "generalist-reviewer",
  "retro-analyst",
  "orchestrator",
  "security-specialist",
  "test-specialist",
  "docs-specialist",
  "debugger",
  // Story 9.4 — Epic 9 Quality Lead: a real instantiable role with bounded
  // permissions (catalogue + permission YAML both ship), so it joins the parity
  // roster. (The Story 9.2 `author` role is catalogue-only — a planner sub-mode
  // with no permission YAML — so it is intentionally absent here.)
  "quality-lead",
] as const;

const PERMISSION_FILES = [
  "hiring-manager.yaml",
  "planner.yaml",
  "generalist-dev.yaml",
  "generalist-reviewer.yaml",
  "retro-analyst.yaml",
  "orchestrator.yaml",
  "security-specialist.yaml",
  "test-specialist.yaml",
  "docs-specialist.yaml",
  "debugger.yaml",
  // Story 9.4 — Epic 9 Quality Lead bounded permission spec.
  "quality-lead.yaml",
  "gh-error-map.yaml",
] as const;

/**
 * Special-case permission specs that have NO matching catalogue role.
 * These are mode-overlay specs used by specific skill invocations.
 *
 * Story 2.7: `ask-mode` is the non-mutating side-session allowlist for
 * `/flow:ask`. It lives alongside catalogue-role specs but does not have
 * a `plugins/flow/catalogue/ask-mode.md` counterpart. Excluded from the
 * catalogue-parity loop; its shape is asserted independently in
 * `ask-skill.test.ts` AC4(f).
 */
const SPECIAL_PERMISSION_SPECS = ["ask-mode"] as const;

async function readCatalogueGhAllow(role: string): Promise<string[]> {
  const abs = path.join(CATALOGUE_DIR, `${role}.md`);
  const raw = await fs.readFile(abs, "utf8");
  const { frontmatterRaw } = splitFrontmatter(raw, abs);
  const fm = yamlParse(frontmatterRaw) as { gh_allow?: unknown };
  if (!Array.isArray(fm.gh_allow)) {
    return [];
  }
  return fm.gh_allow.map((v) => String(v));
}

describe("Story 2.2 — per-role permission spec files (catalogue parity)", () => {
  describe("AC1: permissions/ contains exactly the expected files (11 + special-case specs)", () => {
    it("lists the 10 per-role YAMLs plus gh-error-map.yaml plus special-case specs", async () => {
      const entries = (await fs.readdir(PERMISSIONS_DIR))
        .filter((e) => e !== ".gitkeep")
        .sort();
      // All expected files: the eleven original + any special-case specs (ask-mode.yaml).
      const expectedSpecialFiles = SPECIAL_PERMISSION_SPECS.map((s) => `${s}.yaml`);
      const expectedAll = [...PERMISSION_FILES, ...expectedSpecialFiles].sort();
      const extra = entries.filter((e) => !expectedAll.includes(e));
      const missing = expectedAll.filter((e) => !entries.includes(e));
      expect({ extra, missing }).toEqual({ extra: [], missing: [] });
    });
  });

  describe("AC4(a): cross-directory parity — every catalogue role has a permissions YAML and vice versa", () => {
    it("every catalogue <role>.md has a matching permissions/<role>.yaml", async () => {
      const orphans: string[] = [];
      for (const role of CATALOGUE_ROLES) {
        const permPath = path.join(PERMISSIONS_DIR, `${role}.yaml`);
        try {
          await fs.access(permPath);
        } catch {
          orphans.push(`catalogue role '${role}' has no permissions/${role}.yaml`);
        }
      }
      expect(orphans).toEqual([]);
    });

    it("every permissions/<role>.yaml (except gh-error-map.yaml and special-case specs) has a matching catalogue file", async () => {
      const orphans: string[] = [];
      for (const file of PERMISSION_FILES) {
        if (file === "gh-error-map.yaml") continue;
        const role = file.replace(/\.yaml$/, "");
        // Story 2.7: skip special-case specs that have no catalogue counterpart.
        if ((SPECIAL_PERMISSION_SPECS as readonly string[]).includes(role)) continue;
        const catPath = path.join(CATALOGUE_DIR, `${role}.md`);
        try {
          await fs.access(catPath);
        } catch {
          orphans.push(`permissions file '${file}' has no catalogue/${role}.md`);
        }
      }
      expect(orphans).toEqual([]);
    });
  });

  describe("AC2 / AC4(b): every per-role permissions YAML parses against RolePermissionsSchema", () => {
    for (const role of CATALOGUE_ROLES) {
      it(`${role}.yaml parses via loadRolePermissions`, async () => {
        const perms = await loadRolePermissions({
          role,
          pluginRoot: REAL_PLUGIN_ROOT,
        });
        expect(perms.role).toBe(role);
        expect(perms.tools_allow.length).toBeGreaterThan(0);
        expect(Array.isArray(perms.gh_allow)).toBe(true);
      });
    }
  });

  describe("AC4(c): every permissions/<role>.yaml gh_allow set equals the catalogue gh_allow set", () => {
    for (const role of CATALOGUE_ROLES) {
      it(`${role}: catalogue and permissions agree on gh_allow (set equality)`, async () => {
        const perms = await loadRolePermissions({
          role,
          pluginRoot: REAL_PLUGIN_ROOT,
        });
        const catGh = await readCatalogueGhAllow(role);
        const permSorted = [...perms.gh_allow].sort();
        const catSorted = [...catGh].sort();
        const onlyInPerm = permSorted.filter((s) => !catSorted.includes(s));
        const onlyInCat = catSorted.filter((s) => !permSorted.includes(s));
        expect(
          {
            role,
            permissionsPath: `plugins/flow/permissions/${role}.yaml`,
            cataloguePath: `plugins/flow/catalogue/${role}.md`,
            onlyInPermissions: onlyInPerm,
            onlyInCatalogue: onlyInCat,
          },
          `gh_allow drift between catalogue and permissions for '${role}'`,
        ).toEqual({
          role,
          permissionsPath: `plugins/flow/permissions/${role}.yaml`,
          cataloguePath: `plugins/flow/catalogue/${role}.md`,
          onlyInPermissions: [],
          onlyInCatalogue: [],
        });
      });
    }
  });

  describe("AC3 / AC4(d): generalist-reviewer negative-capability omissions", () => {
    it("reviewer gh_allow does not contain pr-merge", async () => {
      const perms = await loadRolePermissions({
        role: "generalist-reviewer",
        pluginRoot: REAL_PLUGIN_ROOT,
      });
      expect(perms.gh_allow).not.toContain("pr-merge");
    });

    it("reviewer gh_allow does not contain pr-close", async () => {
      const perms = await loadRolePermissions({
        role: "generalist-reviewer",
        pluginRoot: REAL_PLUGIN_ROOT,
      });
      expect(perms.gh_allow).not.toContain("pr-close");
    });

    it("reviewer gh_allow contains no push-bearing subcommand", async () => {
      const perms = await loadRolePermissions({
        role: "generalist-reviewer",
        pluginRoot: REAL_PLUGIN_ROOT,
      });
      const pushy = perms.gh_allow.filter((s) => /push/i.test(s));
      expect(pushy).toEqual([]);
    });
  });

  describe("AC4(e): gh-error-map.yaml exists and parses as valid YAML", () => {
    it("plugins/flow/permissions/gh-error-map.yaml parses to an object with entries: array", async () => {
      const abs = path.join(PERMISSIONS_DIR, "gh-error-map.yaml");
      const raw = await fs.readFile(abs, "utf8");
      let parsed: unknown;
      try {
        parsed = yamlParse(raw);
      } catch (err) {
        throw new Error(
          `gh-error-map.yaml failed to parse: ${abs}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      expect(parsed, `gh-error-map.yaml must be a mapping at ${abs}`).toBeTypeOf("object");
      expect(parsed).not.toBeNull();
      const obj = parsed as { entries?: unknown };
      expect(Array.isArray(obj.entries), `expected entries: [] in ${abs}`).toBe(true);
    });
  });
});
