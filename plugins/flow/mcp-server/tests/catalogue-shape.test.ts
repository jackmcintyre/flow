/**
 * Story 2.1 AC1–AC4 — catalogue file format and shipped role templates.
 *
 * See `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §3
 * for the canonical catalogue file skeleton (frontmatter + four required
 * `##` sections in canonical order).
 *
 * This test is the contract gate for:
 *  - AC1: the catalogue directory contains exactly the v1 roster files
 *    (10 original v1 roles + the Epic 9 `author` seam role, Story 9.2).
 *  - AC2: every catalogue file's frontmatter parses against `CatalogueRoleSchema`.
 *  - AC3: every catalogue file's `domain:` string is pairwise distinct (FR98 / FR99).
 *  - AC4(a–e): a single harness that discovers, parses, asserts file-set
 *    equality, asserts domain uniqueness, and asserts the four required
 *    `##` headers appear in canonical order in each file.
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCatalogueRole,
  splitFrontmatter,
} from "../src/lib/markdown-frontmatter.js";
import { assertCatalogueBodySections } from "../src/schemas/catalogue.js";
import { CatalogueShapeError } from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOGUE_DIR = path.resolve(HERE, "..", "..", "catalogue");

/**
 * The fixed catalogue roster. Story 2.1 ACs reference the original 10
 * v1 roles; Story 9.2 (Epic 9 author seam) adds the `author` role. Any
 * addition / removal / rename is a breaking change and must update this
 * list deliberately.
 */
const CATALOGUE_FILES = [
  "hiring-manager.md",
  "planner.md",
  "generalist-dev.md",
  "generalist-reviewer.md",
  "retro-analyst.md",
  "orchestrator.md",
  "security-specialist.md",
  "test-specialist.md",
  "docs-specialist.md",
  "debugger.md",
  // Story 9.2 — Epic 9 author seam: one plain-language feature in, one draft out.
  "author.md",
  // Story 9.4 — Epic 9 Quality Lead: adjudicates the panel verdict (ready / rework / escalate).
  "quality-lead.md",
] as const;

describe("Story 2.1 — catalogue file format and shipped role templates", () => {
  describe("AC1 / AC4(a,c): catalogue directory contains exactly the v1 roster", () => {
    it("lists exactly the expected roster files (filtering `.gitkeep` if still present)", async () => {
      const entries = await fs.readdir(CATALOGUE_DIR);
      const markdown = entries.filter((e) => e.endsWith(".md")).sort();
      const expected = [...CATALOGUE_FILES].sort();
      const extra = markdown.filter((m) => !expected.includes(m));
      const missing = expected.filter((m) => !markdown.includes(m));
      expect({ extra, missing }).toEqual({ extra: [], missing: [] });
      expect(markdown).toEqual(expected);
    });
  });

  describe("AC2 / AC4(b): every shipped catalogue file parses against the schema", () => {
    for (const filename of CATALOGUE_FILES) {
      it(`${filename} parses with required frontmatter and required sections`, async () => {
        const abs = path.join(CATALOGUE_DIR, filename);
        const raw = await fs.readFile(abs, "utf8");
        const parsed = parseCatalogueRole(raw, abs);

        // Frontmatter contract.
        expect(parsed.role).toBe(filename.replace(/\.md$/, ""));
        expect(parsed.domain.length).toBeGreaterThan(0);
        expect(["opus", "sonnet", "haiku"]).toContain(parsed.model_tier);
        expect(parsed.tools_allow.length).toBeGreaterThan(0);
        expect(Array.isArray(parsed.gh_allow)).toBe(true);
        expect(parsed.locked_phrases.handoff.length).toBeGreaterThan(0);
        expect(parsed.locked_phrases.yield.length).toBeGreaterThan(0);
        expect(parsed.locked_phrases.verdict.length).toBeGreaterThan(0);

        // Section contract.
        expect(parsed.sections.Domain.length).toBeGreaterThan(0);
        expect(parsed.sections.Mandate.length).toBeGreaterThan(0);
        expect(parsed.sections["Out of mandate"].length).toBeGreaterThan(0);
        expect(parsed.sections.Prompt.length).toBeGreaterThan(0);

        // sourcePath stamp.
        expect(parsed.sourcePath).toBe(abs);
      });
    }
  });

  describe("AC4(e): each shipped catalogue file has the four required `##` headers in canonical order", () => {
    for (const filename of CATALOGUE_FILES) {
      it(`${filename} has Domain → Mandate → Out of mandate → Prompt in order`, async () => {
        const abs = path.join(CATALOGUE_DIR, filename);
        const raw = await fs.readFile(abs, "utf8");
        const { body } = splitFrontmatter(raw, abs);
        // Throws CatalogueShapeError on missing or out-of-order headers.
        expect(() => assertCatalogueBodySections(body, abs)).not.toThrow();
      });
    }
  });

  describe("AC3 / AC4(d): domains are distinct across the v1 catalogue", () => {
    it("no two shipped catalogue files share a `domain:` string", async () => {
      const domains: { role: string; domain: string }[] = [];
      for (const filename of CATALOGUE_FILES) {
        const abs = path.join(CATALOGUE_DIR, filename);
        const raw = await fs.readFile(abs, "utf8");
        const parsed = parseCatalogueRole(raw, abs);
        domains.push({ role: parsed.role, domain: parsed.domain });
      }
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const { role, domain } of domains) {
        const prior = seen.get(domain);
        if (prior) {
          collisions.push(`'${domain}': ${prior} and ${role}`);
        } else {
          seen.set(domain, role);
        }
      }
      expect(collisions).toEqual([]);
      expect(new Set(domains.map((d) => d.domain)).size).toBe(CATALOGUE_FILES.length);
    });
  });

  describe("AC4(e): assertCatalogueBodySections rejects out-of-order headers", () => {
    it("throws CatalogueShapeError when sections appear in the wrong order", () => {
      const outOfOrder = [
        "## Mandate",
        "x",
        "## Domain",
        "x",
        "## Out of mandate",
        "x",
        "## Prompt",
        "x",
      ].join("\n");
      expect(() => assertCatalogueBodySections(outOfOrder, "/fake/path.md")).toThrow(
        CatalogueShapeError,
      );
    });

    it("throws CatalogueShapeError when a required header is missing", () => {
      const missing = [
        "## Domain",
        "x",
        "## Mandate",
        "x",
        "## Prompt",
        "x",
      ].join("\n");
      expect(() => assertCatalogueBodySections(missing, "/fake/path.md")).toThrow(
        CatalogueShapeError,
      );
    });
  });

  describe("parser: error paths", () => {
    it("throws CatalogueShapeError when the file has no frontmatter opener", () => {
      const bad = "# Role\n\n## Domain\nx\n";
      expect(() => parseCatalogueRole(bad, "/fake/path.md")).toThrow(CatalogueShapeError);
    });

    it("throws CatalogueShapeError on missing required frontmatter key", () => {
      const bad = [
        "---",
        "role: foo",
        "domain: bar",
        "model_tier: sonnet",
        "tools_allow: [Read]",
        // locked_phrases missing on purpose
        "---",
        "# Foo",
        "## Domain",
        "x",
        "## Mandate",
        "x",
        "## Out of mandate",
        "x",
        "## Prompt",
        "x",
        "",
      ].join("\n");
      expect(() => parseCatalogueRole(bad, "/fake/path.md")).toThrow(CatalogueShapeError);
    });

    it("throws CatalogueShapeError on unknown frontmatter key", () => {
      const bad = [
        "---",
        "role: foo",
        "domain: bar",
        "model_tier: sonnet",
        "tools_allow: [Read]",
        "gh_allow: []",
        "locked_phrases:",
        "  handoff: a",
        "  yield: b",
        "  verdict: c",
        "surprise: nope",
        "---",
        "# Foo",
        "## Domain",
        "x",
        "## Mandate",
        "x",
        "## Out of mandate",
        "x",
        "## Prompt",
        "x",
        "",
      ].join("\n");
      expect(() => parseCatalogueRole(bad, "/fake/path.md")).toThrow(CatalogueShapeError);
    });

    it("throws CatalogueShapeError when a required '##' section is missing", () => {
      const bad = [
        "---",
        "role: foo",
        "domain: bar",
        "model_tier: sonnet",
        "tools_allow: [Read]",
        "gh_allow: []",
        "locked_phrases:",
        "  handoff: a",
        "  yield: b",
        "  verdict: c",
        "---",
        "# Foo",
        "## Domain",
        "x",
        "## Mandate",
        "x",
        // 'Out of mandate' missing
        "## Prompt",
        "x",
        "",
      ].join("\n");
      expect(() => parseCatalogueRole(bad, "/fake/path.md")).toThrow(CatalogueShapeError);
    });

    it("rejects non-kebab-case role ids", () => {
      const bad = [
        "---",
        "role: FooBar",
        "domain: bar",
        "model_tier: sonnet",
        "tools_allow: [Read]",
        "gh_allow: []",
        "locked_phrases:",
        "  handoff: a",
        "  yield: b",
        "  verdict: c",
        "---",
        "## Domain",
        "x",
        "## Mandate",
        "x",
        "## Out of mandate",
        "x",
        "## Prompt",
        "x",
        "",
      ].join("\n");
      expect(() => parseCatalogueRole(bad, "/fake/path.md")).toThrow(CatalogueShapeError);
    });

    it("rejects invalid model_tier values", () => {
      const bad = [
        "---",
        "role: foo",
        "domain: bar",
        "model_tier: turbo",
        "tools_allow: [Read]",
        "gh_allow: []",
        "locked_phrases:",
        "  handoff: a",
        "  yield: b",
        "  verdict: c",
        "---",
        "## Domain",
        "x",
        "## Mandate",
        "x",
        "## Out of mandate",
        "x",
        "## Prompt",
        "x",
        "",
      ].join("\n");
      expect(() => parseCatalogueRole(bad, "/fake/path.md")).toThrow(CatalogueShapeError);
    });
  });

  describe("CatalogueShapeError carries the canonical error code", () => {
    it("exposes code = 'CATALOGUE_SHAPE_ERROR'", () => {
      try {
        parseCatalogueRole("not frontmatter", "/fake/path.md");
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CatalogueShapeError);
        expect((err as CatalogueShapeError).code).toBe("CATALOGUE_SHAPE_ERROR");
      }
    });
  });
});
