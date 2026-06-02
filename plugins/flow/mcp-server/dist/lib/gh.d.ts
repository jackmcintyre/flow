import { execa as defaultExeca } from "execa";
import type { RolePermissions } from "../schemas/role-permissions.js";
export interface GhCallResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/**
 * Single entrypoint for `gh` invocations from the MCP server (NFR17 /
 * NFR12 / NFR16). Enforces the calling role's `gh_allow` before
 * spawning any subprocess.
 *
 * Subcommand normalisation: `subcommand` is authored kebab-cased in
 * the role spec (so it stays a valid YAML identifier and matches the
 * `gh` CLI's actual segment shape). The wrapper splits on `-` before
 * invoking `gh`, so `pr-view` becomes `["pr", "view"]` in the spawned
 * command, matching `gh pr view`.
 *
 * `gh_allow_args` is reserved for forward-compat with Story 2.x /
 * Epic 3 (placeholder substitution). The v1 matching rule is exact
 * string match — no template substitution. Shipped v1 specs leave
 * `gh_allow_args` empty.
 *
 * This wrapper classifies recoverable errors via `gh-error-map.yaml` (NFR18 /
 * Story 4.5). On a mapped failure it raises `GhRecoverableError`. On an unmapped
 * non-zero exit it returns the raw result (callers like `runDevTerminalAction`
 * inspect `exitCode` and raise their own typed errors). Does NOT retry, does
 * NOT handle auth (we inherit the user's `gh` auth), does NOT write telemetry.
 * Single-purpose.
 *
 * The `execaImpl` option is a test seam — production callers do not
 * pass it. Tests inject a `vi.fn()` to verify zero-spawn behaviour
 * on negative paths and to stub success on positive paths.
 *
 * The `pluginRootOverride` option is a test seam for `loadGhErrorMap` —
 * production callers do not pass it. Tests inject a path pointing to a
 * fixture `gh-error-map.yaml`.
 */
export declare function gh(opts: {
    role: string;
    permissions: RolePermissions;
    subcommand: string;
    args?: readonly string[];
    execaImpl?: typeof defaultExeca;
    pluginRootOverride?: string;
    /** Optional stdin body piped to the subprocess. Supported by execa natively. */
    input?: string;
    /**
     * Optional working directory for the spawned `gh` process. `gh` resolves the
     * target GitHub repo from its cwd; when the dev operates in an isolated
     * worktree (Story 8.16) the caller passes the worktree path so `gh pr create`
     * targets the intended repo rather than the orchestrating checkout. Omitted →
     * `gh` inherits the parent process cwd (the prior behaviour).
     */
    cwd?: string;
}): Promise<GhCallResult>;
