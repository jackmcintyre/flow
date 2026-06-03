import { AmbiguousAdapterError, NoAdapterMatchedError, UnknownAdapterError, } from "../errors.js";
import { BmadAdapter } from "./bmad/index.js";
import { NativeAdapter } from "./native/index.js";
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
export const adapters = [BmadAdapter, NativeAdapter];
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
export async function getActiveAdapter(opts) {
    const registry = opts.adapters ?? adapters;
    // Branch A — caller provided a configured adapter name
    if (opts.configuredAdapterName !== undefined) {
        const found = registry.find((a) => a.name === opts.configuredAdapterName);
        if (found)
            return found;
        throw new UnknownAdapterError({
            configuredAdapterName: opts.configuredAdapterName,
            registeredAdapterNames: registry.map((a) => a.name),
            configPath: `${opts.targetRepoRoot}/.flow/config.yaml`,
        });
    }
    // Branch B — no config; run detect() on all adapters in parallel,
    // preserve registration order in the results array.
    const detectResults = await Promise.all(registry.map((adapter) => adapter.detect(opts.targetRepoRoot)));
    const matches = registry.filter((_, i) => detectResults[i]);
    if (matches.length === 0) {
        throw new NoAdapterMatchedError({
            targetRepoRoot: opts.targetRepoRoot,
            registeredAdapters: registry.map((a) => a.name),
        });
    }
    if (matches.length >= 2) {
        throw new AmbiguousAdapterError({
            targetRepoRoot: opts.targetRepoRoot,
            matchingAdapters: matches.map((a) => a.name),
        });
    }
    return matches[0];
}
