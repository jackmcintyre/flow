import { execa as defaultExeca } from "execa";
import { GhSubcommandDeniedError, GhRecoverableError } from "../errors.js";
import { assertNoNegativeFlags } from "./git.js";
import { loadGhErrorMap, classifyGhError } from "./gh-error-map.js";
import { getPluginRoot } from "./plugin-root.js";
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
export async function gh(opts) {
    const { role, permissions, subcommand } = opts;
    const args = opts.args ?? [];
    const execaImpl = opts.execaImpl ?? defaultExeca;
    const pluginRoot = opts.pluginRootOverride ?? getPluginRoot();
    if (!permissions.gh_allow.includes(subcommand)) {
        throw new GhSubcommandDeniedError({
            role,
            attemptedSubcommand: subcommand,
            allowedSubcommands: permissions.gh_allow,
            specPath: permissions.sourcePath,
        });
    }
    // Negative-capability refusal: refuse --no-verify, --force, and
    // --force-with-lease (including --force-with-lease=<ref> variant)
    // BEFORE any subprocess spawn. This check is additive over gh_allow
    // (so denied subcommands still surface as GhSubcommandDeniedError).
    // (Story 4.4 AC2 / NFR16 / Pattern §9)
    assertNoNegativeFlags(args, role, "gh");
    // v1 gh_allow_args enforcement: exact-string match only.
    const allowedArgs = permissions.gh_allow_args[subcommand];
    if (allowedArgs && allowedArgs.length > 0) {
        for (const candidate of args) {
            if (!allowedArgs.includes(candidate)) {
                throw new GhSubcommandDeniedError({
                    role,
                    attemptedSubcommand: `${subcommand} ${candidate}`,
                    allowedSubcommands: allowedArgs,
                    specPath: permissions.sourcePath,
                });
            }
        }
    }
    // Translate kebab-cased subcommand into space-separated gh segments.
    const segments = subcommand.split("-");
    const execaOpts = {};
    if (opts.input !== undefined)
        execaOpts.input = opts.input;
    if (opts.cwd !== undefined)
        execaOpts.cwd = opts.cwd;
    const result = Object.keys(execaOpts).length > 0
        ? await execaImpl("gh", [...segments, ...args], execaOpts)
        : await execaImpl("gh", [...segments, ...args]);
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const exitCode = result.exitCode ?? 0;
    // Post-result classification: on non-zero exit, check the error map.
    // Raises GhRecoverableError on a mapped class; returns normally on unmapped
    // non-zero exits so callers (e.g. runDevTerminalAction) can raise their own
    // typed errors. Happy path (exitCode 0) bypasses classification.
    // (Story 4.5 AC2a / Task 3.2)
    if (exitCode !== 0) {
        const errorMap = await loadGhErrorMap(pluginRoot);
        const errorClass = classifyGhError({ exitCode, stderr }, errorMap);
        if (errorClass !== null) {
            throw new GhRecoverableError({ class: errorClass, exitCode, stderr, subcommand });
        }
    }
    return { stdout, stderr, exitCode };
}
