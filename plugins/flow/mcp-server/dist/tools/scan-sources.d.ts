/**
 * Result returned by `scanSources`. All five ref arrays are disjoint.
 *
 * - `createdRefs`: manifests that did not exist before this scan (AC1 path).
 * - `updatedRefs`: manifests still in `to-do/` whose `source_hash` was
 *   refreshed because the source story changed (AC3 path).
 * - `unchangedRefs`: manifests in `to-do/` with a matching hash — no write
 *   performed (AC2 idempotent path).
 * - `skippedRefs`: refs the adapter listed but the tool deliberately did NOT
 *   touch. `reason: "not-in-to-do"` means the manifest already exists in
 *   another state dir (in-progress, blocked, done) — the dev loop owns it
 *   there, or a prior scan already blocked it. `reason: "discipline-violation"`
 *   means this scan just created a new blocked manifest for the first time.
 * - `blockedRefs`: refs that failed discipline in THIS scan and had a manifest
 *   written to `blocked/` for the first time (Story 3.5 Task 6.3). Overlaps
 *   with `skippedRefs[reason: "discipline-violation"]` by design — `skippedRefs`
 *   is the legacy seam, `blockedRefs` is the new operator-facing surface. On
 *   the second scan after a story is blocked, it appears in skippedRefs with
 *   `reason: "not-in-to-do"` (blocked manifests are owned state, not touched).
 */
export interface ScanResult {
    targetRepoRoot: string;
    adapterName: string;
    createdRefs: string[];
    updatedRefs: string[];
    unchangedRefs: string[];
    skippedRefs: Array<{
        ref: string;
        reason: "not-in-to-do" | "discipline-violation" | "unreadable-manifest";
        detail?: string;
    }>;
    /** Story 3.5: refs that failed planning-discipline and were written to blocked/. */
    blockedRefs: string[];
    /**
     * Story 5.13: refs blocked because prose dep declarations and the manifest's
     * `depends_on` set are not equal (symmetric difference is non-empty).
     * Each entry carries the symmetric-difference detail for the rendered output.
     */
    depsDriftRefs: Array<{
        ref: string;
        proseRefs: string[];
        manifestRefs: string[];
    }>;
}
/**
 * Render a `ScanResult` as a human-readable text summary.
 * The tool returns this string verbatim; the `/flow:scan` skill
 * prints it without paraphrase or omission.
 */
export declare function renderScanResult(result: ScanResult): string;
/**
 * Project the active adapter's source stories into per-story execution
 * manifests under `<targetRepoRoot>/.flow/state/to-do/<ref>.yaml`.
 *
 * **Idempotency (AC2 / NFR10):** On a re-scan with no source changes, this
 * function writes nothing. "Not rewritten" is load-bearing: the dev loop's
 * polling semantics detect work by mtime changes. Re-writing byte-identical
 * content would produce spurious mtime updates and corrupt the polling.
 *
 * **Hash-refresh (AC3):** If a source story's hash changed AND its manifest
 * is still in `to-do/`, the manifest is rewritten with the new hash and
 * updated `source_path`. All other fields (including any operator hand-edits
 * to `narrative`, `acceptance_criteria`, or `withdrawn`) are preserved.
 *
 * **Claim isolation (AC3 negative):** Manifests in `in-progress/`, `blocked/`,
 * or `done/` are NEVER touched. They are owned by the dev loop / orchestrator.
 * `scan-sources` only ever writes into `to-do/`.
 *
 * **Concurrency:** v1 assumes at most one `scan-sources` invocation per
 * target repo at a time. The MCP server is single-process; concurrent
 * invocations are out of scope. Do NOT add a lock here — see Story 4.x's
 * claim flow for the locking design.
 *
 * **`validateAgainstDiscipline` seam:** The call at step 3 is a documented
 * seam for Story 3.5. In v1, every adapter's implementation is pass-through
 * (returns the input story unchanged). Story 3.5 will make some adapters
 * return a `DisciplineViolation` — at that point the `skippedRefs` path
 * with `reason: "discipline-violation"` will light up without any change to
 * this file.
 */
export declare function scanSources(opts: {
    targetRepoRoot: string;
    /**
     * Plugin root override — test seam for the author-time risk classifier's
     * spec lookup (Story 10.4). Defaults to the resolved plugin root.
     */
    pluginRootOverride?: string;
}): Promise<ScanResult>;
