/**
 * `computeAgreement` MCP tool — Story 4.10.
 *
 * Reads every `*.jsonl` file under `<targetRepoRoot>/.flow/telemetry/`, parses
 * lines via `TelemetryEventSchema`, keeps only `reviewer.verdict` and
 * `reviewer.verdict.merge_action` events, joins them by `(pr_number, session_id)`,
 * applies the exclusion rules (reviewer-failure, still-open / absent), sorts the
 * resolved pairs newest-first by the verdict event's `ts`, takes the first
 * `lastNVerdicts` (default 50), and returns:
 *
 *   `{ ratio, distribution, window_size, sample_size,
 *      skipped_unresolved, skipped_excluded, malformed_lines }  | null`
 *
 * Returns `null` when resolved-pair count is strictly less than `lastNVerdicts`
 * (insufficient data).
 *
 * Join key (Story 4.12 `record-pr-close-action.ts` JSDoc): `(pr_number, session_id)`.
 * Agreement truth table: see `lib/agreement.ts` (FR67, NFR24).
 *
 * Story 4.10 · FR67 · NFR24
 */
import { z } from "zod";
/** Default rolling window size (AC1a, Conventions). */
export declare const DEFAULT_AGREEMENT_WINDOW = 50;
/**
 * Zod schema for the `computeAgreement` return value (AC1b). `.strict()` at
 * every level so unknown-key injection is rejected (AC4n).
 *
 * Exported for downstream consumers (Story 4.10b) to import and use for
 * round-trip validation.
 */
export declare const AgreementMetricResultSchema: z.ZodObject<{
    ratio: z.ZodNumber;
    distribution: z.ZodObject<{
        "READY FOR MERGE": z.ZodNumber;
        "NEEDS CHANGES": z.ZodNumber;
        BLOCKED: z.ZodNumber;
    }, z.core.$strict>;
    window_size: z.ZodNumber;
    sample_size: z.ZodNumber;
    skipped_unresolved: z.ZodNumber;
    skipped_excluded: z.ZodNumber;
    malformed_lines: z.ZodNumber;
}, z.core.$strict>;
export type AgreementMetricResult = z.infer<typeof AgreementMetricResultSchema>;
export interface ComputeAgreementOptions {
    targetRepoRoot: string;
    lastNVerdicts?: number;
    /**
     * Test seam: inject a fake directory reader.
     * Returns the sorted list of `.jsonl` filenames in the telemetry dir.
     * Production callers do not pass this.
     */
    readTelemetryDirImpl?: (dirPath: string) => Promise<string[]>;
    /**
     * Test seam: inject a fake file reader.
     * Production callers do not pass this.
     */
    readFileImpl?: (filePath: string) => Promise<string>;
}
/**
 * Compute the rolling agreement ratio between reviewer verdicts and the
 * eventual human merge actions.
 *
 * Returns `null` on insufficient data (AC2). Throws `AgreementWindowInvalidError`
 * on an invalid `lastNVerdicts` value (AC2c / AC4i).
 *
 * Story 4.10 · FR67 · NFR24
 */
export declare function computeAgreement(opts: ComputeAgreementOptions): Promise<AgreementMetricResult | null>;
