/**
 * `readBacklogInventory` MCP tool — Story 3.6 HIGH-1 fix.
 *
 * Builds the backlog inventory server-side so the `/crew:plan` skill does
 * not need to enumerate `.yaml` files itself via the `Read` tool (which
 * requires known paths and cannot glob). The skill declares
 * `allowed_tools: [Task, readBacklogInventory]` and delegates enumeration
 * to this tool.
 *
 * Returns the typed `BacklogInventory` JSON the planner skill prose
 * consumes, including:
 *   - `mode`: `"first-run"` | `"re-open"`
 *   - `backlog_inventory`: array of `{ ref, title, state, withdrawn }`
 *
 * `MalformedExecutionManifestError` (and any other `parseExecutionManifest`
 * typed errors) are surfaced verbatim — this resolves MEDIUM-1 as well.
 *
 * Architecture reference: Story 3.6 reviewer HIGH-1.
 */
import { z } from "zod";
import { type StateName } from "../state/manifest-state-machine.js";
export declare const ReadBacklogInventoryInputSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    ref: z.ZodOptional<z.ZodString>;
    includeSpecText: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
/** State values for backlog inventory entries. Extends StateName with the native-source-only sentinel. */
export type InventoryState = StateName | "native-source-only";
/** A single entry in the backlog inventory. */
export interface BacklogInventoryEntry {
    ref: string;
    title: string;
    state: InventoryState;
    withdrawn: boolean;
    /**
     * Operator readiness flag (Story 9.1), projected verbatim from the parsed
     * manifest. Additive: `native-source-only` entries (no manifest yet) read as
     * `false`, matching the schema default for an unblessed item. The dashboard
     * (Story 9.5) surfaces this so the operator sees what is blessed at a glance.
     */
    ready: boolean;
    /**
     * True iff every `depends_on` ref is present in `<root>/.crew/state/done/`
     * (Story 9.5). Computed by the same stat-based check `listClaimableTodos`
     * uses. An item with no dependencies is trivially deps-ready. Carried so a
     * reader can distinguish a blessed-but-blocked item (ready, deps NOT ready)
     * from a claimable one. `native-source-only` entries read as deps-ready
     * (they carry no `depends_on` until scanned).
     */
    depsReady: boolean;
    /**
     * The draft's full source markdown. Present ONLY when the caller passes
     * `includeSpecText: true`; otherwise `undefined`. Read from the manifest's
     * `source_path` for in-manifest entries, or the native-stories file content
     * for `native-source-only` entries. The gate-1 judge workflow needs this so
     * the lens judges grade the real draft rather than an empty spec.
     */
    specText?: string;
    /**
     * The manifest's persisted `risk_tier` (Story 10.4 single source of truth).
     * Present ONLY when `includeSpecText: true` and the manifest carries one;
     * `undefined` for `native-source-only` entries (no manifest) and legacy
     * manifests authored before the field existed. The gate-1 workflow feeds this
     * to the Considered lens so it grades at the persisted tier.
     */
    riskTier?: "low" | "medium" | "high";
}
/** Output shape returned by `readBacklogInventory`. */
export interface ReadBacklogInventoryOutput {
    /** `"first-run"` when the inventory is empty; `"re-open"` when at least one entry exists. */
    mode: "first-run" | "re-open";
    backlog_inventory: BacklogInventoryEntry[];
}
/**
 * Build the backlog inventory for the target repo.
 *
 * - Scans all four state directories (`to-do`, `in-progress`, `blocked`, `done`)
 *   for `.yaml` manifest files. Each is parsed via `parseExecutionManifest`
 *   (typed errors surface verbatim — not caught here).
 * - On the native-adapter branch only: also scans `.crew/native-stories/` for
 *   ULID-pattern `.md` files whose `native:<ULID>` ref does not already appear
 *   in the manifest inventory. Those entries get `state: "native-source-only"`,
 *   `withdrawn: false`, and `title` from the file's first H1.
 * - Derives `mode`: `"re-open"` if at least one entry exists, else `"first-run"`.
 *
 * @throws {MalformedExecutionManifestError} if any manifest fails schema validation.
 */
export declare function readBacklogInventory(rawInput: unknown): Promise<ReadBacklogInventoryOutput>;
