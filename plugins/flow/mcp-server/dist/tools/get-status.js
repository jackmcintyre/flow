import * as path from "node:path";
import { StaleWorkspaceConfigError, StandardsDocMalformedError, StandardsDocMissingError, } from "../errors.js";
import { getPluginVersion } from "../lib/plugin-version.js";
import { readCycleState } from "../schemas/cycle-state.js";
import { StatusReportSchema, } from "../schemas/status-report.js";
import { lookupStandards } from "../state/lookup-standards.js";
import { validateActiveAdapter } from "../state/validate-active-adapter.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";
/**
 * Compose `getPluginVersion`, `resolveWorkspace`, `validateActiveAdapter`,
 * and `lookupStandards` into a single typed report describing whether the
 * plugin sees the user's repo (Story 1.7).
 *
 * Algorithm (do not deviate):
 *  1. Read the plugin semver from the manifest.
 *  2. Resolve the workspace. Hard failures (no adapter, ambiguous adapter,
 *     invalid config) propagate; the skill body surfaces them via the
 *     standard MCP error path.
 *  3. Validate the active adapter. Only `StaleWorkspaceConfigError` is
 *     caught and projected into a downgraded `adapter.state = "mismatched"`
 *     report — every other error is a bug and must surface.
 *  4. Lookup standards. `StandardsDocMissingError` → `standards.state =
 *     "missing"`; `StandardsDocMalformedError` → `standards.state =
 *     "malformed"` carrying `zodMessage`. Both are downgrades, not failures.
 *  5. Read the cycle-state file. When a cycle is open, report its ULID;
 *     when absent, report `"none"` (the existing baseline — Story
 *     native:01KT484NY4HCBPBTT6VEY1Q0CS). `StatusReportSchema.cycle` already
 *     accepts a ULID or `"none"`, so no schema change is needed.
 *  6. Validate the assembled report against `StatusReportSchema` before
 *     returning — defends against future field drift.
 *
 * No cache, no telemetry. The only direct IO is the cycle-state read (a single
 * small JSON file); everything else goes through an existing primitive.
 */
export async function getStatus(opts) {
    const pluginVersion = getPluginVersion();
    const workspace = await resolveWorkspace({
        targetRepoRoot: opts.targetRepoRoot,
        adapters: opts.adapters,
    });
    let adapterReport;
    try {
        await validateActiveAdapter(workspace, { adapters: opts.adapters });
        adapterReport = { state: "ok", name: workspace.activeAdapterName };
    }
    catch (err) {
        if (err instanceof StaleWorkspaceConfigError) {
            adapterReport = {
                state: "mismatched",
                name: workspace.activeAdapterName,
                otherMatchingAdapters: err.otherMatchingAdapters,
            };
        }
        else {
            throw err;
        }
    }
    const standardsPath = path.join(workspace.targetRepoRoot, "docs", "standards.md");
    let standardsReport;
    try {
        await lookupStandards(workspace.targetRepoRoot);
        standardsReport = { state: "ok", path: standardsPath };
    }
    catch (err) {
        if (err instanceof StandardsDocMissingError) {
            standardsReport = { state: "missing", path: standardsPath };
        }
        else if (err instanceof StandardsDocMalformedError) {
            standardsReport = {
                state: "malformed",
                path: standardsPath,
                zodMessage: err.zodMessage,
            };
        }
        else {
            throw err;
        }
    }
    // Read the open work cycle, if any. Absence ⇒ "none" (baseline behaviour); a
    // present cycle-state file reports its ULID. A malformed file is a hard stop —
    // it propagates so a corrupt boundary surfaces rather than being hidden.
    const cycleState = await readCycleState(workspace.targetRepoRoot);
    const report = {
        pluginVersion,
        targetRepoRoot: workspace.targetRepoRoot,
        adapter: adapterReport,
        standards: standardsReport,
        cycle: cycleState ? cycleState.cycle_ulid : "none",
    };
    return StatusReportSchema.parse(report);
}
/**
 * Pure formatter — no IO, no clock. Returns the five canonical status
 * lines joined by `\n`, with NO trailing newline. The MCP tool wraps
 * the string in a `{ type: "text", text }` content block.
 */
export function renderStatus(report) {
    return [
        `flow v${report.pluginVersion}`,
        `target repo: ${report.targetRepoRoot}`,
        `adapter: ${report.adapter.name} (${report.adapter.state})`,
        `standards: ${report.standards.state} — ${report.standards.path}`,
        `cycle: ${report.cycle}`,
    ].join("\n");
}
