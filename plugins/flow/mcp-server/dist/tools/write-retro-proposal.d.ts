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
 *   5. Apply the durability routing heuristic to any `persona-append`
 *      proposal that carries a `routing_context` but no
 *      `durability_recommendation` yet, then store the result back in the
 *      validated file shape so it round-trips in the frontmatter.
 *   6. Render frontmatter + body, write through `writeManagedFile`
 *      (canonical-fs guard). Role defaults to `"retro-analyst"` so the
 *      role-trace is meaningful.
 *
 * **Durability routing (Story native:01KT6RH6XJFE2E09WMEHJ03JBD).**
 * When a `persona-append` proposal provides `routing_context` (recurrence,
 * optional role_count/story_count), `writeRetroProposal` computes a
 * `durability_recommendation` using `routeDurability` and stores it on the
 * proposal before rendering. This makes every recurring lesson self-
 * describing: the markdown body shows "**Durability recommendation:** code —
 * <reason>" and the frontmatter persists the structured field for tooling.
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
import { RetroProposalFileSchema, type DurabilityRecommendation, type DurabilityRoutingContext } from "../schemas/retro-proposal.js";
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
 * One entry in the `durabilityRecommendations` array returned by
 * `writeRetroProposal` — identifies the proposal id and its routing outcome
 * so the caller can surface it without re-parsing the markdown.
 *
 * (Story native:01KT6RH6XJFE2E09WMEHJ03JBD AC1)
 */
export interface ProposalDurabilityRecommendation {
    /** The proposal's ULID id. */
    proposalId: string;
    /** The computed recommendation ('note', 'skill', or 'code'). */
    recommendation: "note" | "skill" | "code";
    /** One-sentence plain-language reason explaining the choice. */
    reason: string;
}
/**
 * Write a retro-proposal markdown file. See module JSDoc for full
 * behaviour.
 *
 * @returns `{ absPath, proposalCount, durabilityRecommendations }` —
 *   the absolute path of the written file, the count of proposals
 *   serialised into it, and the list of durability recommendations
 *   computed for any `persona-append` proposal that carried a
 *   `routing_context` (Story native:01KT6RH6XJFE2E09WMEHJ03JBD AC1).
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
    durabilityRecommendations: ProposalDurabilityRecommendation[];
}>;
/**
 * Routing reason strings — canonical text per recommendation tier.
 * Kept as constants so tests can assert exact strings without copying prose.
 */
export declare const DURABILITY_REASONS: {
    readonly code: "This failure has a stable mechanical shape and keeps recurring — a guard makes it impossible";
    readonly skill: "This procedure is useful across multiple roles or stories — a shared skill makes it reusable";
    readonly note: "This is a one-off judgment call — a note is the right home";
};
/**
 * Deterministic durability routing heuristic.
 *
 * Given a structured lesson entry (kind, optional failure_class) and a
 * routing context (recurrence count, optional role_count / story_count),
 * returns the appropriate `{ recommendation, reason }` pair or `null` when
 * the inputs are insufficient to route (i.e. no routing_context supplied).
 *
 * Routing table (from implementation_notes):
 *   1. kind in ['pitfall', 'tool-quirk'] AND failure_class present
 *      AND recurrence > 1  →  'code'
 *   2. kind == 'pattern' AND (role_count > 1 OR story_count > 1)
 *      AND recurrence > 1  →  'skill'
 *   3. otherwise           →  'note'
 *
 * AC2: pitfall/tool-quirk + failure_class + recurrence > 1 → code
 * AC3: pattern + (role_count>1 or story_count>1) + recurrence > 1 → skill
 * AC4: anything else (including observed only once) → note
 *
 * @param kind       - lesson kind from the closed enum (or undefined).
 * @param failureClass - the lesson's failure_class (or undefined).
 * @param ctx        - routing context with recurrence and optional counts.
 * @returns `{ recommendation, reason }` or `null` when ctx is absent.
 */
export declare function routeDurability(kind: string | undefined, failureClass: string | undefined, ctx: DurabilityRoutingContext): DurabilityRecommendation;
export { RetroProposalFileSchema };
