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
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { RetroProposalAlreadyExistsError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { RetroProposalFileSchema, parseRetroProposalFile, } from "../schemas/retro-proposal.js";
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
export async function writeRetroProposal(opts) {
    const { targetRepoRoot, isoTimestamp, proposals, cycleWindow = null, role = "retro-analyst", } = opts;
    // Step 1 + 2: Validate via the canonical parser. The wrapper schema
    // validates `iso_timestamp` (defends against path-traversal in the
    // filename component) AND each proposal in `proposals` via the
    // discriminated union — a single Zod pass covers both AC1's "validate
    // before path-form" and AC2's "discriminated union over seven
    // literals." `parseRetroProposalFile` throws MalformedRetroProposalError
    // on failure.
    let fileShape = parseRetroProposalFile({
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
    // Step 5: Apply the durability routing heuristic to any persona-append
    // proposal that has routing_context but no durability_recommendation yet.
    // The heuristic is deterministic given the inputs, so it is owned by the
    // tool (not the LLM) — load-bearing decisions live in tool-written
    // artefacts, not LLM prose (memory `feedback_default_to_deterministic_seams`).
    const durabilityRecommendations = [];
    const enrichedProposals = fileShape.proposals.map((proposal) => {
        if (proposal.type !== "persona-append")
            return proposal;
        // If already has a recommendation (pre-filled by a deterministic caller),
        // surface it in the return value without overwriting.
        if (proposal.durability_recommendation) {
            durabilityRecommendations.push({
                proposalId: proposal.id,
                recommendation: proposal.durability_recommendation.recommendation,
                reason: proposal.durability_recommendation.reason,
            });
            return proposal;
        }
        // Compute from routing_context when present.
        if (!proposal.routing_context)
            return proposal;
        const rec = routeDurability(proposal.kind, proposal.failure_class, proposal.routing_context);
        if (!rec)
            return proposal;
        durabilityRecommendations.push({
            proposalId: proposal.id,
            recommendation: rec.recommendation,
            reason: rec.reason,
        });
        // Return enriched proposal with the computed recommendation baked in,
        // so it persists in the frontmatter and round-trips cleanly.
        return { ...proposal, durability_recommendation: rec };
    });
    // Re-validate the enriched shape (baking computed recommendations in before
    // the round-trip guarantee applies). This is a pure in-memory pass.
    fileShape = parseRetroProposalFile({
        iso_timestamp: isoTimestamp,
        cycle_window: cycleWindow,
        proposals: enrichedProposals,
    });
    // Step 6: Render + write. The frontmatter is the source of truth;
    // the body is operator-readable scaffolding.
    const contents = renderProposalMarkdown(fileShape);
    await writeManagedFile({
        absPath,
        contents,
        targetRepoRoot,
        mcpToolContext: { toolName: "writeRetroProposal", role },
    });
    return {
        absPath,
        proposalCount: fileShape.proposals.length,
        durabilityRecommendations,
    };
}
// ---------------------------------------------------------------------------
// Durability routing heuristic (Story native:01KT6RH6XJFE2E09WMEHJ03JBD)
// ---------------------------------------------------------------------------
/**
 * Routing reason strings — canonical text per recommendation tier.
 * Kept as constants so tests can assert exact strings without copying prose.
 */
export const DURABILITY_REASONS = {
    code: "This failure has a stable mechanical shape and keeps recurring — a guard makes it impossible",
    skill: "This procedure is useful across multiple roles or stories — a shared skill makes it reusable",
    note: "This is a one-off judgment call — a note is the right home",
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
export function routeDurability(kind, failureClass, ctx) {
    const { recurrence, role_count, story_count } = ctx;
    // Rule 1: stable mechanical failure — harden as a code guard.
    if ((kind === "pitfall" || kind === "tool-quirk") &&
        failureClass !== undefined &&
        failureClass.length > 0 &&
        recurrence > 1) {
        return { recommendation: "code", reason: DURABILITY_REASONS.code };
    }
    // Rule 2: broadly useful procedure — promote to a shared skill.
    if (kind === "pattern" &&
        ((role_count !== undefined && role_count > 1) ||
            (story_count !== undefined && story_count > 1)) &&
        recurrence > 1) {
        return { recommendation: "skill", reason: DURABILITY_REASONS.skill };
    }
    // Rule 3: default — keep as a note.
    return { recommendation: "note", reason: DURABILITY_REASONS.note };
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
 * Empty-proposals special case: when `fileShape.proposals` is empty, the
 * body is just the header lines plus a single paragraph:
 *   "No proposals produced this cycle."
 */
function renderProposalMarkdown(fileShape) {
    const fm = renderFrontmatter(fileShape);
    const body = renderBody(fileShape);
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
 * when the array is empty).
 */
function renderBody(fileShape) {
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
 *
 * For `persona-append` proposals with a computed `durability_recommendation`,
 * an extra line is appended:
 *   "**Durability recommendation:** <code|skill|note> — <reason>"
 * (Story native:01KT6RH6XJFE2E09WMEHJ03JBD AC1)
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
        case "persona-append": {
            const fields = [
                ["target_role", proposal.target_role],
                ["lesson", proposal.lesson],
            ];
            // Append durability recommendation when present (Story native:01KT6RH6XJFE2E09WMEHJ03JBD).
            if (proposal.durability_recommendation) {
                const { recommendation, reason } = proposal.durability_recommendation;
                fields.push([
                    "Durability recommendation",
                    `${recommendation} — ${reason}`,
                ]);
            }
            return fields;
        }
    }
}
// Re-export the schema's `RetroProposalFileSchema` for callers that need
// the raw schema (e.g. apply-tool tests in Epic 6b). Keeps the public
// surface in one import path.
export { RetroProposalFileSchema };
