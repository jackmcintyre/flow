import type { PlanningAdapter } from "./adapter.js";
/**
 * Registered planning adapters, in declaration order. The workspace
 * resolver (Story 1.2) iterates this list for first-run `detect()`.
 * Story 3.1 implements `getActiveAdapter()` on top.
 *
 * Registration order is load-bearing: `getActiveAdapter()` in Branch B
 * (no-config detect path) reports ambiguity in registration order and
 * returns the sole match when exactly one adapter's `detect()` is true.
 * Story 3.4 appends `NativeAdapter` after `BmadAdapter`. Registration
 * order is load-bearing — `AmbiguousAdapterError.matchingAdapters` reports
 * in registration order (Story 3.4 § Architecture compliance).
 */
export declare const adapters: PlanningAdapter[];
export interface GetActiveAdapterOptions {
    targetRepoRoot: string;
    /**
     * Pre-resolved value of `adapter:` from `.flow/config.yaml`, if any.
     * When provided the registry skips `detect()` entirely and returns the
     * matching adapter by name (Branch A). When absent the registry runs
     * `detect()` on every registered adapter (Branch B).
     */
    configuredAdapterName?: string;
    /**
     * Override the registry list. Test seam; defaults to the live
     * `adapters` array. Providing an explicit list here does NOT mutate
     * the module-level `adapters` export.
     */
    adapters?: PlanningAdapter[];
}
/**
 * Resolve the active planning adapter for the current repo.
 *
 * **Branch A — `configuredAdapterName` is provided:**
 * Finds the adapter in the registry whose `name` matches. Returns it
 * if found. Throws {@link UnknownAdapterError} if no adapter has that
 * name. `detect()` is NOT consulted in this branch — the caller already
 * committed to a name.
 *
 * **Branch B — `configuredAdapterName` is absent:**
 * Runs `detect(targetRepoRoot)` on every registered adapter. Collects
 * results, then: zero matches → throws {@link NoAdapterMatchedError};
 * one match → returns it; ≥2 matches → throws
 * {@link AmbiguousAdapterError}.
 *
 * **No-short-circuit rule (Branch B):**
 * All registered adapters' `detect()` calls are issued (via
 * `Promise.all`) before evaluating the result. This is intentional:
 * ambiguity can only be detected by consulting every adapter. The "first
 * match wins" phrasing in AC3 is preserved by the
 * "ambiguity-throws-instead" semantics — when exactly one adapter
 * matches it is trivially the "first (and only)" match. Do NOT add a
 * short-circuit here; doing so would hide ambiguity bugs silently.
 *
 * **Detect parallelism:**
 * `Promise.all` is used so detect calls run concurrently. The
 * `matches` array is reconstructed in registration index order before
 * evaluating the result, so the `AmbiguousAdapterError.matchingAdapters`
 * list respects registration order regardless of resolution timing.
 *
 * **Caller guidance:**
 * Most callers should use `resolveWorkspace()` (Story 1.2), which parses
 * `.flow/config.yaml` and returns a fully-populated `Workspace`. Use
 * `getActiveAdapter()` directly only when the caller has already resolved
 * the configured adapter name (or wants the no-config detect-only path)
 * and just needs the adapter instance.
 *
 * @throws {UnknownAdapterError} Branch A: configured name not found.
 * @throws {NoAdapterMatchedError} Branch B: zero detect matches.
 * @throws {AmbiguousAdapterError} Branch B: two or more detect matches.
 */
export declare function getActiveAdapter(opts: GetActiveAdapterOptions): Promise<PlanningAdapter>;
