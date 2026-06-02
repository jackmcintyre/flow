import type { PlanningAdapter } from "../adapters/adapter.js";
import { type PluginSettings } from "../schemas/workspace-config.js";
/**
 * Result of resolving a target repo's workspace configuration. The MCP
 * tool layer (Story 1.4+) and `/status` skill (Story 1.7) consume this.
 */
export interface Workspace {
    /** Absolute path to the target repo root. */
    targetRepoRoot: string;
    /** Mirrors `adapter` from `.flow/config.yaml`. */
    activeAdapterName: string;
    /**
     * The registered `PlanningAdapter` instance for `activeAdapterName`.
     * The adapter's per-invocation context (e.g. BMad's `(targetRepo, storiesRoot)` binding)
     * has already been applied; callers may invoke adapter methods immediately without
     * calling any `configure` helper.
     */
    activeAdapter: PlanningAdapter;
    /** Validated by the adapter's own schema. Opaque to the caller. */
    adapterConfig: unknown;
    /** Plugin-level settings with documented defaults applied. */
    pluginSettings: PluginSettings;
}
export interface ResolveWorkspaceOptions {
    targetRepoRoot: string;
    /** Override registered adapters. Test seam; defaults to the live registry. */
    adapters?: PlanningAdapter[];
}
/**
 * Resolve `<targetRepoRoot>/.flow/config.yaml` into a typed
 * `Workspace`. Auto-detects on first use; surfaces typed errors for
 * missing-adapter, ambiguous-adapter, and invalid-config cases.
 *
 * Pure function — no module-level caching, no global state mutation
 * beyond the single config-write on first-run unambiguous detect.
 */
export declare function resolveWorkspace(opts: ResolveWorkspaceOptions): Promise<Workspace>;
