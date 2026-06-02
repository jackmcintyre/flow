/**
 * Agreement truth-table helper for `computeAgreement` (Story 4.10).
 *
 * Pins the 6-cell agreement definition so that `computeAgreement` and any
 * future Epic 6 retro stats share a single implementation without drift risk.
 *
 * Agreement definition (FR67, NFR24):
 *
 * | verdict          | merge_action      | agreement? |
 * |------------------|-------------------|------------|
 * | READY FOR MERGE  | merged            | YES        |
 * | READY FOR MERGE  | closed-unmerged   | NO         |
 * | NEEDS CHANGES    | merged            | NO         |
 * | NEEDS CHANGES    | closed-unmerged   | YES        |
 * | BLOCKED          | merged            | NO         |
 * | BLOCKED          | closed-unmerged   | YES        |
 *
 * This function accepts only resolved non-excluded values. Upstream callers
 * must strip `"reviewer-failure"` verdicts (excluded, Story 4.10 AC1g) and
 * `"still-open"` merge actions (unresolved, AC3) before invoking this helper.
 * Caller-side exhaustiveness is enforced by the input type union.
 *
 * Story 4.10 · FR67 · NFR24
 */
export function isAgreement(verdict, mergeAction) {
    return ((verdict === "READY FOR MERGE" && mergeAction === "merged") ||
        (verdict !== "READY FOR MERGE" && mergeAction === "closed-unmerged"));
}
