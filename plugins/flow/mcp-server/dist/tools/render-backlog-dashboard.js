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
import { readBacklogInventory, } from "./read-backlog-inventory.js";
import { shortHandle } from "../lib/short-handle.js";
/**
 * Derive the epic key from a story ref. Refs are `<adapter>:<source-id>`; the
 * BMad source-id is `<epic>.<story>` (`bmad:9.5` → epic `"9"`). A ref whose
 * source-id has no `.` (e.g. a native ULID) carries no epic → `null`.
 *
 * Pure — no IO.
 */
export function deriveEpic(ref) {
    const colon = ref.indexOf(":");
    const sourceId = colon === -1 ? ref : ref.slice(colon + 1);
    const dot = sourceId.indexOf(".");
    if (dot === -1)
        return null;
    return sourceId.slice(0, dot);
}
/**
 * Compute claimability from an inventory entry: claimable iff it is a `to-do/`
 * item that is blessed (`ready`), dependency-satisfied (`depsReady`), and not
 * withdrawn. This mirrors the drain's claim eligibility (deps-ready AND ready,
 * an un-withdrawn to-do item). Pure.
 */
function isClaimableEntry(entry) {
    return (entry.state === "to-do" &&
        entry.ready === true &&
        entry.depsReady === true &&
        entry.withdrawn === false);
}
/**
 * Impure getter: read the backlog inventory once and project the typed
 * dashboard snapshot. The ONLY IO in this module. Mirrors `getStatus`.
 *
 * @throws {MalformedExecutionManifestError} surfaced verbatim from the inventory reader.
 */
export async function getBacklogDashboard(opts) {
    const { backlog_inventory } = await readBacklogInventory({
        targetRepoRoot: opts.targetRepoRoot,
    });
    const entries = backlog_inventory.map((e) => ({
        ref: e.ref,
        title: e.title,
        epic: deriveEpic(e.ref),
        state: e.state,
        withdrawn: e.withdrawn,
        ready: e.ready,
        claimable: isClaimableEntry(e),
    }));
    return { entries };
}
/** Sentinel epic heading for entries whose ref carries no epic. */
const NO_EPIC_HEADING = "(no epic)";
/** Render one item row. Pure. */
function renderRow(entry) {
    const readiness = entry.ready ? "ready" : "not ready";
    const claim = entry.claimable ? "claimable" : "not claimable";
    const withdrawn = entry.withdrawn ? " [withdrawn]" : "";
    const handle = shortHandle(entry.ref);
    return `  - [${handle}] ${entry.ref} — ${entry.title} [${entry.state}] (${readiness}, ${claim})${withdrawn}`;
}
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
export function renderBacklogDashboard(snapshot) {
    const lines = ["Backlog dashboard"];
    if (snapshot.entries.length === 0) {
        lines.push("  (backlog is empty — nothing here)");
        return lines.join("\n");
    }
    // Group by epic (null epic → the (no epic) bucket).
    const byEpic = new Map();
    for (const entry of snapshot.entries) {
        const key = entry.epic;
        const bucket = byEpic.get(key);
        if (bucket) {
            bucket.push(entry);
        }
        else {
            byEpic.set(key, [entry]);
        }
    }
    // Order epics: numeric ascending, then non-numeric (string-sorted), then the
    // null bucket last. Deterministic — no clock, no Map insertion-order reliance.
    const epicKeys = [...byEpic.keys()];
    epicKeys.sort((a, b) => {
        if (a === b)
            return 0;
        if (a === null)
            return 1; // null sinks to the end
        if (b === null)
            return -1;
        const na = Number(a);
        const nb = Number(b);
        const aNum = !Number.isNaN(na);
        const bNum = !Number.isNaN(nb);
        if (aNum && bNum)
            return na - nb;
        if (aNum)
            return -1; // numeric epics before non-numeric
        if (bNum)
            return 1;
        return a < b ? -1 : 1;
    });
    for (const key of epicKeys) {
        const heading = key === null ? NO_EPIC_HEADING : `Epic ${key}`;
        lines.push(heading);
        // Within an epic, keep natural ref order (stable inventory order, then ref).
        const rows = byEpic.get(key).slice().sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
        for (const row of rows) {
            lines.push(renderRow(row));
        }
    }
    return lines.join("\n");
}
