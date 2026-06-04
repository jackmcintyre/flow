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
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { RetroProposalAlreadyExistsError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { RetroProposalFileSchema, parseRetroProposalFile, } from "../schemas/retro-proposal.js";
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
export function routeLessonDurability(input) {
    const { lesson, recurrence, roleCount = 1, storyCount = 1 } = input;
    // Rule 1: pitfall or tool-quirk with a stable failure class that has recurred.
    if ((lesson.kind === "pitfall" || lesson.kind === "tool-quirk") &&
        lesson.failure_class !== undefined &&
        recurrence > 1) {
        return {
            tier: "code",
            reason: "This failure has a stable mechanical shape and keeps recurring — a guard makes it impossible",
        };
    }
    // Rule 2: cross-role or cross-story pattern that has recurred.
    if (lesson.kind === "pattern" &&
        (roleCount > 1 || storyCount > 1) &&
        recurrence > 1) {
        return {
            tier: "skill",
            reason: "This procedure is useful across multiple roles or stories — a shared skill makes it reusable",
        };
    }
    // Rule 3: all other cases — keep as a note.
    return {
        tier: "note",
        reason: "This is a one-off judgment call — a note is the right home",
    };
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
export async function writeRetroProposal(opts) {
    const { targetRepoRoot, isoTimestamp, proposals, cycleWindow = null, role = "retro-analyst", lessonRoutings = [], } = opts;
    // Compute durability recommendations for each lesson routing input.
    const routedLessons = lessonRoutings.map((input) => ({
        lessonText: input.lesson.text,
        recommendation: routeLessonDurability(input),
    }));
    // Step 1 + 2: Validate via the canonical parser. The wrapper schema
    // validates `iso_timestamp` (defends against path-traversal in the
    // filename component) AND each proposal in `proposals` via the
    // discriminated union — a single Zod pass covers both AC1's "validate
    // before path-form" and AC2's "discriminated union over seven
    // literals." `parseRetroProposalFile` throws MalformedRetroProposalError
    // on failure.
    const fileShape = parseRetroProposalFile({
        iso_timestamp: isoTimestamp,
        cycle_window: cycleWindow,
        proposals,
    });
    // Step 3: Form the absolute path. `isoTimestamp` has already passed
    // the ISO-8601 regex inside the schema, so a `../escape`-shaped value
    // would have thrown above before we got here.
    const absPath = path.join(targetRepoRoot, ".flow", "retro-proposals", `${isoTimestamp}.md`);
    // Step 4: Collision check. fs.access throws if the file does NOT
    // exist; we invert that to "exists → throw". Note: writeManagedFile
    // itself will mkdir-p the parent directory, so we only need to check
    // for an existing file (not the parent dir).
    let exists = false;
    try {
        await fs.access(absPath);
        exists = true;
    }
    catch {
        // ENOENT (or any access failure) → safe to write.
    }
    if (exists) {
        throw new RetroProposalAlreadyExistsError({ absPath, isoTimestamp });
    }
    // Step 5: Render + write. The frontmatter is the source of truth;
    // the body is operator-readable scaffolding.
    const contents = renderProposalMarkdown(fileShape, routedLessons);
    await writeManagedFile({
        absPath,
        contents,
        targetRepoRoot,
        mcpToolContext: { toolName: "writeRetroProposal", role },
    });
    return { absPath, proposalCount: fileShape.proposals.length, routedLessons };
}
// ---------------------------------------------------------------------------
// Rendering — frontmatter + body
// ---------------------------------------------------------------------------
/**
 * Render a `RetroProposalFile` as the on-disk markdown file:
 *
 *     ---
 *     <yaml frontmatter>
 *     ---
 *
 *     # Retro proposals — <isoTimestamp>
 *
 *     Cycle window: <from> → <to>   (or "Not specified" when null)
 *     Proposals: <N>
 *
 *     ## Proposal 1 — <type> — <id>
 *     **Rationale.** <rationale>
 *     <type-specific fields as a definition list>
 *
 *     ## Proposal 2 — ...
 *
 *     ## Durability recommendations
 *     (when lessonRoutings was provided)
 *
 * Empty-proposals special case: when `fileShape.proposals` is empty, the
 * body is just the header lines plus a single paragraph:
 *   "No proposals produced this cycle."
 */
function renderProposalMarkdown(fileShape, routedLessons) {
    const fm = renderFrontmatter(fileShape);
    const body = renderBody(fileShape, routedLessons);
    return `---\n${fm}---\n\n${body}`;
}
/**
 * Render the YAML frontmatter block (lineWidth: 0 for stable output;
 * Story 6.3's idempotency guarantee depends on byte-stable
 * stringification).
 *
 * The frontmatter mirrors the `RetroProposalFile` shape exactly so that
 * `yaml.parse(frontmatter)` -> `parseRetroProposalFile` round-trips.
 */
function renderFrontmatter(fileShape) {
    return yamlStringify({
        iso_timestamp: fileShape.iso_timestamp,
        cycle_window: fileShape.cycle_window,
        proposals: fileShape.proposals,
    }, { lineWidth: 0 });
}
/**
 * Render the operator-readable Markdown body. Header lines first,
 * then one H2 section per proposal (or the "No proposals" sentence
 * when the array is empty). When `routedLessons` is non-empty, appends
 * a "## Durability recommendations" section listing each lesson's
 * routing decision and plain-language reason.
 */
function renderBody(fileShape, routedLessons) {
    const { iso_timestamp, cycle_window, proposals } = fileShape;
    const lines = [];
    lines.push(`# Retro proposals — ${iso_timestamp}`);
    lines.push("");
    if (cycle_window) {
        lines.push(`Cycle window: ${cycle_window.from} → ${cycle_window.to}`);
    }
    else {
        lines.push("Cycle window: Not specified");
    }
    lines.push(`Proposals: ${proposals.length}`);
    lines.push("");
    if (proposals.length === 0) {
        lines.push("No proposals produced this cycle.");
        lines.push("");
    }
    else {
        proposals.forEach((proposal, idx) => {
            lines.push(`## Proposal ${idx + 1} — ${proposal.type} — ${proposal.id}`);
            lines.push("");
            lines.push(`**Rationale.** ${proposal.rationale}`);
            lines.push("");
            const fields = renderProposalFields(proposal);
            for (const [key, value] of fields) {
                lines.push(`- **${key}:** ${value}`);
            }
            lines.push("");
        });
    }
    // Durability recommendations section (Story DR1 / native:01KT6RH6XJFE2E09WMEHJ03JBD).
    // Appended when the caller provided lesson routing inputs — gives the operator
    // a plain-language steer on how to make each lesson durable.
    if (routedLessons.length > 0) {
        lines.push("## Durability recommendations");
        lines.push("");
        for (const routed of routedLessons) {
            lines.push(`**Lesson:** ${routed.lessonText}`);
            lines.push(`**Durability recommendation:** ${routed.recommendation.tier} — ${routed.recommendation.reason}`);
            lines.push("");
        }
    }
    return lines.join("\n");
}
/**
 * Per-variant definition-list rendering. Returns `[key, value]` pairs
 * suitable for emission as Markdown bullet items (`- **key:** value`).
 *
 * Values that are themselves structured (objects, arrays, multi-line
 * strings) are rendered with backticks + JSON for compactness; the
 * frontmatter remains the authoritative source — the body is operator-
 * readable scaffolding only.
 */
function renderProposalFields(proposal) {
    switch (proposal.type) {
        case "rule":
            return [
                ["text", proposal.text],
                ["target_failure_class", proposal.target_failure_class],
                ["recommended_promotion_level", proposal.recommended_promotion_level],
            ];
        case "rule-retirement":
            return [
                ["target_rule_id", proposal.target_rule_id],
                ["fire_count_over_window", String(proposal.fire_count_over_window)],
                ["recommended_action", proposal.recommended_action],
            ];
        case "skill-create":
            return [
                ["proposed_path", proposal.proposed_path],
                ["frontmatter_description", proposal.frontmatter_description],
                [
                    "body",
                    `(${proposal.body.split("\n").length} lines — see frontmatter)`,
                ],
            ];
        case "skill-revise":
            return [
                ["target_skill_path", proposal.target_skill_path],
                ["version_bump", proposal.version_bump],
                [
                    "revised_body",
                    `(${proposal.revised_body.split("\n").length} lines — see frontmatter)`,
                ],
            ];
        case "skill-supersede":
            return [
                ["superseded_skill_path", proposal.superseded_skill_path],
                ["replacement.proposed_path", proposal.replacement.proposed_path],
                [
                    "replacement.frontmatter_description",
                    proposal.replacement.frontmatter_description,
                ],
                [
                    "replacement.body",
                    `(${proposal.replacement.body.split("\n").length} lines — see frontmatter)`,
                ],
            ];
        case "skill-retire":
            return [
                ["target_skill_path", proposal.target_skill_path],
                [
                    "last_invoked_at",
                    proposal.last_invoked_at === null
                        ? "null (never fired)"
                        : proposal.last_invoked_at,
                ],
            ];
        case "team-change":
            return [
                ["action", proposal.action],
                ["target_role", proposal.target_role],
                ["justification", proposal.justification],
                [
                    "predicted_impact.affected_failure_classes",
                    `[${proposal.predicted_impact.affected_failure_classes.join(", ")}]`,
                ],
            ];
        case "persona-append":
            return [
                ["target_role", proposal.target_role],
                ["lesson", proposal.lesson],
            ];
    }
}
// Re-export the schema's `RetroProposalFileSchema` for callers that need
// the raw schema (e.g. apply-tool tests in Epic 6b). Keeps the public
// surface in one import path.
export { RetroProposalFileSchema };
