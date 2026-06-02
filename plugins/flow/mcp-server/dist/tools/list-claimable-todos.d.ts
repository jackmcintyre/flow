/**
 * `listClaimableTodos` MCP tool — Story 4.2 Task 3.
 *
 * Enumerates `.flow/state/to-do/<ref>.yaml` files, parses each via
 * `parseExecutionManifest`, filters by `isClaimable`, and emits a sorted
 * (alphabetical ref order) projection used by the `/flow:start` skill.
 *
 * The return shape also includes `inProgressCount` so the skill can decide
 * the queue-drained condition without a separate filesystem call.
 *
 * Per-candidate `depsReady` is computed by statting
 * `<targetRepoRoot>/.flow/state/done/<dep>.yaml` for each dep in
 * `depends_on`. If all present, `depsReady: true`.
 *
 * No write side-effects. Propagates `MalformedExecutionManifestError` verbatim.
 *
 * Architecture §MCP Tool Naming — camelCase verb-noun: `listClaimableTodos`.
 * Story 4.2 Task 3.1–3.5.
 */
export interface ClaimableCandidate {
    /** Story ref, e.g. `"native:01HZ..."` or `"bmad:1.1"`. */
    ref: string;
    /**
     * Short human-friendly display handle derived from the ref.
     * For a `native:<ULID>` ref this is the first 8 characters of the ULID.
     * For any other ref (e.g. `bmad:8.18`) this is the local part after the
     * first `:`. Always non-empty. Use this on operator-facing surfaces instead
     * of the full ref.
     */
    shortHandle: string;
    /** Human-readable title from the manifest. */
    title: string;
    /** Dependency refs from the manifest. */
    depends_on: readonly string[];
    /**
     * True iff all `depends_on` refs are present in `<targetRepoRoot>/.flow/state/done/`.
     * False if any dep is missing. The `/flow:start` skill claims only refs where
     * `depsReady: true` on a given pass.
     */
    depsReady: boolean;
    /**
     * Operator readiness flag carried through verbatim from the parsed manifest
     * (Story 9.1). The claim entry point (`claimNextStory`) requires BOTH
     * `depsReady` AND `ready` before a candidate is eligible — a candidate that
     * is deps-ready but not operator-blessed is listed here (so the intake
     * cockpit can show it) but is never claimed.
     */
    ready: boolean;
}
export interface ListClaimableTodosResult {
    todos: ClaimableCandidate[];
    /** Count of `.yaml` files currently in `<targetRepoRoot>/.flow/state/in-progress/`. */
    inProgressCount: number;
}
export interface ListClaimableTodosOptions {
    targetRepoRoot: string;
}
/**
 * List all claimable candidates from `<targetRepoRoot>/.flow/state/to-do/`
 * in stable alphabetical ref order, along with the count of in-progress manifests.
 *
 * @throws {MalformedExecutionManifestError} When any manifest fails schema validation.
 */
export declare function listClaimableTodos(opts: ListClaimableTodosOptions): Promise<ListClaimableTodosResult>;
