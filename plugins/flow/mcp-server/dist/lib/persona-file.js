import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { PersonaFileMalformedError } from "../errors.js";
import { assertCatalogueBodySections } from "../schemas/catalogue.js";
import { PersonaFrontmatterSchema, REQUIRED_PERSONA_SECTIONS, } from "../schemas/persona.js";
import { splitFrontmatter } from "./markdown-frontmatter.js";
/**
 * Pure persona file parser — no IO. Reuses `splitFrontmatter` and
 * `assertCatalogueBodySections` from Story 2.1.
 *
 * Validates:
 *  - YAML frontmatter parses cleanly.
 *  - Frontmatter matches `PersonaFrontmatterSchema` (catalogue shape
 *    plus `hired_at` and `catalogue_version`).
 *  - Body contains the four required catalogue sections in canonical
 *    order (via `assertCatalogueBodySections`).
 *  - Body contains a `## Knowledge` section appearing strictly AFTER
 *    `## Prompt`.
 *
 * Throws `PersonaFileMalformedError` on any failure. Catalogue-side
 * errors (e.g. CatalogueShapeError from the shared body-section
 * assertion) are caught and re-thrown as PersonaFileMalformedError so
 * persona/catalogue failure surfaces stay distinct downstream.
 */
export function parsePersonaFile(raw, sourcePath) {
    let frontmatterRaw;
    let body;
    try {
        const split = splitFrontmatter(raw, sourcePath);
        frontmatterRaw = split.frontmatterRaw;
        body = split.body;
    }
    catch (err) {
        throw new PersonaFileMalformedError({
            personaPath: sourcePath,
            zodMessage: err instanceof Error ? err.message : String(err),
        });
    }
    let parsedYaml;
    try {
        parsedYaml = yamlParse(frontmatterRaw);
    }
    catch (err) {
        throw new PersonaFileMalformedError({
            personaPath: sourcePath,
            zodMessage: `frontmatter YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        });
    }
    const result = PersonaFrontmatterSchema.safeParse(parsedYaml);
    if (!result.success) {
        throw new PersonaFileMalformedError({
            personaPath: sourcePath,
            zodMessage: formatZodIssues(result.error.issues),
        });
    }
    try {
        assertCatalogueBodySections(body, sourcePath);
    }
    catch (err) {
        throw new PersonaFileMalformedError({
            personaPath: sourcePath,
            zodMessage: err instanceof Error ? err.message : String(err),
        });
    }
    // Extra Knowledge-after-Prompt check (Task 1.5).
    const headings = collectHeadings(body);
    const promptIdx = headings.indexOf("Prompt");
    const knowledgeIdx = headings.indexOf("Knowledge");
    if (knowledgeIdx === -1) {
        throw new PersonaFileMalformedError({
            personaPath: sourcePath,
            zodMessage: "missing required '##' section: 'Knowledge'",
        });
    }
    if (knowledgeIdx <= promptIdx) {
        throw new PersonaFileMalformedError({
            personaPath: sourcePath,
            zodMessage: "required '##' sections are out of order — 'Knowledge' must appear after 'Prompt'",
        });
    }
    const sections = extractSections(body);
    return {
        ...result.data,
        sections: sections,
        sourcePath,
    };
}
/**
 * Pure renderer — no IO, no clock. Produces the full on-disk file
 * contents (frontmatter `---` block + five sections in canonical order)
 * for a freshly-instantiated persona. The `Knowledge` body is the empty
 * string. `Domain`, `Mandate`, `Out of mandate`, `Prompt` are copied
 * verbatim from the catalogue.
 *
 * The renderer is the ONLY place persona-file YAML is serialised in
 * v1. `instantiatePersona` calls it.
 */
export function renderPersonaFile(opts) {
    const { catalogue, hiredAt, catalogueVersion } = opts;
    // Canonical key order — persona-only keys go last. Preserved by
    // `yaml.stringify` when we feed a plain object whose insertion order
    // matches the contract.
    const frontmatter = {
        role: catalogue.role,
        domain: catalogue.domain,
        model_tier: catalogue.model_tier,
        tools_allow: [...catalogue.tools_allow],
        gh_allow: [...catalogue.gh_allow],
        locked_phrases: { ...catalogue.locked_phrases },
        hired_at: hiredAt,
        catalogue_version: catalogueVersion,
    };
    const yamlBlock = yamlStringify(frontmatter).replace(/\n$/, "");
    // Display H1 — copy the catalogue's role display name verbatim. The
    // catalogue body does NOT include the H1 inside its `sections` map
    // (the `extractSections` helper only collects `##` headings), so we
    // re-derive it from the catalogue's source body. To stay pure and
    // avoid re-reading files, we reconstruct the H1 from the role id.
    // The shipped catalogue files use Title Case display names that are
    // produced by capitalising hyphen-separated words.
    const h1 = toDisplayName(catalogue.role);
    const sections = [
        `# ${h1}`,
        ``,
        `## Domain`,
        ``,
        catalogue.sections.Domain,
        ``,
        `## Mandate`,
        ``,
        catalogue.sections.Mandate,
        ``,
        `## Out of mandate`,
        ``,
        catalogue.sections["Out of mandate"],
        ``,
        `## Prompt`,
        ``,
        catalogue.sections.Prompt,
        ``,
        `## Knowledge`,
        ``,
    ];
    return `---\n${yamlBlock}\n---\n\n${sections.join("\n")}`;
}
function toDisplayName(role) {
    return role
        .split("-")
        .map((part) => part.length === 0 ? part : part[0].toUpperCase() + part.slice(1))
        .join(" ");
}
/**
 * Collect the ordered list of `## <Heading>` strings from a Markdown
 * body, ignoring `###` and deeper. Mirrors the line-scanning style of
 * `assertCatalogueBodySections`.
 */
function collectHeadings(body) {
    const headings = [];
    for (const line of body.split("\n")) {
        const match = /^##\s+(.+?)\s*$/.exec(line);
        if (match && !line.startsWith("###")) {
            headings.push(match[1].trim());
        }
    }
    return headings;
}
/**
 * Walk the body line-by-line and collect `## <Heading>` sections.
 * Returns the five required headings as a record; extra `##` sections
 * are ignored.
 *
 * Copy-and-adapted from `markdown-frontmatter.ts`'s private
 * `extractSections` (intentional — that helper is module-private and
 * the upstream module is intentionally small).
 */
function extractSections(body) {
    const lines = body.split("\n");
    const out = {};
    let currentHeading = null;
    let currentBody = [];
    const flush = () => {
        if (currentHeading !== null) {
            out[currentHeading] = currentBody
                .join("\n")
                .replace(/^\n+/, "")
                .replace(/\n+$/, "");
        }
    };
    for (const line of lines) {
        const match = /^##\s+(.+?)\s*$/.exec(line);
        if (match && !line.startsWith("###")) {
            flush();
            currentHeading = match[1].trim();
            currentBody = [];
        }
        else if (currentHeading !== null) {
            currentBody.push(line);
        }
    }
    flush();
    const filtered = {};
    for (const required of REQUIRED_PERSONA_SECTIONS) {
        filtered[required] = out[required] ?? "";
    }
    return filtered;
}
function formatZodIssues(issues) {
    const first = issues[0];
    if (!first)
        return "(no issue details)";
    const dottedPath = first.path.length > 0 ? first.path.join(".") : "<root>";
    return `${dottedPath}: ${first.message}`;
}
