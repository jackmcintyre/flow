/**
 * `LensVerdict` + `PanelVerdict` schemas — Story 9.3 (judge panel, gate 1 Tier 1).
 *
 * The deterministic seam of the judge panel. Each lens judge's *reasoning* is
 * free, but only the `{ lens, role, pass, missed }` projection is load-bearing
 * — exactly the reviewer's posture (`reviewer-result.json`). The judge writes
 * this projection to a per-lens result file; the panel reads the file (never
 * the judge's transcript) and validates it against `LensVerdictSchema`.
 *
 * The rubric (`_bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md`
 * §3) defines the five Tier-1 lenses. Lens diversity is non-negotiable: one
 * distinct judging role per lens, because a panel that shares the author's
 * blind spots rubber-stamps (the documented scar that motivates this design).
 *
 * Two hard rules baked into the schema:
 *   - `missed` is required and non-empty (`.min(1)`). A fail with an empty
 *     `missed` is itself malformed — the operator / Quality Lead needs the
 *     specific gap to act. (A pass also carries a `missed` string; it is the
 *     short "nothing missed" note, never empty.)
 *   - `lens` is a closed enum over exactly the five Tier-1 lenses.
 */
import { z } from "zod";
/**
 * The five Tier-1 rubric lenses (rubric §3). Closed set — adding a lens means
 * adding a literal here AND wiring its role binding in `judge-panel.ts`.
 */
export declare const LENS_NAMES: readonly ["structure", "verifiability", "discipline", "domain", "considered"];
export declare const LensNameSchema: z.ZodEnum<{
    considered: "considered";
    discipline: "discipline";
    domain: "domain";
    structure: "structure";
    verifiability: "verifiability";
}>;
export type LensName = z.infer<typeof LensNameSchema>;
/**
 * A single lens judge's machine-checkable verdict — the deterministic seam.
 *
 * - `lens`   — which Tier-1 lens this verdict grades.
 * - `role`   — the judging role that produced it (lens diversity — one distinct
 *              role per lens). Carried on the verdict so the panel can assert
 *              no two lenses shared a judge.
 * - `pass`   — the boolean verdict.
 * - `missed` — the specific gap (non-empty). On a fail this NAMES what the draft
 *              is missing; on a pass it is a short confirmation note. Never empty
 *              — an empty `missed` is a malformed verdict.
 *
 * `.strict()` so an unexpected key (e.g. a leaked prose blob) is rejected at the
 * file boundary, mirroring the telemetry-event posture.
 */
export declare const LensVerdictSchema: z.ZodObject<{
    lens: z.ZodEnum<{
        considered: "considered";
        discipline: "discipline";
        domain: "domain";
        structure: "structure";
        verifiability: "verifiability";
    }>;
    role: z.ZodString;
    pass: z.ZodBoolean;
    missed: z.ZodString;
}, z.core.$strict>;
export type LensVerdict = z.infer<typeof LensVerdictSchema>;
/**
 * The aggregated panel verdict — Tier-0 status plus exactly the five lens
 * verdicts, one per lens, keyed by lens.
 *
 * - `tier0`  — `"pass"` | `"fail"`. The panel may re-assert Tier-0 status
 *              (Story 9.2 enforces it at authoring) but does not re-implement
 *              the checks. Defaults to `"pass"` at the panel call site when the
 *              draft has already cleared Tier 0.
 * - `lenses` — the five `LensVerdict`s. The schema enforces exactly five entries
 *              with no duplicate lens (a missing or doubled lens is the
 *              rubber-stamp failure in disguise).
 *
 * The panel produces this object and writes NOTHING to the readiness flag —
 * that adjudication is Story 9.4's (the Quality Lead's) call.
 */
export declare const PanelVerdictSchema: z.ZodObject<{
    tier0: z.ZodEnum<{
        fail: "fail";
        pass: "pass";
    }>;
    lenses: z.ZodArray<z.ZodObject<{
        lens: z.ZodEnum<{
            considered: "considered";
            discipline: "discipline";
            domain: "domain";
            structure: "structure";
            verifiability: "verifiability";
        }>;
        role: z.ZodString;
        pass: z.ZodBoolean;
        missed: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type PanelVerdict = z.infer<typeof PanelVerdictSchema>;
