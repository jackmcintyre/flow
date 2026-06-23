/**
 * `findPackageRoot` — walk up from a test-file path to the nearest enclosing
 * `package.json`, with pnpm-workspace-aware delegation.
 *
 * Extracted from `tools/run-reviewer-session.ts` (Story native:01KVS2MG) so the
 * SAME package-resolution walk backs BOTH the review-time vitest check AND the
 * author/scan-time discipline resolvability check. Keeping one implementation
 * means author-time and review-time package resolution cannot diverge — a story
 * whose `vitest:` target resolves to a runnable package at author time will
 * resolve to the same package root when the reviewer runs it.
 *
 * `run-reviewer-session.ts` re-exports `findPackageRoot` from this module so it
 * stays importable by name from there (other call sites depend on that import
 * path).
 *
 * Story 5.27 — AC1, AC2 (original walk).
 * Story native:01KT6QGBWP7KJDVMHQK3MEKDXP — workspace-root vitest delegation.
 * Story native:01KV6S35N4VF64WZT99SMZSFRJ — test-name-pattern fallback.
 */

import * as path from "node:path";
import { accessSync, readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * Check whether a directory has the vitest binary available locally.
 *
 * Returns true when `<dir>/node_modules/.bin/vitest` is accessible.
 * Used by `findPackageRoot` to skip workspace roots that don't install vitest
 * directly (e.g. `plugins/flow/` which delegates to its `mcp-server` sub-package).
 */
function hasLocalVitest(dir: string): boolean {
  try {
    accessSync(path.join(dir, "node_modules", ".bin", "vitest"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Given a pnpm workspace root (`dir`), parse `pnpm-workspace.yaml` and return
 * the first workspace-member directory that has vitest installed locally.
 *
 * Returns `{ ok: true, packageRoot }` on success or `{ ok: false }` when no
 * workspace member with vitest is found.  Only single-level glob patterns
 * (e.g. `"mcp-server"` or `"packages/*"`) are supported — deep globs are
 * skipped.  Fail-soft: any parse / access error returns `{ ok: false }`.
 */
function findVitestInWorkspaceMembers(
  workspaceRoot: string,
): { ok: true; packageRoot: string } | { ok: false } {
  try {
    const yaml = readFileSync(
      path.join(workspaceRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    const parsed = parseYaml(yaml) as { packages?: unknown };
    const packages = parsed?.packages;
    if (!Array.isArray(packages)) return { ok: false };

    for (const pattern of packages) {
      if (typeof pattern !== "string") continue;
      // Only handle simple (non-glob) patterns like "mcp-server" and single-level
      // globs like "packages/*".
      const segments = pattern.split("/");
      const hasGlob = segments.some((s) => s === "*" || s === "**");
      if (!hasGlob) {
        // Direct member: `<workspaceRoot>/<pattern>`
        const memberDir = path.join(workspaceRoot, pattern);
        if (hasLocalVitest(memberDir)) {
          return { ok: true, packageRoot: memberDir };
        }
      } else {
        // Single-level glob like "packages/*": scan the parent directory.
        const parentSegments = segments.slice(0, segments.indexOf("*"));
        const parentDir = path.join(workspaceRoot, ...parentSegments);
        try {
          const entries = readdirSync(parentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const memberDir = path.join(parentDir, entry.name);
            if (hasLocalVitest(memberDir)) {
              return { ok: true, packageRoot: memberDir };
            }
          }
        } catch {
          // parent directory not readable — skip this pattern.
        }
      }
    }
  } catch {
    // pnpm-workspace.yaml not present or not parseable — not a workspace root.
  }
  return { ok: false };
}

/**
 * Scan the subtree rooted at `root` (bounded by `maxDepth`) for the first
 * `pnpm-workspace.yaml` found. Returns the directory path if found, null
 * otherwise. Skips `node_modules` and `.git` to avoid unbounded traversal.
 *
 * Used as a fallback by `findPackageRoot` when the upward walk from the test
 * file path finds no `package.json` within `checkRoot`. This happens when the
 * `vitest:` AC marker is a test-name pattern (e.g. `"AC1 — valid vitest target"`)
 * rather than a repo-relative file path — the dirname walk resolves to
 * `checkRoot` itself and finds no `package.json` there. A downward scan for
 * `pnpm-workspace.yaml` recovers the correct member package in that case.
 *
 * Story native:01KV6S35N4VF64WZT99SMZSFRJ — test-name-pattern vitest markers.
 */
function findWorkspaceYamlInSubtree(root: string, maxDepth: number): string | null {
  if (maxDepth < 0) return null;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return null; // not readable — skip
  }
  if (entries.some((e) => e.isFile() && e.name === "pnpm-workspace.yaml")) {
    return root;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name as string;
    if (name === "node_modules" || name === ".git") continue;
    const found = findWorkspaceYamlInSubtree(path.join(root, name), maxDepth - 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Walk up from `testFilePathAbs` to find the nearest enclosing `package.json`.
 *
 * Starts at `path.dirname(testFilePathAbs)` and walks toward the filesystem
 * root, stopping (inclusively) at `checkRoot`. Returns `{ ok: true, packageRoot }`
 * if found, `{ ok: false }` if the walk exhausts `checkRoot` without finding one.
 *
 * Workspace-root handling: when the walk finds a `package.json` that has a
 * sibling `pnpm-workspace.yaml`, the directory is treated as a workspace root.
 * In that case the function searches the workspace members (listed in the YAML)
 * for one that has vitest installed locally (`node_modules/.bin/vitest`) and
 * returns that member instead. This covers the case where a `vitest:` AC marker
 * targets a source file in a sub-directory of a pnpm workspace root whose root
 * package delegates vitest to a member package (e.g. `plugins/flow/workflows/
 * run.workflow.js` → `plugins/flow/` workspace root → member `mcp-server`).
 *
 * Fallback for test-name-pattern markers: when the upward walk finds no
 * `package.json` within `checkRoot` (which happens when the `vitest:` marker is
 * a test-name string like `"AC1 — valid vitest target"` rather than a file path,
 * so `testFilePathAbs` = `checkRoot/<marker>` and dirname = `checkRoot`), this
 * function scans the `checkRoot` subtree (bounded to depth 4) for a
 * `pnpm-workspace.yaml` and delegates to `findVitestInWorkspaceMembers`. This
 * lets test-name-pattern markers resolve the correct package root in pnpm
 * workspace repos. See Story native:01KV6S35N4VF64WZT99SMZSFRJ.
 *
 * Guard: `d === checkRootAbs || d.startsWith(checkRootAbs + path.sep)` prevents
 * false-positive prefix matches on sibling paths (e.g. `/tmp/checker` when
 * checkRoot is `/tmp/check`). ESM — uses `accessSync` from "node:fs" (top-level
 * import), NOT `require(...)`.
 *
 * Story 5.27 — AC1, AC2.
 * Story native:01KT6QGBWP7KJDVMHQK3MEKDXP — workspace-root vitest delegation.
 */
export function findPackageRoot(opts: {
  testFilePathAbs: string;
  checkRoot: string;
}): { ok: true; packageRoot: string } | { ok: false } {
  const checkRootAbs = path.resolve(opts.checkRoot);
  let dir = path.dirname(opts.testFilePathAbs);

  const isWithinCheckRoot = (d: string): boolean =>
    d === checkRootAbs || d.startsWith(checkRootAbs + path.sep);

  while (isWithinCheckRoot(dir)) {
    try {
      accessSync(path.join(dir, "package.json"));
      // Found a package.json. Check whether this is a pnpm workspace root
      // (has a sibling pnpm-workspace.yaml). If so, look for a workspace member
      // that has vitest installed — that member is the correct vitest root.
      const memberResult = findVitestInWorkspaceMembers(dir);
      if (memberResult.ok) {
        return memberResult;
      }
      // Not a workspace root, or no member has vitest installed — use this
      // package root directly (the vitest binary may not be installed in fixture
      // environments; the caller handles the missing-vitest failure).
      return { ok: true, packageRoot: dir };
    } catch {
      // package.json not present here — walk up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root reached
    dir = parent;
  }

  // Fallback: the upward walk found no package.json within checkRoot.
  // This happens when the vitest: marker is a test-name pattern (no directory
  // component), so testFilePathAbs resolves to checkRoot/<pattern> and dirname
  // is checkRoot itself, which has no package.json. Scan downward from checkRoot
  // for a pnpm-workspace.yaml and try its workspace members.
  const workspaceYamlDir = findWorkspaceYamlInSubtree(checkRootAbs, 4);
  if (workspaceYamlDir !== null) {
    const memberResult = findVitestInWorkspaceMembers(workspaceYamlDir);
    if (memberResult.ok) return memberResult;
  }

  return { ok: false };
}
