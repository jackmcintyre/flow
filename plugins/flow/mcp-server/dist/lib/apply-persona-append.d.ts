/**
 * The `persona-append`-kind `ProposalApplyHandler` — Story 6.9.
 *
 * Accepts a `persona-append` proposal and appends the lesson as a new bullet
 * to the `## Knowledge` section of the target role's persona file
 * (`team/<target_role>/PERSONA.md`).
 *
 * ## Apply semantics
 *
 *   1. Resolve the persona file path: `team/<target_role>/PERSONA.md`.
 *   2. Read the file from disk. If absent, throw `PersonaFileNotFoundError`.
 *   3. Parse via `parsePersonaFile` to validate it is a well-formed persona.
 *   4. Reconstruct the full file, replacing the Knowledge section body with
 *      the existing body + a new `- <lesson>` bullet appended. If the body
 *      is empty, the new body is `- <lesson>`; if non-empty, the bullet is
 *      appended after a newline.
 *   5. Serialise the full file from parsed sections (NOT regex substitution):
 *      frontmatter from the parsed PersonaFrontmatter, sections in canonical
 *      order, replacing only the Knowledge section body.
 *   6. Write via `writeManagedFile`.
 *   7. Return the repo-relative persona path as `changedPaths`.
 *
 * ## No commit
 *
 * The handler only mutates the working tree and returns the repo-relative
 * paths it changed. The gate (`acceptProposal`) owns the commit + proposal
 * stamp + telemetry.
 *
 * ## Idempotency
 *
 * Idempotency is the gate's, not the handler's. The gate's persisted-`applied`
 * no-op (Story 6.4 AC4) guards against a second apply.
 *
 * (Story 6.9 — persona-knowledge write-back keystone)
 */
import type { ProposalApplyHandler } from "./proposal-apply-registry.js";
/**
 * Append a skill-reference line to the Skills section body.
 *
 * Each skill reference is formatted as:
 *   `- <skillName> (<skillPath>): <whenToUse>`
 *
 * If the body is empty, the result is the single reference line; if non-empty,
 * the line is appended after a newline.
 */
export declare function appendSkillReference(existingBody: string, skillName: string, skillPath: string, whenToUse: string): string;
/**
 * Apply a skill-reference addition to a persona file in the target repo.
 *
 * Reads the persona file at `team/<role>/PERSONA.md`, appends a skill-reference
 * entry to the `## Skills` section (creating the section after `## Knowledge`
 * if it does not yet exist), and writes back via `writeManagedFile`.
 *
 * Returns the repo-relative persona path (for the caller's `changedPaths`).
 *
 * @throws {PersonaFileNotFoundError} When the persona file does not exist.
 */
export declare function applySkillReferenceToPersona(opts: {
    targetRepoRoot: string;
    role: string;
    skillName: string;
    skillPath: string;
    whenToUse: string;
    toolName: string;
    actingRole: string;
}): Promise<string>;
/**
 * Construct the `persona-append`-kind apply handler. The production registry
 * calls this with no args; seams are injectable for tests.
 */
export declare function makePersonaAppendHandler(): ProposalApplyHandler;
