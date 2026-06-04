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
 * **Durability routing (Story DR1 / native:01KT6RH6XJFE2E09WMEHJ03JBD).**
 * Each recurring lesson may carry a `durability_recommendation` of
 * `'note' | 'skill' | 'code'` with a plain-language reason. The routing
 * heuristic is in `routeLessonDurability` (exported for unit tests). When
 * `lessonRoutings` is provided, the rendered body appends a
 * "**Durability recommendation:**" line to each matching lesson block and
 * the structured recommendations are returned in the call result.
 *
 * FR58 — single proposal markdown file under `<target-repo>/.flow/retro-proposals/<ISO>.md`.
 * FR59 — seven typed proposal variants.
 */
import { RetroProposalFileSchema } from "../schemas/retro-proposal.js";
import type { Lesson } from "../schemas/story-retro.js";
/**
 * The three durability tiers a lesson can be routed to.
 *
 * - `'note'`  — keep as an ad-hoc note (one-off judgment call).
 * - `'skill'` — promote to a shared, reusable skill.
 * - `'code'`  — harden as a code guard (e.g. a lint rule or runtime assertion).
 */
export type DurabilityTier = "note" | "skill" | "code";
/**
 * A single durability recommendation produced by `routeLessonDurability`.
 */
export interface DurabilityRecommendation {
    /** The routing decision. */
    tier: DurabilityTier;
    /** Plain-language explanation of the decision, suitable for the operator. */
    reason: string;
}
/**
 * Input to the lesson durability routing heuristic.
 *
 * The fields mirror the `LessonSchema` shape from `story-retro.ts` plus the
 * recurrence/cross-role/cross-story counts that are computed from the retro
 * inputs by `gatherRetroInputs`.
 */
export interface LessonRoutingInput {
    /** The structured lesson (kind, text, optional failure_class). */
    lesson: Lesson;
    /**
     * How many times this lesson (or a lesson of the same failure_class) has
     * been recorded across all prior retros. A value of 1 means it has only
     * appeared this cycle (first time); a value > 1 means it has recurred.
     */
    recurrence: number;
    /**
     * How many distinct roles contributed this lesson or a lesson in the same
     * failure class. Defaults to 1 when not specified (single-role observation).
     */
    roleCount?: number;
    /**
     * How many distinct stories contributed this lesson or a lesson in the same
     * failure class. Defaults to 1 when not specified (single-story observation).
     */
    storyCount?: number;
}
/**
 * Route a lesson to its durability tier using the routing heuristic.
 *
 * Routing table (evaluated top-to-bottom; first match wins):
 *
 * 1. `kind in ['pitfall', 'tool-quirk'] AND failure_class present AND recurrence > 1`
 *    → `'code'` — "This failure has a stable mechanical shape and keeps recurring — a guard makes it impossible"
 *
 * 2. `kind == 'pattern' AND (roleCount > 1 OR storyCount > 1) AND recurrence > 1`
 *    → `'skill'` — "This procedure is useful across multiple roles or stories — a shared skill makes it reusable"
 *
 * 3. otherwise
 *    → `'note'` — "This is a one-off judgment call — a note is the right home"
 *
 * This function is deterministic and has no side effects — it reads the input
 * fields and returns a recommendation.
 *
 * @param input - The routing input (lesson + recurrence counts).
 * @returns A `DurabilityRecommendation` carrying the tier and plain-language reason.
 */
export declare function routeLessonDurability(input: LessonRoutingInput): DurabilityRecommendation;
/**
 * A lesson entry paired with its durability recommendation to embed in the
 * retro proposal markdown and structured result.
 */
export interface RoutedLesson {
    /** The original lesson text (for correlation in the markdown body). */
    lessonText: string;
    /** The routing recommendation produced by `routeLessonDurability`. */
    recommendation: DurabilityRecommendation;
}
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
    /**
     * Optional lesson routing inputs. When provided, `routeLessonDurability`
     * is called for each entry and the resulting recommendations are:
     *   1. Appended to the rendered markdown body as a
     *      "**Durability recommendation:**" line per lesson.
     *   2. Returned in the structured result as `routedLessons`.
     *
     * Only lessons with `recurrence > 0` (i.e. recurring at least once) carry
     * a recommendation per AC1. Lessons with `recurrence == 1` (first-ever
     * observation) are included too — the recommendation guides the operator
     * on where to store even a first-observation so they can track it.
     *
     * Story native:01KT6RH6XJFE2E09WMEHJ03JBD (DR1).
     */
    lessonRoutings?: LessonRoutingInput[];
}
/**
 * Write a retro-proposal markdown file. See module JSDoc for full
 * behaviour.
 *
 * @returns `{ absPath, proposalCount, routedLessons }` — the absolute path
 *   of the written file, the count of proposals serialised into it, and
 *   (when `lessonRoutings` was provided) the structured durability
 *   recommendations for each lesson.
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
    routedLessons: RoutedLesson[];
}>;
export { RetroProposalFileSchema };
