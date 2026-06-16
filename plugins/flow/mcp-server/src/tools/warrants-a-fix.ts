/**
 * `warrantsAFix` — pure, side-effect-free classifier.
 *
 * Maps one retro proposal (or its `type` field, or an entire
 * `RetroProposalFile`) to a boolean answer: does this warrant a fix story?
 *
 * **Fix-worthy variants (return `true`):**
 *   - `rule`                  — propose a new discipline rule
 *   - `rule-retirement`       — retire or relax an existing rule
 *   - `skill-create`          — create a new skill file
 *   - `skill-revise`          — revise an existing skill body
 *   - `skill-supersede`       — retire one skill and create its replacement
 *   - `skill-retire`          — retire an existing skill
 *   - `team-change`           — hire or unhire a role
 *   - `persona-append`        — append a durable lesson to a role's Knowledge
 *   - `promote-lesson-to-skill` — promote a role lesson into a shared skill
 *   - `build-story`           — queue a build-and-review story for a core-machinery change
 *   - `lesson-consolidation`  — merge two near-duplicate lessons into one
 *   - `lesson-retirement`     — retire never-earned-keep lessons to the archived store
 *
 * **Not fix-worthy (return `false`):**
 *   - An empty `proposals` array in a `RetroProposalFile` (the analyst found
 *     nothing worth changing — a purely informational/no-op retro).
 *
 * The twelve concrete proposal types are ALL concrete change proposals: every
 * type that can appear in the validated `RetroProposalSchema` discriminated
 * union carries real structural change. Therefore `warrantsAFix` for any
 * single validated proposal is always `true` — the "no fix needed" signal
 * is represented by an empty `proposals` array, never by a special proposal
 * type. This is the invariant the unit tests are anchored against.
 *
 * **Why a standalone module?**  The decision must be independently testable
 * and must not import any write-path code (no `writeNativeStory`, no state
 * side-effects). Keeping it here (not inlined into SKILL.md prose) means the
 * retro-skill's SKILL.md spawns the author subagent based on a deterministic
 * tool call result, never on LLM prose alone.
 *
 * Story native:01KTZGJ68HE6Z66A50BV7N6BJZ — AC2.
 * Story native:01KV76P2DW42BPBPT4ZQ0FS63Y — added `build-story` variant.
 */

import type { RetroProposal, RetroProposalFile } from "../schemas/retro-proposal.js";

// ---------------------------------------------------------------------------
// Single-proposal classifier
// ---------------------------------------------------------------------------

/**
 * Returns `true` for every concrete proposal type in the closed
 * `RetroProposalSchema` discriminated union — all twelve variants carry a real
 * change, so any single validated proposal is fix-worthy.
 *
 * This function exists as a named, testable unit to prevent the classifier
 * logic from drifting into SKILL.md prose where it cannot be unit-tested.
 *
 * @param proposal  A single validated `RetroProposal`.
 * @returns         `true` — all twelve schema variants are fix-worthy.
 */
export function warrantsAFix(proposal: RetroProposal): true {
  // All twelve validated proposal variants represent concrete changes.
  // The "no fix needed" signal lives in the `RetroProposalFile.proposals`
  // array being empty (handled by `warrantsAnyFix`), not in a special type.
  // TypeScript exhaustiveness is guaranteed by the discriminated union:
  // any new variant added to `RetroProposalSchema` will be fix-worthy by
  // construction (the schema only accepts concrete change proposals).
  void proposal; // satisfy TS — the type narrows the input; all branches return true
  return true;
}

// ---------------------------------------------------------------------------
// File-level classifier (the primary operator-facing predicate)
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the proposal file contains at least one proposal —
 * i.e. at least one concrete change was surfaced by the retro-analyst.
 *
 * Returns `false` when `proposals` is empty (the analyst found nothing worth
 * changing, a purely informational retro). In that case no draft story is
 * warranted.
 *
 * @param proposalFile  A parsed `RetroProposalFile` (output of `parseRetroProposalFile`).
 * @returns             `true` iff the file carries ≥1 proposal.
 */
export function warrantsAnyFix(proposalFile: RetroProposalFile): boolean {
  return proposalFile.proposals.length > 0;
}

// ---------------------------------------------------------------------------
// Proposal-type-level classifier (for the retro SKILL.md to call per item)
// ---------------------------------------------------------------------------

/**
 * The full set of proposal types that the `warrantsAFix` classifier
 * treats as fix-worthy. Exported so tests can assert completeness without
 * re-importing the schema's RETRO_PROPOSAL_TYPES constant.
 *
 * Every type in `RETRO_PROPOSAL_TYPES` is fix-worthy — the list is provided
 * here as a stable surface for test assertions.
 */
export const FIX_WORTHY_TYPES = [
  "rule",
  "rule-retirement",
  "skill-create",
  "skill-revise",
  "skill-supersede",
  "skill-retire",
  "team-change",
  "persona-append",
  "promote-lesson-to-skill",
  "build-story",
  "lesson-consolidation",
  "lesson-retirement",
] as const;
