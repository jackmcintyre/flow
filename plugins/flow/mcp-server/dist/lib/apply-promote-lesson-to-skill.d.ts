/**
 * The `promote-lesson-to-skill` apply handler — Story native:01KT6RHQ1K4KQMASAXNEK6MY7E.
 *
 * Accepts a `promote-lesson-to-skill` proposal and performs two atomic effects:
 *
 *  1. Creates a new skill file at `proposed_skill_path` under `.flow/skills/`
 *     (reuses the `writeNewSkill` path from Story 6.7; fails with
 *     SkillAlreadyExistsError before any write if the path is occupied).
 *
 *  2. Appends a one-line skill reference to the `## Skills` section of the
 *     originating role's PERSONA.md. The reference serialises as an HTML comment
 *     block (`<!-- skill:ref {...} -->`) so it is machine-parseable by
 *     `buildPersonaSpawnPrompt` while staying human-readable.
 *
 * ## Skill-reference block format
 *
 *   `<!-- skill:ref {"name":"<skill-name>","skill_path":"<rel-path>","when_to_use":"<when>"} -->`
 *
 * `buildPersonaSpawnPrompt` renders each block as a one-line entry:
 *   `[<skill-name>] <when_to_use>`
 *
 * The full skill body is available on demand by reading the skill file at
 * `skill_path`.
 *
 * ## Ordering (atomicity)
 *
 * The skill file is created BEFORE the persona is updated. If the skill-create
 * throws (e.g. SkillAlreadyExistsError), the persona is left unchanged and no
 * half-applied state is committed (the gate only commits on a clean `apply`
 * return).
 *
 * ## No commit
 *
 * The handler only mutates the working tree and returns the repo-relative paths
 * it changed. The gate (`acceptProposal`) owns the commit + proposal stamp +
 * telemetry.
 *
 * (Story native:01KT6RHQ1K4KQMASAXNEK6MY7E — FR promote-lesson-to-skill)
 */
import { type SkillHandlerDeps } from "./apply-skill-proposal.js";
import type { ProposalApplyHandler } from "./proposal-apply-registry.js";
/** The prefix/suffix that delineate a skill-ref block (machine-parseable). */
export declare const SKILL_REF_BLOCK_PREFIX = "<!-- skill:ref ";
export declare const SKILL_REF_BLOCK_SUFFIX = " -->";
/**
 * A parsed skill reference as it appears in a persona's `## Skills` section.
 */
export interface SkillRef {
    name: string;
    skill_path: string;
    when_to_use: string;
}
/**
 * Serialise a `SkillRef` as an HTML comment block for storage in a persona's
 * `## Skills` section body.
 */
export declare function serialiseSkillRef(ref: SkillRef): string;
/**
 * Parse all `<!-- skill:ref {...} -->` blocks from a `## Skills` section body.
 * Silently skips malformed or unrecognisable blocks. Returns an array of
 * parsed `SkillRef` objects.
 *
 * Exported for unit testing.
 */
export declare function extractSkillRefs(skillsBody: string): SkillRef[];
/**
 * Append a skill-ref block to a `## Skills` section body.
 * If the body is empty, the result is the serialised block; if non-empty,
 * the block is appended after a newline.
 *
 * Exported for unit testing.
 */
export declare function appendSkillRef(existingBody: string, ref: SkillRef): string;
/**
 * Extract the `## Skills` section body from the raw persona file text, or an
 * empty string when the section is absent. Scans line-by-line for the heading
 * then collects subsequent lines until the next `##` heading.
 *
 * Exported for unit testing.
 */
export declare function extractSkillsSection(raw: string): string;
/**
 * Build the `promote-lesson-to-skill` apply handler. The clock seam is
 * injectable (same pattern as `createSkillProposalHandlers`) so tests can
 * assert `introduced_at` deterministically.
 */
export declare function makePromoteLessonToSkillHandler(deps: SkillHandlerDeps): ProposalApplyHandler;
