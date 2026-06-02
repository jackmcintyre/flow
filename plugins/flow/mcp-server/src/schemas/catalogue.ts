import { z } from "zod";
import { CatalogueShapeError } from "../errors.js";

/**
 * Catalogue role file schema (FR82, FR83, FR98, FR99; architecture
 * Implementation-patterns-consistency-rules §3).
 *
 * Catalogue files live at `plugins/<plugin>/catalogue/<role>.md`. Each
 * file is plain Markdown with YAML frontmatter; the frontmatter shape
 * is fixed by `CatalogueRoleSchema` and the body must contain the four
 * canonical `##` sections (`Domain`, `Mandate`, `Out of mandate`,
 * `Prompt`) IN THAT ORDER.
 *
 * `.strict()` rejects unknown keys at every level — typos must fail
 * loudly. Persona files (Story 2.3) are a SIBLING shape that adds
 * `hired_at` / `catalogue_version` frontmatter and a `## Knowledge`
 * section; persona schema is intentionally NOT defined here and is NOT
 * a child of this schema.
 *
 * `role` regex enforces kebab-case (consistent with
 * `RolePermissionsSchema`). `domain` is the routing key for FR99 /
 * FR98 — exact-match string, load-bearing.
 *
 * `locked_phrases` carries the three load-bearing template strings
 * (handoff / yield / verdict) that the dev/reviewer loops grep
 * against. Missing any of the three is a contract violation.
 */
export const ModelTierSchema = z.enum(["opus", "sonnet", "haiku"]);

export const LockedPhrasesSchema = z
  .object({
    handoff: z.string().min(1),
    yield: z.string().min(1),
    verdict: z.string().min(1),
  })
  .strict();

export const CatalogueRoleSchema = z
  .object({
    role: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/),
    domain: z.string().min(1),
    model_tier: ModelTierSchema,
    tools_allow: z.array(z.string().min(1)).min(1),
    gh_allow: z.array(z.string().min(1)).default([]),
    locked_phrases: LockedPhrasesSchema,
  })
  .strict();

export type CatalogueRoleFrontmatter = z.infer<typeof CatalogueRoleSchema>;

/**
 * The four required `##` section names in a catalogue file body, in
 * the canonical order they appear. The parser tolerates extra sections
 * after `Prompt` but the four required headings must be present AND in
 * this order.
 */
export const REQUIRED_CATALOGUE_SECTIONS = [
  "Domain",
  "Mandate",
  "Out of mandate",
  "Prompt",
] as const;

export type RequiredCatalogueSection = (typeof REQUIRED_CATALOGUE_SECTIONS)[number];

/**
 * Parsed catalogue role. The frontmatter is Zod-typed; the body
 * sections are returned as a `Record<sectionHeading, bodyText>` so the
 * caller can pull `Prompt` out for persona-prompt assembly (Story 2.3)
 * without re-parsing the file.
 *
 * `sourcePath` is stamped on after parsing; it is NOT part of the
 * on-disk contract.
 */
export type CatalogueRole = CatalogueRoleFrontmatter & {
  sections: Record<RequiredCatalogueSection, string>;
  sourcePath: string;
};

/**
 * Body validator: asserts the four required `##` section headers
 * appear in the canonical order in the supplied Markdown body (the
 * post-frontmatter portion of a catalogue file).
 *
 * Uses simple line-scanning, NOT a full Markdown parser — the contract
 * is line-level header presence and order. Top-level `##` headers
 * delimit sections; `###` and deeper are ignored.
 *
 * Throws `CatalogueShapeError` on:
 *  - a required header that does not appear at all
 *  - the required headers appearing out of canonical order
 *
 * Story 2.3 will reuse this assertion against persona files (which add
 * `## Knowledge` after `## Prompt`); the canonical four-in-order
 * prefix is the shared contract.
 */
export function assertCatalogueBodySections(body: string, sourcePath = "<body>"): void {
  const headers: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match && !line.startsWith("###")) {
      headers.push(match[1]!.trim());
    }
  }

  let cursor = 0;
  for (const required of REQUIRED_CATALOGUE_SECTIONS) {
    const idx = headers.indexOf(required, cursor);
    if (idx === -1) {
      // Either missing entirely, or appears earlier than expected
      // (which is the out-of-order case caught below).
      const seenEarlier = headers.indexOf(required);
      if (seenEarlier === -1) {
        throw new CatalogueShapeError({
          sourcePath,
          zodMessage: `missing required '##' section: '${required}'`,
        });
      }
      throw new CatalogueShapeError({
        sourcePath,
        zodMessage:
          `required '##' sections are out of order — expected ` +
          `[${REQUIRED_CATALOGUE_SECTIONS.join(", ")}] but saw '${required}' ` +
          `before earlier required sections`,
      });
    }
    cursor = idx + 1;
  }
}
