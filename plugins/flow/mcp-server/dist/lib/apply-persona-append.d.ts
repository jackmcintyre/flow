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
import type { StructuredLesson } from "../schemas/story-retro.js";
/**
 * Append a structured lesson block to a Knowledge section body.
 * If the body is empty, the result is the serialised block; if non-empty,
 * the block is appended after a newline.
 *
 * Exported for unit testing.
 */
export declare function appendStructuredLesson(existingBody: string, lesson: StructuredLesson): string;
/**
 * Construct the `persona-append`-kind apply handler. The production registry
 * calls this with no args; seams are injectable for tests.
 */
export declare function makePersonaAppendHandler(): ProposalApplyHandler;
