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
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { TelemetryEventSchema } from "../schemas/telemetry-events.js";
import { isAgreement } from "../lib/agreement.js";
import { AgreementWindowInvalidError } from "../errors.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Default rolling window size (AC1a, Conventions). */
export const DEFAULT_AGREEMENT_WINDOW = 50;
// ---------------------------------------------------------------------------
// Output schema & type
// ---------------------------------------------------------------------------
/**
 * Zod schema for the `computeAgreement` return value (AC1b). `.strict()` at
 * every level so unknown-key injection is rejected (AC4n).
 *
 * Exported for downstream consumers (Story 4.10b) to import and use for
 * round-trip validation.
 */
export const AgreementMetricResultSchema = z
    .object({
    ratio: z.number().min(0).max(1),
    distribution: z
        .object({
        "READY FOR MERGE": z.number().int().nonnegative(),
        "NEEDS CHANGES": z.number().int().nonnegative(),
        BLOCKED: z.number().int().nonnegative(),
    })
        .strict(),
    window_size: z.number().int().nonnegative(),
    sample_size: z.number().int().nonnegative(),
    skipped_unresolved: z.number().int().nonnegative(),
    skipped_excluded: z.number().int().nonnegative(),
    malformed_lines: z.number().int().nonnegative(),
})
    .strict();
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
/**
 * Compute the rolling agreement ratio between reviewer verdicts and the
 * eventual human merge actions.
 *
 * Returns `null` on insufficient data (AC2). Throws `AgreementWindowInvalidError`
 * on an invalid `lastNVerdicts` value (AC2c / AC4i).
 *
 * Story 4.10 · FR67 · NFR24
 */
export async function computeAgreement(opts) {
    const { targetRepoRoot, lastNVerdicts: rawWindow, readTelemetryDirImpl, readFileImpl, } = opts;
    // ------------------------------------------------------------------
    // Step 1: Validate lastNVerdicts (AC2c, AC4i)
    // ------------------------------------------------------------------
    const lastNVerdicts = rawWindow ?? DEFAULT_AGREEMENT_WINDOW;
    if (!Number.isFinite(lastNVerdicts) ||
        !Number.isInteger(lastNVerdicts) ||
        lastNVerdicts <= 0) {
        throw new AgreementWindowInvalidError({
            lastNVerdicts,
            reason: "must be a positive integer",
        });
    }
    // ------------------------------------------------------------------
    // Step 2: List *.jsonl files (AC2a)
    // ------------------------------------------------------------------
    const telemetryDir = path.join(targetRepoRoot, ".flow", "telemetry");
    let jsonlFiles;
    try {
        if (readTelemetryDirImpl) {
            jsonlFiles = await readTelemetryDirImpl(telemetryDir);
        }
        else {
            const entries = await fs.readdir(telemetryDir, { withFileTypes: true });
            jsonlFiles = entries
                .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
                .map((e) => e.name)
                .sort(); // deterministic lex order (AC1f tie-break via file+line)
        }
    }
    catch (err) {
        if (err !== null &&
            typeof err === "object" &&
            err.code === "ENOENT") {
            return null; // directory absent → insufficient data (AC2a)
        }
        throw err;
    }
    if (jsonlFiles.length === 0) {
        return null; // no *.jsonl files → insufficient data (AC2a)
    }
    // ------------------------------------------------------------------
    // Step 3: Parse all lines (AC3 / AC4k)
    // ------------------------------------------------------------------
    const verdicts = [];
    const mergeActions = [];
    let malformed_lines = 0;
    for (const filename of jsonlFiles) {
        const filePath = path.join(telemetryDir, filename);
        const raw = readFileImpl
            ? await readFileImpl(filePath)
            : await fs.readFile(filePath, "utf8");
        for (const rawLine of raw.split("\n")) {
            const line = rawLine.trim();
            if (line === "") {
                // Empty lines (including trailing newline) — skip silently (Conventions)
                continue;
            }
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                malformed_lines++;
                continue;
            }
            const result = TelemetryEventSchema.safeParse(parsed);
            if (!result.success) {
                malformed_lines++;
                continue;
            }
            const event = result.data;
            if (event.type === "reviewer.verdict") {
                verdicts.push(event);
            }
            else if (event.type === "reviewer.verdict.merge_action") {
                mergeActions.push(event);
            }
            // All other types are valid events, silently discarded (not malformed)
        }
    }
    if (verdicts.length === 0) {
        return null; // no reviewer.verdict events → insufficient data (AC2a)
    }
    // ------------------------------------------------------------------
    // Step 4: Build a merge_action index keyed by `${pr_number}::${session_id}`
    // For multiple merge_action events on the same key, keep the latest
    // by `resolved_at` (AC1e / AC3d).
    // ------------------------------------------------------------------
    const mergeActionIndex = new Map();
    for (const ma of mergeActions) {
        const key = `${ma.data.pr_number}::${ma.session_id}`;
        const existing = mergeActionIndex.get(key);
        if (!existing || ma.data.resolved_at > existing.data.resolved_at) {
            mergeActionIndex.set(key, ma);
        }
    }
    // ------------------------------------------------------------------
    // Step 5: Apply exclusion + unresolved logic (AC1g, AC3)
    // ------------------------------------------------------------------
    let skipped_excluded = 0;
    let skipped_unresolved = 0;
    const resolvedPairs = [];
    for (const v of verdicts) {
        // Exclude reviewer-failure verdicts (AC1g)
        if (v.data.verdict === "reviewer-failure") {
            skipped_excluded++;
            continue;
        }
        // Find the latest matching merge_action for this (pr_number, session_id)
        const key = `${v.data.pr_number}::${v.session_id}`;
        const ma = mergeActionIndex.get(key);
        if (!ma || ma.data.merge_action === "still-open") {
            // Unresolved — absent or still-open (AC3a, AC3b)
            skipped_unresolved++;
            continue;
        }
        resolvedPairs.push({
            verdict: v.data.verdict,
            mergeAction: ma.data.merge_action,
            ts: v.ts,
            session_id: v.session_id,
        });
    }
    // ------------------------------------------------------------------
    // Step 6: Sort newest-first by ts, tie-break by session_id ascending (AC1f)
    // ------------------------------------------------------------------
    resolvedPairs.sort((a, b) => {
        if (b.ts !== a.ts) {
            return b.ts < a.ts ? -1 : 1; // descending ts
        }
        // Tie-break: session_id ascending
        return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
    });
    // ------------------------------------------------------------------
    // Step 7: Take the first lastNVerdicts (skip-then-take per AC3c)
    // ------------------------------------------------------------------
    if (resolvedPairs.length < lastNVerdicts) {
        return null; // insufficient resolved pairs (AC2a / AC2d)
    }
    const window = resolvedPairs.slice(0, lastNVerdicts);
    // ------------------------------------------------------------------
    // Step 8: Walk the window — compute ratio + distribution (AC1h, AC1i)
    // ------------------------------------------------------------------
    let agreementCount = 0;
    const distribution = {
        "READY FOR MERGE": 0,
        "NEEDS CHANGES": 0,
        BLOCKED: 0,
    };
    for (const pair of window) {
        distribution[pair.verdict]++;
        if (isAgreement(pair.verdict, pair.mergeAction)) {
            agreementCount++;
        }
    }
    // ------------------------------------------------------------------
    // Step 9: Assemble result (AC1b, AC1i, AC1j)
    // ------------------------------------------------------------------
    return {
        ratio: agreementCount / lastNVerdicts,
        distribution,
        window_size: lastNVerdicts,
        sample_size: lastNVerdicts,
        skipped_unresolved,
        skipped_excluded,
        malformed_lines,
    };
}
