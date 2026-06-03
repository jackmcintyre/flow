/**
 * Map a BMad status string to the plugin's execution-state vocabulary.
 * `optional` returns `null` to signal "skip this story".
 */
export function mapBmadStatusToExecution(status) {
    switch (status) {
        case "backlog":
            return "to-do";
        case "ready-for-dev":
            return "to-do";
        case "in-progress":
            return "in-progress";
        case "done":
            return "done";
        case "optional":
            return null;
        case "contexted":
            return "to-do";
        case "draft":
            return "to-do";
        case "approved":
            return "to-do";
        case "review":
            return "in-progress";
    }
}
/**
 * AC3: detect a BMad-vs-manifest discrepancy. The matrix is documented
 * in Story 3.3 Task 4.3.
 *
 * Inputs are the raw BMad source-status string (e.g. `"done"`) and the
 * manifest's recorded execution state (e.g. `"in-progress"`). Returns
 * an `agree` outcome when there's no meaningful conflict, otherwise a
 * `discrepancy` carrying both sides plus a severity.
 */
export function reconcileStatus(sourceStatus, manifestStatus) {
    // Pairs the matrix calls out explicitly.
    const key = `${sourceStatus}|${manifestStatus}`;
    switch (key) {
        case "done|to-do":
            return { kind: "discrepancy", source: sourceStatus, manifest: manifestStatus, severity: "warn" };
        case "done|in-progress":
            return { kind: "discrepancy", source: sourceStatus, manifest: manifestStatus, severity: "block" };
        case "done|done":
            return { kind: "agree" };
        case "done|blocked":
            return { kind: "discrepancy", source: sourceStatus, manifest: manifestStatus, severity: "block" };
        case "in-progress|to-do":
            return { kind: "discrepancy", source: sourceStatus, manifest: manifestStatus, severity: "info" };
        case "in-progress|done":
            return { kind: "discrepancy", source: sourceStatus, manifest: manifestStatus, severity: "warn" };
    }
    // Default: if mapping the source onto an execution state yields the
    // same value as the manifest, we agree; otherwise it's an info-level
    // discrepancy. Unknown source statuses fall through to `agree` here
    // because the parser would have rejected them upstream — by the time
    // reconcileStatus runs we trust the input.
    let mapped = null;
    if (isKnownBmadStatus(sourceStatus)) {
        mapped = mapBmadStatusToExecution(sourceStatus);
    }
    if (mapped === null)
        return { kind: "agree" };
    if (mapped === manifestStatus)
        return { kind: "agree" };
    return { kind: "discrepancy", source: sourceStatus, manifest: manifestStatus, severity: "info" };
}
function isKnownBmadStatus(s) {
    return (s === "backlog" ||
        s === "ready-for-dev" ||
        s === "in-progress" ||
        s === "done" ||
        s === "optional" ||
        s === "contexted" ||
        s === "draft" ||
        s === "approved" ||
        s === "review");
}
