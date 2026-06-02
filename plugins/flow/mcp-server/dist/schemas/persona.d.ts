import { z } from "zod";
/**
 * Persona file schema (FR89, FR93, FR96, FR97, FR98, FR99; architecture
 * Implementation-patterns-consistency-rules §3).
 *
 * Persona files live at `<target-repo>/team/<role>/PERSONA.md`. They are
 * a SIBLING shape of catalogue files — the catalogue frontmatter plus
 * two persona-only keys (`hired_at`, `catalogue_version`), and a body
 * that adds a fifth `## Knowledge` section after `## Prompt`.
 *
 * `.strict()` rejects unknown keys at every level — typos must fail
 * loudly. Persona-only keys go LAST in canonical key order to mirror the
 * on-disk layout produced by `renderPersonaFile`.
 */
export declare const PersonaFrontmatterSchema: z.ZodObject<{
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
    hired_at: z.ZodString;
    catalogue_version: z.ZodString;
}, z.core.$strict>;
export type PersonaFrontmatter = z.infer<typeof PersonaFrontmatterSchema>;
/**
 * The five required `##` section names in a persona file body, in the
 * canonical order they appear. Extends `REQUIRED_CATALOGUE_SECTIONS`
 * by one — `Knowledge` is appended after `Prompt`. Story 2.3 / Epic 3
 * appends to the `Knowledge` section body; `Domain`, `Mandate`, `Out of
 * mandate`, `Prompt` are copied verbatim from the catalogue at hire
 * time.
 */
export declare const REQUIRED_PERSONA_SECTIONS: readonly ["Domain", "Mandate", "Out of mandate", "Prompt", "Knowledge"];
export type RequiredPersonaSection = (typeof REQUIRED_PERSONA_SECTIONS)[number];
/**
 * Parsed persona file. Mirrors `CatalogueRole`'s shape exactly so
 * consumers can interchange where the four-section catalogue prefix is
 * what matters; the `Knowledge` body is the only extra field. The
 * `sourcePath` is stamped on by the parser; it is NOT part of the
 * on-disk contract.
 */
export type PersonaFile = PersonaFrontmatter & {
    sections: Record<RequiredPersonaSection, string>;
    sourcePath: string;
};
