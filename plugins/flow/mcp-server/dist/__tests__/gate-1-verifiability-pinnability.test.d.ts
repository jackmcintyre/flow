/**
 * Gate-1 Verifiability lens — pinnability-once-built tests.
 *
 * Story native:01KT496MGGREGP34GX91KDV1F7.
 *
 * The Verifiability lens in gate-1.workflow.js previously graded whether code
 * and tests ALREADY EXISTED, causing it to wrongly reject sound plans for
 * net-new behaviour (the very code the plan proposes to write does not exist
 * yet — that is the point). This story fixes the grading instruction to judge
 * PINNABILITY-ONCE-BUILT: once the proposed work is built, could a
 * correctly-written test be made to fail if the behaviour were missing?
 *
 * Tests:
 *
 * AC1 — (integration) Given a plan with pinnable-once-built net-new behaviour
 *        AND a plan whose success condition is unpinnable in principle, both run
 *        through the panel, the pinnable plan APPROVES and the unpinnable REJECTS.
 *
 * AC2 — (unit) An existing-code bug-pin plan (already built) is still APPROVED,
 *        confirming the fix does not regress the case that works today.
 *
 * AC3 — (unit) A success condition that would be unmet before the proposed work
 *        and met after it is treated as SOUND — not faulted on "would hold equally
 *        before and after".
 *
 * AC4 — (unit) When the panel rejects a plan, the rejection reason names an
 *        in-principle-unprovable success condition, never the mere absence of
 *        not-yet-written code or test scaffolding.
 *
 * Wording anchor: Two text-content assertions lock the fix in place so CI catches
 * any revert of the LENS_RUBRIC.verifiability wording in gate-1.workflow.js and
 * the matching rubric §3.2 update.
 */
export {};
