import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CanonicalFsWriteError } from "../errors.js";
/**
 * Canonical-state path globs, relative to `<targetRepoRoot>`. These are
 * the paths only MCP tools are permitted to mutate (FR81 / NFR16).
 *
 * The static guard in `tests/canonical-fs-guard.test.ts` (AC5c) walks
 * `mcp-server/src/**` and forbids any file other than this module (and,
 * once it lands in Story 1.5, `lib/logger.ts`) from importing a
 * write-shaped `node:fs` API.
 */
export const CANONICAL_PATH_GLOBS = [
    ".crew/state/**",
    ".crew/telemetry/**",
    ".crew/retro-proposals/**",
    ".crew/skills/**",
    ".crew/sprint-history/**",
    ".crew/sessions/**",
    "team/**",
    "docs/standards.md",
    "docs/risk-tiering.md",
    "docs/discipline-rules.yaml",
];
/**
 * Match a single path segment against a glob segment. Supports exact
 * matches; the caller handles `**` as a wildcard that consumes one or
 * more segments.
 */
function segmentMatches(globSeg, pathSeg) {
    return globSeg === pathSeg;
}
/**
 * Tiny dependency-free glob matcher. Supports `**` (matches zero or
 * more path segments) and exact-segment matches. Sufficient for the
 * canonical-path globs above; not a general-purpose glob engine.
 */
function matchGlob(glob, relPath) {
    const globSegments = glob.split("/").filter((s) => s.length > 0);
    const pathSegments = relPath.split("/").filter((s) => s.length > 0);
    function recurse(gi, pi) {
        if (gi === globSegments.length) {
            return pi === pathSegments.length;
        }
        const g = globSegments[gi];
        if (g === "**") {
            // `**` matches zero or more segments.
            for (let consume = 0; consume <= pathSegments.length - pi; consume++) {
                if (recurse(gi + 1, pi + consume))
                    return true;
            }
            return false;
        }
        if (pi >= pathSegments.length)
            return false;
        if (!segmentMatches(g, pathSegments[pi]))
            return false;
        return recurse(gi + 1, pi + 1);
    }
    return recurse(0, 0);
}
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
export function isCanonicalPath(absPath, targetRepoRoot) {
    const normalisedAbs = path.resolve(absPath);
    const normalisedRoot = path.resolve(targetRepoRoot);
    const rel = path.relative(normalisedRoot, normalisedAbs);
    // Path-traversal guard: anything outside the repo root is not a
    // canonical-state write for this repo.
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return { canonical: false };
    }
    // Normalise to forward slashes for glob matching.
    const relPosix = rel.split(path.sep).join("/");
    for (const glob of CANONICAL_PATH_GLOBS) {
        if (matchGlob(glob, relPosix)) {
            return { canonical: true, matchedGlob: glob };
        }
    }
    return { canonical: false };
}
/**
 * Monotonic per-process counter that makes each `atomicWriteFile` temp sibling
 * unique. Paired with `process.pid` (unique across concurrent drain processes)
 * it guarantees two writers targeting the SAME final path never share one temp
 * file — see `atomicWriteFile` for why a fixed `.tmp` raced under concurrency.
 */
let atomicWriteSeq = 0;
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
export async function atomicWriteFile(absPath, contents) {
    atomicWriteSeq = (atomicWriteSeq + 1) % Number.MAX_SAFE_INTEGER;
    const tmpPath = `${absPath}.${process.pid}.${atomicWriteSeq}.tmp`;
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(tmpPath, contents, "utf8");
    try {
        await fs.rename(tmpPath, absPath);
    }
    catch (err) {
        // Best-effort: don't leave the unique temp sibling behind on a failed rename.
        await fs.rm(tmpPath, { force: true }).catch(() => { });
        throw err;
    }
}
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
export async function writeManagedFile(opts) {
    const { absPath, contents, targetRepoRoot, mcpToolContext } = opts;
    const match = isCanonicalPath(absPath, targetRepoRoot);
    if (match.canonical && !mcpToolContext) {
        throw new CanonicalFsWriteError({
            attemptedPath: absPath,
            canonicalPathGlob: match.matchedGlob ?? "<unknown>",
        });
    }
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, contents, "utf8");
}
