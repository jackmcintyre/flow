/**
 * Canonical-state path globs, relative to `<targetRepoRoot>`. These are
 * the paths only MCP tools are permitted to mutate (FR81 / NFR16).
 *
 * The static guard in `tests/canonical-fs-guard.test.ts` (AC5c) walks
 * `mcp-server/src/**` and forbids any file other than this module (and,
 * once it lands in Story 1.5, `lib/logger.ts`) from importing a
 * write-shaped `node:fs` API.
 */
export declare const CANONICAL_PATH_GLOBS: readonly string[];
/**
 * Match an absolute path against the canonical-path globs, relative
 * to `targetRepoRoot`. Pure. Returns the first matched glob or
 * `{ canonical: false }`.
 *
 * Rejects path-traversal escapes — if the resolved relative path
 * begins with `..` (the absolute path is outside the repo root), the
 * function returns `{ canonical: false }` rather than matching, since
 * such a write is by definition not a canonical-state write under
 * this repo.
 */
export declare function isCanonicalPath(absPath: string, targetRepoRoot: string): {
    canonical: boolean;
    matchedGlob?: string;
};
/**
 * Atomically write `contents` to `absPath` using a UNIQUE temp sibling file
 * followed by `fs.rename` (POSIX rename(2) — atomic on the same filesystem).
 *
 * The temp sibling is written first; if the write fails the final path is
 * never touched. On success, `fs.rename` replaces `absPath` in a single
 * syscall so readers never see a partial file.
 *
 * **Why the temp name is unique per call (not a fixed `<absPath>.tmp`):** under
 * concurrent drains two flows can target the SAME final path (e.g. a shared
 * session's `dev-outcome.json`). With a fixed `.tmp` sibling, flow A's `rename`
 * consumes `<f>.tmp` and flow B's `rename` then hits `ENOENT` because its temp
 * was renamed out from under it — the consistent `concurrent-drains-isolation`
 * CI red (mis-attributed to git-lock contention). A unique `<f>.<pid>.<seq>.tmp`
 * per call gives each writer its own temp, so every `rename` succeeds; the final
 * file is simply last-writer-wins (atomic, never partial). A failed `rename`
 * cleans up its own temp so unique names can't accumulate as litter.
 *
 * This is the ONLY file in `mcp-server/src/**` (alongside
 * `state/manifest-state-machine.ts`) permitted to invoke `rename`.
 * The static guard in `tests/canonical-fs-guard.test.ts` (AC5c) enforces
 * this — `managed-fs.ts` is listed in both the write whitelist and the
 * rename whitelist.
 */
export declare function atomicWriteFile(absPath: string, contents: string): Promise<void>;
/**
 * The ONLY entrypoint in the MCP server permitted to write a file
 * under a canonical-state path (FR81 / NFR16). When the target path
 * is non-canonical, the write passes through; when it is canonical,
 * the call requires an explicit `mcpToolContext` (proof that an MCP
 * tool — not arbitrary code — is the caller) and otherwise throws
 * `CanonicalFsWriteError`.
 *
 * Creates parent directories with `{ recursive: true }` before
 * writing. UTF-8 encoding.
 *
 * The static guard in `tests/canonical-fs-guard.test.ts` enforces
 * that no other file in `mcp-server/src/**` imports a write-shaped
 * `node:fs` API.
 */
export declare function writeManagedFile(opts: {
    absPath: string;
    contents: string;
    targetRepoRoot: string;
    mcpToolContext?: {
        toolName: string;
        role: string;
    };
}): Promise<void>;
