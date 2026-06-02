/**
 * `writeRetroProposal` MCP tool — Story 6.3 AC1.
 *
 * Writes exactly one immutable proposal markdown file at
 * `<targetRepoRoot>/.flow/retro-proposals/<isoTimestamp>.md`. The file
 * carries:
 *   - A YAML frontmatter block (the source-of-truth for apply-time
 *     re-validation in Epic 6b) wrapping the validated `proposals` array
 *     plus the `iso_timestamp` and optional `cycle_window`.
 *   - An operator-readable rendered Markdown body listing each proposal
 *     as an H2 section with the structured fields as a definition list.
 *
 * Steps:
 *   1. Validate `isoTimestamp` via `IsoTimestampSchema.parse` — defends
 *      against path-traversal smuggling in the filename component
 *      (a `"../escape"` value is rejected before path-forming).
 *   2. Validate the full file shape via `RetroProposalFileSchema.parse`.
 *      Failures throw `MalformedRetroProposalError`.
 *   3. Form the absolute path
 *      `<targetRepoRoot>/.flow/retro-proposals/<isoTimestamp>.md`.
 *   4. `fs.access` to check for collision — the first-ever retro creates
 *      the directory; a duplicate timestamp throws
 *      `RetroProposalAlreadyExistsError`. **Do not overwrite.**
 *   5. Render frontmatter + body, write through `writeManagedFile`
 *      (canonical-fs guard). Role defaults to `"retro-analyst"` so the
 *      role-trace is meaningful.
 *
 * **Immutability.** Proposals are immutable artifacts keyed by ISO
 * timestamp. Collisions are bugs in the caller (the retro-analyst
 * re-using a timestamp) — never silent overwrites.
 *
 * **Round-trip guarantee.** The YAML frontmatter (not the rendered body)
 * is the source of truth; `parseRetroProposalFile(yaml.parse(frontmatter))`
 * MUST round-trip cleanly. Epic 6b's `/accept-proposal` reads the
 * frontmatter, not the body.
 *
 * FR58 — single proposal markdown file under `<target-repo>/.flow/retro-proposals/<ISO>.md`.
 * FR59 — seven typed proposal variants.
 */
import { RetroProposalFileSchema } from "../schemas/retro-proposal.js";
/**
 * Options accepted by `writeRetroProposal`.
 *
 * The `proposals` field is typed `unknown[]` to make the boundary
 * explicit: the validator inside this function is the only layer that
 * promotes raw shapes to `RetroProposal`. Callers (tools, handlers,
 * subagent transcripts) MUST NOT pre-validate elsewhere and rely on
 * type narrowing — every write goes back through the Zod boundary.
 */
export interface WriteRetroProposalOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /** UTC ISO-8601 timestamp; validated before path-forming. */
    isoTimestamp: string;
    /** Raw proposals — each validated via `RetroProposalSchema` before write. */
    proposals: unknown[];
    /** Optional calibration window the proposals derive from. */
    cycleWindow?: {
        from: string;
        to: string;
    } | null;
    /** Optional role label for `writeManagedFile`'s canonical-fs guard.
     *  Defaults to `"retro-analyst"` (the documented v1 caller). */
    role?: string;
}
/**
 * Write a retro-proposal markdown file. See module JSDoc for full
 * behaviour.
 *
 * @returns `{ absPath, proposalCount }` — the absolute path of the
 *   written file and the count of proposals serialised into it.
 *
 * @throws {MalformedRetroProposalError} When `isoTimestamp` is malformed
 *   (non-ISO-8601 / non-UTC), when any proposal fails its variant's
 *   schema, when an unknown discriminator literal is used, or when
 *   the file-level wrapper fails (e.g. malformed `cycle_window`).
 * @throws {RetroProposalAlreadyExistsError} When a file already exists
 *   at the target path (immutable artifacts; collisions are caller
 *   bugs).
 * @throws {CanonicalFsWriteError} If `writeManagedFile` is invoked
 *   outside a tool context (structurally impossible from the
 *   registered MCP handler).
 */
export declare function writeRetroProposal(opts: WriteRetroProposalOptions): Promise<{
    absPath: string;
    proposalCount: number;
}>;
export { RetroProposalFileSchema };
