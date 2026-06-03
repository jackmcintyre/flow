import { z } from "zod";
import { LockedPhrasesSchema, ModelTierSchema, } from "./catalogue.js";
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
export const PersonaFrontmatterSchema = z
    .object({
    // Catalogue frontmatter fields, in canonical order. Constraints are
    // copied verbatim from CatalogueRoleSchema; do NOT loosen them.
    role: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/),
    domain: z.string().min(1),
    model_tier: ModelTierSchema,
    tools_allow: z.array(z.string().min(1)).min(1),
    gh_allow: z.array(z.string().min(1)).default([]),
    locked_phrases: LockedPhrasesSchema,
    // Persona-only fields.
    hired_at: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "hired_at must be ISO-8601 UTC (Z-suffixed)"),
    catalogue_version: z
        .string()
        .regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, "catalogue_version must be semver"),
})
    .strict();
/**
 * The five required `##` section names in a persona file body, in the
 * canonical order they appear. Extends `REQUIRED_CATALOGUE_SECTIONS`
 * by one — `Knowledge` is appended after `Prompt`. Story 2.3 / Epic 3
 * appends to the `Knowledge` section body; `Domain`, `Mandate`, `Out of
 * mandate`, `Prompt` are copied verbatim from the catalogue at hire
 * time.
 */
export const REQUIRED_PERSONA_SECTIONS = [
    "Domain",
    "Mandate",
    "Out of mandate",
    "Prompt",
    "Knowledge",
];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _supersetCheck = true;
