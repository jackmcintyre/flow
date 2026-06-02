/**
 * Generated backlog dashboard — Story 9.5 (Epic 9 intake cockpit, read surface).
 *
 * The cockpit's read surface: the outstanding backlog rendered as grouped
 * tables from live state, never a hand-maintained list. It closes the original
 * "build the tables" ask — the grouping tables are *generated from state*.
 *
 * Mirrors the project's standing getter/`render*` split (see `renderStatus` in
 * `get-status.ts`):
 *   - `getBacklogDashboard` is the impure getter — it reads the inventory once
 *     (the only IO) and projects a typed snapshot.
 *   - `renderBacklogDashboard` is a pure function of that snapshot — NO file IO,
 *     NO clock. Calling it twice with the same snapshot yields byte-identical
 *     output. This is what makes the render unit-testable and what keeps the
 *     dashboard honest: it is *output*, never a checked-in file an operator can
 *     drift by hand.
 *
 * Scope (per the story): group-by-epic + state + readiness/claimability over a
 * read of the existing backlog-inventory enumeration. It does NOT mutate
 * anything, does NOT own operator priority/sequencing (items order by natural
 * ref order), and does NOT define the readiness flag (Story 9.1).
 */
import { type BacklogInventoryEntry } from "./read-backlog-inventory.js";
/**
 * One row of the dashboard snapshot — a backlog item with its epic, state, and
 * the two operator-facing booleans the cockpit surfaces.
 */
export interface BacklogDashboardEntry {
    ref: string;
    title: string;
    /** Epic key derived from the ref (`bmad:9.5` → `"9"`); `null` when the ref carries no epic (e.g. a native ULID). */
    epic: string | null;
    state: BacklogInventoryEntry["state"];
    withdrawn: boolean;
    /** Operator readiness flag (Story 9.1). */
    ready: boolean;
    /**
     * Claimable iff the item is a `to-do/` item that is blessed (`ready`),
     * dependency-satisfied, and not withdrawn — exactly the drain's claim
     * eligibility. Distinct from `ready`: a blessed item blocked on an unmet
     * dependency is `ready` but NOT `claimable`.
     */
    claimable: boolean;
}
/**
 * The typed snapshot the pure renderer consumes. Produced by the impure getter;
 * passing the same snapshot to `renderBacklogDashboard` twice is byte-stable.
 */
export interface BacklogDashboardSnapshot {
    entries: BacklogDashboardEntry[];
}
/**
 * Derive the epic key from a story ref. Refs are `<adapter>:<source-id>`; the
 * BMad source-id is `<epic>.<story>` (`bmad:9.5` → epic `"9"`). A ref whose
 * source-id has no `.` (e.g. a native ULID) carries no epic → `null`.
 *
 * Pure — no IO.
 */
export declare function deriveEpic(ref: string): string | null;
/**
 * Impure getter: read the backlog inventory once and project the typed
 * dashboard snapshot. The ONLY IO in this module. Mirrors `getStatus`.
 *
 * @throws {MalformedExecutionManifestError} surfaced verbatim from the inventory reader.
 */
export declare function getBacklogDashboard(opts: {
    targetRepoRoot: string;
}): Promise<BacklogDashboardSnapshot>;
/**
 * Pure renderer: format the snapshot as grouped-by-epic text. NO file IO, NO
 * clock — a pure function of its argument. Same snapshot in → byte-identical
 * text out.
 *
 * Grouping/order: entries are grouped by epic and epics are ordered naturally
 * (numeric epics ascending, then any non-numeric epic keys, then the
 * `(no epic)` bucket last); within an epic, items keep natural ref order. An
 * empty backlog renders a single "nothing here" line, not a crash.
 */
export declare function renderBacklogDashboard(snapshot: BacklogDashboardSnapshot): string;
