/**
 * BMad lifecycle vocabulary and its mapping to the plugin's execution
 * state. See `plugins/flow/docs/spikes/bmad-format.md`.
 */
export type BmadStatus = "backlog" | "ready-for-dev" | "in-progress" | "done" | "optional" | "contexted" | "draft" | "approved" | "review";
export type ExecutionState = "to-do" | "in-progress" | "blocked" | "done";
/**
 * Map a BMad status string to the plugin's execution-state vocabulary.
 * `optional` returns `null` to signal "skip this story".
 */
export declare function mapBmadStatusToExecution(status: BmadStatus): ExecutionState | null;
/**
 * Outcome of reconciling a BMad source status with the execution
 * manifest's recorded state. The adapter computes the outcome; the
 * calling skill (Story 3.2's `scan-sources`) surfaces it.
 */
export type ReconciliationOutcome = {
    kind: "agree";
} | {
    kind: "discrepancy";
    source: string;
    manifest: string;
    severity: "info" | "warn" | "block";
};
/**
 * AC3: detect a BMad-vs-manifest discrepancy. The matrix is documented
 * in Story 3.3 Task 4.3.
 *
 * Inputs are the raw BMad source-status string (e.g. `"done"`) and the
 * manifest's recorded execution state (e.g. `"in-progress"`). Returns
 * an `agree` outcome when there's no meaningful conflict, otherwise a
 * `discrepancy` carrying both sides plus a severity.
 */
export declare function reconcileStatus(sourceStatus: string, manifestStatus: string): ReconciliationOutcome;
