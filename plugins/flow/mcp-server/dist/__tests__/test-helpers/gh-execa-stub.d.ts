/**
 * Shared `gh` execa stub factory for integration tests.
 *
 * Extracted from `run-reviewer-session.test.ts` (Story 4.6 Issue 2).
 * Extended in Story 4.6b to support `gh repo view --json owner,name`
 * and `gh api` routing.
 * Extended in Story 4.7 to support discriminated `gh api GET` and
 * `gh api PATCH` routing by URL pattern and method (Task 5.2).
 * Updated in Story 5.15 to replace `gh pr view --json baseRepository` with
 * `gh repo view --json owner,name` (flat shape).
 *
 * Story 4.6b Task 8.2; Story 4.7 Task 5.2; Story 5.15
 */
export interface GhStubResult {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    timedOut?: boolean;
}
/**
 * A discriminating handler for a specific `gh api` call.
 * Matched when `args[1]` equals the given method and `args[0]` matches
 * the given URL (exact string or RegExp).
 */
export interface GhApiRoute {
    /** URL to match (args[0]). String for exact match, RegExp for pattern. */
    url: string | RegExp;
    /** HTTP method to match (args[1], e.g. "GET", "POST", "PATCH"). */
    method: string;
    /** The response to return when this route matches. */
    response: GhStubResult;
    /** Optional capture callback — receives input and args when matched. */
    onCall?: (input: string | undefined, args: string[]) => void;
}
export interface GhExecaStubOpts {
    /** Override for `gh pr diff <prNumber>` calls. Default: empty diff, exitCode 0. */
    prDiff?: GhStubResult;
    /** Override for `gh repo view --json owner,name` calls. Default: crew repo JSON, exitCode 0. */
    repoView?: GhStubResult;
    /**
     * Discriminating routes for `gh api` calls, matched in order.
     * The first matching route wins. If no route matches, falls back to `api`.
     */
    apiRoutes?: GhApiRoute[];
    /** Fallback for `gh api ...` calls not matched by any apiRoute. Default: { id: 12345 }, exitCode 0. */
    api?: GhStubResult;
    /** Override for `pnpm vitest ...` calls. Default: exitCode 0. */
    vitest?: GhStubResult;
    /**
     * Capture callback for `gh api` calls — receives the `input` option
     * so tests can JSON-parse and assert the request body shape.
     * Called for every api call not matched by an apiRoute with its own onCall.
     */
    onApiCall?: (input: string | undefined, args: string[]) => void;
}
/**
 * Build a discriminating `execaImpl` stub for integration tests that need
 * to mock `gh` calls (pr diff, repo view, api) and optionally `pnpm vitest`.
 *
 * Routes by `cmd` and `args[0..1]`:
 *   - `cmd === "gh" && args[0] === "pr" && args[1] === "diff"` → prDiff response
 *   - `cmd === "gh" && args[0] === "repo" && args[1] === "view"` → repoView response
 *   - `cmd === "gh" && args[0] === "api"`:
 *     - Checks `apiRoutes` in order (matching by args[1]=url and args[2]=method)
 *     - Falls back to `api` response (+ fires onApiCall)
 *   - `cmd === "pnpm"` → vitest response
 */
export declare function makeGhExecaStub(opts?: GhExecaStubOpts): typeof import("execa").execa;
