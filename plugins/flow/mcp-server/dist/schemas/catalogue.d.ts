import { z } from "zod";
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
export declare const ModelTierSchema: z.ZodEnum<{
    haiku: "haiku";
    opus: "opus";
    sonnet: "sonnet";
}>;
export declare const LockedPhrasesSchema: z.ZodObject<{
    handoff: z.ZodString;
    yield: z.ZodString;
    verdict: z.ZodString;
}, z.core.$strict>;
export declare const CatalogueRoleSchema: z.ZodObject<{
    role: z.ZodString;
    domain: z.ZodString;
    model_tier: z.ZodEnum<{
        haiku: "haiku";
        opus: "opus";
        sonnet: "sonnet";
    }>;
    tools_allow: z.ZodArray<z.ZodString>;
    gh_allow: z.ZodDefault<z.ZodArray<z.ZodString>>;
    locked_phrases: z.ZodObject<{
        handoff: z.ZodString;
        yield: z.ZodString;
        verdict: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type CatalogueRoleFrontmatter = z.infer<typeof CatalogueRoleSchema>;
/**
 * The four required `##` section names in a catalogue file body, in
 * the canonical order they appear. The parser tolerates extra sections
 * after `Prompt` but the four required headings must be present AND in
 * this order.
 */
export declare const REQUIRED_CATALOGUE_SECTIONS: readonly ["Domain", "Mandate", "Out of mandate", "Prompt"];
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
export declare function assertCatalogueBodySections(body: string, sourcePath?: string): void;
