import { parse as yamlParse } from "yaml";
import { z } from "zod";
import { CatalogueShapeError } from "../errors.js";
import {
  CatalogueRoleSchema,
  REQUIRED_CATALOGUE_SECTIONS,
  assertCatalogueBodySections,
  type CatalogueRole,
  type RequiredCatalogueSection,
} from "../schemas/catalogue.js";

/**
 * Split a Markdown file into its YAML frontmatter head and the body.
 *
 * Frontmatter must be the first non-empty content, delimited by `---`
 * lines at the file start and the next `---` line. CRLF / BOM are
 * normalised. Reused across catalogue (Story 2.1) and future persona
 * (Story 2.3) parsing.
 *
 * Throws `CatalogueShapeError` when delimiters are missing — the
 * catalogue is the only v1 caller, so error specificity is acceptable;
 * Story 2.3 can introduce a sibling helper / error if persona parsing
 * needs a distinct surface.
 */
export function splitFrontmatter(
  raw: string,
  sourcePath: string,
): { frontmatterRaw: string; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");

  if (!text.startsWith("---\n") && !text.startsWith("---\r")) {
    throw new CatalogueShapeError({
      sourcePath,
      zodMessage: "file must start with '---' YAML frontmatter opener",
    });
  }

  const closeIdx = text.indexOf("\n---", 4);
  if (closeIdx === -1) {
    throw new CatalogueShapeError({
      sourcePath,
      zodMessage: "missing closing '---' YAML frontmatter delimiter",
    });
  }

  const frontmatterRaw = text.slice(4, closeIdx);
  const afterFence = text.slice(closeIdx + 4);
  const body = afterFence.replace(/^\s*\n/, "");
  return { frontmatterRaw, body };
}

/**
 * Pure catalogue file parser — no IO. The caller supplies the file
 * contents and a `sourcePath` for error reporting (mirrors
 * `parseStandardsDoc`).
 *
 * Validates:
 *  - YAML frontmatter delimited by `---` lines parses cleanly.
 *  - Frontmatter matches `CatalogueRoleSchema`.
 *  - Body contains all four required `##` sections (`Domain`,
 *    `Mandate`, `Out of mandate`, `Prompt`) in canonical order.
 *
 * Throws `CatalogueShapeError` on any failure.
 */
export function parseCatalogueRole(raw: string, sourcePath: string): CatalogueRole {
  const { frontmatterRaw, body } = splitFrontmatter(raw, sourcePath);

  let parsedYaml: unknown;
  try {
    parsedYaml = yamlParse(frontmatterRaw);
  } catch (err) {
    throw new CatalogueShapeError({
      sourcePath,
      zodMessage: `frontmatter YAML parse error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const result = CatalogueRoleSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw new CatalogueShapeError({
      sourcePath,
      zodMessage: formatZodIssues(result.error.issues),
    });
  }

  // Order + presence assertion (throws CatalogueShapeError on failure).
  assertCatalogueBodySections(body, sourcePath);
  const sections = extractSections(body);

  return {
    ...result.data,
    sections: sections as Record<RequiredCatalogueSection, string>,
    sourcePath,
  };
}

/**
 * Walk the body line-by-line and collect `## <Heading>` sections.
 * Returns the four required headings as a record; extra `##` sections
 * are ignored.
 */
function extractSections(body: string): Partial<Record<RequiredCatalogueSection, string>> {
  const lines = body.split("\n");
  const out: Partial<Record<string, string>> = {};
  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentHeading !== null) {
      out[currentHeading] = currentBody.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    }
  };

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match && !line.startsWith("###")) {
      flush();
      currentHeading = match[1]!.trim();
      currentBody = [];
    } else if (currentHeading !== null) {
      currentBody.push(line);
    }
  }
  flush();

  const filtered: Partial<Record<RequiredCatalogueSection, string>> = {};
  for (const required of REQUIRED_CATALOGUE_SECTIONS) {
    if (required in out) filtered[required] = out[required] ?? "";
  }
  return filtered;
}

function formatZodIssues(issues: z.ZodIssue[]): string {
  const first = issues[0];
  if (!first) return "(no issue details)";
  const dottedPath = first.path.length > 0 ? first.path.join(".") : "<root>";
  return `${dottedPath}: ${first.message}`;
}
